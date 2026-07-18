import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  ActorRecord,
  ApiSession,
  Currency,
  FundingType,
  InviteRecord,
  OwnerMasterRecord,
  OwnerPlan,
  OrderRecord,
  ReceivableRecord,
  SavedCustomerRecord,
  SubmittedOrder,
  TransferDraft,
  UserSession,
  WorkspaceState
} from "../types";
import { calculateQuote, compactAmount, minorFromMajor } from "../utils/money";

declare const process: { env?: Record<string, string | undefined> } | undefined;

const defaultApiBaseUrl = "https://haderapay.com";
const apiBaseUrl = (typeof process !== "undefined" && process?.env?.EXPO_PUBLIC_HADERAPAY_API_URL
  ? process.env.EXPO_PUBLIC_HADERAPAY_API_URL
  : defaultApiBaseUrl).replace(/\/+$/, "");
const sessionCacheKey = "haderapay.mobile.session.v1";
const sessionActivityCacheKey = "haderapay.mobile.activity.v1";
const workspaceCachePrefix = "haderapay.mobile.workspace.v1.";
let activeSession: UserSession | null = null;

export const allowedIdleTimeoutSeconds = [10, 20, 30, 60, 300, 900, 1800, 3600, 7200] as const;

function normalizeIdleTimeoutSeconds(value: unknown): number {
  const seconds = Number(value);
  return allowedIdleTimeoutSeconds.includes(seconds as typeof allowedIdleTimeoutSeconds[number]) ? seconds : 7200;
}

class OfflineError extends Error {}

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
    throw new OfflineError("Could not reach HaderaPay. Check the app server address and internet connection.");
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) as ApiEnvelope<T> : {} as ApiEnvelope<T>;
  if (!response.ok) {
    throw new Error(data.error || "HaderaPay could not complete this request.");
  }
  return data;
}

async function readCache<T>(key: string): Promise<T | null> {
  try {
    const value = await AsyncStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full device or restricted storage must not interrupt live app use.
  }
}

async function cacheSession(session: UserSession): Promise<void> {
  activeSession = session;
  await writeCache(sessionCacheKey, session);
}

export async function getLastSessionActivityAt(): Promise<number> {
  const value = await readCache<number>(sessionActivityCacheKey);
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export async function rememberSessionActivity(at = Date.now()): Promise<void> {
  await writeCache(sessionActivityCacheKey, at);
}

function workspaceCacheKey(workspaceId: string): string {
  return `${workspaceCachePrefix}${workspaceId}`;
}

function cacheableWorkspaceState(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    orders: state.orders.map((order) => order.paymentProof ? {
      ...order,
      paymentProof: { ...order.paymentProof, dataUri: "" }
    } : order)
  };
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
    workspace: session.workspace.name || "HaderaPay Workspace",
    idleTimeoutSeconds: normalizeIdleTimeoutSeconds(session.user.idleTimeoutSeconds),
    managedByMaster: false
  };
}

function normalizeState(state: Partial<WorkspaceState> | null | undefined): WorkspaceState {
  return {
    ...(state || {}),
    actors: Array.isArray(state?.actors) ? state.actors : [],
    orders: Array.isArray(state?.orders) ? state.orders : [],
    receivables: Array.isArray(state?.receivables) ? state.receivables : [],
    savedCustomers: Array.isArray(state?.savedCustomers) ? state.savedCustomers : [],
    transfers: Array.isArray(state?.transfers) ? state.transfers : [],
    ledger: Array.isArray(state?.ledger) ? state.ledger : [],
    masterBankEntries: Array.isArray(state?.masterBankEntries) ? state.masterBankEntries : [],
    archives: Array.isArray(state?.archives) ? state.archives : [],
    settlements: Array.isArray(state?.settlements) ? state.settlements : [],
    chatConversations: Array.isArray(state?.chatConversations) ? state.chatConversations : []
  };
}

export function canCreateOrders(session: UserSession | null | undefined): boolean {
  return Boolean(
    session &&
    ["Broker", "Special Broker"].includes(session.actorRole) &&
    (session.role === "Actor" || session.managedByMaster === true)
  );
}

export async function getCurrentSession(): Promise<UserSession | null> {
  try {
    const result = await api<{ session: ApiSession | null }>("/api/session");
    const session = normalizeSession(result.session);
    if (session) {
      await cacheSession(session);
      await rememberSessionActivity();
    }
    else {
      activeSession = null;
      await AsyncStorage.multiRemove([sessionCacheKey, sessionActivityCacheKey]);
    }
    return session;
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
    const cached = await readCache<UserSession>(sessionCacheKey);
    const normalizedCached = cached ? { ...cached, idleTimeoutSeconds: normalizeIdleTimeoutSeconds(cached.idleTimeoutSeconds) } : null;
    activeSession = normalizedCached;
    return normalizedCached;
  }
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
  await cacheSession(session);
  await rememberSessionActivity();
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
  await cacheSession(session);
  await rememberSessionActivity();
  return session;
}

