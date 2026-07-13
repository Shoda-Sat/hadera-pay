import type {
  ActorRecord,
  ApiSession,
  Currency,
  FundingType,
  OrderRecord,
  ReceivableRecord,
  SubmittedOrder,
  TransferDraft,
  UserSession,
  WorkspaceState
} from "../types";
import { calculateQuote, compactAmount } from "../utils/money";

declare const process: { env?: Record<string, string | undefined> } | undefined;

const defaultApiBaseUrl = "https://haderapay.com";
const apiBaseUrl = (typeof process !== "undefined" && process?.env?.EXPO_PUBLIC_HADERAPAY_API_URL
  ? process.env.EXPO_PUBLIC_HADERAPAY_API_URL
  : defaultApiBaseUrl).replace(/\/+$/, "");

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

type ApiEnvelope<T> = T & {
  error?: string;
};

function safeCurrency(value: unknown, fallback: Currency = "USD"): Currency {
  return ["USD", "ETB", "EUR", "ERN"].includes(String(value)) ? value as Currency : fallback;
}

async function api<T>(path: string, options: ApiOptions = {}): Promise<ApiEnvelope<T>> {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      credentials: "include",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch {
    throw new Error("Could not reach HaderaPay. Check the app server address and internet connection.");
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) as ApiEnvelope<T> : {} as ApiEnvelope<T>;
  if (!response.ok) {
    throw new Error(data.error || "HaderaPay could not complete this request.");
  }
  return data;
}

function normalizeSession(session: ApiSession | null | undefined): UserSession | null {
  if (!session?.user || !session.workspace || !session.membership) return null;
  const actorRole = session.membership.actorRole || (session.membership.role === "Master" ? "Master" : "Agent");
  return {
    userId: session.user.id || "",
    name: session.user.name || session.membership.actorName || "",
    email: session.user.email || "",
    role: session.membership.role || "Actor",
    actorId: session.membership.actorId || "",
    actorName: session.membership.actorName || session.user.name || "",
    actorRole,
    currency: safeCurrency(session.membership.currency),
    workingCurrencies: (session.membership.workingCurrencies || []).map((currency) => safeCurrency(currency)),
    workspaceId: session.workspace.id || "",
    workspace: session.workspace.name || "HaderaPay Workspace"
  };
}

function normalizeState(state: Partial<WorkspaceState> | null | undefined): WorkspaceState {
  return {
    ...(state || {}),
    actors: Array.isArray(state?.actors) ? state.actors : [],
    orders: Array.isArray(state?.orders) ? state.orders : [],
    receivables: Array.isArray(state?.receivables) ? state.receivables : []
  };
}

export function canCreateOrders(session: UserSession | null | undefined): boolean {
  return session?.role === "Actor" && ["Broker", "Special Broker"].includes(session.actorRole);
}

export async function getCurrentSession(): Promise<UserSession | null> {
  const result = await api<{ session: ApiSession | null }>("/api/session");
  return normalizeSession(result.session);
}

export async function login(email: string, password: string): Promise<UserSession> {
  if (!email.trim() || !password.trim()) {
    throw new Error("Enter username/email and password.");
  }
  const result = await api<{ session: ApiSession }>("/api/auth/login", {
    method: "POST",
    body: { email, password }
  });
  const session = normalizeSession(result.session);
  if (!session) throw new Error("This login is not linked to a workspace.");
  return session;
}

export async function signup(input: {
  name: string;
  email: string;
  password: string;
  inviteCode: string;
}): Promise<UserSession> {
  if (!input.name.trim() || !input.email.trim() || input.password.length < 6 || !input.inviteCode.trim()) {
    throw new Error("Complete signup details and use a password with at least 6 characters.");
  }
  const result = await api<{ session: ApiSession }>("/api/auth/signup", {
    method: "POST",
    body: {
      name: input.name,
      email: input.email,
      password: input.password,
      inviteCode: input.inviteCode,
      role: "Actor"
    }
  });
  const session = normalizeSession(result.session);
  if (!session) throw new Error("This signup was not linked to a workspace.");
  return session;
}

export async function logout(): Promise<void> {
  await api<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export async function loadWorkspaceState(): Promise<WorkspaceState> {
  const result = await api<{ state: WorkspaceState }>("/api/app-state");
  return normalizeState(result.state);
}

async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  await api<{ ok: boolean }>("/api/app-state", {
    method: "PUT",
    body: { state }
  });
}

function minorFromMajor(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100);
}

