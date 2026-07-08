import { calculateCommission, calculateConvertedAmount, hasRequiredReceiverDetail, type ExchangeRate, type LedgerLineInput, type Order } from "./domain";
import type { LedgerRepository } from "./ledger";
import { LedgerService } from "./ledger";

type Tx = unknown;

export interface OrderRepository {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  createOrder(tx: Tx, order: Omit<Order, "id" | "state">): Promise<Order>;
  getOrderForUpdate(tx: Tx, orderId: string): Promise<Order>;
  markOrderPendingForward(tx: Tx, orderId: string): Promise<void>;
  assignOrder(tx: Tx, orderId: string, agentUserId: string): Promise<void>;
  markOrderPaid(tx: Tx, orderId: string, paidJournalEntryId: string, voidableUntil: Date): Promise<void>;
  markOrderCancelled(tx: Tx, orderId: string): Promise<void>;
  markOrderVoided(tx: Tx, orderId: string, voidJournalEntryId: string): Promise<void>;
}

export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly ledgerRepo: LedgerRepository,
    private readonly ledger = new LedgerService(ledgerRepo),
  ) {}

  async createDraft(input: Omit<Order, "id" | "state" | "payoutAmountMinor" | "commissionAmountMinor">): Promise<Order> {
    if (!hasRequiredReceiverDetail(input)) {
      throw new Error("order requires at least one receiver detail: receiver name, account number, phone number, or remarks");
    }

    const payoutAmountMinor = calculateConvertedAmount(input.sourceAmountMinor, input.exchangeRate);
    const commissionAmountMinor = calculateCommission(input.sourceAmountMinor, input.commissionBps);

    return this.orders.transaction((tx) => this.orders.createOrder(tx, {
      ...input,
      payoutAmountMinor,
      commissionAmountMinor,
    }));
  }

  async forwardToMaster(orderId: string): Promise<void> {
    await this.orders.transaction(async (tx) => {
      const order = await this.orders.getOrderForUpdate(tx, orderId);
      requireState(order, "DRAFT");
      await this.orders.markOrderPendingForward(tx, orderId);
    });
  }

  async assign(orderId: string, agentUserId: string): Promise<void> {
    await this.orders.transaction(async (tx) => {
      const order = await this.orders.getOrderForUpdate(tx, orderId);
      requireState(order, "PENDING_FORWARD");
      await this.orders.assignOrder(tx, orderId, agentUserId);
    });
  }

  async cancelBeforePayment(orderId: string): Promise<void> {
    await this.orders.transaction(async (tx) => {
      const order = await this.orders.getOrderForUpdate(tx, orderId);
      if (order.state !== "PENDING_FORWARD" && order.state !== "ASSIGNED") {
        throw new Error("only unposted orders can be cancelled");
      }
      await this.orders.markOrderCancelled(tx, orderId);
    });
  }

  async pay(orderId: string, paidByAgentUserId: string, masterUserId: string, voidWindowMinutes = 30): Promise<string> {
    return this.orders.transaction(async (tx) => {
      const order = await this.orders.getOrderForUpdate(tx, orderId);
      requireState(order, "ASSIGNED");
      if (order.assignedAgentUserId !== paidByAgentUserId) throw new Error("order is assigned to a different paying actor");

      const lines = await buildOrderPaymentLines(this.ledgerRepo, tx, order);
      const journalEntryId = await this.ledger.postInTransaction(tx, {
        sourceType: "ORDER_PAYMENT",
        sourceId: order.id,
        idempotencyKey: `order:${order.id}:paid`,
        description: `Order ${order.id} paid`,
        createdByUserId: masterUserId,
        lines,
      });

      const voidableUntil = new Date(Date.now() + voidWindowMinutes * 60_000);
      await this.orders.markOrderPaid(tx, orderId, journalEntryId, voidableUntil);
      return journalEntryId;
    });
  }

  async voidPaidOrder(orderId: string, requestedByAgentUserId: string, approvedByMasterUserId: string): Promise<string> {
    return this.orders.transaction(async (tx) => {
      const order = await this.orders.getOrderForUpdate(tx, orderId);
      requireState(order, "PAID");
      if (order.assignedAgentUserId !== requestedByAgentUserId) throw new Error("only the paying actor can request this void");
      if (!order.paidJournalEntryId) throw new Error("paid order has no journal entry");
      if (order.voidableUntil && order.voidableUntil.getTime() < Date.now()) throw new Error("void window has expired");

      const journalEntryId = await this.ledger.reverseInTransaction(tx, {
        originalJournalEntryId: order.paidJournalEntryId,
        sourceType: "ORDER_VOID",
        sourceId: order.id,
        idempotencyKey: `order:${order.id}:void`,
        description: `Void order ${order.id}`,
        createdByUserId: approvedByMasterUserId,
      });

      await this.orders.markOrderVoided(tx, orderId, journalEntryId);
      return journalEntryId;
    });
  }
}