export async function logout(): Promise<void> {
  activeSession = null;
  await AsyncStorage.multiRemove([sessionCacheKey, sessionActivityCacheKey]);
  try {
    await api<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
  } finally {
    activeSession = null;
  }
}

export async function updateIdleTimeout(idleTimeoutSeconds: number): Promise<UserSession> {
  const result = await api<{ session: ApiSession }>("/api/auth/timeout", {
    method: "PUT",
    body: { idleTimeoutSeconds }
  });
  const session = normalizeSession(result.session);
  if (!session) throw new Error("The updated account session could not be loaded.");
  await cacheSession(session);
  await rememberSessionActivity();
  return session;
}

export async function reportSessionActivity(): Promise<void> {
  await api<{ ok: boolean }>("/api/auth/activity", { method: "POST" });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  if (!currentPassword || newPassword.length < 6) throw new Error("Enter the current password and a new password of at least 6 characters.");
  await api<{ ok: boolean }>("/api/auth/password", {
    method: "POST",
    body: { currentPassword, newPassword }
  });
}

export async function loadWorkspaceState(): Promise<WorkspaceState> {
  try {
    const result = await api<{ state: WorkspaceState }>("/api/app-state");
    const state = { ...normalizeState(result.state), offlineSnapshot: false, lastSyncedAt: new Date().toISOString() };
    if (activeSession?.workspaceId) await writeCache(workspaceCacheKey(activeSession.workspaceId), cacheableWorkspaceState(state));
    return state;
  } catch (error) {
    if (!(error instanceof OfflineError) || !activeSession?.workspaceId) throw error;
    const cached = await readCache<WorkspaceState>(workspaceCacheKey(activeSession.workspaceId));
    if (!cached) throw new Error("Connect once to download this account before using it offline.");
    return { ...normalizeState(cached), offlineSnapshot: true, lastSyncedAt: cached.lastSyncedAt };
  }
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  if (state.offlineSnapshot) throw new Error("Reconnect to the internet before making financial changes.");
  await api<{ ok: boolean }>("/api/app-state", {
    method: "PUT",
    body: { state: { ...state, offlineSnapshot: undefined, lastSyncedAt: undefined } }
  });
  if (activeSession?.workspaceId) {
    await writeCache(workspaceCacheKey(activeSession.workspaceId), cacheableWorkspaceState({
      ...state,
      offlineSnapshot: false,
      lastSyncedAt: new Date().toISOString()
    }));
  }
}

export async function updateWorkspaceState(mutator: (state: WorkspaceState) => void): Promise<WorkspaceState> {
  const state = await loadWorkspaceState();
  mutator(state);
  await saveWorkspaceState(state);
  return state;
}

export async function removeWorkspaceActor(actorId: string, actorName: string): Promise<WorkspaceState> {
  const result = await api<{ state: WorkspaceState }>("/api/app-state/remove-actor", {
    method: "POST",
    body: { actorId, actorName }
  });
  return normalizeState(result.state);
}

export async function resetWorkspaceData(scope: "data" | "wipe"): Promise<WorkspaceState> {
  const result = await api<{ state: WorkspaceState }>("/api/app-state/reset", {
    method: "POST",
    body: { scope }
  });
  return normalizeState(result.state);
}

export async function loadInvites(): Promise<InviteRecord[]> {
  const result = await api<{ invites: InviteRecord[] }>("/api/invites");
  return Array.isArray(result.invites) ? result.invites : [];
}

export async function createInvite(input: { actorRole: ActorRecord["role"]; currency: Currency; workingCurrencies: Currency[] }): Promise<InviteRecord> {
  const result = await api<{ invite: InviteRecord }>("/api/invites", {
    method: "POST",
    body: input
  });
  return result.invite;
}

export async function loadOwnerMasters(): Promise<{ users: OwnerMasterRecord[]; plans: OwnerPlan[] }> {
  const result = await api<{ users: OwnerMasterRecord[]; plans: OwnerPlan[] }>("/api/owner/masters");
  return { users: Array.isArray(result.users) ? result.users : [], plans: Array.isArray(result.plans) ? result.plans : [] };
}

export async function createOwnerMaster(input: { name: string; email: string; password: string; currency: Currency; plan: string }): Promise<void> {
  await api<{ ok: boolean }>("/api/owner/masters", { method: "POST", body: input });
}