function nextOrderNumberFromOrders(orders: OrderRecord[]): number {
  return orders.reduce((next, order) => {
    const match = String(order?.id || "").match(/^ORD-(\d+)$/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function nextReceivableNumberFromReceivables(receivables: ReceivableRecord[]): number {
  return receivables.reduce((next, receivable) => {
    const match = String(receivable?.id || "").match(/^REC-(\d+)$/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function nextOrderId(state: WorkspaceState): string {
  const nextNumber = Math.max(Number(state.orderCounter || 0) + 1, nextOrderNumberFromOrders(state.orders));
  state.orderCounter = nextNumber;
  return `ORD-${nextNumber}`;
}

function nextReceivableId(state: WorkspaceState): string {
  const nextNumber = Math.max(Number(state.receivableCounter || 0) + 1, nextReceivableNumberFromReceivables(state.receivables));
  state.receivableCounter = nextNumber;
  return `REC-${nextNumber}`;
}

function sessionActor(session: UserSession, state: WorkspaceState): ActorRecord | undefined {
  return state.actors.find((actor) => actor.id === session.actorId) ||
    state.actors.find((actor) => actor.name === session.actorName);
}

function buildReceivable(session: UserSession, draft: TransferDraft, order: OrderRecord, state: WorkspaceState): ReceivableRecord {
  const now = new Date().toISOString();
  return {
    id: nextReceivableId(state),
    orderId: order.id,
    borrower: session.actorName,
    borrowerActorId: session.actorId,
    currency: order.sourceCurrency,
    principalMinor: order.sourceAmountMinor,
    senderName: draft.senderName,
    receiverName: draft.receiverName,
    accountNumber: draft.accountNumber,
    phoneNumber: draft.phoneNumber,
    remarks: draft.remarks,
    createdAt: now,
    updatedAt: now,
    createdBy: session.actorName,
    payments: []
  };
}

export async function submitTransferOrder(session: UserSession, draft: TransferDraft): Promise<SubmittedOrder> {
  if (!canCreateOrders(session)) {
    throw new Error("Only Brokers and Special Brokers can send new orders.");
  }
  if (!draft.senderName.trim() || !draft.receiverName.trim()) {
    throw new Error("Sender and receiver names are required.");
  }
  if (!draft.fundingType) {
    throw new Error("Choose Cash or Credit before sending.");
  }

  const state = await loadWorkspaceState();
  const actor = sessionActor(session, state);
  const sourceCurrency = actor?.orderMultiCurrencyEnabled === true ? draft.sourceCurrency : safeCurrency(actor?.currency, session.currency);
  const quote = calculateQuote({ ...draft, broker: session.actorName, sourceCurrency });
  if (quote.sourceAmount <= 0 || quote.payoutAmount <= 0 || quote.rate <= 0) {
    throw new Error("Enter source amount, payout amount, and rate greater than zero.");
  }

  const now = new Date().toISOString();
  const order: OrderRecord = {
    id: nextOrderId(state),
    broker: session.actorName,
    agent: "Unassigned",
    agentActorId: "",
    sourceCurrency,
    payoutCurrency: draft.payoutCurrency,
    sourceAmountMinor: minorFromMajor(quote.sourceAmount),
    payoutAmountMinor: minorFromMajor(quote.payoutAmount),
    commissionMinor: minorFromMajor(quote.commissionAmount),
    grossMinor: minorFromMajor(quote.grossAmount),
    rate: quote.rate,
    commissionPercent: Number(draft.commissionPercent || 0) || 0,
    senderName: draft.senderName.trim(),
    receiverName: draft.receiverName.trim(),
    accountNumber: draft.accountNumber.trim(),
    phoneNumber: draft.phoneNumber.trim(),
    remarks: draft.remarks.trim(),
    amount: compactAmount(sourceCurrency, quote.sourceAmount),
    fundingType: draft.fundingType as FundingType,
    state: "Pending Forward",
    journal: "",
    createdAt: now,
    sentAt: now,
    paidAt: "",
    returnedBy: "",
    returnedReason: "",
    updatedAt: now
  };

  state.orders = [order, ...state.orders.filter((item) => item.id !== order.id)];
  if (draft.fundingType === "credit") {
    state.receivables = [buildReceivable(session, draft, order, state), ...state.receivables];
  }

  await saveWorkspaceState(state);
  return {
    orderId: order.id,
    status: "Pending Master Approval",
    createdAt: now,
    state
  };
}