async function buildOrderPaymentLines(repo: LedgerRepository, tx: Tx, order: Order): Promise<LedgerLineInput[]> {
  if (!order.assignedAgentUserId) throw new Error("order must be assigned before payment");

  const brokerAccountId = await repo.getActorAccountId(tx, order.brokerUserId, order.sourceCurrency);
  const agentAccountId = await repo.getActorAccountId(tx, order.assignedAgentUserId, order.payoutCurrency);
  const feeRevenueAccountId = order.commissionAmountMinor > 0n
    ? await repo.getPlatformAccountId(tx, "MASTER_FEE_REVENUE", order.sourceCurrency)
    : undefined;

  const lines: LedgerLineInput[] = [];
  const brokerGross = order.sourceAmountMinor + order.commissionAmountMinor;

  if (order.sourceCurrency === order.payoutCurrency && order.sourceAmountMinor === order.payoutAmountMinor) {
    lines.push(
      { accountId: brokerAccountId, direction: "DEBIT", currency: order.sourceCurrency, amountMinor: brokerGross, memo: "Broker payable to Master" },
      { accountId: agentAccountId, direction: "CREDIT", currency: order.payoutCurrency, amountMinor: order.payoutAmountMinor, memo: "Master payable to paying actor" },
    );
    if (feeRevenueAccountId && order.commissionAmountMinor > 0n) {
      lines.push({ accountId: feeRevenueAccountId, direction: "CREDIT", currency: order.sourceCurrency, amountMinor: order.commissionAmountMinor, memo: "Order commission" });
    }
    return lines;
  }

  const sourceFxAccountId = await repo.getPlatformAccountId(tx, "MASTER_FX_CLEARING", order.sourceCurrency);
  const payoutFxAccountId = await repo.getPlatformAccountId(tx, "MASTER_FX_CLEARING", order.payoutCurrency);

  lines.push(
    { accountId: brokerAccountId, direction: "DEBIT", currency: order.sourceCurrency, amountMinor: brokerGross, memo: "Broker payable to Master" },
    { accountId: sourceFxAccountId, direction: "CREDIT", currency: order.sourceCurrency, amountMinor: order.sourceAmountMinor, memo: "Source currency FX leg" },
    { accountId: payoutFxAccountId, direction: "DEBIT", currency: order.payoutCurrency, amountMinor: order.payoutAmountMinor, memo: "Payout currency FX leg" },
    { accountId: agentAccountId, direction: "CREDIT", currency: order.payoutCurrency, amountMinor: order.payoutAmountMinor, memo: "Master payable to paying actor" },
  );

  if (feeRevenueAccountId && order.commissionAmountMinor > 0n) {
    lines.push({ accountId: feeRevenueAccountId, direction: "CREDIT", currency: order.sourceCurrency, amountMinor: order.commissionAmountMinor, memo: "Order commission" });
  }

  return lines;
}

function requireState(order: Order, expected: Order["state"]): void {
  if (order.state !== expected) throw new Error(`order ${order.id} must be ${expected}, got ${order.state}`);
}
