import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import type {
  AccountDeviceWarning,
  ActorRecord,
  ApiSession,
  ArchiveRecord,
  ChatConversationRecord,
  ChatMessageRecord,
  Currency,
  FundingType,
  InviteRecord,
  LedgerLine,
  OwnerMasterRecord,
  OwnerPlan,
  OrderRecord,
  PreparedPaymentProof,
  ReceivableRecord,
  SavedCustomerRecord,
  SubmittedOrder,
  TransferDraft,
  UserSession,
  WorkspaceState
} from "../types";
import { ensureActorLedgerNumbers, nextActorLedgerSequence } from "../domain/ledgerNumbering";
import {
  brokerRoutingOrderMatches,
  clearMobileRoutingAction,
  mobileBrokerRoutingAttemptId,
  persistMobileRoutingAction,
  readMobileRoutingAction,
  routingOrderContentMatches,
  routingOrderIdentityMatches,
  type MobileBrokerRoutingAction,
  type MobileRoutingSession
} from "../domain/routingDurability";
import { calculateQuote, compactAmount, fixedOrderCommissionForActor, fixedOrderRateForActor, minorFromMajor, parseDecimalNumber } from "../utils/money";
import { retainOrdersForUnclosedParticipants } from "../utils/orderParticipantRetention";

declare const process: { env?: Record<string, string | undefined> } | undefined;

const defaultApiBaseUrl = "https://haderapay.com";
const apiBaseUrl = (typeof process !== "undefined" && process?.env?.EXPO_PUBLIC_HADERAPAY_API_URL
  ? process.env.EXPO_PUBLIC_HADERAPAY_API_URL
  : defaultApiBaseUrl).replace(/\/+$/, "");
const sessionCacheKey = "haderapay.mobile.session.v1";
const sessionActivityCacheKey = "haderapay.mobile.activity.v1";
const deviceIdCacheKey = "haderapay.mobile.device.v1";
const workspaceCachePrefix = "haderapay.mobile.workspace.v1.";
const subscriptionReadOnlyGraceMs = 30 * 24 * 60 * 60 * 1000;
let activeSession: UserSession | null = null;
let activeDeviceId: string | null = null;
let activeWorkspaceRevision: string | null = null;
let activeWorkspaceSnapshotJson: string | null = null;
let activeWorkspaceSnapshotSessionKey = "";
let activeWorkspaceMutationGeneration = 0;
const activeWorkspaceSaveScopes = new Set<string>();
const processingBrokerRoutingScopes = new Set<string>();

export const allowedIdleTimeoutSeconds = [10, 20, 30, 60, 300, 900, 1800, 3600, 7200, 0] as const;

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

