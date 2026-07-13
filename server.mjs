import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dbPath = path.join(dataDir, "auth-db.json");
const inviteTtlMs = 1000 * 60 * 60;
const ownerUser = process.env.OWNER_USER ?? "Owner";
const ownerPassword = process.env.OWNER_PASSWORD ?? "1453@Siem#";
let saveQueue = Promise.resolve();
const sessionIdleMs = 1000 * 60 * 60 * 3;
const sessionCookieMaxAgeSeconds = Math.floor(sessionIdleMs / 1000);
const subscriptionPlans = new Map([
  ["one_day", { label: "1 day", days: 1 }],
  ["three_days", { label: "3 days", days: 3 }],
  ["one_week", { label: "1 week", days: 7 }],
  ["one_month", { label: "1 month", days: 30 }],
  ["three_months", { label: "3 months", days: 90 }],
  ["one_year", { label: "1 year", days: 365 }],
]);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".sql", "text/plain; charset=utf-8"],
  [".ts", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".zip", "application/zip"],
]);

const blankDb = () => ({
  users: [],
  workspaces: [],
  memberships: [],
  invites: [],
  sessions: [],
  appStates: {},
  ownerPasswordHash: "",
});

async function readPersistedDb() {
  try {
    return { ...blankDb(), ...JSON.parse(await readFile(dbPath, "utf8")) };
  } catch {
    return null;
  }
}

function mergeRecordsById(existingItems = [], incomingItems = []) {
  const merged = new Map();
  [...existingItems, ...incomingItems].forEach((item) => {
    if (!item || typeof item !== "object" || !item.id) return;
    merged.set(item.id, { ...(merged.get(item.id) || {}), ...item });
  });
  return Array.from(merged.values());
}

function mergeAppStates(existingStates = {}, incomingStates = {}) {
  return Object.fromEntries(
    Array.from(new Set([...Object.keys(existingStates || {}), ...Object.keys(incomingStates || {})])).map((workspaceId) => [
      workspaceId,
      {
        ...(existingStates?.[workspaceId] || {}),
        ...(incomingStates?.[workspaceId] || {}),
      },
    ])
  );
}

function mergeDatabase(existingDb, incomingDb) {
  if (!existingDb) return { ...blankDb(), ...incomingDb };
  return {
    ...blankDb(),
    ...existingDb,
    ...incomingDb,
    users: mergeRecordsById(existingDb.users, incomingDb.users),
    workspaces: mergeRecordsById(existingDb.workspaces, incomingDb.workspaces),
    memberships: mergeRecordsById(existingDb.memberships, incomingDb.memberships),
    invites: mergeRecordsById(existingDb.invites, incomingDb.invites),
    sessions: mergeRecordsById(existingDb.sessions, incomingDb.sessions),
    appStates: mergeAppStates(existingDb.appStates, incomingDb.appStates),
  };
}

async function loadDb() {
  await mkdir(dataDir, { recursive: true });
  const db = await readPersistedDb();
  if (db) return db;
  try {
    const db = blankDb();
    await saveDb(db);
    return db;
  } catch {
    return blankDb();
  }
}

async function saveDb(db, options = {}) {
  const write = async () => {
    await mkdir(dataDir, { recursive: true });
    const nextDb = options.replace === true
      ? { ...blankDb(), ...db }
      : mergeDatabase(await readPersistedDb(), db);
    const tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(nextDb, null, 2));
    await rename(tempPath, dbPath);
  };
  saveQueue = saveQueue.then(write, write);
  await saveQueue;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function inviteCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function inviteIsExpired(invite, now = Date.now()) {
  const createdAt = new Date(invite.createdAt || 0).getTime();
  return !Number.isFinite(createdAt) || now - createdAt >= inviteTtlMs;
}

function purgeExpiredInvites(db) {
  const now = Date.now();
  const activeInvites = db.invites.filter((invite) => invite.acceptedAt || !inviteIsExpired(invite, now));
  if (activeInvites.length === db.invites.length) return false;
  db.invites = activeInvites;
  return true;
}

function addDays(dateMs, days) {
  return new Date(dateMs + days * 24 * 60 * 60 * 1000).toISOString();
}

function subscriptionPlan(planId) {
  return subscriptionPlans.get(planId) || subscriptionPlans.get("one_month");
}

function subscriptionExpired(expiresAt) {
  return new Date(expiresAt || 0).getTime() <= Date.now();
}

function ensureMasterSubscriptions(db) {
  let changed = false;
  db.memberships
    .filter((membership) => membership.role === "Master")
    .forEach((membership) => {
      const user = db.users.find((item) => item.id === membership.userId);
      if (!user) return;
      if (!Object.prototype.hasOwnProperty.call(user, "active")) {
        user.active = true;
        changed = true;
      }
      if (!user.subscriptionExpiresAt) {
        user.subscriptionExpiresAt = addDays(Date.now(), 30);
        user.subscriptionPlan = "one_month";
        changed = true;
      }
    });
  return changed;
}

