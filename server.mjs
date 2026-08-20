import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  backfillAllClosedActorOrderSnapshots,
  backfillClosedParticipantOrderSnapshots,
} from "./src/archiveParticipantBackfill.mjs";
import { closeActorBalance } from "./src/closeActorBalance.mjs";
import { removeExactDuplicateOrders } from "./src/exactDuplicateOrderCleanup.mjs";
import { repairOrderJournalCollisions } from "./src/orderJournalCollisions.mjs";
import { retainOrdersForOpenParticipants } from "./src/orderParticipantRetention.mjs";
import {
  findPendingOrderIntegrityIssues,
  nextBrokerOrderNumberForActor,
  recoveredOrderMatches,
  removeRecoveredOrderAliases,
} from "./src/orderIntegrity.mjs";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dbPath = path.join(dataDir, "auth-db.json");
const inviteTtlMs = 1000 * 60 * 60;
const ownerUser = process.env.OWNER_USER ?? "Owner";
const ownerPassword = process.env.OWNER_PASSWORD;
if (typeof ownerPassword !== "string" || ownerPassword.length < 12) {
  throw new Error("OWNER_PASSWORD is required and must contain at least 12 characters.");
}
const maxJsonBodyBytes = 12 * 1024 * 1024;
const supportedCurrencies = ["USD", "ETB", "EUR", "ERN", "SSP", "SDG", "LYD"];
const supportedCurrencySet = new Set(supportedCurrencies);
const r2AccountId = String(process.env.R2_ACCOUNT_ID || "").trim();
const r2BucketName = String(process.env.R2_BUCKET_NAME || "").trim();
const r2AccessKeyId = String(process.env.R2_ACCESS_KEY_ID || "").trim();
const r2SecretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || "");
const r2Endpoint = String(process.env.R2_ENDPOINT || (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : "")).replace(/\/+$/, "");
const r2Configured = Boolean(r2BucketName && r2AccessKeyId && r2SecretAccessKey && r2Endpoint);
const r2Client = r2Configured
  ? new S3Client({
    region: "auto",
    endpoint: r2Endpoint,
    credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  : null;
const signedUploadSeconds = 5 * 60;
const signedDownloadSeconds = 2 * 60;
const attachmentRules = new Map([
  ["payment-proof", {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: new Set([
      "image/jpeg",
      "image/png",
    ]),
  }],
  ["chat-photo", {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: new Set(["image/jpeg", "image/png", "image/webp"]),
  }],
  ["order-photo", {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: new Set(["image/jpeg", "image/png", "image/webp"]),
  }],
  ["chat-voice", {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: new Set(["audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"]),
  }],
  ["chat-file", {
    maxBytes: 8 * 1024 * 1024,
    mimeTypes: new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]),
  }],
]);
let saveQueue = Promise.resolve();
const allowedSessionIdleSeconds = new Set([0, 10, 20, 30, 60, 300, 900, 1800, 3600, 7200]);
const defaultSessionIdleSeconds = 7200;
const persistentSessionCookieMaxAgeSeconds = 10 * 365 * 24 * 60 * 60;
const loginLockMs = 1000 * 60 * 60;
const loginAttemptWindowMs = 1000 * 60 * 60;
const deviceLoginWarningMs = 1000 * 60;
const subscriptionExpiryWarningMs = 5 * 24 * 60 * 60 * 1000;
const subscriptionReadOnlyGraceMs = 30 * 24 * 60 * 60 * 1000;
const loginOperationLocks = new Map();
const subscriptionPlans = new Map([
  ["one_day", { label: "1 day", days: 1 }],
  ["three_days", { label: "3 days", days: 3 }],
  ["one_week", { label: "1 week", days: 7 }],
  ["one_month", { label: "1 month", days: 30 }],
  ["three_months", { label: "3 months", days: 90 }],
  ["six_months", { label: "6 months", days: 180 }],
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
  [".apk", "application/vnd.android.package-archive"],
  [".ttf", "font/ttf"],
]);

const blankDb = () => ({
  users: [],
  workspaces: [],
  memberships: [],
  invites: [],
  sessions: [],
  appStates: {},
  files: [],
  ownerPasswordHash: "",
  ownerIdleTimeoutSeconds: defaultSessionIdleSeconds,
  loginAttempts: {},
});