async function deviceId(): Promise<string> {
  if (activeDeviceId) return activeDeviceId;
  try {
    activeDeviceId = await AsyncStorage.getItem(deviceIdCacheKey);
  } catch {
    activeDeviceId = null;
  }
  if (!activeDeviceId) {
    activeDeviceId = `android-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    try {
      await AsyncStorage.setItem(deviceIdCacheKey, activeDeviceId);
    } catch {
      // An in-memory ID still distinguishes this running app instance.
    }
  }
  return activeDeviceId;
}

function safeCurrency(value: unknown, fallback: Currency = "USD"): Currency {
  return ["USD", "ETB", "EUR", "ERN", "SSP", "SDG", "LYD"].includes(String(value)) ? value as Currency : fallback;
}

async function api<T>(path: string, options: ApiOptions = {}): Promise<ApiEnvelope<T>> {
  const method = String(options.method || "GET").toUpperCase();
  const readOnlyWriteAllowed = ["/api/auth/activity", "/api/auth/logout", "/api/auth/login", "/api/auth/signup"].includes(path);
  if (activeSession?.subscriptionReadOnly === true && method !== "GET" && !readOnlyWriteAllowed) {
    throw new Error("This workspace is read-only after subscription expiry. Renew the subscription to make changes or export reports.");
  }
  const currentDeviceId = await deviceId();
  const headers = {
    Accept: "application/json",
    "X-HaderaPay-Device-Id": currentDeviceId,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      method,
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
    const error = new Error(data.error || "HaderaPay could not complete this request.") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data;
}

export interface StoredAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  purpose: "payment-proof" | "order-photo" | "chat-photo" | "chat-voice" | "chat-file";
  createdAt: string;
}

export async function uploadR2Attachment(input: {
  uri: string;
  purpose: StoredAttachment["purpose"];
  contextId: string;
  fileName: string;
  mimeType: string;
  size: number;
  onProgress?: (percent: number) => void;
}): Promise<StoredAttachment> {
  const mimeType = input.mimeType.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
  const pending = await api<{
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
    file: StoredAttachment;
  }>("/api/files/upload-url", {
    method: "POST",
    body: {
      purpose: input.purpose,
      contextId: input.contextId,
      fileName: input.fileName,
      mimeType,
      size: input.size
    }
  });
  input.onProgress?.(0);
  const uploadTask = FileSystem.createUploadTask(pending.uploadUrl, input.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: pending.uploadHeaders || { "Content-Type": mimeType }
  }, ({ totalBytesSent, totalBytesExpectedToSend }) => {
    if (totalBytesExpectedToSend <= 0) return;
    input.onProgress?.(Math.min(99, Math.round(totalBytesSent / totalBytesExpectedToSend * 100)));
  });
  const uploadResponse = await uploadTask.uploadAsync();
  if (!uploadResponse) throw new Error("The attachment upload was interrupted. Check your connection and try again.");
  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    throw new Error("R2 rejected the attachment upload. Check the bucket access settings.");
  }
  input.onProgress?.(100);
  const completed = await api<{ file: StoredAttachment }>(`/api/files/${encodeURIComponent(pending.file.id)}/complete`, { method: "POST" });
  return completed.file;
}

export async function getR2AttachmentDownload(attachmentId: string): Promise<{ downloadUrl: string; file: StoredAttachment }> {
  return api<{ downloadUrl: string; file: StoredAttachment }>(`/api/files/${encodeURIComponent(attachmentId)}/download-url`);
}

export async function getR2StorageStatus(): Promise<{ configured: boolean; storedFiles: number; pendingFiles: number; legacyAttachments: number }> {
  return api<{ configured: boolean; storedFiles: number; pendingFiles: number; legacyAttachments: number }>("/api/files/status");
}

export async function migrateR2Attachments(limit = 10): Promise<{ attempted: number; migrated: number; failed: number; remaining: number; state: WorkspaceState }> {
  const result = await api<{ attempted: number; migrated: number; failed: number; remaining: number; state: WorkspaceState; revision?: string }>("/api/files/migrate", {
    method: "POST",
    body: { limit }
  });
  const state = normalizeState(result.state);
  await rememberWorkspaceSnapshot(state, result.revision);
  return { ...result, state };
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

function workspaceSnapshotSessionKey(session: MobileRoutingSession | null | undefined): string {
  return session ? `${session.workspaceId}:${session.userId}` : "";
}

export function currentWorkspaceSession(): UserSession | null {
  return activeSession;
}

function assertUserSessionIsCurrent(session: UserSession): void {
  const current = currentWorkspaceSession();
  if (workspaceSnapshotSessionKey(current) !== workspaceSnapshotSessionKey(session) ||
      (session.loginStartedAt && current?.loginStartedAt !== session.loginStartedAt)) {
    throw new Error("The signed-in session changed before this order action finished.");
  }
}

function assertWorkspaceRequestSession(session: MobileRoutingSession | null, generation: number): void {
  if (!session || workspaceSnapshotSessionKey(activeSession) !== workspaceSnapshotSessionKey(session) ||
      generation !== activeWorkspaceMutationGeneration) {
    throw new Error("The signed-in workspace changed before this request finished.");
  }
}

function resetWorkspaceSnapshot(): void {
  activeWorkspaceMutationGeneration += 1;
  activeWorkspaceRevision = null;
  activeWorkspaceSnapshotJson = null;
  activeWorkspaceSnapshotSessionKey = "";
}

async function rememberWorkspaceSnapshot(
  state: WorkspaceState,
  revision?: string,
  submittedSession: MobileRoutingSession | null = activeSession,
  generation = activeWorkspaceMutationGeneration
): Promise<void> {
  assertWorkspaceRequestSession(submittedSession, generation);
  const cachedState = cacheableWorkspaceState(state);
  const serialized = JSON.stringify(cachedState);
  const activeSerialized = JSON.stringify(state);
  try {
    await AsyncStorage.setItem(workspaceCacheKey(submittedSession!.workspaceId), serialized);
  } catch {
    // The live in-memory snapshot still avoids unnecessary network reloads.
  }
  assertWorkspaceRequestSession(submittedSession, generation);
  activeWorkspaceRevision = typeof revision === "string"
    ? revision
    : typeof state._syncRevision === "string"
      ? state._syncRevision
      : null;
  activeWorkspaceSnapshotJson = activeSerialized;
  activeWorkspaceSnapshotSessionKey = workspaceSnapshotSessionKey(submittedSession);
}

async function cacheSession(session: UserSession): Promise<void> {
  if (workspaceSnapshotSessionKey(activeSession) !== workspaceSnapshotSessionKey(session)) {
    resetWorkspaceSnapshot();
  }
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
    archives: state.archives.map((archive) => {
      if (!archive._reportKey) return archive;
      const { orders, receivables, transfers, ledger, ...summary } = archive;
      return {
        ...summary,
        _reportDetailLoaded: false,
        orderCount: Number(archive.orderCount ?? orders?.length ?? 0),
        receivableCount: Number(archive.receivableCount ?? receivables?.length ?? 0),
        transferCount: Number(archive.transferCount ?? transfers?.length ?? 0),
        ledgerLineCount: Number(archive.ledgerLineCount ?? ledger?.length ?? 0)
      };
    }),
    chatConversations: state.chatConversations.map(lightweightChatConversationForCache),
    orders: state.orders.map((order) => order.paymentProof ? {
      ...order,
      paymentProof: { ...order.paymentProof, dataUri: "" }
    } : order)
  };
}

function lightweightChatConversationForCache(chat: ChatConversationRecord): ChatConversationRecord {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const lastMessage = messages[messages.length - 1] || chat.lastMessage || null;
  const { media, ...lightweightLastMessage } = (lastMessage || {}) as ChatMessageRecord;
  return {
    ...chat,
    messages: [],
    lastMessage: lastMessage ? lightweightLastMessage as ChatMessageRecord : null,
    messageCount: Math.max(Number(chat.messageCount || 0), messages.length),
    _messagesLoaded: false,
    _messagesLoading: false,
    _hasOlderMessages: Math.max(Number(chat.messageCount || 0), messages.length) > 0,
    _nextBefore: ""
  };
}

function normalizeSession(session: ApiSession | null | undefined): UserSession | null {
  if (!session?.user || !session.workspace || !session.membership) return null;
  const actorRole = session.membership.actorRole || (session.membership.role === "Master" ? "Master" : "Agent");
  return {
    loginStartedAt: session.loginStartedAt || "",
    userId: session.user.id || "",
    name: session.user.name || session.membership.actorName || "",
    email: session.user.email || "",
    role: session.membership.role || "Actor",
    actorId: session.membership.actorId || "",
    actorName: session.membership.actorName || session.user.name || "",
    actorRole,
    brokerCode: session.membership.brokerCode || "",
    currency: safeCurrency(session.membership.currency),
    workingCurrencies: (session.membership.workingCurrencies || []).map((currency) => safeCurrency(currency)),
    workspaceId: session.workspace.id || "",
    workspace: session.workspace.name || "HaderaPay Workspace",
    idleTimeoutSeconds: normalizeIdleTimeoutSeconds(session.user.idleTimeoutSeconds),
    managedByMaster: false,
    subscriptionExpiresAt: session.subscription?.expiresAt || "",
    subscriptionReadOnly: session.subscription?.readOnly === true,
    subscriptionGraceEndsAt: session.subscription?.graceEndsAt || "",
    subscriptionReadOnlyDaysRemaining: Number(session.subscription?.readOnlyDaysRemaining || 0),
    subscriptionAccessDenied: session.subscription?.accessDenied === true
  };
}

function sessionForCurrentSubscriptionWindow(session: UserSession | null, now = Date.now()): UserSession | null {
  if (!session || session.role === "Owner") return session;
  const expiresAtMs = new Date(session.subscriptionExpiresAt || 0).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return session;
  const graceEndsAtMs = new Date(session.subscriptionGraceEndsAt || 0).getTime();
  const effectiveGraceEndsAtMs = Number.isFinite(graceEndsAtMs) && graceEndsAtMs > expiresAtMs
    ? graceEndsAtMs
    : expiresAtMs + subscriptionReadOnlyGraceMs;
  if (now >= effectiveGraceEndsAtMs) return null;
  const readOnly = now >= expiresAtMs;
  return {
    ...session,
    subscriptionReadOnly: readOnly,
    subscriptionGraceEndsAt: new Date(effectiveGraceEndsAtMs).toISOString(),
    subscriptionReadOnlyDaysRemaining: readOnly
      ? Math.max(1, Math.ceil((effectiveGraceEndsAtMs - now) / (24 * 60 * 60 * 1000)))
      : 0,
    subscriptionAccessDenied: false
  };
}

type ArchiveCollection = "orders" | "receivables" | "transfers" | "ledger";

function archiveSnapshotItemKey(type: ArchiveCollection, item: unknown): string {
  const value = item as Record<string, unknown>;
  if (type === "orders") {
    return [value.id || value.brokerOrderNumber, value.createdAt || value.sentAt, value.broker, value.agent, value.sourceCurrency, value.sourceAmountMinor, value.payoutCurrency, value.payoutAmountMinor, value.journal].join(":");
  }
  if (type === "receivables") return [value.id || value.orderId, value.createdAt, value.orderId, value.borrower, value.currency, value.principalMinor].join(":");
  if (type === "transfers") return [value.id || value.journal, value.createdAt || value.sentAt, value.from, value.to, value.currency, value.amountMinor, value.journal].join(":");
  return [value.entryId, value.journal, value.source, value.account, value.direction, value.currency, value.amountMinor, value.postedAt].join(":");
}

function normalizeArchiveSnapshots(value: ArchiveRecord[] | undefined): ArchiveRecord[] {
  const archives = (Array.isArray(value) ? value : []).map((archive) => ({
    ...archive,
    orders: archive._reportDetailLoaded === false && Array.isArray(archive._orderRefs)
      ? archive._orderRefs as OrderRecord[]
      : Array.isArray(archive.orders) ? archive.orders : [],
    receivables: Array.isArray(archive.receivables) ? archive.receivables : [],
    transfers: Array.isArray(archive.transfers) ? archive.transfers : [],
    ledger: Array.isArray(archive.ledger) ? archive.ledger : []
  }));
  const seenByActor = new Map<string, Record<ArchiveCollection, Set<string>>>();
  archives
    .map((archive, index) => ({ archive, index }))
    .sort((left, right) => new Date(left.archive.closedAt || 0).getTime() - new Date(right.archive.closedAt || 0).getTime() || left.index - right.index)
    .forEach(({ archive }) => {
      const actorKey = String(archive.actorId || archive.actor || "Unknown Actor");
      const seen = seenByActor.get(actorKey) || {
        orders: new Set<string>(),
        receivables: new Set<string>(),
        transfers: new Set<string>(),
        ledger: new Set<string>()
      };
      seenByActor.set(actorKey, seen);
      (["orders", "receivables", "transfers", "ledger"] as ArchiveCollection[]).forEach((type) => {
        const items = archive[type] || [];
        const unique = items.filter((item) => {
          const key = archiveSnapshotItemKey(type, item);
          if (!key || seen[type].has(key)) return false;
          seen[type].add(key);
          return true;
        });
        if (type === "orders") archive.orders = unique as NonNullable<ArchiveRecord["orders"]>;
        else if (type === "receivables") archive.receivables = unique as NonNullable<ArchiveRecord["receivables"]>;
        else if (type === "transfers") archive.transfers = unique as NonNullable<ArchiveRecord["transfers"]>;
        else archive.ledger = unique as NonNullable<ArchiveRecord["ledger"]>;
      });
    });
  return archives;
}

function recoveredOrderMatches(left: OrderRecord, right: OrderRecord): boolean {
  const leftActorId = String(left.brokerActorId || "").trim();
  const rightActorId = String(right.brokerActorId || "").trim();
  const sameActor = leftActorId && rightActorId
    ? leftActorId === rightActorId
    : String(left.broker || "").trim().toLocaleLowerCase() === String(right.broker || "").trim().toLocaleLowerCase();
  if (!sameActor) return false;
  const leftMoment = String(left.createdAt || left.sentAt || "").trim();
  const rightMoment = String(right.createdAt || right.sentAt || "").trim();
  if (leftMoment && rightMoment && leftMoment !== rightMoment) return false;
  return String(left.sourceCurrency || "") === String(right.sourceCurrency || "") &&
    Number(left.sourceAmountMinor || 0) === Number(right.sourceAmountMinor || 0) &&
    String(left.payoutCurrency || "") === String(right.payoutCurrency || "") &&
    Number(left.payoutAmountMinor || 0) === Number(right.payoutAmountMinor || 0) &&
    String(left.receiverName || "").trim().toLocaleLowerCase() === String(right.receiverName || "").trim().toLocaleLowerCase() &&
    String(left.accountNumber || "").trim() === String(right.accountNumber || "").trim() &&
    String(left.phoneNumber || "").trim() === String(right.phoneNumber || "").trim();
}

function removeRecoveredOrderAliases(orders: OrderRecord[]): OrderRecord[] {
  const recovered = orders.filter((order) => String(order.collisionSourceOrderId || "").trim());
  if (!recovered.length) return orders;
  return orders.filter((candidate) => !recovered.some((order) =>
    candidate !== order &&
    String(candidate.id || "") === String(order.collisionSourceOrderId || "") &&
    recoveredOrderMatches(candidate, order)
  ));
}

function normalizeState(state: Partial<WorkspaceState> | null | undefined): WorkspaceState {
  const archives = normalizeArchiveSnapshots(state?.archives);
  const deletedOrderIds = Array.from(new Set(
    (Array.isArray(state?.deletedOrderIds) ? state.deletedOrderIds : [])
      .map((orderId) => String(orderId || "").trim())
      .filter(Boolean)
  ));
  const deletedOrderIdSet = new Set(deletedOrderIds);
  const normalized = {
    ...(state || {}),
    actors: Array.isArray(state?.actors) ? state.actors : [],
    orders: retainOrdersForUnclosedParticipants(
      removeRecoveredOrderAliases((Array.isArray(state?.orders) ? state.orders : []).filter((order) => !deletedOrderIdSet.has(order.id))),
      archives,
      Array.isArray(state?.ledger) ? state.ledger : [],
      Array.isArray(state?.actors) ? state.actors : [],
      deletedOrderIds,
      Array.isArray(state?.orderParticipantIdentityLinks) ? state.orderParticipantIdentityLinks : [],
      String(state?._workspaceId || "")
    ),
    receivables: Array.isArray(state?.receivables) ? state.receivables : [],
    savedCustomers: Array.isArray(state?.savedCustomers) ? state.savedCustomers : [],
    transfers: Array.isArray(state?.transfers) ? state.transfers : [],
    ledger: Array.isArray(state?.ledger) ? state.ledger : [],
    masterBankEntries: Array.isArray(state?.masterBankEntries) ? state.masterBankEntries : [],
    archives,
    settlements: Array.isArray(state?.settlements) ? state.settlements : [],
    chatConversations: Array.isArray(state?.chatConversations) ? state.chatConversations : [],
    deletedOrderIds
  } as WorkspaceState;
  ensureActorLedgerNumbers(normalized);
  return normalized;
}

function preserveLoadedChatPages(remote: WorkspaceState, local: WorkspaceState): WorkspaceState {
  remote.chatConversations = remote.chatConversations.map((chat) => {
    if (chat._messagesLoaded !== false || chat.messages.length > 0) return chat;
    const current = local.chatConversations.find((item) => item.id === chat.id);
    if (!current) return chat;
    const remoteLastId = String(chat.lastMessage?.id || "");
    const hasRemoteLast = !remoteLastId || current.messages.some((message) => message.id === remoteLastId);
    return {
      ...chat,
      messages: current.messages,
      _messagesLoaded: current._messagesLoaded === true && hasRemoteLast,
      _messagesLoading: false,
      _hasOlderMessages: current._messagesLoaded === true && hasRemoteLast
        ? current._hasOlderMessages === true
        : chat._hasOlderMessages === true,
      _nextBefore: current._messagesLoaded === true && hasRemoteLast
        ? String(current._nextBefore || "")
        : ""
    };
  });
  return remote;
}

export function canCreateOrders(session: UserSession | null | undefined): boolean {
  return Boolean(
    session &&
    session.subscriptionReadOnly !== true &&
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
      resetWorkspaceSnapshot();
      await AsyncStorage.multiRemove([sessionCacheKey, sessionActivityCacheKey]);
    }
    return session;
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
    const cached = await readCache<UserSession>(sessionCacheKey);
    const normalizedCached = sessionForCurrentSubscriptionWindow(
      cached ? { ...cached, idleTimeoutSeconds: normalizeIdleTimeoutSeconds(cached.idleTimeoutSeconds) } : null
    );
    if (cached && !normalizedCached) {
      await AsyncStorage.multiRemove([sessionCacheKey, sessionActivityCacheKey]);
      resetWorkspaceSnapshot();
    }
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
  resetWorkspaceSnapshot();
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

export async function getAccountDeviceWarning(): Promise<{ warning: AccountDeviceWarning | null; session: UserSession | null }> {
  const result = await api<{ warning: AccountDeviceWarning | null; subscription?: ApiSession["subscription"] }>("/api/auth/device-warning");
  if (activeSession && result.subscription) {
    const nextSession = sessionForCurrentSubscriptionWindow({
      ...activeSession,
      subscriptionExpiresAt: result.subscription.expiresAt || "",
      subscriptionReadOnly: result.subscription.readOnly === true,
      subscriptionGraceEndsAt: result.subscription.graceEndsAt || "",
      subscriptionReadOnlyDaysRemaining: Number(result.subscription.readOnlyDaysRemaining || 0),
      subscriptionAccessDenied: result.subscription.accessDenied === true
    });
    if (nextSession) {
      const changed = nextSession.subscriptionReadOnly !== activeSession.subscriptionReadOnly ||
        nextSession.subscriptionExpiresAt !== activeSession.subscriptionExpiresAt ||
        nextSession.subscriptionGraceEndsAt !== activeSession.subscriptionGraceEndsAt ||
        nextSession.subscriptionReadOnlyDaysRemaining !== activeSession.subscriptionReadOnlyDaysRemaining;
      activeSession = nextSession;
      if (changed) await cacheSession(nextSession);
    }
  }
  return { warning: result.warning || null, session: activeSession };
}

export async function changePassword(currentPassword: string, newPassword: string, confirmNewPassword: string): Promise<void> {
  if (!currentPassword || newPassword.length < 6) throw new Error("Enter the current password and a new password of at least 6 characters.");
  if (newPassword !== confirmNewPassword) throw new Error("New password and confirmation must match.");
  await api<{ ok: boolean }>("/api/auth/password", {
    method: "POST",
    body: { currentPassword, newPassword, confirmNewPassword }
  });
}

export async function loadWorkspaceState(): Promise<WorkspaceState> {
  const submittedSession = currentWorkspaceSession();
  const generation = activeWorkspaceMutationGeneration;
  if (!submittedSession?.workspaceId) throw new Error("Sign in before loading this workspace.");
  try {
    const result = await api<{ state: WorkspaceState; revision?: string }>("/api/app-state?reports=summary&chats=summary");
    assertWorkspaceRequestSession(submittedSession, generation);
    const normalized = normalizeState(result.state);
    const currentScope = workspaceSnapshotSessionKey(submittedSession);
    let currentState: WorkspaceState | null = null;
    if (activeWorkspaceSnapshotSessionKey === currentScope && activeWorkspaceSnapshotJson) {
      try {
        currentState = normalizeState(JSON.parse(activeWorkspaceSnapshotJson) as WorkspaceState);
      } catch {
        currentState = null;
      }
    }
    const state = {
      ...(currentState ? preserveLoadedChatPages(normalized, currentState) : normalized),
      offlineSnapshot: false,
      lastSyncedAt: new Date().toISOString()
    };
    await rememberWorkspaceSnapshot(state, result.revision, submittedSession, generation);
    return state;
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
    assertWorkspaceRequestSession(submittedSession, generation);
    const cached = await readCache<WorkspaceState>(workspaceCacheKey(submittedSession.workspaceId));
    if (!cached) throw new Error("Connect once to download this account before using it offline.");
    assertWorkspaceRequestSession(submittedSession, generation);
    const state = { ...normalizeState(cached), offlineSnapshot: true, lastSyncedAt: cached.lastSyncedAt };
    activeWorkspaceSnapshotJson = JSON.stringify(cacheableWorkspaceState(state));
    activeWorkspaceSnapshotSessionKey = workspaceSnapshotSessionKey(submittedSession);
    activeWorkspaceRevision = null;
    return state;
  }
}

export async function loadClosedReportDetail(reportKey: string): Promise<ArchiveRecord> {
  const cleanReportKey = String(reportKey || "").trim();
  if (!cleanReportKey) throw new Error("This report has no database reference. Refresh and try again.");
  const result = await api<{ report: ArchiveRecord }>(`/api/closed-reports/${encodeURIComponent(cleanReportKey)}`);
  if (!result.report) throw new Error("The closed report could not be loaded.");
  return result.report;
}

export async function loadChatMessagesPage(
  state: WorkspaceState,
  chatId: string,
  before = ""
): Promise<WorkspaceState> {
  const submittedSession = currentWorkspaceSession();
  const generation = activeWorkspaceMutationGeneration;
  if (!submittedSession?.workspaceId) throw new Error("Sign in before loading chat messages.");
  const query = `/api/chats/${encodeURIComponent(chatId)}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const result = await api<{ messages: ChatMessageRecord[]; hasOlder: boolean; nextBefore: string }>(query);
  assertWorkspaceRequestSession(submittedSession, generation);
  let baseState = state;
  if (activeWorkspaceSnapshotSessionKey === workspaceSnapshotSessionKey(submittedSession) && activeWorkspaceSnapshotJson) {
    try {
      baseState = normalizeState(JSON.parse(activeWorkspaceSnapshotJson) as WorkspaceState);
    } catch {
      baseState = state;
    }
  }
  const next = normalizeState(JSON.parse(JSON.stringify(baseState)) as WorkspaceState);
  const chat = next.chatConversations.find((item) => item.id === chatId);
  if (!chat) throw new Error("This chat is no longer available.");
  const merged = new Map<string, ChatMessageRecord>();
  [...(chat.messages || []), ...(result.messages || [])].forEach((message) => {
    if (message?.id) merged.set(message.id, { ...(merged.get(message.id) || {}), ...message });
  });
  chat.messages = Array.from(merged.values())
    .sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime());
  chat._messagesLoaded = true;
  chat._messagesLoading = false;
  chat._hasOlderMessages = result.hasOlder === true;
  chat._nextBefore = String(result.nextBefore || "");
  chat.messageCount = Math.max(Number(chat.messageCount || 0), chat.messages.length);
  if (chat.messages.length) chat.lastMessage = chat.messages[chat.messages.length - 1];
  if (!before && submittedSession.actorName) {
    chat.unreadCounts = { ...(chat.unreadCounts || {}), [submittedSession.actorName]: 0 };
    chat.readThroughBy = { ...(chat.readThroughBy || {}), [submittedSession.actorName]: new Date().toISOString() };
  }
  activeWorkspaceSnapshotJson = JSON.stringify(next);
  activeWorkspaceSnapshotSessionKey = workspaceSnapshotSessionKey(submittedSession);
  return next;
}

