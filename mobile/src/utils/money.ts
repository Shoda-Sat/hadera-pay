import type { Currency, TransferDraft, TransferQuote } from "../types";

export const currencies: Currency[] = ["USD", "ETB", "EUR", "ERN"];
const decimalCurrencies = new Set<Currency>(["USD", "EUR"]);

export function parseAmount(value: string): number {
  const numeric = Number(String(value || "").replace(/,/g, "").trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export function currencyDecimals(currency: Currency): number {
  return decimalCurrencies.has(currency) ? 2 : 0;
}

export function currencyFactor(currency: Currency): number {
  return decimalCurrencies.has(currency) ? 100 : 1;
}

export function minorFromMajor(value: number, currency: Currency): number {
  return Math.round((Number.isFinite(value) ? value : 0) * currencyFactor(currency));
}

export function majorFromMinor(value: number, currency: Currency): number {
  return Number(value || 0) / currencyFactor(currency);
}

function normalizedMajor(value: number, currency: Currency): number {
  return majorFromMinor(minorFromMajor(value, currency), currency);
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

export function inputAmount(currency: Currency, amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return amount
    .toFixed(currencyDecimals(currency))
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

export type OrderConversionField = "sourceAmount" | "rate" | "payoutAmount";

export function inputRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return String(rounded);
}

export function reconcileOrderConversion(draft: TransferDraft, touchedFields: readonly OrderConversionField[]): TransferDraft {
  const sourceAmount = parseAmount(draft.sourceAmount);
  const payoutAmount = parseAmount(draft.payoutAmount);
  const rate = parseAmount(draft.rate);
  const touched = new Set(touchedFields);
  const sourceAndPayout = touched.has("sourceAmount") && touched.has("payoutAmount");
  const rateAndPayout = touched.has("rate") && touched.has("payoutAmount");
  const sourceAndRate = touched.has("sourceAmount") && touched.has("rate");

  if (sourceAndPayout && sourceAmount > 0 && payoutAmount > 0) {
    return { ...draft, rate: inputRate(payoutAmount / sourceAmount) };
  }
  if (rateAndPayout && rate > 0 && payoutAmount > 0) {
    return { ...draft, sourceAmount: inputAmount(draft.sourceCurrency, payoutAmount / rate) };
  }
  if (sourceAndRate && sourceAmount > 0 && rate > 0) {
    return { ...draft, payoutAmount: inputAmount(draft.payoutCurrency, sourceAmount * rate) };
  }
  if (rate <= 0 && sourceAmount > 0 && payoutAmount > 0) {
    return { ...draft, rate: inputRate(payoutAmount / sourceAmount) };
  }
  if (sourceAmount <= 0 && payoutAmount > 0 && rate > 0) {
    return { ...draft, sourceAmount: inputAmount(draft.sourceCurrency, payoutAmount / rate) };
  }
  if (payoutAmount <= 0 && sourceAmount > 0 && rate > 0) {
    return { ...draft, payoutAmount: inputAmount(draft.payoutCurrency, sourceAmount * rate) };
  }
  return draft;
}

export function calculateQuote(draft: TransferDraft): TransferQuote {
  const sourceAmount = normalizedMajor(parseAmount(draft.sourceAmount), draft.sourceCurrency);
  const manualPayout = normalizedMajor(parseAmount(draft.payoutAmount), draft.payoutCurrency);
  const rate = parseAmount(draft.rate);
  const commissionPercent = parseAmount(draft.commissionPercent);
  const commissionAmount = normalizedMajor(sourceAmount * commissionPercent / 100, draft.sourceCurrency);
  const payoutAmount = manualPayout > 0
    ? manualPayout
    : normalizedMajor(sourceAmount * rate, draft.payoutCurrency);

  return {
    sourceAmount,
    commissionAmount,
    grossAmount: normalizedMajor(sourceAmount + commissionAmount, draft.sourceCurrency),
    payoutAmount,
    rate,
    sourceCurrency: draft.sourceCurrency,
    payoutCurrency: draft.payoutCurrency
  };
}
