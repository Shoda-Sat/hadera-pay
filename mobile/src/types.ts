export type Currency = "USD" | "ETB" | "EUR" | "ERN";
export type AuthMode = "login" | "signup";
export type AppScreen =
  | "home"
  | "orders"
  | "pendingCancelled"
  | "newOrder"
  | "conversion"
  | "confirmation"
  | "transfers"
  | "search"
  | "receivables"
  | "chat"
  | "ledger"
  | "settlement"
  | "archive"
  | "actors"
  | "settings"
  | "owner"
  | "more";
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
  managedByMaster?: boolean;
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
  transferReceiveMultiCurrencyEnabled?: boolean;
  orderMultiCurrencyEnabled?: boolean;
  managedByMaster?: boolean;
  incomeStatementVisible?: boolean;
  specialPayoutDivider?: number;
  specialPayoutDividerEnabled?: boolean;
  specialPayoutPercent?: number;
  specialPayoutSettings?: Partial<Record<Currency, RateSetting>>;
  incomeUsdPayoutSetting?: RateSetting;
  orderFixedRates?: Partial<Record<Currency, { enabled?: boolean; rate?: number | string }>>;
  orderVisibilityPermissions?: Partial<Record<"sourceCurrency" | "rate" | "commission" | "baseAmount", boolean>>;
}

export interface RateSetting {
  enabled?: boolean;
  divider?: number;
  percent?: number;
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
  brokerOrderNumber?: string;
  brokerActorId?: string;
  agentOrderNumber?: string;
  agentOrderActor?: string;
  agentOrderNumbers?: Record<string, string>;
  broker: string;
  agent: string;
  agentActorId?: string;
  sourceCurrency: Currency;
  payoutCurrency: Currency;
  sourceAmountMinor: number;
  payoutAmountMinor: number;
  commissionMinor: number;
  grossMinor: number;
  moneyUnitVersion?: 2;
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
  returnedAt?: string;
  updatedAt: string;
  locked?: boolean;
  voidJournal?: string;
  voidRequested?: boolean;
  voidRequestedBy?: string;
  voidRequestedAt?: string;
  voidRejectedBy?: string;
  voidRejectedAt?: string;
  voidedBy?: string;
  voidedAt?: string;
  assignedAt?: string;
  cancelledAt?: string;
  lastReminderAt?: string;
  lastReminderBy?: string;
  forwardedPayoutDivider?: number;
  forwardedPayoutPercent?: number;
  manualSpecialPayoutDivider?: number;
  manualSpecialPayoutPercent?: number;
  manualMasterRateDivider?: number;
  manualMasterRatePercent?: number;
  paymentProof?: { dataUri: string; fileName: string; attachedAt: string };
  incomeBaseCurrency?: Currency;
  incomeBaseAmountMinor?: number;
  incomeCollectedCurrency?: Currency;
  incomeCollectedOriginalMinor?: number;
  incomeCollectedEurMinor?: number;
  incomeCollectedUsdMinor?: number;
  incomeProfitMinor?: number;
  incomeSnapshotAt?: string;
  incomeMasterRateSnapshot?: RateSetting & { payoutCurrency?: Currency };
  incomeUsdAgentRateSnapshot?: RateSetting & { actorId?: string; actorName?: string };
}

export interface ReceivableRecord {
  id: string;
  orderId: string;
  brokerOrderNumber?: string;
  agentOrderNumber?: string;
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
  payments: Array<{ id?: string; amountMinor: number; paidAt: string; receivedBy: string }>;
  voided?: boolean;
  voidedAt?: string;
  voidedBy?: string;
  archivedAt?: string;
  archiveId?: string;
}

export interface SavedCustomerRecord {
  id: string;
  actorId: string;
  kind: "sender" | "receiver";
  name: string;
  accountNumber: string;
  phoneNumber: string;
  remarks: string;
  updatedAt: string;
}

export interface LedgerLine {
  journal?: string;
  entryId?: string;
  transferId?: string;
  orderId?: string;
  source?: string;
  account: string;
  direction: "Debit" | "Credit";
  currency: Currency;
  amountMinor: number;
  postedAt?: string;
  details?: string;
  [key: string]: unknown;
}

export type TransferState = "Pending Approval" | "Approved" | "Returned" | "Rejected" | "Reversed";