export async function loadWorkspaceStateIfChanged(): Promise<WorkspaceState | null> {
  const submittedSession = currentWorkspaceSession();
  const generation = activeWorkspaceMutationGeneration;
  const scope = workspaceSnapshotSessionKey(submittedSession);
  if (!submittedSession || !scope || activeWorkspaceSaveScopes.has(scope)) return null;
  try {
    const result = await api<{ revision: string }>("/api/app-state/version");
    assertWorkspaceRequestSession(submittedSession, generation);
    if (
      activeWorkspaceRevision !== null &&
      activeWorkspaceSnapshotSessionKey === scope &&
      result.revision === activeWorkspaceRevision
    ) {
      return null;
    }
    return await loadWorkspaceState();
  } catch (error) {
    if (error instanceof OfflineError) return null;
    throw error;
  }
}

export async function verifyWorkspaceRoutingCommit(
  expectedSession: UserSession,
  predicate: (order: OrderRecord) => boolean
): Promise<{ state: WorkspaceState; order?: OrderRecord } | null> {
  const delays = [0, 200, 500, 1000, 2000];
  let latest: WorkspaceState | null = null;
  let lastError: unknown;
  for (const delayMs of delays) {
    assertUserSessionIsCurrent(expectedSession);
    if (delayMs) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    assertUserSessionIsCurrent(expectedSession);
    try {
      latest = await loadWorkspaceState();
      assertUserSessionIsCurrent(expectedSession);
      if (latest.offlineSnapshot) break;
      const order = [
        ...latest.orders,
        ...latest.archives.flatMap((archive) => archive.orders || [])
      ].find(predicate);
      if (order) return { state: latest, order };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /session changed|workspace changed/i.test(error.message)) throw error;
    }
  }
  if (latest) return { state: latest };
  if (lastError) throw lastError;
  return null;
}

