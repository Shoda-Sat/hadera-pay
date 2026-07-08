import type { LedgerLineInput } from "./domain";
import type { LedgerRepository } from "./ledger";
import { LedgerService } from "./ledger";

type Tx = unknown;

export interface SettlementRepository {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  getActorNetBalanceMinor(tx: Tx, userId: string, currency: string): Promise<bigint>;
  recordSettlement(tx: Tx, settlement: {
    actorUserId: string;
    currency: string;
    amountMinor: bigint;
    direction: "ACTOR_PAID_MASTER" | "MASTER_PAID_ACTOR";
    journalEntryId: string;
  }): Promise<void>;
}

export class SettlementService {
  constructor(
    private readonly settlements: SettlementRepository,
    private readonly ledgerRepo: LedgerRepository,
    private readonly ledger = new LedgerService(ledgerRepo),
  ) {}

  async settleActorNetPosition(params: {
    actorUserId: string;
    currency: string;
    masterUserId: string;
    settlementRunId: string;
  }): Promise<string | undefined> {
    return this.settlements.transaction(async (tx) => {
      const netDebitMinusCredit = await this.settlements.getActorNetBalanceMinor(tx, params.actorUserId, params.currency);
      if (netDebitMinusCredit === 0n) return undefined;

      const actorAccountId = await this.ledgerRepo.getActorAccountId(tx, params.actorUserId, params.currency);
      const masterCashAccountId = await this.ledgerRepo.getPlatformAccountId(tx, "MASTER_CASH", params.currency);
      const amountMinor = netDebitMinusCredit < 0n ? -netDebitMinusCredit : netDebitMinusCredit;
      const actorOwesMaster = netDebitMinusCredit > 0n;

      const lines: LedgerLineInput[] = actorOwesMaster
        ? [
          { accountId: masterCashAccountId, direction: "DEBIT", currency: params.currency, amountMinor, memo: "Cash received from actor" },
          { accountId: actorAccountId, direction: "CREDIT", currency: params.currency, amountMinor, memo: "Cleared actor payable" },
        ]
        : [
          { accountId: actorAccountId, direction: "DEBIT", currency: params.currency, amountMinor, memo: "Cleared Master payable" },
          { accountId: masterCashAccountId, direction: "CREDIT", currency: params.currency, amountMinor, memo: "Cash paid to actor" },
        ];

      const journalEntryId = await this.ledger.postInTransaction(tx, {
        sourceType: "SETTLEMENT",
        sourceId: params.actorUserId,
        idempotencyKey: `settlement:${params.settlementRunId}:${params.actorUserId}:${params.currency}`,
        description: `Settlement for actor ${params.actorUserId} in ${params.currency}`,
        createdByUserId: params.masterUserId,
        lines,
      });

      await this.settlements.recordSettlement(tx, {
        actorUserId: params.actorUserId,
        currency: params.currency,
        amountMinor,
        direction: actorOwesMaster ? "ACTOR_PAID_MASTER" : "MASTER_PAID_ACTOR",
        journalEntryId,
      });
      return journalEntryId;
    });
  }
}