export interface InternalTransferRecord {
  id: string;
  from: string;
  fromActorId?: string;
  to: string;
  toActorId?: string;
  sourceCurrency: Currency;
  sourceAmountMinor: number;
  currency: Currency;
  amountMinor: number;
  rate: number | string;
  commissionPercent?: number;
  commissionMinor?: number;
  remarks: string;
  details?: string;
  state: TransferState;
  journal?: string;
  initiatedBy?: string;
  createdAt: string;
  sentAt: string;
  approvedAt?: string;
  paidOutAt?: string;
  returnedAt?: string;
  returnedBy?: string;
  returnedReason?: string;
  rejectedAt?: string;
  reversalJournal?: string;
  reversedAt?: string;
  reversedBy?: string;
  archivedAt?: string;
  archivedActorIds?: string[];
  archivedActorNames?: string[];
}

export interface MasterBankEntryRecord {
  id: string;
  type: string;
  reference: string;
  direction: "Credit" | "Debit";
  currency: Currency;
  amountMinor: number;
  details: string;
  postedAt: string;
  postedBy?: string;
}

export interface ChatMessageRecord {
  id: string;
  from: string;
  text: string;
  kind?: "text" | "photo" | "voice";
  media?: string;
  fileName?: string;
  forwardedFrom?: string;
  replyTo?: string;
  reactions?: Record<string, string>;
  readBy?: string[];
  createdAt: string;
}

export interface ChatConversationRecord {
  id: string;
  type: "direct" | "group";
  name: string;
  members: string[];
  messages: ChatMessageRecord[];
  createdAt: string;
}

export interface SettlementRecord {
  actor: string;
  currency: Currency;
  netMinor: number;
}

export interface ArchiveRecord {
  id?: string;
  actor?: string;
  actorId?: string;
  actorRole?: ActorRole;
  closedAt?: string;
  incomeProfitMinor?: number;
  incomeProfitCurrency?: Currency;
  balances?: Partial<Record<Currency, number>>;
  orders?: OrderRecord[];
  receivables?: ReceivableRecord[];
  transfers?: Array<{
    id?: string;
    from?: string;
    to?: string;
    sourceCurrency?: Currency;
    sourceAmountMinor?: number;
    currency?: Currency;
    amountMinor?: number;
    rate?: string | number;
    remarks?: string;
    state?: string;
    createdAt?: string;
    sentAt?: string;
    approvedAt?: string;
    paidOutAt?: string;
    journal?: string;
    initiatedBy?: string;
    commissionPercent?: number;
    commissionMinor?: number;
    reversalJournal?: string;
    reversedAt?: string;
    reversedBy?: string;
    details?: string;
  }>;
  ledger?: Array<LedgerLine & {
    journal?: string;
    entryId?: string;
    transferId?: string;
    orderId?: string;
    source?: string;
    postedAt?: string;
    details?: string;
  }>;
  [key: string]: unknown;
}

export interface WorkspaceState {
  actors: ActorRecord[];
  orders: OrderRecord[];
  receivables: ReceivableRecord[];
  savedCustomers: SavedCustomerRecord[];
  transfers: InternalTransferRecord[];
  ledger: LedgerLine[];
  masterBankEntries?: MasterBankEntryRecord[];
  archives: ArchiveRecord[];
  settlements: SettlementRecord[];
  chatConversations: ChatConversationRecord[];
  deletedActorIds?: string[];
  deletedChatIds?: string[];
  masterRateDivisorSettings?: Partial<Record<Currency, RateSetting>>;
  buyingRates?: { eurToUsd?: number; usdToEtb?: number; usdToErn?: number };
  orderCounter?: number;
  receivableCounter?: number;
  customerCounter?: number;
  transferCounter?: number;
  journalCounter?: number;
  actorCounter?: number;
  chatCounter?: number;
  messageCounter?: number;
  offlineSnapshot?: boolean;
  lastSyncedAt?: string;
  [key: string]: unknown;
}

export interface InternalTransferDraft {
  toActorId: string;
  sourceCurrency: Currency;
  payoutCurrency: Currency;
  sourceAmount: string;
  payoutAmount: string;
  rate: string;
  commissionPercent: string;
  remarks: string;
}

export interface InviteRecord {
  id?: string;
  code?: string;
  actorRole: ActorRole;
  currency: Currency;
  workingCurrencies?: Currency[];
  actorId?: string;
  actorName?: string;
  acceptedAt?: string;
}

export interface OwnerPlan {
  id: string;
  label: string;
}

export interface OwnerMasterRecord {
  userId: string;
  name: string;
  email: string;
  workspace: string;
  plan: string;
  active: boolean;
  expiresAt: string;
  expired: boolean;
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
  orderNumber: string;
  status: "Pending Master Approval";
  createdAt: string;
  state: WorkspaceState;
}
