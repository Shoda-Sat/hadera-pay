import type { Currency, TransferDraft, TransferQuote } from "../types";

export const currencies: Currency[] = ["USD", "ETB", "EUR", "ERN"];

export function parseAmount(value: string): number {
  const numeric = Number(String(value || "").replace(/,/g, "").trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export function currencyDecimals(currency: Currency): number {
  return currency === "ETB" || currency === "ERN" ? 2 : 2;
}

export function formatAmount(currency: Currency, amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: currencyDecimals(currency),
    maximumFractionDigits: currencyDecimals(currency)
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function compactAmount(currency: Currency, amount: number): string {
  const formatted = (Number.isFinite(amount) ? amount : 0)
    .toFixed(currencyDecimals(currency))
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
  return `${currency}${formatted}`;
}

export function calculateQuote(draft: TransferDraft): TransferQuote {
  const sourceAmount = parseAmount(draft.sourceAmount);
  const manualPayout = parseAmount(draft.payoutAmount);
  const rate = parseAmount(draft.rate) || 1;
  const commissionPercent = parseAmount(draft.commissionPercent);
  const commissionAmount = sourceAmount * commissionPercent / 100;
  const payoutAmount = manualPayout > 0 ? manualPayout : sourceAmount * rate;

  return {
    sourceAmount,
    commissionAmount,
    grossAmount: sourceAmount + commissionAmount,
    payoutAmount,
    rate,
    sourceCurrency: draft.sourceCurrency,
    payoutCurrency: draft.payoutCurrency
  };
}
