import { calculateCommission, calculateConvertedAmount, type ExchangeRate, type LedgerLineInput } from "./domain";
import type { LedgerRepository } from "./ledger";
import { LedgerService } from "./ledger";

type Tx = unknown;

export type Transfer = {
  id: string;
  transferType: "MASTER_TO_ACTOR" | "AGENT_TO_AGENT" | "BROKER_TO_MASTER" | "MASTER_TOP_UP";
  initiatedByUserId: string;
  fromUserId?: string;
  toUserId?: string;
  state: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "PENDING_RECEIVE" | "RECEIVED";
  sourceCurrency: string;
  destinationCurrency: string;
  sourceAmountMinor: bigint;
  destinationAmountMinor: bigint;
  exchangeRate: ExchangeRate;
  commissionBps: number;
  commissionAmountMinor: bigint;
};

export interface TransferRepository {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  getTransferForUpdate(tx: Tx, transferId: string): Promise<Transfer>;
  markApproved(tx: Tx, transferId: string, approvedByUserId: string, journalEntryId: string): Promise<void>;
  markRejected(tx: Tx, transferId: string, rejectedByUserId: string): Promise<void>;
  markReceived(tx: Tx, transferId: string, receivedByUserId: string, journalEntryId: string): Promise<void>;
}

export class TransferService {
  constructor(
    private readonly transfers: TransferRepository,
    private readonly ledgerRepo: LedgerRepository,
    private readonly ledger = new LedgerService(ledgerRepo),
  ) {}

  calculateDestinationAmount(sourceAmountMinor: bigint, exchangeRate: ExchangeRate): bigint {
    return calculateConvertedAmount(sourceAmountMinor, exchangeRate);
  }

  calculateCommissionAmount(sourceAmountMinor: bigint, commissionBps: number): bigint {
    return calculateCommission(sourceAmountMinor, commissionBps);
  }

  async approve(transferId: string, masterUserId: string): Promise<string> {
    return this.transfers.transaction(async (tx) => {
      const transfer = await this.transfers.getTransferForUpdate(tx, transferId);
      if (transfer.state !== "PENDING_APPROVAL") throw new Error("transfer is not pending approval");

      const journalEntryId = await this.ledger.postInTransaction(tx, {
        sourceType: "TRANSFER",
        sourceId: transfer.id,
        idempotencyKey: `transfer:${transfer.id}:approved`,
        description: `Approved transfer ${transfer.id}`,
        createdByUserId: masterUserId,
        lines: await buildTransferLines(this.ledgerRepo, tx, transfer),
      });

      await this.transfers.markApproved(tx, transferId, masterUserId, journalEntryId);
      return journalEntryId;
    });
  }

  async receiveTopUp(transferId: string, receiverUserId: string): Promise<string> {
    return this.transfers.transaction(async (tx) => {
      const transfer = await this.transfers.getTransferForUpdate(tx, transferId);
      if (transfer.transferType !== "MASTER_TOP_UP") throw new Error("transfer is not a top-up");
      if (transfer.state !== "PENDING_RECEIVE") throw new Error("top-up is not pending receive");
      if (transfer.toUserId !== receiverUserId) throw new Error("top-up belongs to a different receiver");

      const journalEntryId = await this.ledger.postInTransaction(tx, {
        sourceType: "TRANSFER",
        sourceId: transfer.id,
        idempotencyKey: `transfer:${transfer.id}:received`,
        description: `Received top-up ${transfer.id}`,
        createdByUserId: receiverUserId,
        lines: await buildTransferLines(this.ledgerRepo, tx, transfer),
      });

      await this.transfers.markReceived(tx, transferId, receiverUserId, journalEntryId);
      return journalEntryId;
    });
  }
}

async function buildTransferLines(repo: LedgerRepository, tx: Tx, transfer: Transfer): Promise<LedgerLineInput[]> {
  if (!transfer.fromUserId && transfer.transferType !== "MASTER_TO_ACTOR" && transfer.transferType !== "MASTER_TOP_UP") {
    throw new Error("transfer requires a sender");
  }
  if (!transfer.toUserId && transfer.transferType !== "BROKER_TO_MASTER") {
    throw new Error("transfer requires a receiver");
  }

  const sourceDebitAccountId = transfer.fromUserId
    ? await repo.getActorAccountId(tx, transfer.fromUserId, transfer.sourceCurrency)
    : await repo.getPlatformAccountId(tx, "MASTER_CASH", transfer.sourceCurrency);
  const destinationCreditAccountId = transfer.toUserId
    ? await repo.getActorAccountId(tx, transfer.toUserId, transfer.destinationCurrency)
    : await repo.getPlatformAccountId(tx, "MASTER_CASH", transfer.destinationCurrency);

  const feeRevenueAccountId = transfer.commissionAmountMinor > 0n
    ? await repo.getPlatformAccountId(tx, "MASTER_FEE_REVENUE", transfer.sourceCurrency)
    : undefined;

  const sourceGross = transfer.sourceAmountMinor + transfer.commissionAmountMinor;
  const lines: LedgerLineInput[] = [];

  if (transfer.sourceCurrency === transfer.destinationCurrency && transfer.sourceAmountMinor === transfer.destinationAmountMinor) {
    lines.push(
      { accountId: sourceDebitAccountId, direction: "DEBIT", currency: transfer.sourceCurrency, amountMinor: sourceGross, memo: "Transfer source leg" },
      { accountId: destinationCreditAccountId, direction: "CREDIT", currency: transfer.destinationCurrency, amountMinor: transfer.destinationAmountMinor, memo: "Transfer destination leg" },
    );
    if (feeRevenueAccountId && transfer.commissionAmountMinor > 0n) {
      lines.push({ accountId: feeRevenueAccountId, direction: "CREDIT", currency: transfer.sourceCurrency, amountMinor: transfer.commissionAmountMinor, memo: "Transfer commission" });
    }
    return lines;
  }

  const sourceFxAccountId = await repo.getPlatformAccountId(tx, "MASTER_FX_CLEARING", transfer.sourceCurrency);
  const destinationFxAccountId = await repo.getPlatformAccountId(tx, "MASTER_FX_CLEARING", transfer.destinationCurrency);
  lines.push(
    { accountId: sourceDebitAccountId, direction: "DEBIT", currency: transfer.sourceCurrency, amountMinor: sourceGross, memo: "Transfer source leg" },
    { accountId: sourceFxAccountId, direction: "CREDIT", currency: transfer.sourceCurrency, amountMinor: transfer.sourceAmountMinor, memo: "Source currency FX leg" },
    { accountId: destinationFxAccountId, direction: "DEBIT", currency: transfer.destinationCurrency, amountMinor: transfer.destinationAmountMinor, memo: "Destination currency FX leg" },
    { accountId: destinationCreditAccountId, direction: "CREDIT", currency: transfer.destinationCurrency, amountMinor: transfer.destinationAmountMinor, memo: "Transfer destination leg" },
  );
  if (feeRevenueAccountId && transfer.commissionAmountMinor > 0n) {
    lines.push({ accountId: feeRevenueAccountId, direction: "CREDIT", currency: transfer.sourceCurrency, amountMinor: transfer.commissionAmountMinor, memo: "Transfer commission" });
  }
  return lines;
}