export async function loadWorkspaceStateForUpdate(): Promise<WorkspaceState> {
  const submittedSession = currentWorkspaceSession();
  const generation = activeWorkspaceMutationGeneration;
  const scope = workspaceSnapshotSessionKey(submittedSession);
  if (!submittedSession || !scope) throw new Error("Sign in before changing this workspace.");
  if (
    activeWorkspaceRevision !== null &&
    activeWorkspaceSnapshotJson &&
    activeWorkspaceSnapshotSessionKey === scope
  ) {
    try {
      const result = await api<{ revision: string }>("/api/app-state/version");
      assertWorkspaceRequestSession(submittedSession, generation);
      if (result.revision === activeWorkspaceRevision) {
        return normalizeState(JSON.parse(activeWorkspaceSnapshotJson) as WorkspaceState);
      }
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
    }
  }
  return loadWorkspaceState();
}

export async function saveWorkspaceState(state: WorkspaceState, routingSession?: UserSession): Promise<WorkspaceState> {
  if (state.offlineSnapshot) throw new Error("Reconnect to the internet before making financial changes.");
  const submittedSession = currentWorkspaceSession();
  const scope = workspaceSnapshotSessionKey(submittedSession);
  if (!submittedSession || !scope) throw new Error("Sign in before changing this workspace.");
  if (activeWorkspaceSaveScopes.has(scope)) throw new Error("Another workspace change is still being saved. Try again in a moment.");
  if (routingSession) assertUserSessionIsCurrent(routingSession);
  const expectedRevision = activeWorkspaceRevision;
  const routingProtected = Boolean(routingSession);
  const generation = routingProtected ? ++activeWorkspaceMutationGeneration : activeWorkspaceMutationGeneration;
  if (routingProtected) activeWorkspaceSaveScopes.add(scope);
  try {
    const result = await api<{ ok: boolean; state: WorkspaceState; revision?: string }>("/api/app-state", {
      method: "PUT",
      body: {
        state: { ...state, offlineSnapshot: undefined, lastSyncedAt: undefined },
        expectedRevision,
        chatResponse: "summary"
      }
    });
    assertWorkspaceRequestSession(submittedSession, generation);
    if (routingSession) assertUserSessionIsCurrent(routingSession);
    const savedState = {
      ...preserveLoadedChatPages(normalizeState(result.state || state), state),
      offlineSnapshot: false,
      lastSyncedAt: new Date().toISOString()
    };
    await rememberWorkspaceSnapshot(savedState, result.revision, submittedSession, generation);
    return savedState;
  } finally {
    if (routingProtected) activeWorkspaceSaveScopes.delete(scope);
  }
}