function workspaceOwnerSubscription(db, workspace) {
  const owner = db.users.find((user) => user.id === workspace?.ownerUserId);
  return {
    ownerUserId: owner?.id || "",
    ownerName: owner?.name || "Master",
    active: owner?.active !== false,
    inactive: owner?.active === false,
    expiresAt: owner?.subscriptionExpiresAt || "",
    expired: subscriptionExpired(owner?.subscriptionExpiresAt),
  };
}

function masterSubscriptionRows(db) {
  const masterMemberships = new Map();
  db.memberships
    .filter((membership) => membership.role === "Master")
    .forEach((membership) => masterMemberships.set(membership.userId, membership));
  db.workspaces
    .filter((workspace) => workspace.ownerUserId)
    .forEach((workspace) => {
      if (masterMemberships.has(workspace.ownerUserId)) return;
      masterMemberships.set(workspace.ownerUserId, {
        userId: workspace.ownerUserId,
        workspaceId: workspace.id,
        role: "Master",
      });
    });
  return Array.from(masterMemberships.values())
    .map((membership) => {
      const user = db.users.find((item) => item.id === membership.userId);
      const workspace = db.workspaces.find((item) => item.id === membership.workspaceId);
      if (!user) return null;
      return {
        userId: user.id,
        name: user.name || "Unknown",
        email: user.email || "",
        workspace: workspace?.name || "",
        plan: user?.subscriptionPlan || "one_month",
        active: user?.active !== false,
        expiresAt: user?.subscriptionExpiresAt || "",
        expired: subscriptionExpired(user?.subscriptionExpiresAt),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const next = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex"));
}

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sessionIsExpired(session, now = Date.now()) {
  const expiresAt = new Date(session?.expiresAt || 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return true;
  const lastActivityAt = new Date(session?.lastActivityAt || 0).getTime();
  return Number.isFinite(lastActivityAt) && lastActivityAt > 0 && now - lastActivityAt >= sessionIdleMs;
}

function activeSessionRecord(db, sessionId, now = Date.now()) {
  const session = db.sessions.find((item) => item.id === sessionId);
  return session && !sessionIsExpired(session, now) ? session : null;
}

function touchSession(session, now = Date.now()) {
  const timestamp = new Date(now).toISOString();
  session.lastActivityAt = timestamp;
  session.expiresAt = new Date(now + sessionIdleMs).toISOString();
}

function setSessionCookie(response, sessionId) {
  response.setHeader("Set-Cookie", `hp_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionCookieMaxAgeSeconds}`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", "hp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function purgeExpiredSessions(db) {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((session) => !sessionIsExpired(session));
  return db.sessions.length !== before;
}

function publicSessionForRecord(db, session) {
  if (!session) return null;
  if (session.userId === "__owner") {
    return {
      user: { id: "__owner", name: ownerUser, email: ownerUser },
      workspace: { id: "__owner", name: "Owner Console" },
      subscription: { ownerUserId: "__owner", ownerName: ownerUser, active: true, inactive: false, expiresAt: "", expired: false },
      membership: {
        role: "Owner",
        actorId: "OWNER",
        actorName: ownerUser,
        actorRole: "Owner",
        currency: "USD",
        workingCurrencies: [],
      },
    };
  }
  const user = db.users.find((item) => item.id === session.userId);
  const membership = db.memberships.find((item) => item.userId === session.userId && item.workspaceId === session.workspaceId);
  const workspace = db.workspaces.find((item) => item.id === session.workspaceId);
  if (!user || !membership || !workspace) return null;
  const subscription = workspaceOwnerSubscription(db, workspace);
  return {
    user: { id: user.id, name: user.name, email: user.email },
    workspace: { id: workspace.id, name: workspace.name },
    subscription,
    membership: {
      role: membership.role,
      actorId: membership.actorId,
      actorName: membership.actorName,
      actorRole: membership.actorRole,
      currency: membership.currency,
      workingCurrencies: membership.workingCurrencies || [],
    },
  };
}

function publicSession(db, sessionId) {
  return publicSessionForRecord(db, activeSessionRecord(db, sessionId));
}

function workspaceActors(db, workspaceId) {
  return db.memberships
    .filter((membership) => membership.workspaceId === workspaceId)
    .map((membership) => ({
      id: membership.actorId,
      name: membership.actorName,
      role: membership.actorRole,
      currency: membership.currency || "USD",
      workingCurrencies: membership.workingCurrencies || [],
      active: true,
      transferEnabled: true,
      transferMode: "master",
      incomeStatementVisible: true,
    }));
}

function mergeById(existingItems = [], incomingItems = []) {
  const merged = new Map();
  [...existingItems, ...incomingItems].forEach((item) => {
    if (!item || typeof item !== "object" || !item.id) return;
    merged.set(item.id, { ...(merged.get(item.id) || {}), ...item });
  });
  return Array.from(merged.values());
}

function recordTimestamp(item = {}) {
  return Math.max(
    new Date(item.voidRequestedAt || 0).getTime(),
    new Date(item.voidRejectedAt || 0).getTime(),
    new Date(item.voidedAt || 0).getTime(),
    new Date(item.updatedAt || 0).getTime(),
    new Date(item.paidAt || 0).getTime(),
    new Date(item.assignedAt || 0).getTime(),
    new Date(item.approvedAt || 0).getTime(),
    new Date(item.paidOutAt || 0).getTime(),
    new Date(item.rejectedAt || 0).getTime(),
    new Date(item.returnedAt || 0).getTime(),
    new Date(item.sentAt || 0).getTime(),
    new Date(item.createdAt || 0).getTime(),
    0
  );
}

function mergeOrders(existingItems = [], incomingItems = []) {
  const merged = new Map();
  [...existingItems, ...incomingItems].forEach((item) => {
    if (!item || typeof item !== "object" || !item.id) return;
    const previous = merged.get(item.id);
    if (!previous) {
      merged.set(item.id, item);
      return;
    }
    const itemIsNewer = recordTimestamp(item) >= recordTimestamp(previous);
    const next = itemIsNewer ? { ...previous, ...item } : { ...item, ...previous };
    if (previous.journal && !next.journal) next.journal = previous.journal;
    if (item.journal && !next.journal) next.journal = item.journal;
    if (previous.paidAt && !next.paidAt) next.paidAt = previous.paidAt;
    if (item.paidAt && !next.paidAt) next.paidAt = item.paidAt;
    if (previous.voidRequestedAt && !next.voidRequestedAt) next.voidRequestedAt = previous.voidRequestedAt;
    if (item.voidRequestedAt && !next.voidRequestedAt) next.voidRequestedAt = item.voidRequestedAt;
    if (previous.voidRequestedBy && !next.voidRequestedBy) next.voidRequestedBy = previous.voidRequestedBy;
    if (item.voidRequestedBy && !next.voidRequestedBy) next.voidRequestedBy = item.voidRequestedBy;
    if (previous.voidRejectedAt && !next.voidRejectedAt) next.voidRejectedAt = previous.voidRejectedAt;
    if (item.voidRejectedAt && !next.voidRejectedAt) next.voidRejectedAt = item.voidRejectedAt;
    if (previous.voidRejectedBy && !next.voidRejectedBy) next.voidRejectedBy = previous.voidRejectedBy;
    if (item.voidRejectedBy && !next.voidRejectedBy) next.voidRejectedBy = item.voidRejectedBy;
    if (previous.voidJournal && !next.voidJournal) next.voidJournal = previous.voidJournal;
    if (item.voidJournal && !next.voidJournal) next.voidJournal = item.voidJournal;
    if (previous.voidedAt && !next.voidedAt) next.voidedAt = previous.voidedAt;
    if (item.voidedAt && !next.voidedAt) next.voidedAt = item.voidedAt;
    if (previous.voidedBy && !next.voidedBy) next.voidedBy = previous.voidedBy;
    if (item.voidedBy && !next.voidedBy) next.voidedBy = item.voidedBy;
    const latestVoidRequest = Math.max(new Date(next.voidRequestedAt || 0).getTime(), 0);
    const latestVoidReject = Math.max(new Date(next.voidRejectedAt || 0).getTime(), 0);
    const hasOpenVoidRequest = (previous.state === "Void Requested" || item.state === "Void Requested" || previous.voidRequested || item.voidRequested) &&
      latestVoidRequest >= latestVoidReject;
    if (!hasOpenVoidRequest && (previous.state === "Paid" || item.state === "Paid" || next.paidAt || next.journal)) {
      next.state = "Paid";
      next.returnedBy = "";
      next.returnedReason = "";
      next.returnedAt = "";
    }
    if (hasOpenVoidRequest) {
      next.state = "Void Requested";
      next.voidRequested = true;
    }
    if (previous.state === "Voided" || item.state === "Voided") next.state = "Voided";
    merged.set(item.id, next);
  });
  return Array.from(merged.values());
}

function mergeTransfers(existingItems = [], incomingItems = []) {
  const merged = new Map();
  [...existingItems, ...incomingItems].forEach((item) => {
    if (!item || typeof item !== "object" || !item.id) return;
    const previous = merged.get(item.id);
    if (!previous) {
      merged.set(item.id, item);
      return;
    }
    const itemIsNewer = recordTimestamp(item) >= recordTimestamp(previous);
    const next = itemIsNewer ? { ...previous, ...item } : { ...item, ...previous };
    if (previous.journal && !next.journal) next.journal = previous.journal;
    if (item.journal && !next.journal) next.journal = item.journal;
    if (previous.approvedAt && !next.approvedAt) next.approvedAt = previous.approvedAt;
    if (item.approvedAt && !next.approvedAt) next.approvedAt = item.approvedAt;
    if (previous.paidOutAt && !next.paidOutAt) next.paidOutAt = previous.paidOutAt;
    if (item.paidOutAt && !next.paidOutAt) next.paidOutAt = item.paidOutAt;
    if ((previous.state === "Approved" || item.state === "Approved") && next.journal) next.state = "Approved";
    merged.set(item.id, next);
  });
  return Array.from(merged.values());
}

function nextOrderNumberFromOrders(orders = []) {
  return orders.reduce((next, order) => {
    const match = String(order?.id || "").match(/^ORD-(\d+)$/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function nextReceivableNumberFromReceivables(receivables = []) {
  return receivables.reduce((next, receivable) => {
    const match = String(receivable?.id || "").match(/^REC-(\d+)$/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function nextTransferNumberFromTransfers(transfers = []) {
  return transfers.reduce((next, transfer) => {
    const match = String(transfer?.id || "").match(/^TRF-(\d+)$/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function nextJournalNumberFromLedger(ledger = []) {
  return ledger.reduce((next, line) => {
    const match = String(line?.journal || "").match(/^JRN-(\d+)$/);
    return match ? Math.max(next, Number(match[1]) - 999) : next;
  }, 1);
}

function mergeByKey(existingItems = [], incomingItems = [], keyForItem) {
  const merged = new Map();
  [...existingItems, ...incomingItems].forEach((item) => {
    if (!item || typeof item !== "object") return;
    const key = keyForItem(item);
    if (!key) return;
    merged.set(key, { ...(merged.get(key) || {}), ...item });
  });
  return Array.from(merged.values());
}

function mergeChatConversations(existingItems = [], incomingItems = []) {
  const merged = mergeById(existingItems, incomingItems);
  return merged.map((chat) => {
    const existing = existingItems.find((item) => item.id === chat.id);
    const incoming = incomingItems.find((item) => item.id === chat.id);
    return {
      ...chat,
      messages: mergeById(existing?.messages, incoming?.messages),
    };
  });
}

function mergeReceivables(existingItems = [], incomingItems = []) {
  const merged = mergeById(existingItems, incomingItems);
  return merged.map((receivable) => {
    const existing = existingItems.find((item) => item.id === receivable.id);
    const incoming = incomingItems.find((item) => item.id === receivable.id);
    const next = {
      ...receivable,
      payments: mergeById(existing?.payments || [], incoming?.payments || []),
    };
    if (existing?.voided || incoming?.voided) next.voided = true;
    if (existing?.voidedAt && !next.voidedAt) next.voidedAt = existing.voidedAt;
    if (incoming?.voidedAt && !next.voidedAt) next.voidedAt = incoming.voidedAt;
    if (existing?.voidedBy && !next.voidedBy) next.voidedBy = existing.voidedBy;
    if (incoming?.voidedBy && !next.voidedBy) next.voidedBy = incoming.voidedBy;
    return next;
  });
}

function mergeWorkspaceState(db, workspaceId, incomingState = {}) {
  const currentState = db.appStates[workspaceId] || {};
  const nextState = { ...currentState, ...incomingState };
  const membershipActors = workspaceActors(db, workspaceId);
  const activeActorIds = new Set(membershipActors.map((actor) => actor.id));
  const deletedActorIds = new Set([...(currentState.deletedActorIds || []), ...(incomingState.deletedActorIds || [])]);
  const deletedChatIds = new Set([...(currentState.deletedChatIds || []), ...(incomingState.deletedChatIds || [])]);
  activeActorIds.forEach((actorId) => deletedActorIds.delete(actorId));
  nextState.actors = mergeById(currentState.actors, incomingState.actors);
  nextState.actors = nextState.actors.filter((actor) => !deletedActorIds.has(actor?.id));
  nextState.orders = mergeOrders(currentState.orders, incomingState.orders);
  nextState.receivables = mergeReceivables(currentState.receivables, incomingState.receivables);
  nextState.transfers = mergeTransfers(currentState.transfers, incomingState.transfers);
  nextState.ledger = mergeByKey(currentState.ledger, incomingState.ledger, (line) =>
    [line.journal, line.source, line.account, line.direction, line.currency, line.amountMinor, line.postedAt].join(":")
  );
  nextState.archives = mergeByKey(currentState.archives, incomingState.archives, (archive) =>
    archive.id || [archive.actor, archive.closedAt, archive.closedBy].join(":")
  );
  nextState.chatConversations = mergeChatConversations(currentState.chatConversations, incomingState.chatConversations)
    .filter((chat) => !deletedChatIds.has(chat?.id));
  nextState.actors = mergeById(membershipActors, nextState.actors);
  nextState.actors = nextState.actors.filter((actor) => activeActorIds.has(actor?.id) || !deletedActorIds.has(actor?.id));
  nextState.deletedActorIds = Array.from(deletedActorIds);
  nextState.deletedActorNames = [];
  nextState.deletedChatIds = Array.from(deletedChatIds);
  nextState.orderCounter = Math.max(Number(currentState.orderCounter || 0), Number(incomingState.orderCounter || 0), nextOrderNumberFromOrders(nextState.orders) - 1);
  nextState.receivableCounter = Math.max(Number(currentState.receivableCounter || 0), Number(incomingState.receivableCounter || 0), nextReceivableNumberFromReceivables(nextState.receivables) - 1);
  nextState.transferCounter = Math.max(Number(currentState.transferCounter || 0), Number(incomingState.transferCounter || 0), nextTransferNumberFromTransfers(nextState.transfers) - 1);
  nextState.journalCounter = Math.max(Number(currentState.journalCounter || 0), Number(incomingState.journalCounter || 0), nextJournalNumberFromLedger(nextState.ledger) - 1);
  return nextState;
}

function resetWorkspaceState(db, workspaceId, scope = "data") {
  const currentState = db.appStates[workspaceId] || {};
  const allActors = mergeById(workspaceActors(db, workspaceId), currentState.actors || []);
  const masterActor = allActors.find((actor) => actor?.role === "Master") || {
    id: "ACT-0",
    name: "Master",
    role: "Master",
    currency: "USD",
    active: true,
    transferEnabled: true,
    transferMode: "both",
  };
  const actors = scope === "wipe"
    ? [{ ...masterActor, id: "ACT-0", name: "Master", role: "Master", active: true, transferEnabled: true, transferMode: "both" }]
    : allActors;
  const removedActors = scope === "wipe" ? allActors.filter((actor) => actor?.role !== "Master") : [];
  const nextState = {
    ...currentState,
    actors,
    orders: [],
    receivables: [],
    transfers: [],
    ledger: [],
    archives: [],
    settlements: scope === "wipe"
      ? []
      : actors
        .filter((actor) => actor?.role !== "Master")
        .map((actor) => ({ actor: actor.name, currency: actor.currency || "USD", netMinor: 0 })),
    journalCounter: 0,
    orderCounter: 0,
    receivableCounter: 0,
    transferCounter: 0,
    editingOrderId: "",
    editingTransferId: "",
    selectedLedgerActor: "",
    expandedFixedRateActorId: "",
    expandedSpecialDividerActorId: "",
    orderState: "Draft",
  };
  if (scope === "wipe") {
    nextState.actorCounter = Number(currentState.actorCounter || 0);
    nextState.selectedActorId = "ACT-0";
    nextState.chatConversations = [];
    nextState.chatCounter = 0;
    nextState.messageCounter = 0;
    nextState.deletedActorIds = Array.from(new Set([...(currentState.deletedActorIds || []), ...removedActors.map((actor) => actor.id).filter(Boolean)]));
    nextState.deletedActorNames = Array.from(new Set([...(currentState.deletedActorNames || []), ...removedActors.map((actor) => actor.name).filter(Boolean)]));
  }
  return nextState;
}

async function requireSession(request, response, db) {
  const sessionId = parseCookies(request).hp_session;
  const sessionRecord = activeSessionRecord(db, sessionId);
  const session = publicSessionForRecord(db, sessionRecord);
  if (!session) {
    clearSessionCookie(response);
    sendJson(response, 401, { error: "Please log in." });
    return null;
  }
  if (session.subscription.expired) {
    sendJson(response, 402, { error: "This workspace subscription has expired." });
    return null;
  }
  if (session.subscription.inactive) {
    sendJson(response, 403, { error: "This workspace is inactive." });
    return null;
  }
  touchSession(sessionRecord);
  setSessionCookie(response, sessionRecord.id);
  await saveDb(db);
  return session;
}

function requireOwner(session, response) {
  if (session.membership.role !== "Owner") {
    sendJson(response, 403, { error: "Only Owner can perform this action." });
    return false;
  }
  return true;
}

function createSession(db, userId, workspaceId) {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const session = {
    id: id("sess"),
    userId,
    workspaceId,
    createdAt: timestamp,
    lastActivityAt: timestamp,
    expiresAt: new Date(now + sessionIdleMs).toISOString(),
  };
  db.sessions.push(session);
  return session;
}

async function handleApi(request, response, url) {
  const db = await loadDb();
  const method = request.method || "GET";
  const removedExpiredInvites = purgeExpiredInvites(db);
  const removedExpiredSessions = purgeExpiredSessions(db);
  const addedMissingSubscriptions = ensureMasterSubscriptions(db);
  if (removedExpiredInvites || removedExpiredSessions || addedMissingSubscriptions) {
    await saveDb(db, { replace: removedExpiredInvites || removedExpiredSessions });
  }

  if (url.pathname === "/api/session" && method === "GET") {
    const sessionId = parseCookies(request).hp_session;
    const sessionRecord = activeSessionRecord(db, sessionId);
    const session = publicSessionForRecord(db, sessionRecord);
    if (sessionRecord && session) {
      touchSession(sessionRecord);
      setSessionCookie(response, sessionRecord.id);
      await saveDb(db);
    } else {
      clearSessionCookie(response);
    }
    sendJson(response, 200, { session });
    return;
  }

  if (url.pathname === "/api/auth/signup" && method === "POST") {
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = body.role === "Master" ? "Master" : "Actor";
    if (!name || !email || password.length < 6) return sendJson(response, 400, { error: "Enter name, email, and a password of at least 6 characters." });
    if (db.users.some((user) => user.email === email)) return sendJson(response, 409, { error: "That email already has an account." });
    if (role === "Master") return sendJson(response, 403, { error: "Master accounts are created by Owner." });

    const user = { id: id("usr"), name, email, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    let workspace;
    let membership;

    if (role === "Master") {
      const planId = subscriptionPlans.has(body.subscriptionPlan) ? body.subscriptionPlan : "one_month";
      const plan = subscriptionPlan(planId);
      user.subscriptionPlan = planId;
      user.subscriptionExpiresAt = addDays(Date.now(), plan.days);
      workspace = { id: id("ws"), name: `${name} Workspace`, ownerUserId: user.id, createdAt: new Date().toISOString() };
      membership = {
        id: id("mem"),
        userId: user.id,
        workspaceId: workspace.id,
        role: "Master",
        actorId: "ACT-0",
        actorName: "Master",
        actorRole: "Master",
        currency: "USD",
        workingCurrencies: [],
        createdAt: new Date().toISOString(),
      };
      db.workspaces.push(workspace);
    } else {
      const code = String(body.inviteCode || "").trim().toUpperCase();
      const invite = db.invites.find((item) => item.code === code && !item.acceptedAt);
      if (!invite) return sendJson(response, 400, { error: "Enter a valid unused invite code from Master." });
      workspace = db.workspaces.find((item) => item.id === invite.workspaceId);
      if (!workspace) return sendJson(response, 400, { error: "Invite workspace was not found." });
      membership = {
        id: id("mem"),
        userId: user.id,
        workspaceId: workspace.id,
        role: "Actor",
        actorId: invite.actorId || id("act"),
        actorName: name,
        actorRole: invite.actorRole || "Agent",
        currency: invite.currency || "USD",
        workingCurrencies: invite.workingCurrencies || [],
        createdAt: new Date().toISOString(),
      };
      invite.acceptedAt = new Date().toISOString();
      invite.acceptedByUserId = user.id;
    }

    db.users.push(user);
    db.memberships.push(membership);
    const session = createSession(db, user.id, workspace.id);
    await saveDb(db);
    setSessionCookie(response, session.id);
    sendJson(response, 200, { session: publicSession(db, session.id) });
    return;
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const body = await readJson(request);
    const rawLogin = String(body.email || body.username || "").trim();
    const rawPassword = String(body.password || "").trim();
    if (
      rawLogin.toLowerCase() === ownerUser.toLowerCase() &&
      (db.ownerPasswordHash ? verifyPassword(rawPassword, db.ownerPasswordHash) : rawPassword === ownerPassword)
    ) {
      const session = createSession(db, "__owner", "__owner");
      await saveDb(db);
      setSessionCookie(response, session.id);
      sendJson(response, 200, { session: publicSession(db, session.id) });
      return;
    }
    const email = rawLogin.toLowerCase();
    const user = db.users.find((item) => item.email === email);
    if (!user || !verifyPassword(body.password, user.passwordHash)) return sendJson(response, 401, { error: "Email or password is incorrect." });
    const membership = db.memberships.find((item) => item.userId === user.id);
    if (!membership) return sendJson(response, 401, { error: "This account is not linked to a workspace." });
    const workspace = db.workspaces.find((item) => item.id === membership.workspaceId);
    const subscription = workspaceOwnerSubscription(db, workspace);
    if (membership.role === "Master" && user.active === false) return sendJson(response, 403, { error: "This Master account is inactive." });
    if (subscription.inactive) return sendJson(response, 403, { error: "This workspace is inactive." });
    if (subscription.expired) return sendJson(response, 402, { error: "This workspace subscription has expired." });
    const session = createSession(db, user.id, membership.workspaceId);
    await saveDb(db);
    setSessionCookie(response, session.id);
    sendJson(response, 200, { session: publicSession(db, session.id) });
    return;
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    const sessionId = parseCookies(request).hp_session;
    const nextDb = { ...db, sessions: db.sessions.filter((item) => item.id !== sessionId) };
    await saveDb(nextDb, { replace: true });
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  const session = await requireSession(request, response, db);
  if (!session) return;

  if (url.pathname === "/api/auth/password" && method === "POST") {
    const body = await readJson(request);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 6) return sendJson(response, 400, { error: "Enter a new password of at least 6 characters." });
    if (session.user.id === "__owner") {
      const ownerMatches = db.ownerPasswordHash
        ? verifyPassword(currentPassword, db.ownerPasswordHash)
        : currentPassword === ownerPassword;
      if (!ownerMatches) return sendJson(response, 401, { error: "Current password is incorrect." });
      db.ownerPasswordHash = hashPassword(newPassword);
      await saveDb(db);
      sendJson(response, 200, { ok: true });
      return;
    }
    const user = db.users.find((item) => item.id === session.user.id);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) return sendJson(response, 401, { error: "Current password is incorrect." });
    user.passwordHash = hashPassword(newPassword);
    await saveDb(db);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/owner/masters" && method === "GET") {
    if (!requireOwner(session, response)) return;
    sendJson(response, 200, {
      plans: Array.from(subscriptionPlans.entries()).map(([id, plan]) => ({ id, label: plan.label })),
      users: masterSubscriptionRows(db),
      currentUserId: session.user.id,
    });
    return;
  }

  if (url.pathname === "/api/owner/masters" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !email || password.length < 6) return sendJson(response, 400, { error: "Enter Master name, email, and a password of at least 6 characters." });
    if (db.users.some((user) => user.email === email)) return sendJson(response, 409, { error: "That email already has an account." });
    const planId = subscriptionPlans.has(body.plan) ? body.plan : "one_month";
    const plan = subscriptionPlan(planId);
    const user = {
      id: id("usr"),
      name,
      email,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
      active: true,
      subscriptionPlan: planId,
      subscriptionExpiresAt: addDays(Date.now(), plan.days),
    };
    const workspace = { id: id("ws"), name: `${name} Workspace`, ownerUserId: user.id, createdAt: new Date().toISOString() };
    const membership = {
      id: id("mem"),
      userId: user.id,
      workspaceId: workspace.id,
      role: "Master",
      actorId: "ACT-0",
      actorName: "Master",
      actorRole: "Master",
      currency: "USD",
      workingCurrencies: [],
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    db.workspaces.push(workspace);
    db.memberships.push(membership);
    await saveDb(db);
    sendJson(response, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, subscriptionExpiresAt: user.subscriptionExpiresAt } });
    return;
  }

  if (url.pathname === "/api/owner/masters/active" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const userId = String(body.userId || "");
    const targetUser = db.users.find((user) => user.id === userId);
    const targetMembership = db.memberships.find((membership) => membership.userId === userId && membership.role === "Master");
    if (!targetUser || !targetMembership) return sendJson(response, 404, { error: "Master user was not found." });
    targetUser.active = body.active === true;
    await saveDb(db);
    sendJson(response, 200, { ok: true, user: { id: targetUser.id, active: targetUser.active } });
    return;
  }

  if (url.pathname === "/api/owner/subscriptions/extend" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const userId = String(body.userId || "");
    const targetUser = db.users.find((user) => user.id === userId);
    const targetMembership = db.memberships.find((membership) => membership.userId === userId && membership.role === "Master");
    if (!targetUser || !targetMembership) return sendJson(response, 404, { error: "Master user was not found." });
    const planId = subscriptionPlans.has(body.plan) ? body.plan : "one_month";
    const plan = subscriptionPlan(planId);
    const currentExpiry = new Date(targetUser.subscriptionExpiresAt || 0).getTime();
    const startsAt = body.mode === "reset" ? Date.now() : Math.max(Date.now(), Number.isFinite(currentExpiry) ? currentExpiry : 0);
    targetUser.subscriptionPlan = planId;
    targetUser.subscriptionExpiresAt = addDays(startsAt, plan.days);
    await saveDb(db);
    sendJson(response, 200, { ok: true, user: { id: targetUser.id, subscriptionExpiresAt: targetUser.subscriptionExpiresAt } });
    return;
  }

  if (url.pathname === "/api/invites" && method === "GET") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can view invites." });
    const invites = db.invites
      .filter((item) => item.workspaceId === session.workspace.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((invite) => {
        const membership = db.memberships.find((item) =>
          item.workspaceId === invite.workspaceId &&
          item.actorId === invite.actorId &&
          (!invite.acceptedByUserId || item.userId === invite.acceptedByUserId)
        );
        return {
          ...invite,
          actorName: membership?.actorName || "",
        };
      });
    sendJson(response, 200, { invites });
    return;
  }

  if (url.pathname === "/api/invites" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can create invites." });
    const body = await readJson(request);
    const actorRole = ["Broker", "Agent", "Special Broker", "Special Agent"].includes(body.actorRole) ? body.actorRole : "Agent";
    const currency = ["USD", "ETB", "EUR", "ERN"].includes(body.currency) ? body.currency : "USD";
    const workingCurrencies = Array.isArray(body.workingCurrencies)
      ? body.workingCurrencies.filter((item) => ["USD", "ETB", "EUR", "ERN"].includes(item)).slice(0, 5)
      : [];
    const invite = {
      id: id("inv"),
      code: inviteCode(),
      workspaceId: session.workspace.id,
      actorRole,
      currency,
      workingCurrencies: actorRole === "Special Agent" ? Array.from(new Set([currency, ...workingCurrencies])).slice(0, 5) : [],
      actorId: id("act"),
      createdByUserId: session.user.id,
      createdAt: new Date().toISOString(),
      acceptedAt: "",
      acceptedByUserId: "",
    };
    db.invites.push(invite);
    await saveDb(db);
    sendJson(response, 200, { invite });
    return;
  }

  if (url.pathname === "/api/app-state" && method === "GET") {
    const currentState = db.appStates[session.workspace.id] || {};
    const state = mergeWorkspaceState(db, session.workspace.id, currentState);
    db.appStates[session.workspace.id] = state;
    await saveDb(db);
    sendJson(response, 200, { state });
    return;
  }

  if (url.pathname === "/api/app-state/remove-actor" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can remove actors." });
    const body = await readJson(request);
    const actorId = String(body.actorId || "");
    const actorName = String(body.actorName || "");
    if (!actorId || actorId === "ACT-0") return sendJson(response, 400, { error: "Choose an actor to remove." });
    const removedActorUserIds = db.memberships
      .filter((membership) =>
        membership.workspaceId === session.workspace.id &&
        membership.role !== "Master" &&
        (membership.actorId === actorId || membership.actorName === actorName)
      )
      .map((membership) => membership.userId);
    db.memberships = db.memberships.filter((membership) =>
      membership.workspaceId !== session.workspace.id ||
      membership.role === "Master" ||
      (membership.actorId !== actorId && membership.actorName !== actorName)
    );
    db.invites = db.invites.filter((invite) =>
      invite.workspaceId !== session.workspace.id ||
      (invite.actorId !== actorId &&
        invite.actorName !== actorName &&
        !removedActorUserIds.includes(invite.acceptedByUserId))
    );
    db.users = db.users.filter((user) => !removedActorUserIds.includes(user.id));
    db.sessions = db.sessions.filter((item) =>
      item.workspaceId !== session.workspace.id || !removedActorUserIds.includes(item.userId)
    );
    const currentState = db.appStates[session.workspace.id] || {};
    const nextState = { ...currentState };
    nextState.deletedActorIds = Array.from(new Set([...(currentState.deletedActorIds || []), actorId]));
    nextState.deletedActorNames = Array.from(new Set([...(currentState.deletedActorNames || []), actorName].filter(Boolean)));
    nextState.actors = (currentState.actors || []).filter((actor) => actor?.id !== actorId);
    nextState.settlements = (currentState.settlements || []).filter((item) => item?.actor !== actorName);
    if (nextState.selectedLedgerActor === actorName) nextState.selectedLedgerActor = "";
    if (nextState.expandedFixedRateActorId === actorId) nextState.expandedFixedRateActorId = "";
    if (nextState.expandedSpecialDividerActorId === actorId) nextState.expandedSpecialDividerActorId = "";
    db.appStates[session.workspace.id] = nextState;
    await saveDb(db, { replace: true });
    sendJson(response, 200, { ok: true, state: nextState });
    return;
  }

  if (url.pathname === "/api/app-state/reset" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can reset workspace data." });
    const body = await readJson(request);
    const scope = body.scope === "wipe" ? "wipe" : "data";
    let removedActorIds = [];
    let removedActorNames = [];
    if (scope === "wipe") {
      const removedActorMemberships = db.memberships
        .filter((membership) => membership.workspaceId === session.workspace.id && membership.role !== "Master");
      const removedActorInvites = db.invites.filter((invite) => invite.workspaceId === session.workspace.id);
      const removedActorUserIds = Array.from(new Set([
        ...removedActorMemberships.map((membership) => membership.userId),
        ...removedActorInvites.map((invite) => invite.acceptedByUserId).filter(Boolean)
      ]));
      removedActorIds = Array.from(new Set([
        ...removedActorMemberships.map((membership) => membership.actorId).filter(Boolean),
        ...removedActorInvites.map((invite) => invite.actorId).filter(Boolean)
      ]));
      removedActorNames = removedActorMemberships.map((membership) => membership.actorName).filter(Boolean);
      db.memberships = db.memberships.filter((membership) =>
        membership.workspaceId !== session.workspace.id || membership.role === "Master"
      );
      db.invites = db.invites.filter((invite) => invite.workspaceId !== session.workspace.id);
      db.users = db.users.filter((user) => !removedActorUserIds.includes(user.id));
      db.sessions = db.sessions.filter((item) =>
        item.workspaceId !== session.workspace.id || !removedActorUserIds.includes(item.userId)
      );
    }
    const nextState = resetWorkspaceState(db, session.workspace.id, scope);
    if (scope === "wipe") {
      nextState.deletedActorIds = Array.from(new Set([...(nextState.deletedActorIds || []), ...removedActorIds]));
      nextState.deletedActorNames = Array.from(new Set([...(nextState.deletedActorNames || []), ...removedActorNames]));
      nextState.actors = (nextState.actors || []).filter((actor) => actor?.role === "Master");
    }
    db.appStates[session.workspace.id] = nextState;
    await saveDb(db, { replace: scope === "wipe" });
    sendJson(response, 200, { ok: true, state: nextState });
    return;
  }

  if (url.pathname === "/api/app-state" && method === "PUT") {
    const body = await readJson(request);
    db.appStates[session.workspace.id] = mergeWorkspaceState(db, session.workspace.id, body.state || {});
    await saveDb(db);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "API route not found." });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const relativePath = pathname === "/" ? "preview.html" : pathname.slice(1);
    const filePath = path.resolve(root, relativePath);

    if (!filePath.startsWith(root)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
    });
    response.end(body);
  } catch (error) {
    if (request.url?.startsWith("/api/")) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Server error." });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`HaderaPay running at http://${host}:${port}`);
});
