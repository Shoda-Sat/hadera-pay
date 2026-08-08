import type { Currency, ReceivableRecord, UserSession } from "../types";

export type ReceivableCurrencyTotal = {
  currency: Currency;
  principalMinor: number;
  collectedMinor: number;
  balanceMinor: number;
};

function sessionIsMaster(session: UserSession): boolean {
  return session.role === "Master" && session.actorRole === "Master";
}

export function receivableIsVoided(receivable: ReceivableRecord): boolean {
  return receivable.voided === true || Boolean(receivable.voidedAt);
}

export function receivableCollectedMinor(receivable: ReceivableRecord): number {
  return (receivable.payments || []).reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0);
}

export function visibleReceivablesForSession(
  receivables: ReceivableRecord[],
  session: UserSession
): ReceivableRecord[] {
  return receivables
    .filter((receivable) => !receivable.archivedAt && (
      sessionIsMaster(session) ||
      Boolean(session.actorId && receivable.borrowerActorId === session.actorId) ||
      receivable.borrower === session.actorName
    ))
    .slice()
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
}

export function receivableTotalsByCurrency(receivables: ReceivableRecord[]): ReceivableCurrencyTotal[] {
  const totals = new Map<Currency, { principalMinor: number; collectedMinor: number }>();
  receivables.forEach((receivable) => {
    const currency = (receivable.currency || "USD") as Currency;
    if (!totals.has(currency)) totals.set(currency, { principalMinor: 0, collectedMinor: 0 });
    if (receivableIsVoided(receivable)) return;
    const total = totals.get(currency)!;
    total.principalMinor += Number(receivable.principalMinor || 0);
    total.collectedMinor += receivableCollectedMinor(receivable);
  });
  return Array.from(totals, ([currency, total]) => ({
    currency,
    principalMinor: total.principalMinor,
    collectedMinor: total.collectedMinor,
    balanceMinor: Math.max(0, total.principalMinor - total.collectedMinor)
  }));
}
