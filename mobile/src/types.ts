export type Currency = "USD" | "ETB" | "EUR" | "ERN";
export type AuthMode = "login" | "signup";
export type AppScreen = "home" | "transfer" | "conversion" | "confirmation";
export type FundingType = "cash" | "credit";

export interface UserSession {
  name: string;
  email: string;
  role: "Master" | "Actor";
  workspace: string;
}

export interface TransferDraft {
  broker: string;
  sourceCurrency: Currency;
  payoutCurrency: Currency;
  sourceAmount: string;
  payoutAmount: string;
  rate: string;
  commissionPercent: string;
  fundingType: FundingType;
  senderName: string;
  receiverName: string;
  phoneNumber: string;
  accountNumber: string;
  remarks: string;
}

export interface TransferQuote {
  sourceAmount: number;
  commissionAmount: number;
  grossAmount: number;
  payoutAmount: number;
  rate: number;
  sourceCurrency: Currency;
  payoutCurrency: Currency;
}

export interface SubmittedOrder {
  orderId: string;
  status: "Pending Master Approval";
  createdAt: string;
}
