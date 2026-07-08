export type Role = "MASTER" | "BROKER" | "AGENT" | "SPECIAL_BROKER";
export type OrderState = "DRAFT" | "PENDING_FORWARD" | "ASSIGNED" | "PAID" | "CANCELLED" | "VOIDED";
export type TransferState = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "PENDING_RECEIVE" | "RECEIVED";
export type Direction = "DEBIT" | "CREDIT";

export type Money = {
  currency: string;
  amountMinor: bigint;
};

export type ExchangeRate = {
  numerator: bigint;
  denominator: bigint;
};

export type Actor = {
  id: string;
  role: Role;
  baseCurrency: string;
};

export type Order = {
  id: string;
  brokerUserId: string;
  assignedAgentUserId?: string;
  state: OrderState;
  sourceCurrency: string;
  payoutCurrency: string;
  sourceAmountMinor: bigint;
  payoutAmountMinor: bigint;
  exchangeRate: ExchangeRate;
  commissionBps: number;
  commissionAmountMinor: bigint;
  senderName?: string;
  receiverName?: string;
  receiverAccountNumber?: string;
  receiverPhoneNumber?: string;
  remarks?: string;
  paidJournalEntryId?: string;
  voidJournalEntryId?: string;
  voidableUntil?: Date;
};

export type LedgerLineInput = {
  accountId: string;
  direction: Direction;
  currency: string;
  amountMinor: bigint;
  memo?: string;
};

export type JournalInput = {
  sourceType: "ORDER_PAYMENT" | "ORDER_VOID" | "TRANSFER" | "TRANSFER_REVERSAL" | "SETTLEMENT";
  sourceId: string;
  idempotencyKey: string;
  description: string;
  createdByUserId?: string;
  reversedJournalEntryId?: string;
  lines: LedgerLineInput[];
};

export function calculateConvertedAmount(amountMinor: bigint, rate: ExchangeRate): bigint {
  return (amountMinor * rate.numerator) / rate.denominator;
}

export function calculateCommission(amountMinor: bigint, commissionBps: number): bigint {
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new Error("commissionBps must be an integer between 0 and 10000");
  }
  return (amountMinor * BigInt(commissionBps)) / 10_000n;
}

export function hasRequiredReceiverDetail(input: Pick<Order, "receiverName" | "receiverAccountNumber" | "receiverPhoneNumber" | "remarks">): boolean {
  return [input.receiverName, input.receiverAccountNumber, input.receiverPhoneNumber, input.remarks]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}