interface AtomicBrokerSubmitResult {
  ok: boolean;
  revision?: string;
  alreadyApplied?: boolean;
  archived?: boolean;
  order: OrderRecord;
  receivable: ReceivableRecord | null;
  customers: SavedCustomerRecord[];
  orderCounter?: number;
  receivableCounter?: number;
  customerCounter?: number;
  orderState?: WorkspaceState["orderState"];
  state?: WorkspaceState;
}

function brokerSubmitCustomerKey(customer: SavedCustomerRecord): string {
  return [customer.actorId, customer.kind, customer.name.trim().toLocaleLowerCase()].join("|");
}

function adoptAtomicBrokerSubmit(
  localState: WorkspaceState,
  submittedOrder: OrderRecord,
  optimisticReceivableId: string,
  submittedCustomers: SavedCustomerRecord[],
  result: AtomicBrokerSubmitResult
): WorkspaceState {
  const next = normalizeState(JSON.parse(JSON.stringify(localState)) as WorkspaceState);
  const actionOrders = next.orders.filter((candidate) => brokerRoutingOrderMatches(candidate, submittedOrder));
  const actionOrderIds = new Set([
    submittedOrder.id,
    submittedOrder.internalOrderId,
    submittedOrder.collisionSourceOrderId,
    ...actionOrders.flatMap((candidate) => [candidate.id, candidate.internalOrderId, candidate.collisionSourceOrderId])
  ].filter(Boolean).map(String));
  next.orders = next.orders.filter((candidate) => !actionOrders.includes(candidate));
  if (result.archived !== true) next.orders.unshift({ ...result.order });

  next.receivables = next.receivables.filter((candidate) => {
    const belongsToSubmittingBroker = submittedOrder.brokerActorId && candidate.borrowerActorId
      ? candidate.borrowerActorId === submittedOrder.brokerActorId
      : candidate.borrower === submittedOrder.broker;
    const isOptimisticReceivable = Boolean(optimisticReceivableId) && belongsToSubmittingBroker && candidate.id === optimisticReceivableId;
    const belongsToActionOrder = belongsToSubmittingBroker && actionOrderIds.has(String(candidate.orderId || ""));
    return !isOptimisticReceivable && !belongsToActionOrder;
  });
  if (result.receivable) next.receivables.unshift({ ...result.receivable });

  const submittedCustomerIds = new Set(submittedCustomers.map((customer) => customer.id));
  const submittedCustomerActorIds = new Set(submittedCustomers.map((customer) => customer.actorId));
  const customerKeys = new Set([
    ...submittedCustomers.map(brokerSubmitCustomerKey),
    ...(result.customers || []).map(brokerSubmitCustomerKey)
  ]);
  next.savedCustomers = next.savedCustomers.filter((customer) =>
    !(submittedCustomerIds.has(customer.id) && submittedCustomerActorIds.has(customer.actorId)) &&
    !customerKeys.has(brokerSubmitCustomerKey(customer))
  );
  [...(result.customers || [])].reverse().forEach((customer) => next.savedCustomers.unshift({ ...customer }));
  next.orderCounter = Math.max(Number(next.orderCounter || 0), Number(result.orderCounter || 0));
  next.receivableCounter = Math.max(Number(next.receivableCounter || 0), Number(result.receivableCounter || 0));
  next.customerCounter = Math.max(Number(next.customerCounter || 0), Number(result.customerCounter || 0));
  next.orderState = result.orderState || result.order.state || "Pending Forward";
  return next;
}

async function saveBrokerSubmissionAtomic(
  state: WorkspaceState,
  session: UserSession,
  input: {
    order: OrderRecord;
    previousOrder: OrderRecord | null;
    receivable: ReceivableRecord | null;
    removeReceivable: boolean;
    customers: SavedCustomerRecord[];
  }
): Promise<WorkspaceState> {
  if (state.offlineSnapshot) throw new Error("Reconnect to the internet before making financial changes.");
  const submittedSession = currentWorkspaceSession();
  const scope = workspaceSnapshotSessionKey(submittedSession);
  if (!submittedSession || !scope) throw new Error("Sign in before changing this workspace.");
  if (activeWorkspaceSaveScopes.has(scope)) throw new Error("Another workspace change is still being saved. Try again in a moment.");
  assertUserSessionIsCurrent(session);
  const expectedRevision = activeWorkspaceRevision;
  const generation = ++activeWorkspaceMutationGeneration;
  activeWorkspaceSaveScopes.add(scope);
  let fallbackToFullSave = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        assertWorkspaceRequestSession(submittedSession, generation);
        assertUserSessionIsCurrent(session);
        const result = await api<AtomicBrokerSubmitResult>("/api/app-state/submit-order", {
          method: "POST",
          body: {
            actingActorId: session.managedByMaster ? session.actorId : undefined,
            attemptId: input.order.routingSubmissionId,
            order: input.order,
            previousOrder: input.previousOrder,
            receivable: input.receivable,
            removeReceivable: input.removeReceivable,
            customers: input.customers,
            orderCounter: state.orderCounter,
            receivableCounter: state.receivableCounter,
            customerCounter: state.customerCounter,
            expectedRevision
          }
        });
        assertWorkspaceRequestSession(submittedSession, generation);
        assertUserSessionIsCurrent(session);
        const savedState = result.state
          ? normalizeState(result.state)
          : adoptAtomicBrokerSubmit(state, input.order, input.receivable?.id || "", input.customers, result);
        const synchronized = { ...savedState, offlineSnapshot: false, lastSyncedAt: new Date().toISOString() };
        await rememberWorkspaceSnapshot(synchronized, result.revision, submittedSession, generation);
        return synchronized;
      } catch (error) {
        assertWorkspaceRequestSession(submittedSession, generation);
        assertUserSessionIsCurrent(session);
        const status = Number((error as Error & { status?: number })?.status);
        if ([404, 405].includes(status)) {
          fallbackToFullSave = true;
          break;
        }
        if ((Number.isInteger(status) && status >= 400 && status < 500) || attempt === 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } finally {
    activeWorkspaceSaveScopes.delete(scope);
  }
  if (fallbackToFullSave) return saveWorkspaceState(state, session);
  throw new Error("The server did not confirm the exact order that was sent.");
}

interface AtomicOrderPaymentResult {
  ok: boolean;
  revision?: string;
  alreadyApplied?: boolean;
  order: OrderRecord;
  ledgerLines: LedgerLine[];
  receivable: ReceivableRecord | null;
  settlements: WorkspaceState["settlements"];
  chat: Omit<ChatConversationRecord, "messages"> | null;
  message: ChatMessageRecord | null;
  proofDelivered?: boolean;
  journalCounter?: number;
  chatCounter?: number;
  orderState?: WorkspaceState["orderState"];
  state?: WorkspaceState;
}