export async function setOwnerMasterActive(userId: string, active: boolean): Promise<void> {
  await api<{ ok: boolean }>("/api/owner/masters/active", { method: "POST", body: { userId, active } });
}

export async function extendOwnerSubscription(userId: string, plan: string, mode: "extend" | "reset"): Promise<void> {
  await api<{ ok: boolean }>("/api/owner/subscriptions/extend", { method: "POST", body: { userId, plan, mode } });
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

function actorOrderPrefix(name: string): string {
  const clean = String(name || "ACT").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${clean}XXX`.slice(0, 3);
}

function nextBrokerOrderNumber(session: UserSession, state: WorkspaceState): string {
  const prefix = actorOrderPrefix(session.actorName);
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const latestClose = state.archives
    .filter((archive) => archive.actor === session.actorName)
    .reduce((latest, archive) => Math.max(latest, new Date(archive.closedAt || 0).getTime() || 0), 0);
  const records = [
    ...state.orders.map((order) => ({ order, current: true, closedAt: "" })),
    ...state.archives.flatMap((archive) => (archive.orders || []).map((order) => ({ order, current: false, closedAt: archive.closedAt || "" })))
  ];
  const usedNumbers = new Set(records.reduce<number[]>((used, record) => {
    const actorMatches = record.order.brokerActorId === session.actorId || (!record.order.brokerActorId && record.order.broker === session.actorName);
    const recordClosedAt = new Date(record.closedAt || 0).getTime();
    const reserve = record.current || record.order.state === "Voided" || Boolean(record.order.voidJournal) || !latestClose || recordClosedAt > latestClose;
    const match = String(record.order.brokerOrderNumber || record.order.id || "").match(pattern);
    if (actorMatches && reserve && match) used.push(Number(match[1]));
    return used;
  }, []));
  let next = 1;
  while (usedNumbers.has(next)) next += 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
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

function buildReceivable(session: UserSession, draft: TransferDraft, order: OrderRecord, state: WorkspaceState, existing?: ReceivableRecord): ReceivableRecord {
  const now = new Date().toISOString();
  return {
    id: existing?.id || nextReceivableId(state),
    orderId: order.id,
    brokerOrderNumber: order.brokerOrderNumber || order.id,
    agentOrderNumber: order.agentOrderNumber || existing?.agentOrderNumber || "",
    borrower: session.actorName,
    borrowerActorId: session.actorId,
    currency: order.sourceCurrency,
    principalMinor: order.sourceAmountMinor,
    senderName: draft.senderName,
    receiverName: draft.receiverName,
    receiverCity: draft.receiverCity,
    accountNumber: draft.accountNumber,
    phoneNumber: draft.phoneNumber,
    remarks: draft.remarks,
    creditReminder: draft.creditReminder.trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || session.actorName,
    payments: existing?.payments || []
  };
}

function nextSavedCustomerId(state: WorkspaceState): string {
  const highestStoredId = state.savedCustomers.reduce((highest, customer) => {
    const match = String(customer.id || "").match(/^CUST-(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  state.customerCounter = Math.max(Number(state.customerCounter || 0), highestStoredId) + 1;
  return `CUST-${state.customerCounter}`;
}

function upsertSavedCustomer(state: WorkspaceState, actor: ActorRecord | undefined, details: Omit<SavedCustomerRecord, "id" | "actorId" | "updatedAt">): void {
  if (!actor || (!details.name && !details.accountNumber && !details.phoneNumber && !details.remarks)) return;
  const normalizedName = details.name.toLocaleLowerCase();
  const existing = state.savedCustomers.find((customer) =>
    customer.actorId === actor.id &&
    customer.kind === details.kind &&
    customer.name.toLocaleLowerCase() === normalizedName
  );
  const next: SavedCustomerRecord = {
    ...(existing || {}),
    id: existing?.id || nextSavedCustomerId(state),
    actorId: actor.id,
    kind: details.kind,
    name: details.name,
    receiverCity: details.receiverCity,
    accountNumber: details.accountNumber,
    phoneNumber: details.phoneNumber,
    remarks: details.remarks,
    updatedAt: new Date().toISOString()
  };
  if (existing) Object.assign(existing, next);
  else state.savedCustomers.unshift(next);
}

function rememberOrderCustomers(state: WorkspaceState, actor: ActorRecord | undefined, draft: TransferDraft): void {
  upsertSavedCustomer(state, actor, {
    kind: "sender",
    name: draft.senderName.trim(),
    receiverCity: "",
    accountNumber: "",
    phoneNumber: "",
    remarks: ""
  });
  upsertSavedCustomer(state, actor, {
    kind: "receiver",
    name: draft.receiverName.trim(),
    receiverCity: draft.receiverCity.trim(),
    accountNumber: draft.accountNumber.trim(),
    phoneNumber: draft.phoneNumber.trim(),
    remarks: draft.remarks.trim()
  });
}

export async function submitTransferOrder(session: UserSession, draft: TransferDraft, editingOrderId = ""): Promise<SubmittedOrder> {
  if (!canCreateOrders(session)) {
    throw new Error("Only Brokers and Special Brokers can send new orders.");
  }
  if (!draft.receiverName.trim() && !draft.receiverCity.trim() && !draft.phoneNumber.trim() && !draft.accountNumber.trim() && !draft.remarks.trim()) {
    throw new Error("Enter at least one receiver detail.");
  }
  if (!draft.fundingType) {
    throw new Error("Choose Cash or Credit before sending.");
  }

  const state = await loadWorkspaceState();
  const actor = sessionActor(session, state);
  const existingOrder = editingOrderId ? state.orders.find((order) => order.id === editingOrderId) : undefined;
  if (editingOrderId && (!existingOrder || existingOrder.state !== "Returned" || existingOrder.broker !== session.actorName)) {
    throw new Error("This returned order is no longer available for modification.");
  }
  const sourceCurrency = actor?.orderMultiCurrencyEnabled === true ? draft.sourceCurrency : safeCurrency(actor?.currency, session.currency);
  const quote = calculateQuote({ ...draft, broker: session.actorName, sourceCurrency });
  if (quote.sourceAmount <= 0 || quote.payoutAmount <= 0 || quote.rate <= 0) {
    throw new Error("Enter source amount, payout amount, and rate greater than zero.");
  }

  const now = new Date().toISOString();
  const order: OrderRecord = {
    ...(existingOrder || {}),
    id: existingOrder?.id || nextOrderId(state),
    brokerOrderNumber: existingOrder?.brokerOrderNumber || nextBrokerOrderNumber(session, state),
    brokerActorId: actor?.id || session.actorId,
    broker: session.actorName,
    agent: "Unassigned",
    agentActorId: "",
    sourceCurrency,
    payoutCurrency: draft.payoutCurrency,
    sourceAmountMinor: minorFromMajor(quote.sourceAmount, sourceCurrency),
    payoutAmountMinor: minorFromMajor(quote.payoutAmount, draft.payoutCurrency),
    commissionMinor: minorFromMajor(quote.commissionAmount, sourceCurrency),
    grossMinor: minorFromMajor(quote.grossAmount, sourceCurrency),
    moneyUnitVersion: 2,
    rate: quote.rate,
    commissionPercent: Number(draft.commissionPercent || 0) || 0,
    senderName: draft.senderName.trim(),
    receiverName: draft.receiverName.trim(),
    receiverCity: draft.receiverCity.trim(),
    accountNumber: draft.accountNumber.trim(),
    phoneNumber: draft.phoneNumber.trim(),
    remarks: draft.remarks.trim(),
    amount: compactAmount(sourceCurrency, quote.sourceAmount),
    fundingType: draft.fundingType as FundingType,
    state: "Pending Forward",
    journal: "",
    assignedAt: undefined,
    forwardedPayoutDivider: undefined,
    forwardedPayoutPercent: undefined,
    manualSpecialPayoutDivider: undefined,
    manualSpecialPayoutPercent: undefined,
    manualMasterRateDivider: undefined,
    manualMasterRatePercent: undefined,
    paymentProof: undefined,
    createdAt: existingOrder?.createdAt || now,
    sentAt: existingOrder?.sentAt || now,
    paidAt: existingOrder?.paidAt || "",
    returnedBy: "",
    returnedReason: "",
    returnedAt: "",
    updatedAt: now
  };

  state.orders = [order, ...state.orders.filter((item) => item.id !== order.id)];
  rememberOrderCustomers(state, actor, draft);
  const existingReceivableIndex = state.receivables.findIndex((item) => item.orderId === order.id);
  const existingReceivable = existingReceivableIndex >= 0 ? state.receivables[existingReceivableIndex] : undefined;
  if (draft.fundingType === "credit") {
    const receivable = buildReceivable(session, draft, order, state, existingReceivable);
    if (existingReceivableIndex >= 0) state.receivables.splice(existingReceivableIndex, 1, receivable);
    else state.receivables.unshift(receivable);
  } else if (existingReceivable && existingReceivable.payments.reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0) === 0) {
    state.receivables.splice(existingReceivableIndex, 1);
  }

  await saveWorkspaceState(state);
  return {
    orderId: order.id,
    orderNumber: order.brokerOrderNumber || order.id,
    status: "Pending Master Approval",
    createdAt: now,
    state
  };
}
