export type Currency = "USD" | "ETB" | "EUR" | "ERN";
export type AuthMode = "login" | "signup";
export type AppScreen = "home" | "transfer" | "conversion" | "confirmation";
export type FundingType = "cash" | "credit";
export type MembershipRole = "Owner" | "Master" | "Actor";
export type ActorRole = "Owner" | "Master" | "Broker" | "Agent" | "Special Broker" | "Special Agent";

export interface UserSession {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  actorId: string;
  actorName: string;
  actorRole: ActorRole;
  currency: Currency;
  workingCurrencies: Currency[];
  workspaceId: string;
  workspace: string;
}

export interface ApiSession {
  user?: {
    id?: string;
    name?: string;
    email?: string;
  };
  workspace?: {
    id?: string;
    name?: string;
  };
  membership?: {
    role?: MembershipRole;
    actorId?: string;
    actorName?: string;
    actorRole?: ActorRole;
    currency?: Currency;
    workingCurrencies?: Currency[];
  };
}

export interface ActorRecord {
  id: string;
  name: string;
  role: ActorRole;
  currency: Currency;
  active?: boolean;
  workingCurrencies?: Currency[];
  transferEnabled?: boolean;
  transferMode?: "actor" | "master" | "both" | "none";
  orderMultiCurrencyEnabled?: boolean;
}

export type OrderState =
  | "Draft"
  | "Pending Forward"
  | "Assigned"
  | "Returned"
  | "Paid"
  | "Void Requested"
  | "Voided"
  | "Cancelled";

export interface OrderRecord {
  id: string;
  broker: string;
  agent: string;
  agentActorId?: string;
  sourceCurrency: Currency;
  payoutCurrency: Currency;
  sourceAmountMinor: number;
  payoutAmountMinor: number;
  commissionMinor: number;
  grossMinor: number;
  rate: number;
  commissionPercent: number;
  senderName: string;
  receiverName: string;
  accountNumber: string;
  phoneNumber: string;
  remarks: string;
  amount: string;
  fundingType: FundingType;
  state: OrderState;
  journal: string;
  createdAt: string;
  sentAt: string;
  paidAt: string;
  returnedBy: string;
  returnedReason: string;
  updatedAt: string;
  locked?: boolean;
  voidJournal?: string;
  voidRequested?: boolean;
}

export interface ReceivableRecord {
  id: string;
  orderId: string;
  borrower: string;
  borrowerActorId: string;
  currency: Currency;
  principalMinor: number;
  senderName: string;
  receiverName: string;
  accountNumber: string;
  phoneNumber: string;
  remarks: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  payments: Array<{ amountMinor: number; paidAt: string; receivedBy: string }>;
}

export interface WorkspaceState {
  actors: ActorRecord[];
  orders: OrderRecord[];
  receivables: ReceivableRecord[];
  orderCounter?: number;
  receivableCounter?: number;
  [key: string]: unknown;
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
  state: WorkspaceState;
}