function atomicPaymentExpectedOrder(order: OrderRecord): Partial<OrderRecord> {
  const identity: Partial<OrderRecord> = {};
  const fields: Array<keyof OrderRecord> = [
    "id",
    "brokerActorId",
    "broker",
    "createdAt",
    "sentAt",
    "sourceCurrency",
    "sourceAmountMinor",
    "payoutCurrency",
    "payoutAmountMinor",
    "receiverName",
    "accountNumber",
    "phoneNumber"
  ];
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(order, field)) {
      (identity as Record<string, unknown>)[field] = order[field];
    }
  });
  return identity;
}

function atomicPaymentAttemptId(order: OrderRecord): string {
  const token = (value: unknown, fallback = "ASSIGNED") =>
    String(value || fallback).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
  const cycle = order.routingForwardAttemptId || order.assignedAt || order.updatedAt || order.createdAt || "ASSIGNED";
  return `PAY-${token(order.id)}-${token(cycle)}`;
}

function adoptAtomicOrderPayment(
  localState: WorkspaceState,
  result: AtomicOrderPaymentResult
): WorkspaceState {
  const next = normalizeState(JSON.parse(JSON.stringify(localState)) as WorkspaceState);
  const orderIndex = next.orders.findIndex((candidate) => candidate.id === result.order.id);
  if (orderIndex >= 0) next.orders[orderIndex] = { ...result.order };
  else next.orders.push({ ...result.order });

  next.ledger = next.ledger.filter((line) => !(
    line.source === "ORDER_PAYMENT"
    && line.orderId === result.order.id
    && line.journal === result.order.journal
  ));
  next.ledger.unshift(...(result.ledgerLines || []).map((line) => ({ ...line })));

  if (result.receivable) {
    const receivableIndex = next.receivables.findIndex((candidate) =>
      candidate.id === result.receivable?.id || candidate.orderId === result.receivable?.orderId
    );
    if (receivableIndex >= 0) next.receivables[receivableIndex] = { ...result.receivable };
    else next.receivables.push({ ...result.receivable });
  }
  if (Array.isArray(result.settlements)) next.settlements = result.settlements.map((row) => ({ ...row }));

  if (result.chat) {
    let chat = next.chatConversations.find((candidate) => candidate.id === result.chat?.id);
    if (!chat) {
      chat = { ...result.chat, messages: [] } as ChatConversationRecord;
      next.chatConversations.push(chat);
    }
    if (result.message && !chat.messages.some((message) => message.id === result.message?.id)) {
      chat.messages.push({ ...result.message });
    }
  }
  next.journalCounter = Math.max(Number(next.journalCounter || 0), Number(result.journalCounter || 0));
  next.chatCounter = Math.max(Number(next.chatCounter || 0), Number(result.chatCounter || 0));
  next.orderState = result.orderState || "Paid";
  return next;
}

export async function postOrderPaymentAtomic(
  orderId: string,
  actorId: string,
  paymentProof?: PreparedPaymentProof
): Promise<WorkspaceState> {
  const state = await loadWorkspaceStateForUpdate();
  if (state.offlineSnapshot) throw new Error("Reconnect to the internet before posting payment.");
  const order = state.orders.find((candidate) => candidate.id === orderId);
  if (!order || order.state !== "Assigned") throw new Error("This order has already changed. Refresh and try again.");
  const submittedSession = currentWorkspaceSession();
  const scope = workspaceSnapshotSessionKey(submittedSession);
  if (!submittedSession || !scope) throw new Error("Sign in before posting payment.");
  if (activeWorkspaceSaveScopes.has(scope)) throw new Error("Another workspace change is still being saved. Try again in a moment.");
  const expectedRevision = activeWorkspaceRevision;
  const generation = ++activeWorkspaceMutationGeneration;
  const attemptId = atomicPaymentAttemptId(order);
  activeWorkspaceSaveScopes.add(scope);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        assertWorkspaceRequestSession(submittedSession, generation);
        const result = await api<AtomicOrderPaymentResult>("/api/app-state/pay-order", {
          method: "POST",
          body: {
            orderId,
            actingActorId: actorId,
            attemptId,
            expectedRevision,
            expectedOrder: atomicPaymentExpectedOrder(order),
            expectedOrderUpdatedAt: order.updatedAt || "",
            expectedRoutingForwardAttemptId: order.routingForwardAttemptId || "",
            paymentProof: paymentProof || null
          }
        });
        assertWorkspaceRequestSession(submittedSession, generation);
        const savedState = result.state
          ? preserveLoadedChatPages(normalizeState(result.state), state)
          : adoptAtomicOrderPayment(state, result);
        const synchronized = { ...savedState, offlineSnapshot: false, lastSyncedAt: new Date().toISOString() };
        await rememberWorkspaceSnapshot(synchronized, result.revision, submittedSession, generation);
        return synchronized;
      } catch (error) {
        assertWorkspaceRequestSession(submittedSession, generation);
        const status = Number((error as Error & { status?: number })?.status);
        if ((Number.isInteger(status) && status >= 400 && status < 500) || attempt === 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } finally {
    activeWorkspaceSaveScopes.delete(scope);
  }
  throw new Error("The server did not confirm the exact payment.");
}

export async function updateWorkspaceState(mutator: (state: WorkspaceState) => void): Promise<WorkspaceState> {
  const state = await loadWorkspaceStateForUpdate();
  mutator(state);
  return saveWorkspaceState(state);
}

export async function removeWorkspaceActor(actorId: string, actorName: string): Promise<WorkspaceState> {
  const result = await api<{ state: WorkspaceState; revision?: string }>("/api/app-state/remove-actor", {
    method: "POST",
    body: { actorId, actorName }
  });
  const state = normalizeState(result.state);
  await rememberWorkspaceSnapshot(state, result.revision);
  return state;
}

export async function resetWorkspaceActorData(actorId: string): Promise<WorkspaceState> {
  const result = await api<{ state: WorkspaceState; revision?: string }>("/api/app-state/reset-actor", {
    method: "POST",
    body: { actorId }
  });
  const state = normalizeState(result.state);
  await rememberWorkspaceSnapshot(state, result.revision);
  return state;
}