async function readPersistedDb() {
  try {
    return { ...blankDb(), ...JSON.parse(await readFile(dbPath, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`The HaderaPay database could not be read safely: ${error instanceof Error ? error.message : "unknown error"}`);
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

function mergeSessionsById(existingItems = [], incomingItems = []) {
  const merged = new Map(existingItems
    .filter((item) => item?.id)
    .map((item) => [item.id, item]));
  incomingItems.forEach((incoming) => {
    if (!incoming?.id) return;
    const existing = merged.get(incoming.id);
    if (!existing) {
      merged.set(incoming.id, incoming);
      return;
    }
    const existingActivity = new Date(existing.lastActivityAt || 0).getTime();
    const incomingActivity = new Date(incoming.lastActivityAt || 0).getTime();
    merged.set(
      incoming.id,
      incomingActivity >= existingActivity
        ? { ...existing, ...incoming }
        : { ...incoming, ...existing }
    );
  });
  return Array.from(merged.values());
}

function mergeAppStates(existingStates = {}, incomingStates = {}) {
  return Object.fromEntries(
    Array.from(new Set([...Object.keys(existingStates || {}), ...Object.keys(incomingStates || {})])).map((workspaceId) => {
      const existingState = existingStates?.[workspaceId] || {};
      const incomingState = incomingStates?.[workspaceId] || {};
      const existingRevision = String(existingState._syncRevision || "");
      const incomingRevision = String(incomingState._syncRevision || "");
      const archives = mergeArchiveSnapshots(existingState.archives, incomingState.archives);
      const deletedOrderIds = Array.from(new Set([
        ...(Array.isArray(existingState.deletedOrderIds) ? existingState.deletedOrderIds : []),
        ...(Array.isArray(incomingState.deletedOrderIds) ? incomingState.deletedOrderIds : []),
      ].filter(Boolean).map(String)));
      const effectiveState = { ...existingState, ...incomingState };
      const orders = removeOrdersAlreadyArchived(
        mergeOrders(existingState.orders, incomingState.orders),
        archives,
        deletedOrderIds,
        effectiveState.ledger,
        effectiveState.actors
      );
      return [
        workspaceId,
        {
          ...existingState,
          ...incomingState,
          orders,
          archives,
          deletedOrderIds,
          ...(incomingRevision || existingRevision ? { _syncRevision: incomingRevision || existingRevision } : {}),
        },
      ];
    })
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
    sessions: mergeSessionsById(existingDb.sessions, incomingDb.sessions),
    appStates: { ...(existingDb.appStates || {}) },
    files: mergeRecordsById(existingDb.files, incomingDb.files),
    loginAttempts: { ...(incomingDb.loginAttempts || {}) },
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

async function writePersistedDbAtomic(db) {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(db, null, 2));
  await rename(tempPath, dbPath);
}

function enqueueDbWrite(operation) {
  const queued = saveQueue.then(operation, operation);
  saveQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

async function saveDb(db, options = {}) {
  await enqueueDbWrite(async () => {
    const persistedDb = await readPersistedDb();
    for (const [workspaceId, expectedRevision] of Object.entries(options.expectedAppStateRevisions || {})) {
      if (workspaceStateRevision(persistedDb || blankDb(), workspaceId) !== String(expectedRevision || "0")) {
        throw httpError(409, "The workspace changed before this action finished. Refresh and try again.");
      }
    }
    const nextDb = options.replace === true
      ? {
          ...blankDb(),
          ...db,
          appStates: { ...(persistedDb?.appStates || {}) },
        }
      : mergeDatabase(persistedDb, db);
    for (const [workspaceId, nextState] of Object.entries(options.appStateUpdates || {})) {
      if (nextState === null) delete nextDb.appStates[workspaceId];
      else nextDb.appStates[workspaceId] = nextState;
    }
    await writePersistedDbAtomic(nextDb);
  });
}

async function mutateLatestWorkspaceState(workspaceId, expectedRevision, mutate) {
  return enqueueDbWrite(async () => {
    const latestDb = await readPersistedDb();
    if (!latestDb) throw httpError(503, "The workspace database is unavailable.");
    const actualRevision = workspaceStateRevision(latestDb, workspaceId);
    if (String(expectedRevision || "") !== actualRevision) {
      throw httpError(409, "The workspace changed before this action finished. Refresh and try again.");
    }
    const result = await mutate(latestDb, latestDb.appStates?.[workspaceId] || {});
    await writePersistedDbAtomic(latestDb);
    return result;
  });
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function workspaceStateRevision(db, workspaceId) {
  return String(db.appStates?.[workspaceId]?._syncRevision || "0");
}

function markWorkspaceStateChanged(db, workspaceId, state = db.appStates?.[workspaceId] || {}) {
  const revision = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
  state._syncRevision = revision;
  db.appStates[workspaceId] = state;
  return revision;
}

function workspaceStateSaveOptions(db, workspaceId, expectedRevision) {
  return {
    expectedAppStateRevisions: { [workspaceId]: String(expectedRevision || "0") },
    appStateUpdates: { [workspaceId]: db.appStates?.[workspaceId] || {} },
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireR2() {
  if (!r2Client) throw httpError(503, "File storage is not configured. Check the R2 environment variables in Render.");
  return r2Client;
}

function normalizedMimeType(value) {
  return String(value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

function safeAttachmentFileName(value, fallback = "attachment") {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 140);
  return cleaned || fallback;
}

function safeObjectSegment(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || fallback;
}

function publicFileRecord(file) {
  return {
    id: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: Number(file.size || file.expectedSize || 0),
    purpose: file.purpose,
    createdAt: file.createdAt,
  };
}

function attachmentRule(purpose, mimeType, size) {
  const rule = attachmentRules.get(purpose);
  if (!rule) throw httpError(400, "This attachment type is not supported.");
  const normalizedType = normalizedMimeType(mimeType);
  if (!rule.mimeTypes.has(normalizedType)) throw httpError(400, "This file format is not supported for the selected attachment.");
  if (!Number.isSafeInteger(size) || size <= 0) throw httpError(400, "The attachment is empty or its size is unavailable.");
  if (size > rule.maxBytes) throw httpError(413, `The attachment exceeds the ${Math.round(rule.maxBytes / 1024 / 1024)} MB limit.`);
  return { ...rule, mimeType: normalizedType };
}

function sessionCanUseChat(state, session, chatId) {
  const chat = (state?.chatConversations || []).find((item) => item?.id === chatId);
  const actorName = String(session?.membership?.actorName || "");
  return Boolean(chat && actorName && (chat.members || []).includes(actorName));
}

function orderParticipantMatchesIdentity(order, role, actorId, actorName) {
  const participantActorId = String(role === "broker" ? order?.brokerActorId || "" : order?.agentActorId || "");
  const participantName = String(role === "broker" ? order?.broker || "" : order?.agent || "");
  if (participantActorId) return Boolean(actorId && participantActorId === actorId);
  return Boolean(actorName && participantName === actorName);
}

function sessionCanUseOrder(state, session, orderId, { payment = false } = {}) {
  const order = (state?.orders || []).find((item) => item?.id === orderId);
  if (!order) return false;
  if (session?.membership?.role === "Master") return true;
  const actorId = String(session?.membership?.actorId || "");
  const actorName = String(session?.membership?.actorName || "");
  const payerMatches = orderParticipantMatchesIdentity(order, "agent", actorId, actorName);
  if (payment) return order.state === "Assigned" && payerMatches;
  return payerMatches || orderParticipantMatchesIdentity(order, "broker", actorId, actorName);
}

function validateAttachmentContext(db, session, purpose, contextId) {
  const state = db.appStates[session.workspace.id] || {};
  if (purpose === "payment-proof") {
    if (!contextId || !sessionCanUseOrder(state, session, contextId, { payment: true })) {
      throw httpError(403, "Only the assigned payer can attach a payment proof to this order.");
    }
    return;
  }
  if (purpose === "order-photo") {
    if (!contextId || !sessionCanUseOrder(state, session, contextId)) {
      throw httpError(403, "Only an Actor connected to this order can attach an order photo.");
    }
    return;
  }
  if (!contextId || !sessionCanUseChat(state, session, contextId)) {
    throw httpError(403, "You do not have access to this chat.");
  }
}

function sessionCanAccessFile(db, session, file) {
  if (!file || file.workspaceId !== session?.workspace?.id || file.status !== "active") return false;
  const state = db.appStates[session.workspace.id] || {};
  if ((file.contextIds || []).some((contextId) => sessionCanUseChat(state, session, contextId))) return true;
  if (["payment-proof", "order-photo"].includes(file.purpose)) return sessionCanUseOrder(state, session, file.contextId);
  return sessionCanUseChat(state, session, file.contextId);
}

function newFileRecord(session, { purpose, contextId, fileName, mimeType, size, status = "pending" }) {
  const fileId = id("file");
  const now = new Date();
  const safeName = safeAttachmentFileName(fileName);
  const workspaceSegment = safeObjectSegment(session.workspace.id, "workspace");
  const purposeSegment = safeObjectSegment(purpose, "attachment");
  return {
    id: fileId,
    workspaceId: session.workspace.id,
    uploaderUserId: session.user.id,
    uploaderActorId: session.membership.actorId || "",
    purpose,
    contextId,
    contextIds: [contextId],
    fileName: safeName,
    mimeType: normalizedMimeType(mimeType),
    expectedSize: size,
    size: status === "active" ? size : 0,
    status,
    key: `workspaces/${workspaceSegment}/${purposeSegment}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${fileId}-${safeName}`,
    createdAt: now.toISOString(),
    completedAt: status === "active" ? now.toISOString() : "",
  };
}

function parseAttachmentDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) return null;
  const body = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  return body.length ? { mimeType: normalizedMimeType(match[1]), body } : null;
}

function legacyAttachmentCount(state) {
  const chatCount = (state?.chatConversations || []).reduce((total, chat) => total + (chat?.messages || [])
    .filter((message) => String(message?.media || "").startsWith("data:")).length, 0);
  const proofCount = (state?.orders || []).filter((order) => String(order?.paymentProof?.dataUri || "").startsWith("data:")).length;
  return chatCount + proofCount;
}

async function uploadLegacyAttachment(db, session, input) {
  const parsed = parseAttachmentDataUrl(input.dataUrl);
  if (!parsed) throw new Error("The embedded attachment is not a valid Base64 file.");
  attachmentRule(input.purpose, parsed.mimeType, parsed.body.length);
  const file = newFileRecord(session, {
    purpose: input.purpose,
    contextId: input.contextId,
    fileName: input.fileName,
    mimeType: parsed.mimeType,
    size: parsed.body.length,
    status: "active",
  });
  const result = await requireR2().send(new PutObjectCommand({
    Bucket: r2BucketName,
    Key: file.key,
    Body: parsed.body,
    ContentType: file.mimeType,
  }));
  file.etag = String(result.ETag || "").replace(/^"|"$/g, "");
  db.files.push(file);
  return file;
}

async function migrateLegacyAttachments(db, session, limit) {
  const expectedRevision = workspaceStateRevision(db, session.workspace.id);
  const state = db.appStates[session.workspace.id] || {};
  let attempted = 0;
  let migrated = 0;
  let failed = 0;
  for (const chat of state.chatConversations || []) {
    for (const message of chat?.messages || []) {
      if (attempted >= limit) break;
      if (!String(message?.media || "").startsWith("data:")) continue;
      attempted += 1;
      try {
        const purpose = message.kind === "voice" ? "chat-voice" : message.kind === "photo" ? "chat-photo" : "chat-file";
        const file = await uploadLegacyAttachment(db, session, {
          purpose,
          contextId: chat.id,
          fileName: message.fileName || `${message.kind || "attachment"}-${message.id}`,
          dataUrl: message.media,
        });
        message.attachmentId = file.id;
        message.fileName = file.fileName;
        message.mimeType = file.mimeType;
        message.fileSize = file.size;
        message.media = "";
        migrated += 1;
      } catch {
        failed += 1;
      }
    }
    if (attempted >= limit) break;
  }
  if (attempted < limit) {
    for (const order of state.orders || []) {
      if (attempted >= limit) break;
      const proof = order?.paymentProof;
      if (!String(proof?.dataUri || "").startsWith("data:")) continue;
      attempted += 1;
      try {
        const file = await uploadLegacyAttachment(db, session, {
          purpose: "payment-proof",
          contextId: order.id,
          fileName: proof.fileName || `${order.id}-payment-proof`,
          dataUrl: proof.dataUri,
        });
        order.paymentProof = {
          ...proof,
          dataUri: "",
          attachmentId: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          size: file.size,
        };
        migrated += 1;
      } catch {
        failed += 1;
      }
    }
  }
  db.appStates[session.workspace.id] = state;
  const revision = migrated > 0
    ? markWorkspaceStateChanged(db, session.workspace.id, state)
    : workspaceStateRevision(db, session.workspace.id);
  if (migrated > 0) await saveDb(db, workspaceStateSaveOptions(db, session.workspace.id, expectedRevision));
  return { attempted, migrated, failed, remaining: legacyAttachmentCount(state), state, revision };
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

function subscriptionExpiryStatus(expiresAt, now = Date.now()) {
  const hasExpiry = typeof expiresAt === "string" && Boolean(expiresAt.trim());
  const expiresAtMs = hasExpiry ? new Date(expiresAt).getTime() : Number.NaN;
  const validExpiry = Number.isFinite(expiresAtMs);
  const remainingMs = expiresAtMs - now;
  const expired = !validExpiry || remainingMs <= 0;
  const graceEndsAtMs = validExpiry ? expiresAtMs + subscriptionReadOnlyGraceMs : Number.NaN;
  const readOnly = validExpiry && expired && now < graceEndsAtMs;
  const accessDenied = !validExpiry || now >= graceEndsAtMs;
  return {
    expired,
    readOnly,
    accessDenied,
    graceEndsAt: validExpiry ? new Date(graceEndsAtMs).toISOString() : "",
    readOnlyDaysRemaining: readOnly ? Math.max(1, Math.ceil((graceEndsAtMs - now) / (24 * 60 * 60 * 1000))) : 0,
    expiresSoon: validExpiry && !expired && remainingMs <= subscriptionExpiryWarningMs,
    daysRemaining: expired ? 0 : Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))),
  };
}

function subscriptionExpired(expiresAt) {
  return subscriptionExpiryStatus(expiresAt).expired;
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
  const expiryStatus = subscriptionExpiryStatus(owner?.subscriptionExpiresAt);
  return {
    ownerUserId: owner?.id || "",
    ownerName: owner?.name || "Master",
    active: owner?.active !== false,
    inactive: owner?.active === false,
    expiresAt: owner?.subscriptionExpiresAt || "",
    ...expiryStatus,
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
      const expiryStatus = subscriptionExpiryStatus(user?.subscriptionExpiresAt);
      return {
        userId: user.id,
        name: user.name || "Unknown",
        email: user.email || "",
        workspace: workspace?.name || "",
        currency: membership.currency || "USD",
        plan: user?.subscriptionPlan || "one_month",
        active: user?.active !== false,
        expiresAt: user?.subscriptionExpiresAt || "",
        ...expiryStatus,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function validEmailAddress(value) {
  const email = String(value || "").trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validMasterDisplayName(value) {
  const name = String(value || "").trim();
  return name.length > 0 && name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(name);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const value = String(stored || "");
  let salt;
  let hash;
  let iterations;
  if (value.startsWith("pbkdf2-sha256$")) {
    const [algorithm, storedIterations, storedSalt, storedHash] = value.split("$");
    if (algorithm !== "pbkdf2-sha256") return false;
    salt = storedSalt;
    hash = storedHash;
    iterations = Number(storedIterations);
  } else {
    [salt, hash] = value.split(":");
    iterations = 120000;
  }
  if (!salt || !/^[a-f0-9]{64}$/i.test(hash || "") || !Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) {
    return false;
  }
  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(
    crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex"),
    "hex"
  );
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizedSessionIdleSeconds(value) {
  const seconds = Number(value);
  return allowedSessionIdleSeconds.has(seconds) ? seconds : defaultSessionIdleSeconds;
}

function accountIdleTimeoutSeconds(db, userId) {
  if (userId === "__owner") return normalizedSessionIdleSeconds(db.ownerIdleTimeoutSeconds);
  const user = db.users.find((item) => item.id === userId);
  return normalizedSessionIdleSeconds(user?.idleTimeoutSeconds);
}

function loginAttemptKey(login) {
  return crypto.createHash("sha256").update(String(login || "").trim().toLowerCase()).digest("hex");
}

async function withLoginOperationLock(login, operation) {
  const key = loginAttemptKey(login);
  const previous = loginOperationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  loginOperationLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (loginOperationLocks.get(key) === current) loginOperationLocks.delete(key);
  }
}

function activeLoginAttempt(db, login, now = Date.now()) {
  db.loginAttempts ||= {};
  const key = loginAttemptKey(login);
  const attempt = db.loginAttempts[key];
  if (!attempt) return { key, attempt: null };
  const lockedUntil = new Date(attempt.lockedUntil || 0).getTime();
  const lastFailedAt = new Date(attempt.lastFailedAt || 0).getTime();
  const stale = (!Number.isFinite(lockedUntil) || lockedUntil <= now) &&
    (!Number.isFinite(lastFailedAt) || now - lastFailedAt >= loginAttemptWindowMs);
  if (stale || (Number.isFinite(lockedUntil) && lockedUntil > 0 && lockedUntil <= now)) {
    delete db.loginAttempts[key];
    return { key, attempt: null };
  }
  return { key, attempt };
}

function recordFailedLogin(db, login, now = Date.now()) {
  const { key, attempt } = activeLoginAttempt(db, login, now);
  const failedAttempts = Math.min(4, Number(attempt?.failedAttempts || 0) + 1);
  const nextAttempt = {
    failedAttempts,
    lastFailedAt: new Date(now).toISOString(),
    lockedUntil: failedAttempts >= 4 ? new Date(now + loginLockMs).toISOString() : "",
  };
  db.loginAttempts[key] = nextAttempt;
  return nextAttempt;
}

function clearLoginAttempts(db, login) {
  if (!db.loginAttempts) return;
  delete db.loginAttempts[loginAttemptKey(login)];
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
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

function requestDeviceId(request) {
  return String(request.headers["x-haderapay-device-id"] || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .slice(0, 128);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxJsonBodyBytes) {
      const error = new Error("The request is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readBinary(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`The attachment exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sessionIsExpired(session, now = Date.now()) {
  const idleTimeoutSeconds = normalizedSessionIdleSeconds(session?.idleTimeoutSeconds);
  if (idleTimeoutSeconds === 0) return false;
  const expiresAt = new Date(session?.expiresAt || 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return true;
  const lastActivityAt = new Date(session?.lastActivityAt || 0).getTime();
  const idleMs = idleTimeoutSeconds * 1000;
  return Number.isFinite(lastActivityAt) && lastActivityAt > 0 && now - lastActivityAt >= idleMs;
}

function activeSessionRecord(db, sessionId, now = Date.now()) {
  const session = db.sessions.find((item) => item.id === sessionId);
  return session && !sessionIsExpired(session, now) ? session : null;
}

function touchSession(session, now = Date.now()) {
  const timestamp = new Date(now).toISOString();
  const idleTimeoutSeconds = normalizedSessionIdleSeconds(session?.idleTimeoutSeconds);
  session.idleTimeoutSeconds = idleTimeoutSeconds;
  session.lastActivityAt = timestamp;
  session.expiresAt = idleTimeoutSeconds === 0 ? "" : new Date(now + idleTimeoutSeconds * 1000).toISOString();
}

function setSessionCookie(response, session) {
  const idleTimeoutSeconds = normalizedSessionIdleSeconds(session?.idleTimeoutSeconds);
  const maxAge = idleTimeoutSeconds === 0 ? persistentSessionCookieMaxAgeSeconds : idleTimeoutSeconds;
  response.setHeader("Set-Cookie", `hp_session=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
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
      loginStartedAt: session.createdAt || session.lastActivityAt || "",
      user: { id: "__owner", name: ownerUser, email: ownerUser, idleTimeoutSeconds: accountIdleTimeoutSeconds(db, "__owner") },
      workspace: { id: "__owner", name: "Owner Console" },
      subscription: {
        ownerUserId: "__owner",
        ownerName: ownerUser,
        active: true,
        inactive: false,
        expiresAt: "",
        expired: false,
        readOnly: false,
        accessDenied: false,
        graceEndsAt: "",
        readOnlyDaysRemaining: 0,
      },
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
    loginStartedAt: session.createdAt || session.lastActivityAt || "",
    user: { id: user.id, name: user.name, email: user.email, idleTimeoutSeconds: accountIdleTimeoutSeconds(db, user.id) },
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

function sessionsShareDevice(left, right) {
  if (!left || !right) return false;
  if (left.deviceId && right.deviceId) return left.deviceId === right.deviceId;
  return left.id === right.id;
}

function accountDeviceLoginWarning(db, currentSession, now = Date.now()) {
  if (!currentSession || currentSession.userId === "__owner") return null;
  const accountSessions = db.sessions.filter((session) =>
    session.userId === currentSession.userId &&
    session.workspaceId === currentSession.workspaceId &&
    !sessionIsExpired(session, now)
  );
  if (!accountSessions.some((session) => !sessionsShareDevice(session, currentSession))) return null;
  const latestSession = accountSessions.reduce((latest, session) => {
    const latestAt = new Date(latest?.createdAt || 0).getTime() || 0;
    const sessionAt = new Date(session?.createdAt || 0).getTime() || 0;
    return sessionAt > latestAt ? session : latest;
  }, currentSession);
  const occurredAtMs = new Date(latestSession.createdAt || 0).getTime();
  if (!Number.isFinite(occurredAtMs) || occurredAtMs <= 0 || now - occurredAtMs >= deviceLoginWarningMs) return null;
  return {
    id: `device-login:${latestSession.id}`,
    occurredAt: new Date(occurredAtMs).toISOString(),
    expiresAt: new Date(occurredAtMs + deviceLoginWarningMs).toISOString(),
    message: "Another device is logged into your account."
  };
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
      managedByMaster: false,
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

const actorResetTombstoneKeys = ["orders", "receivables", "transfers", "customers", "messages"];

function normalizeActorResetTombstones(value = {}) {
  return Object.fromEntries(actorResetTombstoneKeys.map((key) => [
    key,
    Array.from(new Set((Array.isArray(value?.[key]) ? value[key] : []).filter(Boolean).map(String)))
  ]));
}

function mergeActorResetTombstones(existing = {}, incoming = {}) {
  const current = normalizeActorResetTombstones(existing);
  const next = normalizeActorResetTombstones(incoming);
  return Object.fromEntries(actorResetTombstoneKeys.map((key) => [
    key,
    Array.from(new Set([...current[key], ...next[key]]))
  ]));
}

function orderBelongsToResetActor(order, actor) {
  if (!order || !actor) return false;
  return orderParticipantMatchesIdentity(order, "broker", String(actor.id || ""), String(actor.name || ""))
    || orderParticipantMatchesIdentity(order, "agent", String(actor.id || ""), String(actor.name || ""));
}

function receivableBelongsToResetActor(receivable, actor) {
  if (!receivable || !actor) return false;
  return Boolean(
    (actor.id && receivable.borrowerActorId === actor.id) ||
    receivable.borrower === actor.name
  );
}

function transferBelongsToResetActor(transfer, actor) {
  if (!transfer || !actor) return false;
  return Boolean(
    (actor.id && (transfer.fromActorId === actor.id || transfer.toActorId === actor.id)) ||
    transfer.from === actor.name ||
    transfer.to === actor.name ||
    transfer.initiatedBy === actor.name
  );
}

function messageBelongsToResetActor(message, actor) {
  if (!message || !actor) return false;
  return message.from === actor.name || message.forwardedFrom === actor.name;
}

function applyActorResetTombstones(targetState) {
  const tombstones = normalizeActorResetTombstones(targetState?.actorResetTombstones);
  const orderIds = new Set(tombstones.orders);
  const receivableIds = new Set(tombstones.receivables);
  const transferIds = new Set(tombstones.transfers);
  const customerIds = new Set(tombstones.customers);
  const messageIds = new Set(tombstones.messages);
  targetState.actorResetTombstones = tombstones;
  targetState.orders = (targetState.orders || []).filter((item) => !orderIds.has(String(item?.id || "")));
  targetState.receivables = (targetState.receivables || []).filter((item) => !receivableIds.has(String(item?.id || "")));
  targetState.transfers = (targetState.transfers || []).filter((item) => !transferIds.has(String(item?.id || "")));
  targetState.savedCustomers = (targetState.savedCustomers || []).filter((item) => !customerIds.has(String(item?.id || "")));
  targetState.chatConversations = (targetState.chatConversations || []).map((chat) => ({
    ...chat,
    messages: (chat.messages || []).filter((message) => !messageIds.has(String(message?.id || "")))
  }));
  if (messageIds.has(String(targetState.chatReplyTo || ""))) targetState.chatReplyTo = "";
  return targetState;
}

function resetSpecificActorData(targetState, actor) {
  if (!targetState || !actor || actor.role === "Master") return null;
  const removedOrders = (targetState.orders || []).filter((item) => orderBelongsToResetActor(item, actor));
  const removedReceivables = (targetState.receivables || []).filter((item) => receivableBelongsToResetActor(item, actor));
  const removedTransfers = (targetState.transfers || []).filter((item) => transferBelongsToResetActor(item, actor));
  const removedCustomers = (targetState.savedCustomers || []).filter((item) => item?.actorId === actor.id);
  const removedMessages = (targetState.chatConversations || [])
    .flatMap((chat) => chat?.messages || [])
    .filter((message) => messageBelongsToResetActor(message, actor));
  targetState.actorResetTombstones = mergeActorResetTombstones(targetState.actorResetTombstones, {
    orders: removedOrders.map((item) => item.id),
    receivables: removedReceivables.map((item) => item.id),
    transfers: removedTransfers.map((item) => item.id),
    customers: removedCustomers.map((item) => item.id),
    messages: removedMessages.map((item) => item.id)
  });
  targetState.chatConversations = (targetState.chatConversations || []).map((chat) => ({
    ...chat,
    messages: (chat.messages || []).map((message) => {
      if (!message?.reactions || !Object.prototype.hasOwnProperty.call(message.reactions, actor.name)) return message;
      const reactions = { ...message.reactions };
      delete reactions[actor.name];
      return { ...message, reactions };
    })
  }));
  applyActorResetTombstones(targetState);
  const removedOrderIds = new Set(removedOrders.map((item) => item.id));
  const removedTransferIds = new Set(removedTransfers.map((item) => item.id));
  if (removedOrderIds.has(targetState.editingOrderId)) targetState.editingOrderId = "";
  if (removedTransferIds.has(targetState.editingTransferId)) targetState.editingTransferId = "";
  return {
    orders: removedOrders.length,
    receivables: removedReceivables.length,
    transfers: removedTransfers.length,
    customers: removedCustomers.length,
    messages: removedMessages.length
  };
}

function recordTimestamp(item = {}) {
  return Math.max(
    new Date(item.voidRequestedAt || 0).getTime(),
    new Date(item.voidRejectedAt || 0).getTime(),
    new Date(item.voidedAt || 0).getTime(),
    new Date(item.archivedAt || 0).getTime(),
    new Date(item.updatedAt || 0).getTime(),
    new Date(item.reversedAt || 0).getTime(),
    new Date(item.paidAt || 0).getTime(),
    new Date(item.assignedAt || 0).getTime(),
    new Date(item.approvedAt || 0).getTime(),
    new Date(item.paidOutAt || 0).getTime(),
    new Date(item.rejectedAt || 0).getTime(),
    new Date(item.returnedAt || 0).getTime(),
    new Date(item.cancelledAt || 0).getTime(),
    new Date(item.sentAt || 0).getTime(),
    new Date(item.createdAt || 0).getTime(),
    0
  );
}

const clearableOrderForwardingFields = [
  "forwardedPayoutDivider",
  "forwardedPayoutPercent",
  "manualSpecialPayoutDivider",
  "manualSpecialPayoutPercent",
  "manualMasterRateDivider",
  "manualMasterRatePercent"
];

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
    if (itemIsNewer) {
      clearableOrderForwardingFields.forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(item, field)) delete next[field];
      });
    }
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
    if (previous.cancelledAt && !next.cancelledAt) next.cancelledAt = previous.cancelledAt;
    if (item.cancelledAt && !next.cancelledAt) next.cancelledAt = item.cancelledAt;
    if (previous.cancelledBy && !next.cancelledBy) next.cancelledBy = previous.cancelledBy;
    if (item.cancelledBy && !next.cancelledBy) next.cancelledBy = item.cancelledBy;
    const latestVoidRequest = Math.max(new Date(next.voidRequestedAt || 0).getTime(), 0);
    const latestVoidReject = Math.max(new Date(next.voidRejectedAt || 0).getTime(), 0);
    const requestIsCurrent = latestVoidRequest > latestVoidReject || (latestVoidRequest === 0 && latestVoidReject === 0);
    const hasOpenVoidRequest = !next.voidJournal &&
      (previous.state === "Void Requested" || item.state === "Void Requested" || previous.voidRequested || item.voidRequested) &&
      requestIsCurrent;
    if (!hasOpenVoidRequest && (previous.state === "Paid" || item.state === "Paid" || next.paidAt || next.journal)) {
      next.state = "Paid";
      next.returnedBy = "";
      next.returnedReason = "";
      next.returnedAt = "";
    }
    if (hasOpenVoidRequest) {
      next.state = "Void Requested";
      next.voidRequested = true;
    } else {
      next.voidRequested = false;
    }
    if (previous.state === "Cancelled" || item.state === "Cancelled" || next.cancelledAt) {
      next.state = "Cancelled";
      next.agent = "Cancelled";
      next.agentActorId = "";
      next.voidRequested = false;
    }
    if (previous.state === "Voided" || item.state === "Voided" || next.voidJournal) {
      next.state = "Voided";
      next.voidRequested = false;
      next.excludedFromCalculations = true;
    }
    merged.set(item.id, next);
  });
  return Array.from(merged.values());
}

function transferIdentity(transfer = {}) {
  return String(transfer.recordKey || [
    "TRX",
    transfer.id || "",
    transfer.createdAt || transfer.sentAt || "",
    transfer.from || "",
    transfer.to || "",
    transfer.sourceCurrency || transfer.currency || "",
    transfer.sourceAmountMinor || transfer.amountMinor || 0,
  ].join(":"));
}

function mergeTransfers(existingItems = [], incomingItems = []) {
  const merged = new Map();
  [...existingItems, ...incomingItems].forEach((item) => {
    if (!item || typeof item !== "object" || !item.id) return;
    const recordKey = transferIdentity(item);
    const previous = merged.get(recordKey);
    if (!previous) {
      merged.set(recordKey, { ...item, recordKey });
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
    if (previous.reversalJournal && !next.reversalJournal) next.reversalJournal = previous.reversalJournal;
    if (item.reversalJournal && !next.reversalJournal) next.reversalJournal = item.reversalJournal;
    if (previous.reversedAt && !next.reversedAt) next.reversedAt = previous.reversedAt;
    if (item.reversedAt && !next.reversedAt) next.reversedAt = item.reversedAt;
    if (previous.reversedBy && !next.reversedBy) next.reversedBy = previous.reversedBy;
    if (item.reversedBy && !next.reversedBy) next.reversedBy = item.reversedBy;
    const archivedActorIds = Array.from(new Set([...(previous.archivedActorIds || []), ...(item.archivedActorIds || [])]));
    const archivedActorNames = Array.from(new Set([...(previous.archivedActorNames || []), ...(item.archivedActorNames || [])]));
    if (archivedActorIds.length) next.archivedActorIds = archivedActorIds;
    if (archivedActorNames.length) next.archivedActorNames = archivedActorNames;
    next.archiveIdsByActor = { ...(previous.archiveIdsByActor || {}), ...(item.archiveIdsByActor || {}) };
    const archivedDates = [previous.archivedAt, item.archivedAt].filter(Boolean).sort();
    if (archivedDates.length) next.archivedAt = archivedDates[0];
    if (previous.state === "Reversed" || item.state === "Reversed" || next.reversalJournal) {
      next.state = "Reversed";
    } else if ((previous.state === "Approved" || item.state === "Approved") && next.journal) {
      next.state = "Approved";
    }
    merged.set(recordKey, { ...next, recordKey });
  });
  return Array.from(merged.values());
}

function nextOrderNumberFromOrders(orders = []) {
  return orders.reduce((next, order) => {
    const match = String(order?.id || "").match(/^ORD-(\d+)(?:-|$)/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function nextReceivableNumberFromReceivables(receivables = []) {
  return receivables.reduce((next, receivable) => {
    const match = String(receivable?.id || "").match(/^REC-(\d+)(?:-|$)/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function archivedWorkspaceRecords(state = {}, key) {
  return (Array.isArray(state.archives) ? state.archives : [])
    .flatMap((archive) => Array.isArray(archive?.[key]) ? archive[key] : []);
}

function recordsHaveDifferentIdentity(existing = {}, incoming = {}, identityFields = []) {
  for (const field of identityFields) {
    const existingValue = String(existing?.[field] || "").trim();
    const incomingValue = String(incoming?.[field] || "").trim();
    if (existingValue && incomingValue && existingValue !== incomingValue) return true;
  }
  const existingCreatedAt = String(existing?.createdAt || existing?.sentAt || "").trim();
  const incomingCreatedAt = String(incoming?.createdAt || incoming?.sentAt || "").trim();
  return Boolean(existingCreatedAt && incomingCreatedAt && existingCreatedAt !== incomingCreatedAt);
}

function orderIdentityConflicts(existing = {}, incoming = {}) {
  const bothHaveStableActorIds = Boolean(existing?.brokerActorId && incoming?.brokerActorId);
  return recordsHaveDifferentIdentity(
    existing,
    incoming,
    bothHaveStableActorIds ? ["brokerActorId", "brokerOrderNumber"] : ["brokerOrderNumber", "broker"]
  );
}

function receivableIdentityConflicts(existing = {}, incoming = {}) {
  const bothHaveStableActorIds = Boolean(existing?.borrowerActorId && incoming?.borrowerActorId);
  return recordsHaveDifferentIdentity(
    existing,
    incoming,
    bothHaveStableActorIds ? ["orderId", "borrowerActorId"] : ["orderId", "borrower"]
  );
}

function recordsById(records = []) {
  return records.reduce((grouped, record) => {
    const recordId = String(record?.id || "");
    if (!recordId) return grouped;
    if (!grouped.has(recordId)) grouped.set(recordId, []);
    grouped.get(recordId).push(record);
    return grouped;
  }, new Map());
}

function collisionSafeServerRecordId(prefix, sequence, usedIds) {
  let candidate = "";
  do {
    candidate = `${prefix}-${sequence}-${crypto.randomBytes(10).toString("hex").toUpperCase()}`;
  } while (usedIds.has(candidate));
  usedIds.add(candidate);
  return candidate;
}

function orderReferenceValues(order = {}) {
  return new Set([
    order.brokerOrderNumber,
    order.agentOrderNumber,
    ...Object.values(order.agentOrderNumbers || {}),
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

function rewriteCollidingOrderReferences(state, order, oldId, newId, originalOrderRemainsInPayload) {
  const orderReferences = orderReferenceValues(order);
  const orderJournals = new Set([order.journal, order.voidJournal]
    .map((value) => String(value || "").trim())
    .filter(Boolean));
  (state.receivables || []).forEach((receivable) => {
    if (receivable?.orderId !== oldId) return;
    const receivableReferences = [receivable.brokerOrderNumber, receivable.agentOrderNumber]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const receivableJournals = [receivable.journal, receivable.voidJournal]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (!originalOrderRemainsInPayload ||
      receivableReferences.some((value) => orderReferences.has(value)) ||
      receivableJournals.some((value) => orderJournals.has(value))
    ) {
      receivable.orderId = newId;
    }
  });
  (state.ledger || []).forEach((line) => {
    if (line?.orderId !== oldId) return;
    const journal = String(line.journal || "").trim();
    if (!originalOrderRemainsInPayload || (journal && orderJournals.has(journal))) line.orderId = newId;
  });
  (state.chatConversations || []).forEach((conversation) => {
    (conversation?.messages || []).forEach((message) => {
      if (message?.orderId !== oldId) return;
      const orderNumber = String(message.orderNumber || "").trim();
      if (!originalOrderRemainsInPayload || (orderNumber && orderReferences.has(orderNumber))) message.orderId = newId;
    });
  });
  if (!originalOrderRemainsInPayload && state.editingOrderId === oldId) state.editingOrderId = newId;
}

function resolveIncomingWorkspaceRecordCollisions(currentState = {}, incomingState = {}, options = {}) {
  const currentOrders = [
    ...(Array.isArray(currentState.orders) ? currentState.orders : []),
    ...archivedWorkspaceRecords(currentState, "orders"),
  ];
  const currentReceivables = [
    ...(Array.isArray(currentState.receivables) ? currentState.receivables : []),
    ...archivedWorkspaceRecords(currentState, "receivables"),
  ];
  const incomingOrders = Array.isArray(incomingState.orders) ? incomingState.orders : [];
  const incomingReceivables = Array.isArray(incomingState.receivables) ? incomingState.receivables : [];
  const currentOrdersById = recordsById(currentOrders);
  const currentReceivablesById = recordsById(currentReceivables);
  const hasOrderCollision = incomingOrders.some((order) => {
    const matching = currentOrdersById.get(String(order?.id || "")) || [];
    return matching.some((existing) => orderIdentityConflicts(existing, order));
  });
  const hasReceivableCollision = incomingReceivables.some((receivable) => {
    const matching = currentReceivablesById.get(String(receivable?.id || "")) || [];
    return matching.some((existing) => receivableIdentityConflicts(existing, receivable));
  });
  if (!hasOrderCollision && !hasReceivableCollision) return incomingState;

  const resolved = structuredClone(incomingState);
  const resolvedOrders = Array.isArray(resolved.orders) ? resolved.orders : [];
  const resolvedReceivables = Array.isArray(resolved.receivables) ? resolved.receivables : [];
  const usedOrderIds = new Set([...currentOrders, ...resolvedOrders].map((record) => String(record?.id || "")).filter(Boolean));
  const usedReceivableIds = new Set([...currentReceivables, ...resolvedReceivables].map((record) => String(record?.id || "")).filter(Boolean));
  let nextOrderSequence = Math.max(
    Number(currentState.orderCounter || 0) + 1,
    Number(resolved.orderCounter || 0) + 1,
    nextOrderNumberFromOrders([...currentOrders, ...resolvedOrders])
  );
  let nextReceivableSequence = Math.max(
    Number(currentState.receivableCounter || 0) + 1,
    Number(resolved.receivableCounter || 0) + 1,
    nextReceivableNumberFromReceivables([...currentReceivables, ...resolvedReceivables])
  );
  resolvedOrders.forEach((order) => {
    const oldId = String(order?.id || "");
    if (!oldId) return;
    const matching = currentOrdersById.get(oldId) || [];
    if (!matching.some((existing) => orderIdentityConflicts(existing, order))) return;
    const originalOrderRemainsInPayload = resolvedOrders.some((candidate) =>
      candidate !== order && candidate?.id === oldId &&
      matching.some((existing) => !orderIdentityConflicts(existing, candidate))
    );
    const recoveryOrder = options.brokerActorId
      ? { ...order, brokerActorId: options.brokerActorId, broker: options.brokerName || order?.broker }
      : order;
    const recoveredCandidates = currentOrders.filter((existing) =>
      String(existing?.collisionSourceOrderId || "") === oldId &&
      recoveredOrderMatches(existing, recoveryOrder)
    );
    if (recoveredCandidates.length === 1) {
      const recovered = recoveredCandidates[0];
      const recoveredId = String(recovered?.id || "");
      if (recoveredId) {
        order.id = recoveredId;
        order.internalOrderId = recoveredId;
        order.collisionSourceOrderId = oldId;
        order.brokerOrderNumber = recovered.brokerOrderNumber;
        order.brokerOrderNumberCycle = recovered.brokerOrderNumberCycle;
        rewriteCollidingOrderReferences(resolved, order, oldId, recoveredId, originalOrderRemainsInPayload);
        return;
      }
    }
    const newId = collisionSafeServerRecordId("ORD", nextOrderSequence, usedOrderIds);
    nextOrderSequence += 1;
    order.id = newId;
    if (order.internalOrderId === oldId) order.internalOrderId = newId;
    order._serverCollisionSourceOrderId = oldId;
    rewriteCollidingOrderReferences(resolved, order, oldId, newId, originalOrderRemainsInPayload);
  });

  resolvedReceivables.forEach((receivable) => {
    const oldId = String(receivable?.id || "");
    if (!oldId) return;
    const matching = currentReceivablesById.get(oldId) || [];
    if (!matching.some((existing) => receivableIdentityConflicts(existing, receivable))) return;
    const newId = collisionSafeServerRecordId("REC", nextReceivableSequence, usedReceivableIds);
    nextReceivableSequence += 1;
    receivable.id = newId;
  });
  return resolved;
}

function nextTransferNumberFromTransfers(transfers = []) {
  return transfers.filter((transfer) => !transfer.masterTransactionClosedAt).reduce((next, transfer) => {
    const match = String(transfer?.id || "").match(/^TRF-(\d+)$/);
    return match ? Math.max(next, Number(match[1]) + 1) : next;
  }, 1);
}

function nextManualJournalNumberFromLedger(ledger = []) {
  return ledger
    .filter((line) => line?.source === "JOURNAL" && !line.masterTransactionClosedAt)
    .reduce((next, line) => {
      const match = String(line?.entryId || "").match(/^JNL-(\d+)$/);
      return match ? Math.max(next, Number(match[1]) + 1) : next;
    }, 1);
}

function nextWithdrawalNumberFromLedger(ledger = []) {
  return ledger
    .filter((line) => line?.source === "WITHDRAWAL" && !line.masterTransactionClosedAt)
    .reduce((next, line) => {
      const match = String(line?.entryId || "").match(/^WDL-(\d+)$/);
      return match ? Math.max(next, Number(match[1]) + 1) : next;
    }, 1);
}

function nextJournalNumberFromLedger(ledger = []) {
  return ledger.reduce((next, line) => {
    const match = String(line?.journal || "").match(/^JRN-(\d+)(?:\s+\(\d+\))?$/);
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

function archiveSnapshotItemKey(type, item = {}) {
  if (type === "orders") {
    return [item.id || item.brokerOrderNumber, item.createdAt || item.sentAt, item.broker, item.agent, item.sourceCurrency, item.sourceAmountMinor, item.payoutCurrency, item.payoutAmountMinor, item.journal].join(":");
  }
  if (type === "receivables") return [item.id || item.orderId, item.createdAt, item.orderId, item.borrower, item.currency, item.principalMinor].join(":");
  if (type === "transfers") return [item.recordKey || item.id || item.journal, item.createdAt || item.sentAt, item.from, item.to, item.currency, item.amountMinor, item.journal].join(":");
  if (type === "ledger") {
    return [item.entryId, item.journal, item.source, item.account, item.direction, item.currency, item.amountMinor, item.postedAt].join(":");
  }
  return "";
}

function normalizeArchiveSnapshots(archives = []) {
  const normalized = (Array.isArray(archives) ? archives : [])
    .filter((archive) => archive && typeof archive === "object")
    .map((archive) => ({
      ...archive,
      actor: archive.kind === "master-transactions" || archive.actor === "Master Transactions"
        ? "Transfer Transactions"
        : archive.actor,
      orders: Array.isArray(archive.orders) ? archive.orders : [],
      receivables: Array.isArray(archive.receivables) ? archive.receivables : [],
      transfers: Array.isArray(archive.transfers) ? archive.transfers : [],
      ledger: Array.isArray(archive.ledger) ? archive.ledger : [],
    }));
  const seenByActor = new Map();
  normalized
    .map((archive, index) => ({ archive, index }))
    .sort((left, right) => {
      const timeDifference = new Date(left.archive.closedAt || 0).getTime() - new Date(right.archive.closedAt || 0).getTime();
      return timeDifference || left.index - right.index;
    })
    .forEach(({ archive }) => {
      const actorKey = String(archive.actorId || archive.actor || "Unknown Actor");
      if (!seenByActor.has(actorKey)) {
        seenByActor.set(actorKey, {
          orders: new Set(),
          receivables: new Set(),
          transfers: new Set(),
          ledger: new Set(),
        });
      }
      const actorSeen = seenByActor.get(actorKey);
      ["orders", "receivables", "transfers", "ledger"].forEach((type) => {
        archive[type] = archive[type].filter((item) => {
          const key = archiveSnapshotItemKey(type, item);
          if (!key || actorSeen[type].has(key)) return false;
          actorSeen[type].add(key);
          return true;
        });
      });
    });
  return normalized;
}

function mergeArchiveSnapshots(existingArchives = [], incomingArchives = []) {
  const archiveKey = (archive) => archive?.id || [archive?.actor, archive?.closedAt, archive?.closedBy].join(":");
  const existingByKey = new Map((Array.isArray(existingArchives) ? existingArchives : [])
    .map((archive) => [archiveKey(archive), archive]));
  const incomingByKey = new Map((Array.isArray(incomingArchives) ? incomingArchives : [])
    .map((archive) => [archiveKey(archive), archive]));
  const archives = mergeByKey(existingArchives, incomingArchives, archiveKey).map((archive) => {
    const key = archiveKey(archive);
    const existing = existingByKey.get(key);
    const incoming = incomingByKey.get(key);
    const mergedItems = (type) => mergeByKey(existing?.[type], incoming?.[type], (item) => archiveSnapshotItemKey(type, item));
    return {
      ...archive,
      orders: mergedItems("orders"),
      receivables: mergedItems("receivables"),
      transfers: mergedItems("transfers"),
      ledger: mergedItems("ledger"),
    };
  });
  return normalizeArchiveSnapshots(archives);
}

function removeOrdersAlreadyArchived(orders = [], archives = [], deletedOrderIds = [], ledger = [], actors = []) {
  return retainOrdersForOpenParticipants({
    orders: Array.isArray(orders) ? orders : [],
    archives: normalizeArchiveSnapshots(archives),
    deletedOrderIds: Array.isArray(deletedOrderIds) ? deletedOrderIds : [],
    ledger: Array.isArray(ledger) ? ledger : [],
    actors: Array.isArray(actors) ? actors : [],
  }).orders;
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
  incomingState = resolveIncomingWorkspaceRecordCollisions(currentState, incomingState);
  const nextState = { ...currentState, ...incomingState };
  const membershipActors = workspaceActors(db, workspaceId);
  const activeActorIds = new Set(membershipActors.map((actor) => actor.id));
  const deletedActorIds = new Set([...(currentState.deletedActorIds || []), ...(incomingState.deletedActorIds || [])]);
  const deletedChatIds = new Set([...(currentState.deletedChatIds || []), ...(incomingState.deletedChatIds || [])]);
  const deletedOrderIds = new Set([...(currentState.deletedOrderIds || []), ...(incomingState.deletedOrderIds || [])].filter(Boolean).map(String));
  const actorResetTombstones = mergeActorResetTombstones(currentState.actorResetTombstones, incomingState.actorResetTombstones);
  const chatHistoryResetTime = Math.max(
    new Date(currentState.chatHistoryResetAt || 0).getTime() || 0,
    new Date(incomingState.chatHistoryResetAt || 0).getTime() || 0
  );
  activeActorIds.forEach((actorId) => deletedActorIds.delete(actorId));
  nextState.actors = mergeById(currentState.actors, incomingState.actors);
  nextState.actors = nextState.actors.filter((actor) => !deletedActorIds.has(actor?.id));
  nextState.orders = mergeOrders(currentState.orders, incomingState.orders);
  nextState.orders = removeRecoveredOrderAliases(nextState.orders);
  nextState.savedCustomers = mergeById(currentState.savedCustomers, incomingState.savedCustomers);
  nextState.receivables = mergeReceivables(currentState.receivables, incomingState.receivables);
  nextState.transfers = mergeTransfers(currentState.transfers, incomingState.transfers);
  nextState.ledger = mergeByKey(currentState.ledger, incomingState.ledger, (line) =>
    [line.journal, line.source, line.account, line.direction, line.currency, line.amountMinor, line.postedAt].join(":")
  );
  nextState.masterBankEntries = mergeById(currentState.masterBankEntries, incomingState.masterBankEntries);
  nextState.archives = mergeArchiveSnapshots(currentState.archives, incomingState.archives);
  nextState.deletedOrderIds = Array.from(deletedOrderIds);
  nextState.orders = removeOrdersAlreadyArchived(
    nextState.orders,
    nextState.archives,
    nextState.deletedOrderIds,
    nextState.ledger,
    nextState.actors
  );
  nextState.chatConversations = mergeChatConversations(currentState.chatConversations, incomingState.chatConversations)
    .filter((chat) => !deletedChatIds.has(chat?.id))
    .map((chat) => ({
      ...chat,
      messages: (chat.messages || []).filter((message) =>
        !chatHistoryResetTime || new Date(message?.createdAt || 0).getTime() > chatHistoryResetTime
      ),
    }));
  nextState.actorResetTombstones = actorResetTombstones;
  applyActorResetTombstones(nextState);
  nextState.actors = mergeById(membershipActors, nextState.actors)
    .map((actor) => ({
      ...actor,
      managedByMaster: actor?.role !== "Master" && !activeActorIds.has(actor?.id),
    }));
  nextState.actors = nextState.actors.filter((actor) => activeActorIds.has(actor?.id) || !deletedActorIds.has(actor?.id));
  nextState.deletedActorIds = Array.from(deletedActorIds);
  nextState.deletedActorNames = [];
  nextState.deletedChatIds = Array.from(deletedChatIds);
  nextState.chatHistoryResetAt = chatHistoryResetTime ? new Date(chatHistoryResetTime).toISOString() : "";
  nextState.orderCounter = Math.max(Number(currentState.orderCounter || 0), Number(incomingState.orderCounter || 0), nextOrderNumberFromOrders(nextState.orders) - 1);
  nextState.receivableCounter = Math.max(Number(currentState.receivableCounter || 0), Number(incomingState.receivableCounter || 0), nextReceivableNumberFromReceivables(nextState.receivables) - 1);
  nextState.customerCounter = Math.max(Number(currentState.customerCounter || 0), Number(incomingState.customerCounter || 0));
  const currentMasterTransactionCycle = Number(currentState.masterTransactionCycle || 0);
  const incomingMasterTransactionCycle = Number(incomingState.masterTransactionCycle || 0);
  const currentPeriodCounter = (currentValue, incomingValue, scannedValue) => {
    if (incomingMasterTransactionCycle > currentMasterTransactionCycle) return Math.max(Number(incomingValue || 0), scannedValue);
    if (currentMasterTransactionCycle > incomingMasterTransactionCycle) return Math.max(Number(currentValue || 0), scannedValue);
    return Math.max(Number(currentValue || 0), Number(incomingValue || 0), scannedValue);
  };
  nextState.masterTransactionCycle = Math.max(currentMasterTransactionCycle, incomingMasterTransactionCycle);
  nextState.transferCounter = currentPeriodCounter(currentState.transferCounter, incomingState.transferCounter, nextTransferNumberFromTransfers(nextState.transfers) - 1);
  nextState.manualJournalCounter = currentPeriodCounter(currentState.manualJournalCounter, incomingState.manualJournalCounter, nextManualJournalNumberFromLedger(nextState.ledger) - 1);
  nextState.withdrawalCounter = currentPeriodCounter(currentState.withdrawalCounter, incomingState.withdrawalCounter, nextWithdrawalNumberFromLedger(nextState.ledger) - 1);
  nextState.transferRecordCounter = Math.max(Number(currentState.transferRecordCounter || 0), Number(incomingState.transferRecordCounter || 0));
  nextState.transfers = nextState.transfers.map((transfer) =>
    !transfer.masterTransactionClosedAt && !Object.prototype.hasOwnProperty.call(transfer, "masterTransactionCycle")
      ? { ...transfer, masterTransactionCycle: nextState.masterTransactionCycle }
      : transfer
  );
  nextState.journalCounter = Math.max(Number(currentState.journalCounter || 0), Number(incomingState.journalCounter || 0), nextJournalNumberFromLedger(nextState.ledger) - 1);
  repairOrderJournalCollisions(nextState);
  removeExactDuplicateOrders(nextState);
  return nextState;
}

function sessionCanAccessCreditReminder(session, receivable) {
  if (session?.membership?.role === "Master") return true;
  if (session?.membership?.role !== "Actor") return false;
  if (!["Broker", "Special Broker"].includes(session.membership.actorRole)) return false;
  const actorIdMatches = receivable?.borrowerActorId && receivable.borrowerActorId === session.membership.actorId;
  const actorNameMatches = receivable?.borrower && receivable.borrower === session.membership.actorName;
  return Boolean(actorIdMatches || actorNameMatches);
}

function stripRestrictedCreditReminders(state, session) {
  if (!state || typeof state !== "object") return state;
  const visibleReceivable = (receivable) => {
    if (sessionCanAccessCreditReminder(session, receivable)) return receivable;
    const { creditReminder, ...visible } = receivable;
    return visible;
  };
  return {
    ...state,
    receivables: (state.receivables || []).map(visibleReceivable),
    archives: (state.archives || []).map((archive) => ({
      ...archive,
      receivables: (archive.receivables || []).map(visibleReceivable),
    })),
  };
}

function orderArchiveRepairTarget(state, input = {}) {
  const requestedActorId = String(input.actorId || "").trim();
  const requestedActorName = String(input.actorName || "").trim();
  const actors = Array.isArray(state?.actors) ? state.actors : [];
  const actor = requestedActorId
    ? actors.find((item) => String(item?.id || "") === requestedActorId)
    : actors.find((item) => String(item?.name || "").toLocaleLowerCase() === requestedActorName.toLocaleLowerCase());
  if (!actor || actor.role === "Master") throw httpError(400, "Choose a valid Actor report to repair.");
  return { actorId: String(actor.id || ""), actorName: String(actor.name || "") };
}

function archiveMatchesRepairTarget(archive, target) {
  const archiveActorId = String(archive?.actorId || "").trim();
  if (target.actorId && archiveActorId) return archiveActorId === target.actorId;
  return Boolean(target.actorName && String(archive?.actor || "").trim().toLocaleLowerCase() === target.actorName.toLocaleLowerCase());
}

function orderArchiveRepairInvariantState(state) {
  return {
    ...state,
    archives: (Array.isArray(state?.archives) ? state.archives : []).map((archive) => {
      const { orders, ...withoutOrders } = archive;
      return withoutOrders;
    }),
  };
}

function orderArchiveRepairPlan(state, target, revision = "") {
  const result = backfillClosedParticipantOrderSnapshots(state, target);
  const repaired = result.repaired.slice().sort((left, right) =>
    [left.archiveId, left.orderId, left.journal].join(":").localeCompare([right.archiveId, right.orderId, right.journal].join(":"))
  );
  const planDigest = crypto.createHash("sha256").update(JSON.stringify({
    revision,
    target,
    repaired,
    skippedCount: result.skippedCount,
    orphanCount: result.orphanCount,
    evidenceCount: result.evidenceCount,
  })).digest("hex");
  return {
    result,
    revision,
    target,
    planDigest,
    candidateCount: result.repairedCount,
    skippedCount: result.skippedCount,
    orphanCount: result.orphanCount,
    existingCount: result.existingCount,
    evidenceCount: result.evidenceCount,
  };
}

function validateOrderArchiveRepair(beforeState, plan) {
  if (plan.skippedCount !== 0) throw httpError(409, "The report repair found ambiguous historical records and stopped without changing data.");
  if (plan.orphanCount !== 0) throw httpError(409, "The report repair found historical ledger evidence without a complete matching order and stopped without changing data.");
  if (!isDeepStrictEqual(
    orderArchiveRepairInvariantState(beforeState),
    orderArchiveRepairInvariantState(plan.result.state)
  )) {
    throw httpError(500, "The report repair safety check detected an accounting change and stopped.");
  }
  const beforeArchives = Array.isArray(beforeState?.archives) ? beforeState.archives : [];
  const afterArchives = Array.isArray(plan.result.state?.archives) ? plan.result.state.archives : [];
  const beforeOrderCount = beforeArchives.reduce((total, archive) => total + (archive.orders || []).length, 0);
  const afterOrderCount = afterArchives.reduce((total, archive) => total + (archive.orders || []).length, 0);
  if (afterOrderCount - beforeOrderCount !== plan.candidateCount) {
    throw httpError(500, "The report repair count check failed and stopped.");
  }
  for (let index = 0; index < Math.max(beforeArchives.length, afterArchives.length); index += 1) {
    if (archiveMatchesRepairTarget(beforeArchives[index], plan.target)) continue;
    if (!isDeepStrictEqual(beforeArchives[index]?.orders || [], afterArchives[index]?.orders || [])) {
      throw httpError(500, "The report repair attempted to change another Actor's report and stopped.");
    }
  }
  const afterPlan = backfillClosedParticipantOrderSnapshots(plan.result.state, plan.target);
  if (afterPlan.repairedCount !== 0 || afterPlan.skippedCount !== 0 || afterPlan.orphanCount !== 0) {
    throw httpError(500, "The report repair could not prove an idempotent result and stopped.");
  }
}

function validateWorkspaceWideOrderArchiveRepair(beforeState, result) {
  if (!isDeepStrictEqual(
    orderArchiveRepairInvariantState(beforeState),
    orderArchiveRepairInvariantState(result.state)
  )) {
    throw httpError(500, "The all-workspace report repair safety check detected an accounting change and stopped.");
  }
  const beforeArchives = Array.isArray(beforeState?.archives) ? beforeState.archives : [];
  const afterArchives = Array.isArray(result.state?.archives) ? result.state.archives : [];
  const beforeOrderCount = beforeArchives.reduce((total, archive) => total + (archive.orders || []).length, 0);
  const afterOrderCount = afterArchives.reduce((total, archive) => total + (archive.orders || []).length, 0);
  if (afterOrderCount - beforeOrderCount !== Number(result.repairedCount || 0)) {
    throw httpError(500, "The all-workspace report repair count check failed and stopped.");
  }
  const repairedArchiveIds = new Set((result.repaired || []).map((item) => String(item?.archiveId || "")).filter(Boolean));
  for (let index = 0; index < Math.max(beforeArchives.length, afterArchives.length); index += 1) {
    const beforeOrders = Array.isArray(beforeArchives[index]?.orders) ? beforeArchives[index].orders : [];
    const afterOrders = Array.isArray(afterArchives[index]?.orders) ? afterArchives[index].orders : [];
    if (!isDeepStrictEqual(beforeOrders, afterOrders.slice(0, beforeOrders.length))) {
      throw httpError(500, "The all-workspace report repair attempted to rewrite existing report history and stopped.");
    }
    if (afterOrders.length > beforeOrders.length && !repairedArchiveIds.has(String(afterArchives[index]?.id || ""))) {
      throw httpError(500, "The all-workspace report repair attempted to change an unplanned report and stopped.");
    }
  }
  const repairedKeys = new Set();
  for (const item of result.repaired || []) {
    const key = [item?.archiveId, item?.orderId, item?.journal].map((value) => String(value || "")).join(":");
    if (repairedKeys.has(key)) throw httpError(500, "The all-workspace report repair found a duplicate candidate and stopped.");
    repairedKeys.add(key);
  }
  const secondPass = backfillAllClosedActorOrderSnapshots(result.state);
  if (secondPass.repairedCount !== 0 || !isDeepStrictEqual(secondPass.state, result.state)) {
    throw httpError(500, "The all-workspace report repair could not prove an idempotent result and stopped.");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function orderArchiveRepairEvidenceDigest(state) {
  const evidence = {
    actors: (Array.isArray(state?.actors) ? state.actors : []).map((actor) => ({
      id: actor?.id,
      name: actor?.name,
      role: actor?.role,
      active: actor?.active,
    })),
    archives: (Array.isArray(state?.archives) ? state.archives : []).map((archive) => ({
      id: archive?.id,
      actor: archive?.actor,
      actorId: archive?.actorId,
      actorRole: archive?.actorRole,
      kind: archive?.kind,
      closedAt: archive?.closedAt,
      orders: Array.isArray(archive?.orders) ? archive.orders : [],
    })),
    ledger: (Array.isArray(state?.ledger) ? state.ledger : [])
      .filter((line) => line?.source === "ORDER_PAYMENT" && line?.archived === true)
      .map((line) => ({
        journal: line?.journal,
        orderId: line?.orderId,
        source: line?.source,
        account: line?.account,
        direction: line?.direction,
        currency: line?.currency,
        amountMinor: line?.amountMinor,
        archived: line?.archived,
        closedAt: line?.closedAt,
      })),
  };
  return crypto.createHash("sha256").update(canonicalJson(evidence)).digest("hex");
}

function plannedOrderArchiveAdditions(beforeState, result) {
  const beforeArchives = Array.isArray(beforeState?.archives) ? beforeState.archives : [];
  const afterArchives = Array.isArray(result?.state?.archives) ? result.state.archives : [];
  return afterArchives.flatMap((archive, archiveIndex) => {
    const beforeCount = Array.isArray(beforeArchives[archiveIndex]?.orders) ? beforeArchives[archiveIndex].orders.length : 0;
    const afterOrders = Array.isArray(archive?.orders) ? archive.orders : [];
    return afterOrders.slice(beforeCount).map((order, additionIndex) => ({
      archiveIndex,
      archiveId: String(archive?.id || ""),
      additionIndex,
      order,
    }));
  });
}

function ownerOrderArchiveRepairPlan(db) {
  const planSchema = "owner-order-archive-repair-v2";
  const workspacePlans = (Array.isArray(db?.workspaces) ? db.workspaces : [])
    .slice()
    .sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")))
    .map((workspace) => {
      const workspaceId = String(workspace?.id || "");
      const state = db.appStates?.[workspaceId] || {};
      const revision = workspaceStateRevision(db, workspaceId);
      const result = backfillAllClosedActorOrderSnapshots(state);
      const participantRetention = retainOrdersForOpenParticipants(state);
      const evidenceDigest = orderArchiveRepairEvidenceDigest(state);
      const plannedAdditions = plannedOrderArchiveAdditions(state, result);
      const repaired = (result.repaired || []).slice().sort((left, right) =>
        [left.archiveId, left.orderId, left.journal].join(":").localeCompare([right.archiveId, right.orderId, right.journal].join(":"))
      );
      const blockedActors = (result.blockedActors || []).map((item) => ({
        actorId: String(item?.actorId || ""),
        actor: String(item?.actor || item?.actorName || ""),
        skippedCount: Number(item?.skippedCount || 0),
        orphanCount: Number(item?.orphanCount || 0),
        reason: Number(item?.skippedCount || 0) > 0
          ? "ambiguous evidence"
          : Number(item?.orphanCount || 0) > 0
            ? "incomplete evidence"
            : !String(item?.actorId || "")
              ? "legacy identity without a permanent Actor ID"
              : "manual review required",
      })).sort((left, right) => [left.actorId, left.actor].join(":").localeCompare([right.actorId, right.actor].join(":")));
      const workspacePlanDigest = crypto.createHash("sha256").update(canonicalJson({
        planSchema,
        workspaceId,
        evidenceDigest,
        plannedAdditions,
        repaired,
        blockedActors,
        closedActorCount: Number(result.closedActorCount || 0),
        unclosedActorCount: Number(result.unclosedActorCount || 0),
      })).digest("hex");
      const repairedActorCount = new Set(repaired.map((item) => String(item.actorId || item.actor || "")).filter(Boolean)).size;
      return {
        workspaceId,
        workspaceName: String(workspace?.name || "Workspace"),
        masterName: workspaceOwnerSubscription(db, workspace).ownerName,
        revision,
        evidenceDigest,
        plannedAdditions,
        workspacePlanDigest,
        result,
        repaired,
        blockedActors,
        candidateCount: Number(result.repairedCount || 0),
        repairedActorCount,
        blockedActorCount: Number(result.blockedActorCount || blockedActors.length || 0),
        closedActorCount: Number(result.closedActorCount || 0),
        unclosedActorCount: Number(result.unclosedActorCount || 0),
        openParticipantRecoveryCount: Number(participantRetention.recoveredCount || 0),
        openParticipantConflictCount: Number(participantRetention.skippedConflictCount || 0),
      };
    });
  const planDigest = crypto.createHash("sha256").update(canonicalJson({
    planSchema,
    workspaces: workspacePlans.map((plan) => ({
      workspaceId: plan.workspaceId,
      workspacePlanDigest: plan.workspacePlanDigest,
    })),
  })).digest("hex");
  const revisionDigest = crypto.createHash("sha256").update(JSON.stringify(workspacePlans.map((plan) => [
    plan.workspaceId,
    plan.revision,
  ]))).digest("hex");
  const candidateCount = workspacePlans.reduce((total, plan) => total + plan.candidateCount, 0);
  return {
    workspacePlans,
    planDigest,
    revisionDigest,
    candidateCount,
    eligibleWorkspaceCount: workspacePlans.filter((plan) => plan.candidateCount > 0).length,
    affectedActorCount: workspacePlans.reduce((total, plan) => total + plan.repairedActorCount, 0),
    blockedActorCount: workspacePlans.reduce((total, plan) => total + plan.blockedActorCount, 0),
    closedActorCount: workspacePlans.reduce((total, plan) => total + plan.closedActorCount, 0),
    unclosedActorCount: workspacePlans.reduce((total, plan) => total + plan.unclosedActorCount, 0),
    openParticipantRecoveryCount: workspacePlans.reduce((total, plan) => total + plan.openParticipantRecoveryCount, 0),
    openParticipantConflictCount: workspacePlans.reduce((total, plan) => total + plan.openParticipantConflictCount, 0),
  };
}

function publicOwnerOrderArchiveRepairPlan(plan) {
  return {
    planDigest: plan.planDigest,
    candidateCount: plan.candidateCount,
    eligibleWorkspaceCount: plan.eligibleWorkspaceCount,
    affectedActorCount: plan.affectedActorCount,
    blockedActorCount: plan.blockedActorCount,
    closedActorCount: plan.closedActorCount,
    unclosedActorCount: plan.unclosedActorCount,
    openParticipantRecoveryCount: plan.openParticipantRecoveryCount,
    openParticipantConflictCount: plan.openParticipantConflictCount,
    privateBackupReady: r2Configured,
    canApply: plan.candidateCount > 0 && r2Configured,
    workspaces: plan.workspacePlans.map((workspace) => ({
      workspace: workspace.workspaceName,
      master: workspace.masterName,
      candidateCount: workspace.candidateCount,
      affectedActorCount: workspace.repairedActorCount,
      blockedActorCount: workspace.blockedActorCount,
      blockedActors: workspace.blockedActors.map((item) => ({
        actor: item.actor || "Unknown Actor",
        reason: item.reason,
      })),
      closedActorCount: workspace.closedActorCount,
      unclosedActorCount: workspace.unclosedActorCount,
      openParticipantRecoveryCount: workspace.openParticipantRecoveryCount,
      openParticipantConflictCount: workspace.openParticipantConflictCount,
    })),
  };
}

async function createOrderArchiveRepairBackup(rawDatabase, { workspaceId, revision, planDigest }) {
  if (!r2Client) throw httpError(503, "Private backup storage is unavailable, so no report data was changed.");
  const createdAt = new Date().toISOString();
  const repairId = `order-archive-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
  const sourceSha256 = crypto.createHash("sha256").update(rawDatabase).digest("hex");
  const backupDirectory = path.join(dataDir, "backups");
  const localBackupName = `auth-db.before-${repairId}.${sourceSha256.slice(0, 12)}.json`;
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(path.join(backupDirectory, localBackupName), rawDatabase, { flag: "wx", mode: 0o600 });

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(ownerPassword, salt, 32);
  const additionalData = Buffer.from(JSON.stringify({ version: 1, repairId, workspaceId, revision, planDigest }));
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(rawDatabase), cipher.final()]);
  const payload = JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm+scrypt",
    createdAt,
    repairId,
    sourceSha256,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    additionalData: additionalData.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  const workspaceSegment = String(workspaceId || "workspace").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100) || "workspace";
  const objectKey = `private-backups/database/${workspaceSegment}/${repairId}.json.enc`;
  await r2Client.send(new PutObjectCommand({
    Bucket: r2BucketName,
    Key: objectKey,
    Body: payload,
    ContentType: "application/json",
    Metadata: { repairid: repairId, sourcesha256: sourceSha256 },
  }));
  const storedObject = await r2Client.send(new GetObjectCommand({ Bucket: r2BucketName, Key: objectKey }));
  const storedPayload = Buffer.from(await storedObject.Body.transformToByteArray());
  if (!storedPayload.equals(Buffer.from(payload))) {
    throw httpError(503, "The encrypted private backup could not be verified, so no report data was changed.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(additionalData);
  decipher.setAuthTag(cipher.getAuthTag());
  const restoredDatabase = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (!restoredDatabase.equals(rawDatabase) || crypto.createHash("sha256").update(restoredDatabase).digest("hex") !== sourceSha256) {
    throw httpError(503, "The encrypted private backup could not be restored and verified, so no report data was changed.");
  }
  return { repairId, createdAt, sourceSha256, localBackupName, objectKey };
}

async function applyOrderArchiveRepair(session, input = {}) {
  return enqueueDbWrite(async () => {
    const rawDatabase = await readFile(dbPath);
    const latestDb = { ...blankDb(), ...JSON.parse(rawDatabase.toString("utf8")) };
    const workspaceId = session.workspace.id;
    const currentState = latestDb.appStates?.[workspaceId] || {};
    const target = orderArchiveRepairTarget(currentState, input);
    const revision = workspaceStateRevision(latestDb, workspaceId);
    const plan = orderArchiveRepairPlan(currentState, target, revision);
    const expectedCount = Number(input.expectedCount);
    if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) throw httpError(400, "Check the report before applying a repair.");
    if (String(input.expectedRevision || "") !== revision || String(input.planDigest || "") !== plan.planDigest || expectedCount !== plan.candidateCount) {
      throw httpError(409, "The workspace changed after the repair check. Check the report again before restoring it.");
    }
    validateOrderArchiveRepair(currentState, plan);
    const backup = await createOrderArchiveRepairBackup(rawDatabase, {
      workspaceId,
      revision,
      planDigest: plan.planDigest,
    });
    const nextState = plan.result.state;
    latestDb.appStates ||= {};
    latestDb.appStates[workspaceId] = nextState;
    const nextRevision = markWorkspaceStateChanged(latestDb, workspaceId, nextState);
    await writePersistedDbAtomic(latestDb);
    return {
      ok: true,
      restoredCount: plan.candidateCount,
      skippedCount: plan.skippedCount,
      orphanCount: plan.orphanCount,
      actor: target.actorName,
      revision: nextRevision,
      backup: {
        repairId: backup.repairId,
        createdAt: backup.createdAt,
        sourceSha256: backup.sourceSha256,
        offsite: true,
      },
    };
  });
}

async function applyOwnerOrderArchiveRepairs(input = {}) {
  return enqueueDbWrite(async () => {
    const rawDatabase = await readFile(dbPath);
    const latestDb = { ...blankDb(), ...JSON.parse(rawDatabase.toString("utf8")) };
    const plan = ownerOrderArchiveRepairPlan(latestDb);
    const expectedCount = Number(input.expectedCount);
    if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
      throw httpError(400, "Check all closed reports before applying a repair.");
    }
    if (String(input.planDigest || "") !== plan.planDigest || expectedCount !== plan.candidateCount) {
      throw httpError(409, "One or more workspaces changed after the repair check. Check all closed reports again before restoring them.");
    }
    const eligiblePlans = plan.workspacePlans.filter((workspace) => workspace.candidateCount > 0);
    for (const workspace of eligiblePlans) {
      validateWorkspaceWideOrderArchiveRepair(latestDb.appStates?.[workspace.workspaceId] || {}, workspace.result);
    }
    const backup = await createOrderArchiveRepairBackup(rawDatabase, {
      workspaceId: "all-workspaces",
      revision: plan.revisionDigest,
      planDigest: plan.planDigest,
    });
    latestDb.appStates ||= {};
    const revisions = {};
    for (const workspace of eligiblePlans) {
      latestDb.appStates[workspace.workspaceId] = workspace.result.state;
      revisions[workspace.workspaceId] = markWorkspaceStateChanged(latestDb, workspace.workspaceId, workspace.result.state);
    }
    const serializedCheck = JSON.parse(JSON.stringify(latestDb));
    for (const workspace of eligiblePlans) {
      const secondPass = backfillAllClosedActorOrderSnapshots(serializedCheck.appStates?.[workspace.workspaceId] || {});
      if (secondPass.repairedCount !== 0) {
        throw httpError(500, "The restored database did not pass its final idempotency check, so no report data was changed.");
      }
    }
    await writePersistedDbAtomic(latestDb);
    return {
      ok: true,
      restoredCount: plan.candidateCount,
      workspaceCount: plan.eligibleWorkspaceCount,
      actorCount: plan.affectedActorCount,
      blockedActorCount: plan.blockedActorCount,
      closedActorCount: plan.closedActorCount,
      unclosedActorCount: plan.unclosedActorCount,
      revisions,
      backup: {
        repairId: backup.repairId,
        createdAt: backup.createdAt,
        sourceSha256: backup.sourceSha256,
        offsite: true,
      },
    };
  });
}

async function applyActorBalanceClose(session, input = {}) {
  const workspaceId = session.workspace.id;
  return mutateLatestWorkspaceState(workspaceId, input.expectedRevision, async (latestDb, currentState) => {
    const cancelledOrderPolicy = String(input.cancelledOrderPolicy || "");
    if (!new Set(["include", "omit"]).has(cancelledOrderPolicy)) {
      throw httpError(400, "Choose whether cancelled orders should be kept in Report or removed without Report.");
    }
    const result = closeActorBalance(currentState, {
      actorId: String(input.actorId || "").trim(),
      actorName: String(input.actorName || "").trim(),
      cancelledOrderPolicy,
      closedAt: new Date().toISOString(),
      archiveId: `ARC-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    });
    if (!result.closed) {
      throw httpError(409, result.error || "There are no completed transactions, collected receivables, or cancelled orders to close for this Actor.");
    }
    latestDb.appStates ||= {};
    latestDb.appStates[workspaceId] = result.state;
    const revision = markWorkspaceStateChanged(latestDb, workspaceId, result.state);
    return {
      ok: true,
      state: stripRestrictedCreditReminders(result.state, session),
      revision,
      actor: result.actorName,
      archiveId: result.archiveId,
      cancelledOrderCount: result.cancelledOrderCount,
      includedCancelledOrderCount: result.includedCancelledOrderCount,
      omittedCancelledOrderCount: result.omittedCancelledOrderCount,
    };
  });
}

function sanitizeIncomingWorkspaceState(state, session, db) {
  if (!state || typeof state !== "object") return {};
  const persistedState = db.appStates[session.workspace.id] || {};
  const actorSession = session?.membership?.role === "Actor";
  const actorCanInitiateOrders = actorSession && ["Broker", "Special Broker"].includes(session?.membership?.actorRole);
  state = resolveIncomingWorkspaceRecordCollisions(persistedState, state, actorCanInitiateOrders ? {
    brokerActorId: session.membership.actorId,
    brokerName: session.membership.actorName,
  } : {});
  const sanitized = { ...state };
  const persistedActors = new Map((persistedState.actors || []).map((actor) => [actor?.id, actor]));
  const persistedOrders = new Map((persistedState.orders || []).map((order) => [order?.id, order]));
  const sessionActor = actorSession ? persistedActors.get(session.membership.actorId) : null;
  const fixedSetting = sessionActor?.orderFixedCommission;
  const rawFixedPercent = fixedSetting?.percent;
  const fixedPercent = fixedSetting?.enabled === true && rawFixedPercent !== null && rawFixedPercent !== undefined && String(rawFixedPercent).trim() !== ""
    ? Number(rawFixedPercent)
    : Number.NaN;
  const canonicalizedNewOrders = [];
  const brokerNumberChanges = [];
  delete sanitized._syncRevision;
  if (session?.membership?.role !== "Master") {
    sanitized.deletedOrderIds = Array.isArray(persistedState.deletedOrderIds)
      ? [...persistedState.deletedOrderIds]
      : [];
  }
  if (session?.membership?.role !== "Master") delete sanitized.chatHistoryResetAt;
  if (Array.isArray(state.actors) && session?.membership?.role !== "Master") {
    sanitized.actors = state.actors.map((actor) => {
      const persistedActor = persistedActors.get(actor?.id);
      if (!persistedActor) return actor;
      const protectedActor = { ...actor };
      for (const field of ["orderFixedRates", "orderFixedCommission"]) {
        if (Object.prototype.hasOwnProperty.call(persistedActor, field)) protectedActor[field] = structuredClone(persistedActor[field]);
        else delete protectedActor[field];
      }
      return protectedActor;
    });
  }
  if (Array.isArray(state.receivables)) {
    sanitized.receivables = state.receivables.map((receivable) => {
      if (sessionCanAccessCreditReminder(session, receivable)) return receivable;
      const { creditReminder, ...allowedReceivable } = receivable;
      return allowedReceivable;
    });
  }
  if (session?.membership?.role !== "Master") {
    sanitized.archives = structuredClone(persistedState.archives || []);
  }
  const storedFiles = new Map((db?.files || [])
    .filter((file) => file?.workspaceId === session?.workspace?.id && file?.status === "active")
    .map((file) => [file.id, file]));
  if (Array.isArray(state.orders)) {
    sanitized.orders = state.orders.map((order) => {
      let allowedOrder = { ...order };
      const recoveredCollisionSourceId = String(allowedOrder?._serverCollisionSourceOrderId || "").trim();
      delete allowedOrder._serverCollisionSourceOrderId;
      const proof = order?.paymentProof;
      if (proof?.attachmentId) {
        const file = storedFiles.get(proof.attachmentId);
        if (!(file?.purpose === "payment-proof" && file.contextId === order.id)) {
          const { attachmentId, size, ...allowedProof } = proof;
          allowedOrder = { ...allowedOrder, paymentProof: allowedProof };
        }
      }
      const persistedOrder = persistedOrders.get(allowedOrder?.id);
      const persistedBrokerActor = persistedOrder
        ? persistedActors.get(persistedOrder?.brokerActorId) ||
          Array.from(persistedActors.values()).find((actor) => !persistedOrder?.brokerActorId && actor?.name === persistedOrder?.broker)
        : null;
      const submittedBrokerActor = persistedActors.get(allowedOrder?.brokerActorId) ||
        Array.from(persistedActors.values()).find((actor) => !allowedOrder?.brokerActorId && actor?.name === allowedOrder?.broker);
      const persistedBelongsToSessionActor = Boolean(persistedOrder) && (
        String(persistedOrder?.brokerActorId || "") === String(session.membership.actorId || "") ||
        (!persistedOrder?.brokerActorId && String(persistedOrder?.broker || "") === String(session.membership.actorName || ""))
      );
      const isReturnedResubmission = persistedBelongsToSessionActor && persistedOrder.state === "Returned" && allowedOrder?.state === "Pending Forward";
      if (persistedOrder) {
        const protectedOrder = { ...allowedOrder };
        for (const field of ["brokerActorId", "broker", "brokerOrderNumber", "brokerOrderNumberCycle", "collisionSourceOrderId"]) {
          if (Object.prototype.hasOwnProperty.call(persistedOrder, field)) protectedOrder[field] = persistedOrder[field];
          else delete protectedOrder[field];
        }
        if (actorSession && !isReturnedResubmission) {
          for (const field of ["commissionPercent", "commissionMinor", "grossMinor", "orderCommissionLiability"]) {
            if (Object.prototype.hasOwnProperty.call(persistedOrder, field)) protectedOrder[field] = persistedOrder[field];
            else delete protectedOrder[field];
          }
        }
        if (!actorSession || !isReturnedResubmission) return protectedOrder;
        allowedOrder = protectedOrder;
      }
      if (actorSession) {
        if (!actorCanInitiateOrders) return null;
        allowedOrder = {
          ...allowedOrder,
          brokerActorId: isReturnedResubmission ? persistedOrder.brokerActorId || session.membership.actorId : session.membership.actorId,
          broker: isReturnedResubmission ? persistedOrder.broker || session.membership.actorName : session.membership.actorName,
        };
      }
      const brokerActor = actorSession ? sessionActor : submittedBrokerActor || persistedBrokerActor;
      const isNewOrder = !persistedOrder;
      if (isNewOrder && brokerActor && ["Broker", "Special Broker"].includes(String(brokerActor.role || ""))) {
        const previousNumber = String(allowedOrder.brokerOrderNumber || "");
        const canonicalNumber = nextBrokerOrderNumberForActor(persistedState, brokerActor, canonicalizedNewOrders);
        allowedOrder.brokerActorId = brokerActor.id;
        allowedOrder.broker = brokerActor.name;
        allowedOrder.brokerOrderNumber = canonicalNumber.brokerOrderNumber;
        allowedOrder.brokerOrderNumberCycle = canonicalNumber.brokerOrderNumberCycle;
        if (recoveredCollisionSourceId) allowedOrder.collisionSourceOrderId = recoveredCollisionSourceId;
        else delete allowedOrder.collisionSourceOrderId;
        canonicalizedNewOrders.push(allowedOrder);
        if (previousNumber && previousNumber !== allowedOrder.brokerOrderNumber) {
          brokerNumberChanges.push({ orderId: allowedOrder.id, previousNumber, nextNumber: allowedOrder.brokerOrderNumber });
        }
      } else if (!persistedOrder) {
        delete allowedOrder.collisionSourceOrderId;
      }
      if (!actorSession || !Number.isFinite(fixedPercent)) return allowedOrder;
      const sourceAmountMinor = Math.round(Number(allowedOrder.sourceAmountMinor || 0));
      const commissionMinor = Math.round(sourceAmountMinor * fixedPercent / 100);
      return {
        ...allowedOrder,
        commissionPercent: fixedPercent,
        commissionMinor,
        grossMinor: sourceAmountMinor + commissionMinor,
        orderCommissionLiability: fixedPercent < 0 ? "Master" : "Broker",
      };
    }).filter(Boolean);
  }
  if (brokerNumberChanges.length) {
    const changesByOrderId = new Map(brokerNumberChanges.map((change) => [String(change.orderId || ""), change]));
    sanitized.receivables = (sanitized.receivables || []).map((receivable) => {
      const change = changesByOrderId.get(String(receivable?.orderId || ""));
      return change ? { ...receivable, brokerOrderNumber: change.nextNumber } : receivable;
    });
  }
  if (Array.isArray(state.chatConversations)) {
    sanitized.chatConversations = state.chatConversations.map((chat) => ({
      ...chat,
      messages: (chat?.messages || []).map((message) => {
        if (!message?.attachmentId) return message;
        const file = storedFiles.get(message.attachmentId);
        const chatFileMatches = file && ["chat-photo", "chat-voice", "chat-file"].includes(file.purpose) && (file.contextIds || [file.contextId]).includes(chat.id);
        const proofFileMatches = ["payment-proof", "order-photo"].includes(file?.purpose) && file.contextId === message.orderId;
        if (chatFileMatches) return message;
        if (proofFileMatches) {
          const linkedOrder = (persistedState.orders || []).find((order) => order?.id === message.orderId)
            || (state.orders || []).find((order) => order?.id === message.orderId);
          const persistedChat = (persistedState.chatConversations || []).find((item) => item?.id === chat.id);
          const masterActorName = (persistedState.actors || state.actors || []).find((actor) => actor?.role === "Master")?.name || "Master";
          const brokerChatMatches = Boolean(linkedOrder && persistedChat?.type === "direct" &&
            (persistedChat.members || []).includes(masterActorName) && (persistedChat.members || []).includes(linkedOrder.broker));
          const senderChatMatches = sessionCanUseChat(persistedState, session, chat.id);
          if (brokerChatMatches || senderChatMatches || session?.membership?.role === "Master") {
            file.contextIds = Array.from(new Set([...(file.contextIds || [file.contextId]), chat.id]));
            return message;
          }
        }
        if (file && session?.membership?.role === "Master" && sessionCanUseChat(state, session, chat.id)) {
          file.contextIds = Array.from(new Set([...(file.contextIds || [file.contextId]), chat.id]));
          return message;
        }
        const { attachmentId, fileSize, ...allowedMessage } = message;
        return allowedMessage;
      }),
    }));
  }
  if (brokerNumberChanges.length && Array.isArray(sanitized.chatConversations)) {
    const changesByOrderId = new Map(brokerNumberChanges.map((change) => [String(change.orderId || ""), change]));
    sanitized.chatConversations = sanitized.chatConversations.map((conversation) => ({
      ...conversation,
      messages: (conversation?.messages || []).map((message) => {
        const change = changesByOrderId.get(String(message?.orderId || ""));
        if (!change || String(message?.orderNumber || "") !== change.previousNumber) return message;
        return { ...message, orderNumber: change.nextNumber };
      }),
    }));
  }
  return sanitized;
}

function resetWorkspaceState(db, workspaceId, scope = "data") {
  const currentState = db.appStates[workspaceId] || {};
  const chatHistoryResetAt = new Date().toISOString();
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
    savedCustomers: [],
    receivables: [],
    transfers: [],
    ledger: [],
    masterBankEntries: [],
    archives: [],
    deletedOrderIds: [],
    actorResetTombstones: normalizeActorResetTombstones(),
    chatConversations: scope === "wipe"
      ? []
      : (currentState.chatConversations || []).map((chat) => ({ ...chat, messages: [] })),
    chatHistoryResetAt,
    chatReplyTo: "",
    settlements: scope === "wipe"
      ? []
      : actors
        .filter((actor) => actor?.role !== "Master")
        .map((actor) => ({ actor: actor.name, currency: actor.currency || "USD", netMinor: 0 })),
    journalCounter: 0,
    manualJournalCounter: 0,
    withdrawalCounter: 0,
    orderCounter: 0,
    receivableCounter: 0,
    customerCounter: 0,
    transferCounter: 0,
    transferRecordCounter: 0,
    masterTransactionCycle: 0,
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
    nextState.selectedChatId = "";
    nextState.chatCounter = 0;
    nextState.messageCounter = 0;
    nextState.deletedActorIds = Array.from(new Set([...(currentState.deletedActorIds || []), ...removedActors.map((actor) => actor.id).filter(Boolean)]));
    nextState.deletedActorNames = Array.from(new Set([...(currentState.deletedActorNames || []), ...removedActors.map((actor) => actor.name).filter(Boolean)]));
  }
  return nextState;
}

async function requireSession(request, response, db, { touch = true } = {}) {
  const sessionId = parseCookies(request).hp_session;
  const sessionRecord = activeSessionRecord(db, sessionId);
  const session = publicSessionForRecord(db, sessionRecord);
  if (!session) {
    clearSessionCookie(response);
    sendJson(response, 401, { error: "Please log in." });
    return null;
  }
  if (session.subscription.accessDenied) {
    clearSessionCookie(response);
    sendJson(response, 402, { error: "This workspace's 30-day viewing period has ended. Renew the subscription to regain access." });
    return null;
  }
  if (session.subscription.inactive) {
    sendJson(response, 403, { error: "This workspace is inactive." });
    return null;
  }
  const currentDeviceId = requestDeviceId(request);
  const deviceIdAdded = Boolean(sessionRecord && !sessionRecord.deviceId && currentDeviceId);
  if (deviceIdAdded) sessionRecord.deviceId = currentDeviceId;
  if (touch) {
    touchSession(sessionRecord);
    setSessionCookie(response, sessionRecord);
    await saveDb(db);
  } else if (deviceIdAdded) {
    await saveDb(db);
  }
  return session;
}

function requireOwner(session, response) {
  if (session.membership.role !== "Owner") {
    sendJson(response, 403, { error: "Only Owner can perform this action." });
    return false;
  }
  return true;
}

function createSession(db, userId, workspaceId, deviceId = "") {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const idleTimeoutSeconds = accountIdleTimeoutSeconds(db, userId);
  const session = {
    id: id("sess"),
    userId,
    workspaceId,
    deviceId,
    createdAt: timestamp,
    lastActivityAt: timestamp,
    idleTimeoutSeconds,
    expiresAt: idleTimeoutSeconds === 0 ? "" : new Date(now + idleTimeoutSeconds * 1000).toISOString(),
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
    let session = publicSessionForRecord(db, sessionRecord);
    if (session?.subscription?.accessDenied || session?.subscription?.inactive) session = null;
    if (sessionRecord && session) {
      if (!sessionRecord.deviceId) sessionRecord.deviceId = requestDeviceId(request);
      touchSession(sessionRecord);
      setSessionCookie(response, sessionRecord);
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

    const user = {
      id: id("usr"),
      name,
      email,
      passwordHash: hashPassword(password),
      idleTimeoutSeconds: defaultSessionIdleSeconds,
      createdAt: new Date().toISOString(),
    };
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
      const subscription = workspaceOwnerSubscription(db, workspace);
      if (subscription.inactive) return sendJson(response, 403, { error: "This workspace is inactive." });
      if (subscription.readOnly) {
        return sendJson(response, 403, {
          error: "This workspace is read-only after subscription expiry. Renew the subscription before adding an account.",
          code: "SUBSCRIPTION_READ_ONLY",
          readOnly: true,
          graceEndsAt: subscription.graceEndsAt,
        });
      }
      if (subscription.accessDenied) {
        return sendJson(response, 402, { error: "This workspace's 30-day viewing period has ended. Renew the subscription to regain access." });
      }
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
    const expectedWorkspaceRevision = workspaceStateRevision(db, workspace.id);
    markWorkspaceStateChanged(db, workspace.id);
    clearLoginAttempts(db, email);
    const session = createSession(db, user.id, workspace.id, requestDeviceId(request));
    await saveDb(db, workspaceStateSaveOptions(db, workspace.id, expectedWorkspaceRevision));
    setSessionCookie(response, session);
    sendJson(response, 200, { session: publicSession(db, session.id) });
    return;
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const body = await readJson(request);
    const rawLogin = String(body.email || body.username || "").trim();
    const rawPassword = String(body.password || "").trim();
    return withLoginOperationLock(rawLogin, async () => {
      const loginDb = await loadDb();
      const now = Date.now();
      const { attempt } = activeLoginAttempt(loginDb, rawLogin, now);
      const lockedUntil = new Date(attempt?.lockedUntil || 0).getTime();
      if (Number.isFinite(lockedUntil) && lockedUntil > now) {
        const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
        response.setHeader("Retry-After", String(retryAfterSeconds));
        return sendJson(response, 423, {
          error: "This account is locked for one hour after four failed login attempts. Try again later.",
          lockedUntil: new Date(lockedUntil).toISOString(),
        });
      }
      const ownerLogin = rawLogin.toLowerCase() === ownerUser.toLowerCase();
      const ownerMatches = ownerLogin &&
        (loginDb.ownerPasswordHash ? verifyPassword(rawPassword, loginDb.ownerPasswordHash) : rawPassword === ownerPassword);
      const email = rawLogin.toLowerCase();
      const user = loginDb.users.find((item) => item.email === email);
      const userMatches = user && verifyPassword(body.password, user.passwordHash);
      if (!ownerMatches && !userMatches) {
        const failedLogin = recordFailedLogin(loginDb, rawLogin, now);
        await saveDb(loginDb);
        if (failedLogin.failedAttempts >= 4) {
          response.setHeader("Retry-After", String(Math.floor(loginLockMs / 1000)));
          return sendJson(response, 423, {
            error: "This account is now locked for one hour after four failed login attempts.",
            lockedUntil: failedLogin.lockedUntil,
          });
        }
        if (failedLogin.failedAttempts === 3) {
          return sendJson(response, 401, {
            error: "Email or password is incorrect. Warning: one attempt remains before this account is locked for one hour.",
            warning: true,
            attemptsRemaining: 1,
          });
        }
        return sendJson(response, 401, { error: "Email or password is incorrect." });
      }
      clearLoginAttempts(loginDb, rawLogin);
      if (ownerMatches) {
        const session = createSession(loginDb, "__owner", "__owner", requestDeviceId(request));
        await saveDb(loginDb);
        setSessionCookie(response, session);
        sendJson(response, 200, { session: publicSession(loginDb, session.id) });
        return;
      }
      const membership = loginDb.memberships.find((item) => item.userId === user.id);
      if (!membership) {
        await saveDb(loginDb);
        return sendJson(response, 401, { error: "This account is not linked to a workspace." });
      }
      const workspace = loginDb.workspaces.find((item) => item.id === membership.workspaceId);
      const subscription = workspaceOwnerSubscription(loginDb, workspace);
      if (membership.role === "Master" && user.active === false) {
        await saveDb(loginDb);
        return sendJson(response, 403, { error: "This Master account is inactive." });
      }
      if (subscription.inactive) {
        await saveDb(loginDb);
        return sendJson(response, 403, { error: "This workspace is inactive." });
      }
      if (subscription.accessDenied) {
        await saveDb(loginDb);
        return sendJson(response, 402, { error: "This workspace's 30-day viewing period has ended. Renew the subscription to regain access." });
      }
      const session = createSession(loginDb, user.id, membership.workspaceId, requestDeviceId(request));
      await saveDb(loginDb);
      setSessionCookie(response, session);
      sendJson(response, 200, { session: publicSession(loginDb, session.id) });
    });
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    const sessionId = parseCookies(request).hp_session;
    const nextDb = { ...db, sessions: db.sessions.filter((item) => item.id !== sessionId) };
    await saveDb(nextDb, { replace: true });
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  const backgroundRead = method === "GET" && (
    ["/api/app-state", "/api/app-state/version", "/api/auth/device-warning", "/api/files/status"].includes(url.pathname) ||
    /^\/api\/files\/[^/]+\/(?:download-url|content)$/.test(url.pathname)
  );
  const session = await requireSession(request, response, db, { touch: !backgroundRead });
  if (!session) return;

  if (session.subscription.readOnly && method !== "GET" && url.pathname !== "/api/auth/activity") {
    sendJson(response, 403, {
      error: "This workspace is read-only after subscription expiry. Renew the subscription to make changes.",
      code: "SUBSCRIPTION_READ_ONLY",
      readOnly: true,
      graceEndsAt: session.subscription.graceEndsAt,
    });
    return;
  }

  if (url.pathname === "/api/files/status" && method === "GET") {
    const state = db.appStates[session.workspace.id] || {};
    sendJson(response, 200, {
      configured: r2Configured,
      storedFiles: (db.files || []).filter((file) => file.workspaceId === session.workspace.id && file.status === "active").length,
      pendingFiles: (db.files || []).filter((file) => file.workspaceId === session.workspace.id && file.status === "pending").length,
      legacyAttachments: legacyAttachmentCount(state),
    });
    return;
  }

  if (url.pathname === "/api/files/payment-proof" && method === "POST") {
    const client = requireR2();
    const purpose = "payment-proof";
    const contextId = String(url.searchParams.get("contextId") || "");
    const fileName = safeAttachmentFileName(url.searchParams.get("fileName"));
    const mimeType = normalizedMimeType(request.headers["content-type"]);
    const rule = attachmentRules.get(purpose);
    if (!rule?.mimeTypes.has(mimeType)) {
      return sendJson(response, 400, { error: "Attach only a JPG, JPEG, or PNG image." });
    }
    validateAttachmentContext(db, session, purpose, contextId);
    const body = await readBinary(request, rule.maxBytes);
    attachmentRule(purpose, mimeType, body.length);
    const file = newFileRecord(session, {
      purpose,
      contextId,
      fileName,
      mimeType,
      size: body.length,
      status: "active",
    });
    const result = await client.send(new PutObjectCommand({
      Bucket: r2BucketName,
      Key: file.key,
      Body: body,
      ContentType: file.mimeType,
      ContentLength: body.length,
    }));
    file.etag = String(result.ETag || "").replace(/^"|"$/g, "");
    db.files.push(file);
    await saveDb(db);
    sendJson(response, 200, { file: publicFileRecord(file) });
    return;
  }

  if (url.pathname === "/api/files/upload-url" && method === "POST") {
    const client = requireR2();
    const body = await readJson(request);
    const purpose = String(body.purpose || "");
    const contextId = String(body.contextId || body.orderId || body.chatId || "");
    const fileName = safeAttachmentFileName(body.fileName);
    const size = Number(body.size);
    const rule = attachmentRule(purpose, body.mimeType, size);
    validateAttachmentContext(db, session, purpose, contextId);
    const file = newFileRecord(session, { purpose, contextId, fileName, mimeType: rule.mimeType, size });
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
      Bucket: r2BucketName,
      Key: file.key,
      ContentType: file.mimeType,
    }), { expiresIn: signedUploadSeconds });
    db.files.push(file);
    await saveDb(db);
    sendJson(response, 200, {
      uploadUrl,
      uploadHeaders: { "Content-Type": file.mimeType },
      expiresIn: signedUploadSeconds,
      file: publicFileRecord(file),
    });
    return;
  }

  const completeFileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/complete$/);
  if (completeFileMatch && method === "POST") {
    const client = requireR2();
    const fileId = decodeURIComponent(completeFileMatch[1]);
    const file = (db.files || []).find((item) => item.id === fileId && item.workspaceId === session.workspace.id);
    if (!file || file.status !== "pending") return sendJson(response, 404, { error: "This pending upload is no longer available." });
    if (file.uploaderUserId !== session.user.id && session.membership.role !== "Master") {
      return sendJson(response, 403, { error: "Only the uploader or Master can complete this upload." });
    }
    let head;
    try {
      head = await client.send(new HeadObjectCommand({ Bucket: r2BucketName, Key: file.key }));
    } catch {
      throw httpError(409, "The file has not finished uploading to R2. Try again.");
    }
    const actualSize = Number(head.ContentLength || 0);
    const actualType = normalizedMimeType(head.ContentType || file.mimeType);
    const rule = attachmentRules.get(file.purpose);
    if (!actualSize || actualSize !== Number(file.expectedSize) || actualSize > Number(rule?.maxBytes || 0) || actualType !== file.mimeType) {
      await client.send(new DeleteObjectCommand({ Bucket: r2BucketName, Key: file.key })).catch(() => {});
      db.files = db.files.filter((item) => item.id !== file.id);
      await saveDb(db, { replace: true });
      throw httpError(400, "The uploaded file did not match its approved size or format and was removed.");
    }
    file.status = "active";
    file.size = actualSize;
    file.completedAt = new Date().toISOString();
    file.etag = String(head.ETag || "").replace(/^"|"$/g, "");
    await saveDb(db);
    sendJson(response, 200, { file: publicFileRecord(file) });
    return;
  }

  const downloadFileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download-url$/);
  if (downloadFileMatch && method === "GET") {
    const client = requireR2();
    const fileId = decodeURIComponent(downloadFileMatch[1]);
    const file = (db.files || []).find((item) => item.id === fileId);
    if (!sessionCanAccessFile(db, session, file)) return sendJson(response, 404, { error: "This attachment is unavailable." });
    const downloadUrl = await getSignedUrl(client, new GetObjectCommand({
      Bucket: r2BucketName,
      Key: file.key,
      ResponseContentType: file.mimeType,
      ResponseContentDisposition: `inline; filename="${safeAttachmentFileName(file.fileName)}"`,
    }), { expiresIn: signedDownloadSeconds });
    sendJson(response, 200, {
      downloadUrl,
      expiresIn: signedDownloadSeconds,
      file: publicFileRecord(file),
    });
    return;
  }

  const fileContentMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/content$/);
  if (fileContentMatch && method === "GET") {
    const client = requireR2();
    const fileId = decodeURIComponent(fileContentMatch[1]);
    const file = (db.files || []).find((item) => item.id === fileId);
    if (!sessionCanAccessFile(db, session, file)) return sendJson(response, 404, { error: "This attachment is unavailable." });
    const storedObject = await client.send(new GetObjectCommand({
      Bucket: r2BucketName,
      Key: file.key,
    }));
    if (!storedObject.Body) throw httpError(404, "This attachment is unavailable.");
    const body = Buffer.from(await storedObject.Body.transformToByteArray());
    response.writeHead(200, {
      "Content-Type": file.mimeType,
      "Content-Length": body.length,
      "Content-Disposition": `inline; filename="${safeAttachmentFileName(file.fileName)}"`,
      "Cache-Control": "private, no-store",
    });
    response.end(body);
    return;
  }

  if (url.pathname === "/api/files/migrate" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can migrate existing attachments." });
    requireR2();
    const body = await readJson(request);
    const limit = Math.min(25, Math.max(1, Number(body.limit) || 10));
    const result = await migrateLegacyAttachments(db, session, limit);
    sendJson(response, 200, {
      attempted: result.attempted,
      migrated: result.migrated,
      failed: result.failed,
      remaining: result.remaining,
      state: stripRestrictedCreditReminders(result.state, session),
      revision: result.revision,
    });
    return;
  }

  if (url.pathname === "/api/auth/device-warning" && method === "GET") {
    const sessionId = parseCookies(request).hp_session;
    sendJson(response, 200, {
      warning: accountDeviceLoginWarning(db, activeSessionRecord(db, sessionId)),
      subscription: session.subscription,
    });
    return;
  }

  if (url.pathname === "/api/auth/activity" && method === "POST") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/auth/timeout" && method === "PUT") {
    const body = await readJson(request);
    const idleTimeoutSeconds = Number(body.idleTimeoutSeconds);
    if (!allowedSessionIdleSeconds.has(idleTimeoutSeconds)) {
      return sendJson(response, 400, { error: "Choose one of the available automatic logout times." });
    }
    if (session.user.id === "__owner") {
      db.ownerIdleTimeoutSeconds = idleTimeoutSeconds;
    } else {
      const user = db.users.find((item) => item.id === session.user.id);
      if (!user) return sendJson(response, 404, { error: "This account was not found." });
      user.idleTimeoutSeconds = idleTimeoutSeconds;
    }
    const now = Date.now();
    db.sessions
      .filter((item) => item.userId === session.user.id)
      .forEach((item) => {
        item.idleTimeoutSeconds = idleTimeoutSeconds;
        touchSession(item, now);
      });
    const sessionId = parseCookies(request).hp_session;
    const currentSessionRecord = db.sessions.find((item) => item.id === sessionId);
    if (currentSessionRecord) setSessionCookie(response, currentSessionRecord);
    await saveDb(db);
    sendJson(response, 200, {
      ok: true,
      idleTimeoutSeconds,
      session: publicSessionForRecord(db, currentSessionRecord),
    });
    return;
  }

  if (url.pathname === "/api/auth/password" && method === "POST") {
    const body = await readJson(request);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const confirmNewPassword = String(body.confirmNewPassword || "");
    if (newPassword.length < 6) return sendJson(response, 400, { error: "Enter a new password of at least 6 characters." });
    if (newPassword !== confirmNewPassword) return sendJson(response, 400, { error: "New password and confirmation must match." });
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

  if (url.pathname === "/api/owner/repair-order-archives/plan-all" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const plan = ownerOrderArchiveRepairPlan(db);
    sendJson(response, 200, publicOwnerOrderArchiveRepairPlan(plan));
    return;
  }

  if (url.pathname === "/api/owner/order-integrity/plan" && method === "GET") {
    if (!requireOwner(session, response)) return;
    const issues = (Array.isArray(db.workspaces) ? db.workspaces : []).flatMap((workspace) => {
      const state = db.appStates?.[workspace.id] || {};
      const master = workspaceOwnerSubscription(db, workspace).ownerName;
      return findPendingOrderIntegrityIssues(state).map((issue) => ({
        workspace: String(workspace.name || "Workspace"),
        master,
        actor: issue.actorName,
        actorRole: issue.actorRole,
        orderNumber: issue.orderNumber,
        expectedPrefix: issue.expectedPrefix,
        count: issue.count,
        extraCopies: issue.extraCopies,
        wrongPrefix: issue.wrongPrefix,
        duplicate: issue.duplicate,
        exactDuplicates: issue.exactDuplicates,
        linkedRecords: issue.linkedRecords,
        safeAutoRepair: issue.safeAutoRepair,
        reason: issue.reason,
      }));
    });
    sendJson(response, 200, {
      issueCount: issues.length,
      safeIssueCount: issues.filter((issue) => issue.safeAutoRepair).length,
      extraCopyCount: issues.reduce((total, issue) => total + issue.extraCopies, 0),
      issues,
    });
    return;
  }

  if (url.pathname === "/api/owner/repair-order-archives/apply-all" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const result = await applyOwnerOrderArchiveRepairs(body);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/owner/masters" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const currency = supportedCurrencySet.has(body.currency) ? body.currency : "USD";
    if (!name || !email || password.length < 6) return sendJson(response, 400, { error: "Enter Master name, email, and a password of at least 6 characters." });
    if (db.users.some((user) => user.email === email)) return sendJson(response, 409, { error: "That email already has an account." });
    const planId = subscriptionPlans.has(body.plan) ? body.plan : "one_month";
    const plan = subscriptionPlan(planId);
    const user = {
      id: id("usr"),
      name,
      email,
      passwordHash: hashPassword(password),
      idleTimeoutSeconds: defaultSessionIdleSeconds,
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
      currency,
      workingCurrencies: [],
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    db.workspaces.push(workspace);
    db.memberships.push(membership);
    await saveDb(db);
    sendJson(response, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, currency, subscriptionExpiresAt: user.subscriptionExpiresAt } });
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

  if (url.pathname === "/api/owner/masters/email" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const userId = String(body.userId || "");
    const email = String(body.email || "").trim().toLowerCase();
    const targetUser = db.users.find((user) => user.id === userId);
    const targetMembership = db.memberships.find((membership) =>
      membership.userId === userId && membership.role === "Master"
    );
    if (!targetUser || !targetMembership) {
      return sendJson(response, 404, { error: "Master user was not found." });
    }
    if (!validEmailAddress(email)) {
      return sendJson(response, 400, { error: "Enter a valid Gmail or email address." });
    }
    if (
      email === ownerUser.toLowerCase() ||
      db.users.some((user) => user.id !== userId && String(user.email || "").toLowerCase() === email)
    ) {
      return sendJson(response, 409, { error: "That email already has an account." });
    }
    const previousEmail = targetUser.email || "";
    if (previousEmail === email) {
      sendJson(response, 200, {
        ok: true,
        updated: false,
        user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
      });
      return;
    }
    targetUser.email = email;
    clearLoginAttempts(db, previousEmail);
    clearLoginAttempts(db, email);
    await saveDb(db);
    sendJson(response, 200, {
      ok: true,
      updated: true,
      user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
    });
    return;
  }

  if (url.pathname === "/api/owner/masters/name" && method === "POST") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const userId = String(body.userId || "");
    const name = String(body.name || "").trim();
    const targetUser = db.users.find((user) => user.id === userId);
    const targetMembership = db.memberships.find((membership) =>
      membership.userId === userId && membership.role === "Master"
    );
    if (!targetUser || !targetMembership) {
      return sendJson(response, 404, { error: "Master user was not found." });
    }
    if (!validMasterDisplayName(name)) {
      return sendJson(response, 400, { error: "Enter a Master name between 1 and 100 characters." });
    }
    if (targetUser.name === name) {
      sendJson(response, 200, {
        ok: true,
        updated: false,
        user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
      });
      return;
    }
    targetUser.name = name;
    await saveDb(db);
    sendJson(response, 200, {
      ok: true,
      updated: true,
      user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
    });
    return;
  }

  if (url.pathname === "/api/owner/masters" && method === "DELETE") {
    if (!requireOwner(session, response)) return;
    const body = await readJson(request);
    const userId = String(body.userId || "");
    const targetUser = db.users.find((user) => user.id === userId);
    const targetMembership = db.memberships.find((membership) => membership.userId === userId && membership.role === "Master");
    const workspaceIds = db.workspaces
      .filter((workspace) => workspace.ownerUserId === userId)
      .map((workspace) => workspace.id);
    if (!targetUser || !targetMembership || !workspaceIds.length) {
      return sendJson(response, 404, { error: "Master user was not found." });
    }

    const relatedMemberships = db.memberships.filter((membership) => workspaceIds.includes(membership.workspaceId));
    const relatedInvites = db.invites.filter((invite) => workspaceIds.includes(invite.workspaceId));
    const relatedUserIds = new Set([
      userId,
      ...relatedMemberships.map((membership) => membership.userId),
      ...relatedInvites.map((invite) => invite.acceptedByUserId).filter(Boolean),
    ]);
    const relatedUsers = db.users.filter((user) => relatedUserIds.has(user.id));
    const relatedFiles = (db.files || []).filter((file) => workspaceIds.includes(file.workspaceId));
    const expectedWorkspaceRevisions = Object.fromEntries(
      workspaceIds.map((workspaceId) => [workspaceId, workspaceStateRevision(db, workspaceId)])
    );

    if (relatedFiles.some((file) => file.key) && !r2Client) {
      return sendJson(response, 503, { error: "Private file storage must be available before this Master can be removed." });
    }
    if (relatedFiles.length) {
      const deletionResults = await Promise.allSettled(relatedFiles
        .filter((file) => file.key)
        .map((file) => r2Client.send(new DeleteObjectCommand({ Bucket: r2BucketName, Key: file.key }))));
      if (deletionResults.some((result) => result.status === "rejected")) {
        return sendJson(response, 502, { error: "Stored files could not be removed. No account records were deleted; please try again." });
      }
    }

    db.users = db.users.filter((user) => !relatedUserIds.has(user.id));
    db.workspaces = db.workspaces.filter((workspace) => !workspaceIds.includes(workspace.id));
    db.memberships = db.memberships.filter((membership) => !workspaceIds.includes(membership.workspaceId));
    db.invites = db.invites.filter((invite) => !workspaceIds.includes(invite.workspaceId));
    db.sessions = db.sessions.filter((item) => !workspaceIds.includes(item.workspaceId) && !relatedUserIds.has(item.userId));
    db.files = (db.files || []).filter((file) => !workspaceIds.includes(file.workspaceId));
    workspaceIds.forEach((workspaceId) => delete db.appStates[workspaceId]);
    relatedUsers.forEach((user) => clearLoginAttempts(db, user.email));
    await saveDb(db, {
      replace: true,
      expectedAppStateRevisions: expectedWorkspaceRevisions,
      appStateUpdates: Object.fromEntries(workspaceIds.map((workspaceId) => [workspaceId, null])),
    });
    sendJson(response, 200, {
      ok: true,
      removed: {
        master: targetUser.name,
        workspaces: workspaceIds.length,
        users: relatedUserIds.size,
        actors: relatedMemberships.filter((membership) => membership.role !== "Master").length,
        files: relatedFiles.length,
      },
    });
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
    const currency = supportedCurrencySet.has(body.currency) ? body.currency : "USD";
    const workingCurrencies = Array.isArray(body.workingCurrencies)
      ? body.workingCurrencies.filter((item) => supportedCurrencySet.has(item)).slice(0, supportedCurrencies.length)
      : [];
    const specialWorkingCurrencies = actorRole === "Special Broker" && !workingCurrencies.some((item) => item !== currency)
      ? [...supportedCurrencies]
      : Array.from(new Set([currency, ...workingCurrencies])).slice(0, supportedCurrencies.length);
    const invite = {
      id: id("inv"),
      code: inviteCode(),
      workspaceId: session.workspace.id,
      actorRole,
      currency,
      workingCurrencies: ["Special Agent", "Special Broker"].includes(actorRole) ? specialWorkingCurrencies : [],
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

  if (url.pathname === "/api/app-state/version" && method === "GET") {
    sendJson(response, 200, { revision: workspaceStateRevision(db, session.workspace.id), clientReleaseId: "participant-order-retention-v1" });
    return;
  }

  if (url.pathname === "/api/app-state/close-balance" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can close an Actor balance." });
    const body = await readJson(request);
    const result = await applyActorBalanceClose(session, body);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/app-state/repair-order-archives/plan" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can repair closed Actor reports." });
    const body = await readJson(request);
    const currentState = db.appStates[session.workspace.id] || {};
    const target = orderArchiveRepairTarget(currentState, body);
    const plan = orderArchiveRepairPlan(currentState, target, workspaceStateRevision(db, session.workspace.id));
    sendJson(response, 200, {
      actor: target.actorName,
      actorId: target.actorId,
      candidateCount: plan.candidateCount,
      skippedCount: plan.skippedCount,
      orphanCount: plan.orphanCount,
      existingCount: plan.existingCount,
      evidenceCount: plan.evidenceCount,
      planDigest: plan.planDigest,
      revision: plan.revision,
      privateBackupReady: r2Configured,
      canApply: plan.candidateCount > 0 && plan.skippedCount === 0 && plan.orphanCount === 0 && r2Configured,
    });
    return;
  }

  if (url.pathname === "/api/app-state/repair-order-archives/apply" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can repair closed Actor reports." });
    const body = await readJson(request);
    const result = await applyOrderArchiveRepair(session, body);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/app-state" && method === "GET") {
    const currentState = db.appStates[session.workspace.id] || {};
    const state = mergeWorkspaceState(db, session.workspace.id, currentState);
    sendJson(response, 200, {
      state: stripRestrictedCreditReminders(state, session),
      revision: workspaceStateRevision(db, session.workspace.id),
    });
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
    const expectedRevision = workspaceStateRevision(db, session.workspace.id);
    const currentState = db.appStates[session.workspace.id] || {};
    const nextState = { ...currentState };
    nextState.deletedActorIds = Array.from(new Set([...(currentState.deletedActorIds || []), actorId]));
    nextState.deletedActorNames = Array.from(new Set([...(currentState.deletedActorNames || []), actorName].filter(Boolean)));
    nextState.actors = (currentState.actors || []).filter((actor) => actor?.id !== actorId);
    nextState.settlements = (currentState.settlements || []).filter((item) => item?.actor !== actorName);
    if (nextState.selectedLedgerActor === actorName) nextState.selectedLedgerActor = "";
    if (nextState.expandedFixedRateActorId === actorId) nextState.expandedFixedRateActorId = "";
    if (nextState.expandedSpecialDividerActorId === actorId) nextState.expandedSpecialDividerActorId = "";
    const revision = markWorkspaceStateChanged(db, session.workspace.id, nextState);
    await saveDb(db, { replace: true, ...workspaceStateSaveOptions(db, session.workspace.id, expectedRevision) });
    sendJson(response, 200, { ok: true, state: stripRestrictedCreditReminders(nextState, session), revision });
    return;
  }

  if (url.pathname === "/api/app-state/reset-actor" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can reset Actor data." });
    const body = await readJson(request);
    const actorId = String(body.actorId || "");
    const expectedRevision = workspaceStateRevision(db, session.workspace.id);
    const currentState = db.appStates[session.workspace.id] || {};
    const actors = mergeById(workspaceActors(db, session.workspace.id), currentState.actors || []);
    const actor = actors.find((item) => item?.id === actorId && item?.role !== "Master");
    if (!actor) return sendJson(response, 400, { error: "Choose an Actor to reset." });
    const nextState = structuredClone(currentState);
    nextState.actors = actors;
    const counts = resetSpecificActorData(nextState, actor);
    const revision = markWorkspaceStateChanged(db, session.workspace.id, nextState);
    await saveDb(db, { replace: true, ...workspaceStateSaveOptions(db, session.workspace.id, expectedRevision) });
    sendJson(response, 200, {
      ok: true,
      actor: { id: actor.id, name: actor.name },
      counts,
      state: stripRestrictedCreditReminders(nextState, session),
      revision,
    });
    return;
  }

  if (url.pathname === "/api/app-state/reset" && method === "POST") {
    if (session.membership.role !== "Master") return sendJson(response, 403, { error: "Only Master can reset workspace data." });
    const body = await readJson(request);
    const scope = body.scope === "wipe" ? "wipe" : "data";
    const expectedRevision = workspaceStateRevision(db, session.workspace.id);
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
    const revision = markWorkspaceStateChanged(db, session.workspace.id, nextState);
    await saveDb(db, { replace: true, ...workspaceStateSaveOptions(db, session.workspace.id, expectedRevision) });
    sendJson(response, 200, { ok: true, state: stripRestrictedCreditReminders(nextState, session), revision });
    return;
  }

  if (url.pathname === "/api/app-state" && method === "PUT") {
    const body = await readJson(request);
    const result = await mutateLatestWorkspaceState(
      session.workspace.id,
      body.expectedRevision ?? body.state?._syncRevision,
      async (latestDb) => {
        const incomingState = sanitizeIncomingWorkspaceState(body.state || {}, session, latestDb);
        const nextState = mergeWorkspaceState(latestDb, session.workspace.id, incomingState);
        const revision = markWorkspaceStateChanged(latestDb, session.workspace.id, nextState);
        return {
          ok: true,
          state: stripRestrictedCreditReminders(nextState, session),
          revision,
        };
      }
    );
    sendJson(response, 200, result);
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
    const rootRelativePath = path.relative(root, filePath);
    const protectedDataPath = path.resolve(dataDir);
    const protectedSourcePath = path.resolve(root, "server.mjs");
    const protectedRelativePath = relativePath.split(/[\\/]+/).some((segment) => segment.startsWith("."));

    if (
      rootRelativePath === ".." ||
      rootRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rootRelativePath) ||
      filePath === protectedDataPath ||
      filePath.startsWith(`${protectedDataPath}${path.sep}`) ||
      filePath === protectedSourcePath ||
      protectedRelativePath
    ) {
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
      const statusCode = Number(error?.statusCode);
      sendJson(response, Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500, {
        error: error instanceof Error ? error.message : "Server error.",
      });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`HaderaPay running at http://${host}:${port}`);
});