export async function resetWorkspaceData(scope: "data" | "wipe"): Promise<WorkspaceState> {
  const result = await api<{ state: WorkspaceState; revision?: string }>("/api/app-state/reset", {
    method: "POST",
    body: { scope }
  });
  const state = normalizeState(result.state);
  await rememberWorkspaceSnapshot(state, result.revision);
  return state;
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

export async function updateOwnerMasterEmail(userId: string, email: string): Promise<void> {
  await api<{ ok: boolean }>("/api/owner/masters/email", { method: "POST", body: { userId, email } });
}

export async function updateOwnerMasterName(userId: string, name: string): Promise<void> {
  await api<{ ok: boolean }>("/api/owner/masters/name", { method: "POST", body: { userId, name } });
}

export async function extendOwnerSubscription(userId: string, plan: string, mode: "extend" | "reset"): Promise<void> {
  await api<{ ok: boolean }>("/api/owner/subscriptions/extend", { method: "POST", body: { userId, plan, mode } });
}

function nextOrderNumberFromOrders(orders: OrderRecord[]): number {
  return orders.reduce((next, order) => {
    const match = String(order?.id || "").match(/^ORD-(\d+)(?:-|$)/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

export type CancelledOrderClosePolicy = "include" | "omit";

export async function closeActorBalance(
  actorId: string,
  cancelledOrderPolicy: CancelledOrderClosePolicy,
  expectedRevision: string | null = activeWorkspaceRevision
): Promise<WorkspaceState> {
  if (!actorId) throw new Error("Choose an actor before closing the balance.");
  const result = await api<{ state: WorkspaceState; revision?: string }>("/api/app-state/close-balance", {
    method: "POST",
    body: { actorId, cancelledOrderPolicy, expectedRevision }
  });
  const state = {
    ...normalizeState(result.state),
    offlineSnapshot: false,
    lastSyncedAt: new Date().toISOString()
  };
  await rememberWorkspaceSnapshot(state, result.revision);
  return state;
}

function nextReceivableNumberFromReceivables(receivables: ReceivableRecord[]): number {
  return receivables.reduce((next, receivable) => {
    const match = String(receivable?.id || "").match(/^REC-(\d+)(?:-|$)/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function collisionSafeRecordId(prefix: "ORD" | "REC", sequence: number): string {
  const randomToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 20)
    .toUpperCase();
  return `${prefix}-${sequence}-${randomToken}`;
}

function nextOrderId(state: WorkspaceState): string {
  const nextNumber = Math.max(Number(state.orderCounter || 0) + 1, nextOrderNumberFromOrders(state.orders));
  state.orderCounter = nextNumber;
  return collisionSafeRecordId("ORD", nextNumber);
}

function actorOrderPrefix(name: string): string {
  const clean = String(name || "ACT").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${clean}XXX`.slice(0, 3);
}

function nextBrokerOrderNumber(session: UserSession, state: WorkspaceState): string {
  const actor = sessionActor(session, state);
  const assignedCode = String(actor?.brokerCode || session.brokerCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefix = assignedCode || actorOrderPrefix(session.actorName);
  const next = nextActorLedgerSequence(state, session.actorName);
  return `${prefix}${String(next).padStart(3, "0")}`;
}

function nextReceivableId(state: WorkspaceState): string {
  const nextNumber = Math.max(Number(state.receivableCounter || 0) + 1, nextReceivableNumberFromReceivables(state.receivables));
  state.receivableCounter = nextNumber;
  return collisionSafeRecordId("REC", nextNumber);
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

function upsertSavedCustomer(state: WorkspaceState, actor: ActorRecord | undefined, details: Omit<SavedCustomerRecord, "id" | "actorId" | "updatedAt">): SavedCustomerRecord | null {
  if (!actor || (!details.name && !details.accountNumber && !details.phoneNumber && !details.remarks)) return null;
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
  return existing || next;
}

function rememberOrderCustomers(state: WorkspaceState, actor: ActorRecord | undefined, draft: TransferDraft): SavedCustomerRecord[] {
  const sender = upsertSavedCustomer(state, actor, {
    kind: "sender",
    name: draft.senderName.trim(),
    receiverCity: "",
    accountNumber: "",
    phoneNumber: "",
    remarks: ""
  });
  const receiver = upsertSavedCustomer(state, actor, {
    kind: "receiver",
    name: draft.receiverName.trim(),
    receiverCity: draft.receiverCity.trim(),
    accountNumber: draft.accountNumber.trim(),
    phoneNumber: draft.phoneNumber.trim(),
    remarks: draft.remarks.trim()
  });
  return [sender, receiver].filter((customer): customer is SavedCustomerRecord => Boolean(customer));
}

export async function submitTransferOrder(session: UserSession, draft: TransferDraft, editingOrderId = ""): Promise<SubmittedOrder> {
  if (!canCreateOrders(session)) {
    throw new Error("Only Brokers and Special Brokers can send new orders.");
  }
  const scope = workspaceSnapshotSessionKey(session);
  assertUserSessionIsCurrent(session);
  if (processingBrokerRoutingScopes.has(scope)) throw new Error("This order is already being sent.");
  processingBrokerRoutingScopes.add(scope);
  let protectedAttempt: MobileBrokerRoutingAction | null = null;
  let persisted = false;
  try {
    const unfinished = await readMobileRoutingAction(session);
    assertUserSessionIsCurrent(session);
    if (unfinished?.kind === "master-forward") {
      throw new Error("Finish the protected Master forwarding action before sending another order.");
    }
    protectedAttempt = unfinished;
    const effectiveDraft = unfinished?.draft || draft;
    const effectiveEditingOrderId = unfinished?.editingOrderId || editingOrderId;
    if (!effectiveDraft.receiverName.trim() && !effectiveDraft.receiverCity.trim() && !effectiveDraft.phoneNumber.trim() &&
        !effectiveDraft.accountNumber.trim() && !effectiveDraft.remarks.trim()) {
      throw new Error("Enter at least one receiver detail.");
    }
    if (!effectiveDraft.fundingType) throw new Error("Choose Cash or Credit before sending.");

    const state = await loadWorkspaceStateForUpdate();
    assertUserSessionIsCurrent(session);
    let recoveredCurrentOrder: OrderRecord | undefined;
    let needsCollisionSafeRetryIdentity = false;
    if (unfinished) {
      const acknowledged = state.orders.find((candidate) => brokerRoutingOrderMatches(candidate, unfinished.order));
      if (acknowledged) {
        await clearMobileRoutingAction(session, unfinished.attemptId);
        return {
          orderId: acknowledged.id,
          orderNumber: acknowledged.brokerOrderNumber || acknowledged.id,
          status: "Pending Master Approval",
          createdAt: acknowledged.createdAt || acknowledged.sentAt || new Date().toISOString(),
          state
        };
      }
      const archivedOrders = state.archives.flatMap((archive) => archive.orders || []);
      recoveredCurrentOrder = state.orders.find((candidate) =>
        routingOrderIdentityMatches(candidate, unfinished.order) && routingOrderContentMatches(candidate, unfinished.order)
      );
      const archivedOrder = archivedOrders.find((candidate) =>
        routingOrderIdentityMatches(candidate, unfinished.order) && routingOrderContentMatches(candidate, unfinished.order)
      );
      const currentIdWasDeleted = (state.deletedOrderIds || []).includes(unfinished.order.id);
      if (archivedOrder || currentIdWasDeleted) {
        await clearMobileRoutingAction(session, unfinished.attemptId);
        throw new Error("The server has already archived or removed this order. Its current version will be loaded instead.");
      }
      const currentReferences = recoveredCurrentOrder
        ? [recoveredCurrentOrder.id, recoveredCurrentOrder.internalOrderId, recoveredCurrentOrder.collisionSourceOrderId]
        : [];
      const canRetryReturnedOrder = recoveredCurrentOrder?.state === "Returned" &&
        Boolean(effectiveEditingOrderId) && currentReferences.includes(effectiveEditingOrderId);
      if (recoveredCurrentOrder && !canRetryReturnedOrder) {
        await clearMobileRoutingAction(session, unfinished.attemptId);
        throw new Error(`The server already has this order as ${recoveredCurrentOrder.state}. Its current version will be loaded instead.`);
      }
      const currentIdCollision = [...state.orders, ...archivedOrders].some((candidate) =>
        candidate.id === unfinished.order.id && !routingOrderContentMatches(candidate, unfinished.order)
      );
      needsCollisionSafeRetryIdentity = !effectiveEditingOrderId && !recoveredCurrentOrder &&
        currentIdCollision;
    }

    const actor = sessionActor(session, state);
    const existingOrder = effectiveEditingOrderId
      ? recoveredCurrentOrder || state.orders.find((order) => order.id === effectiveEditingOrderId)
      : undefined;
    if (effectiveEditingOrderId && (!existingOrder || existingOrder.state !== "Returned" ||
        (existingOrder.brokerActorId ? existingOrder.brokerActorId !== (actor?.id || session.actorId) : existingOrder.broker !== session.actorName))) {
      throw new Error("This returned order is no longer available for modification.");
    }
    const previousOrder = existingOrder ? { ...existingOrder } : null;

    let order: OrderRecord;
    if (unfinished) {
      order = {
        ...unfinished.order,
        ...(existingOrder ? {
          id: existingOrder.id,
          internalOrderId: existingOrder.internalOrderId || unfinished.order.internalOrderId,
          collisionSourceOrderId: existingOrder.collisionSourceOrderId || unfinished.order.collisionSourceOrderId
        } : {})
      };
      if (needsCollisionSafeRetryIdentity) {
        const collisionSourceOrderId = order.id;
        order.id = nextOrderId(state);
        order.collisionSourceOrderId = collisionSourceOrderId;
        const brokerNumberCollision = [...state.orders, ...state.archives.flatMap((archive) => archive.orders || [])]
          .some((candidate) =>
            candidate.brokerOrderNumber === order.brokerOrderNumber &&
            (candidate.brokerActorId && order.brokerActorId
              ? candidate.brokerActorId === order.brokerActorId
              : candidate.broker === order.broker) &&
            !routingOrderContentMatches(candidate, order)
          );
        if (brokerNumberCollision) order.brokerOrderNumber = nextBrokerOrderNumber(session, state);
      }
      const conflictingOrder = state.orders.find((candidate) => candidate.id === order.id && candidate !== existingOrder);
      if (conflictingOrder) throw new Error("This protected order ID is already used by a different order. Refresh before retrying.");
      const orderSequence = Number(String(order.id || "").match(/^ORD-(\d+)/)?.[1] || 0);
      if (orderSequence > 0) state.orderCounter = Math.max(Number(state.orderCounter || 0), orderSequence);
      protectedAttempt = {
        ...unfinished,
        orderId: order.id,
        order: { ...order },
        editingOrderId: existingOrder?.id || effectiveEditingOrderId
      };
    } else {
      const sourceCurrency = actor?.orderMultiCurrencyEnabled === true
        ? effectiveDraft.sourceCurrency
        : safeCurrency(actor?.currency, session.currency);
      const fixedRate = fixedOrderRateForActor(actor, effectiveDraft.payoutCurrency);
      const fixedCommission = fixedOrderCommissionForActor(actor);
      const parsedCommissionPercent = parseDecimalNumber(effectiveDraft.commissionPercent);
      const commissionPercent = fixedCommission !== null
        ? fixedCommission
        : Number.isFinite(parsedCommissionPercent) ? parsedCommissionPercent : 0;
      const quote = calculateQuote({
        ...effectiveDraft,
        broker: session.actorName,
        sourceCurrency,
        commissionPercent: String(commissionPercent),
        ...(fixedRate ? { rate: String(fixedRate), payoutAmount: "" } : {})
      });
      if (quote.sourceAmount <= 0 || quote.payoutAmount <= 0 || quote.rate <= 0) {
        throw new Error("Enter source amount, payout amount, and rate greater than zero.");
      }
      const now = new Date().toISOString();
      const orderId = existingOrder?.id || nextOrderId(state);
      const routingSubmissionId = mobileBrokerRoutingAttemptId(
        orderId,
        existingOrder?.returnedAt || existingOrder?.updatedAt || "INITIAL"
      );
      order = {
        ...(existingOrder || {}),
        id: orderId,
        routingSubmissionId,
        routingForwardAttemptId: undefined,
        brokerOrderNumber: existingOrder?.brokerOrderNumber || nextBrokerOrderNumber(session, state),
        brokerOrderNumberCycle: existingOrder?.brokerOrderNumberCycle ?? Math.max(0, Math.floor(Number(actor?.numberingCycle || 0))),
        brokerActorId: actor?.id || session.actorId,
        broker: session.actorName,
        agent: "Unassigned",
        agentActorId: "",
        sourceCurrency,
        payoutCurrency: effectiveDraft.payoutCurrency,
        sourceAmountMinor: minorFromMajor(quote.sourceAmount, sourceCurrency),
        payoutAmountMinor: minorFromMajor(quote.payoutAmount, effectiveDraft.payoutCurrency),
        commissionMinor: minorFromMajor(quote.commissionAmount, sourceCurrency),
        orderCommissionLiability: commissionPercent < 0 ? "Master" : "Broker",
        grossMinor: minorFromMajor(quote.grossAmount, sourceCurrency),
        moneyUnitVersion: 2,
        rate: quote.rate,
        commissionPercent,
        senderName: effectiveDraft.senderName.trim(),
        receiverName: effectiveDraft.receiverName.trim(),
        receiverCity: effectiveDraft.receiverCity.trim(),
        accountNumber: effectiveDraft.accountNumber.trim(),
        phoneNumber: effectiveDraft.phoneNumber.trim(),
        remarks: effectiveDraft.remarks.trim(),
        amount: compactAmount(sourceCurrency, quote.sourceAmount),
        fundingType: effectiveDraft.fundingType as FundingType,
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
      protectedAttempt = {
        kind: "broker-send",
        attemptId: routingSubmissionId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        orderId: order.id,
        order: { ...order },
        draft: { ...effectiveDraft },
        editingOrderId: effectiveEditingOrderId
      };
    }

    const submittedAttempt = protectedAttempt;
    if (!submittedAttempt) throw new Error("The order could not be protected before sending.");
    assertUserSessionIsCurrent(session);
    await persistMobileRoutingAction(session, submittedAttempt);
    persisted = true;
    state.orders = [order, ...state.orders.filter((item) => item.id !== order.id)];
    const submittedCustomers = rememberOrderCustomers(state, actor, effectiveDraft);
    const existingReceivableIndex = state.receivables.findIndex((item) => item.orderId === order.id);
    const existingReceivable = existingReceivableIndex >= 0 ? state.receivables[existingReceivableIndex] : undefined;
    let submittedReceivable: ReceivableRecord | null = null;
    let removeReceivable = false;
    if (effectiveDraft.fundingType === "credit") {
      const receivable = buildReceivable(session, effectiveDraft, order, state, existingReceivable);
      submittedReceivable = receivable;
      if (existingReceivableIndex >= 0) state.receivables.splice(existingReceivableIndex, 1, receivable);
      else state.receivables.unshift(receivable);
    } else if (existingReceivable && existingReceivable.payments.reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0) === 0) {
      state.receivables.splice(existingReceivableIndex, 1);
      removeReceivable = true;
    }

    const savedState = await saveBrokerSubmissionAtomic(state, session, {
      order,
      previousOrder,
      receivable: submittedReceivable,
      removeReceivable,
      customers: submittedCustomers
    });
    assertUserSessionIsCurrent(session);
    const acknowledged = savedState.orders.find((candidate) => brokerRoutingOrderMatches(candidate, order));
    if (!acknowledged) throw new Error("The server did not confirm the exact order that was sent.");
    await clearMobileRoutingAction(session, submittedAttempt.attemptId);
    return {
      orderId: acknowledged.id,
      orderNumber: acknowledged.brokerOrderNumber || acknowledged.id,
      status: "Pending Master Approval",
      createdAt: acknowledged.createdAt || acknowledged.sentAt || order.createdAt,
      state: savedState
    };
  } catch (error) {
    const current = currentWorkspaceSession();
    const sameSession = workspaceSnapshotSessionKey(current) === scope &&
      (!session.loginStartedAt || current?.loginStartedAt === session.loginStartedAt);
    if (persisted && protectedAttempt && sameSession) {
      try {
        const verification = await verifyWorkspaceRoutingCommit(
          session,
          (candidate) => brokerRoutingOrderMatches(candidate, protectedAttempt!.order)
        );
        const latest = verification?.state;
        const acknowledged = verification?.order;
        if (latest && acknowledged) {
          await clearMobileRoutingAction(session, protectedAttempt.attemptId);
          return {
            orderId: acknowledged.id,
            orderNumber: acknowledged.brokerOrderNumber || acknowledged.id,
            status: "Pending Master Approval",
            createdAt: acknowledged.createdAt || acknowledged.sentAt || protectedAttempt.order.createdAt,
            state: latest
          };
        }
      } catch {
        // Keep the protected record; the next exact retry will reconcile it first.
      }
      const detail = error instanceof Error ? error.message : "The send result was not confirmed.";
      throw new Error(`${detail} Your exact order is protected. Retry Send when connected; do not create it again.`);
    }
    throw error;
  } finally {
    processingBrokerRoutingScopes.delete(scope);
  }
}
