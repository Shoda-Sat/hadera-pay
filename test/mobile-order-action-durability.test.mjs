import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} was not found`);
  assert.notEqual(end, -1, `${endMarker} was not found after ${startMarker}`);
  return source.slice(start, end);
}

function sectionFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} was not found`);
  return source.slice(start);
}

function jsxTagWithLabel(source, label) {
  const labelIndex = source.indexOf(`label="${label}"`);
  assert.notEqual(labelIndex, -1, `${label} button was not found`);
  const start = source.lastIndexOf("<Button", labelIndex);
  const end = source.indexOf("/>", labelIndex);
  assert.notEqual(start, -1, `${label} button opening tag was not found`);
  assert.notEqual(end, -1, `${label} button closing tag was not found`);
  return source.slice(start, end + 2);
}

function matchIndex(source, expression, message) {
  const match = source.match(expression);
  assert.ok(match, message);
  return match.index;
}

function loadTypeScriptModule(source, dependencies = {}) {
  const outputText = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", outputText)(module.exports, module, (specifier) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, specifier)) return dependencies[specifier];
    throw new Error(`Unexpected runtime import: ${specifier}`);
  });
  return module.exports;
}

function session(overrides = {}) {
  return {
    userId: "USR-1",
    workspaceId: "WS-1",
    actorId: "ACT-1",
    actorName: "Broker One",
    ...overrides
  };
}

test("mobile routing attempts are typed and stored per workspace user", async () => {
  const [typesSource, durabilitySource] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/src/types.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/routingDurability.ts"), "utf8")
  ]);

  const orderType = sectionBetween(typesSource, "export interface OrderRecord", "export interface PaymentProofRecord");
  assert.match(orderType, /routingSubmissionId\?:\s*string\s*;/,
    "Android orders must retain the Broker submission acknowledgement token.");
  assert.match(orderType, /routingForwardAttemptId\?:\s*string\s*;/,
    "Android orders must retain the Master forwarding acknowledgement token.");

  const values = new Map();
  const asyncStorage = {
    async getItem(key) { return values.has(key) ? values.get(key) : null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); }
  };
  const durability = loadTypeScriptModule(durabilitySource, {
    "@react-native-async-storage/async-storage": { default: asyncStorage, ...asyncStorage }
  });
  const firstSession = session();
  const otherUser = session({ userId: "USR-2" });
  const otherWorkspace = session({ workspaceId: "WS-2" });
  const firstKey = durability.mobileRoutingActionOutboxKey(firstSession);

  assert.match(firstKey, /WS-1/);
  assert.match(firstKey, /USR-1/);
  assert.notEqual(firstKey, durability.mobileRoutingActionOutboxKey(otherUser));
  assert.notEqual(firstKey, durability.mobileRoutingActionOutboxKey(otherWorkspace));

  const record = {
    kind: "broker-send",
    attemptId: "mobile-broker-1",
    workspaceId: firstSession.workspaceId,
    userId: firstSession.userId,
    order: { id: "ORD-1", routingSubmissionId: "mobile-broker-1", receiverName: "Exact receiver" },
    draft: {},
    editingOrderId: ""
  };
  await durability.persistMobileRoutingAction(firstSession, record);
  assert.deepEqual(await durability.readMobileRoutingAction(firstSession), record,
    "The complete unfinished attempt must survive an app restart.");
  assert.equal(await durability.readMobileRoutingAction(otherUser), null,
    "One signed-in user must never recover another user's routing attempt.");
  await durability.clearMobileRoutingAction(firstSession, "different-attempt");
  assert.deepEqual(await durability.readMobileRoutingAction(firstSession), record,
    "A late result for another attempt must not clear the active recovery record.");
  await durability.clearMobileRoutingAction(firstSession, record.attemptId);
  assert.equal(await durability.readMobileRoutingAction(firstSession), null);
  values.set(firstKey, "{not-json");
  await assert.rejects(
    durability.readMobileRoutingAction(firstSession),
    /unreadable/i,
    "Corrupt protection data must block a fresh order instead of failing open."
  );
  values.delete(firstKey);

  const brokerOrder = {
    id: "ORD-1",
    routingSubmissionId: "ROUTE-SEND-ORD-1-ONE",
    brokerActorId: "ACT-BROKER",
    broker: "Broker",
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 550_000,
    receiverName: "Exact receiver",
    accountNumber: "10001",
    phoneNumber: "0911000000",
    createdAt: "2026-08-23T10:00:00.000Z"
  };
  assert.equal(durability.brokerRoutingOrderMatches({ ...brokerOrder }, brokerOrder), true);
  assert.equal(durability.brokerRoutingOrderMatches({ ...brokerOrder, id: "ORD-OTHER" }, brokerOrder), false);
  assert.equal(durability.brokerRoutingOrderMatches({ ...brokerOrder, routingSubmissionId: "another" }, brokerOrder), false);
  assert.equal(durability.brokerRoutingOrderMatches({ ...brokerOrder, receiverName: "Changed" }, brokerOrder), false);
  assert.equal(durability.routingOrderIdentityMatches({ ...brokerOrder, receiverName: "Changed" }, brokerOrder), true);
  assert.equal(durability.routingOrderContentMatches({ ...brokerOrder, receiverName: "Changed" }, brokerOrder), false,
    "A raw ID collision must not be mistaken for the protected Broker order.");

  const masterOrder = {
    ...brokerOrder,
    state: "Assigned",
    routingForwardAttemptId: "ROUTE-FORWARD-1",
    agentActorId: "ACT-PAYER",
    forwardedPayoutDivider: 2.5,
    forwardedPayoutPercent: 1.75
  };
  assert.equal(durability.masterRoutingOrderMatches({ ...masterOrder }, masterOrder), true);
  assert.equal(durability.masterRoutingOrderMatches({ ...masterOrder, id: "ORD-OTHER" }, masterOrder), false);
  assert.equal(durability.masterRoutingOrderMatches({ ...masterOrder, agentActorId: "ACT-OTHER" }, masterOrder), false);
  assert.equal(durability.masterRoutingOrderMatches({ ...masterOrder, forwardedPayoutPercent: 2 }, masterOrder), false);
  assert.equal(
    durability.mobileMasterRoutingAttemptId(masterOrder, "ACT-PAYER", "2.5", "1.75"),
    durability.mobileMasterRoutingAttemptId(masterOrder, "ACT-PAYER", "2.5", "1.75"),
    "The same forwarding details must always produce the same retry token."
  );
});

test("mobile Broker Send persists and reuses one exact attempt until acknowledgement", async () => {
  const clientSource = await readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8");
  const submit = sectionFrom(clientSource, "export async function submitTransferOrder");

  assert.match(submit, /readMobileRoutingAction\(session\)/,
    "A retry or restart must first look for the unfinished Broker attempt.");
  assert.match(submit, /mobileBrokerRoutingAttemptId\(/,
    "Broker Send must assign a stable submission token.");
  assert.match(submit, /routingSubmissionId/);
  assert.match(submit, /persistMobileRoutingAction\(session,[\s\S]*?order/,
    "The durable Broker record must retain the complete submitted order.");

  const persistIndex = matchIndex(submit, /await\s+persistMobileRoutingAction\(/,
    "Broker Send must await durable outbox storage.");
  const saveIndex = matchIndex(submit, /await\s+saveBrokerSubmissionAtomic\(/,
    "Broker Send authoritative save was not found.");
  const afterSave = submit.slice(saveIndex);
  const acknowledgementIndex = matchIndex(afterSave, /brokerRoutingOrderMatches\(/,
    "Broker Send must verify the exact token and order returned by the server.");
  const clearIndex = matchIndex(afterSave, /await\s+clearMobileRoutingAction\(/,
    "The acknowledged Broker outbox clear was not found.");
  assert.ok(persistIndex < saveIndex,
    "Broker Send must reach AsyncStorage before the first network save can be interrupted.");
  assert.ok(acknowledgementIndex < clearIndex,
    "Broker recovery must be cleared only after the server proves the exact attempt committed.");
  assert.match(submit, /if\s*\(unfinished\)[\s\S]*?brokerRoutingOrderMatches\([\s\S]*?clearMobileRoutingAction/,
    "A restarted Broker action may clear its outbox early only after authoritative reconciliation.");
});

test("mobile Master Forward persists the exact payer terms and deterministic message", async () => {
  const workspaceSource = await readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8");
  const assign = sectionBetween(workspaceSource, "export async function assignOrder", "export async function returnOrder");

  assert.match(assign, /readMobileRoutingAction\(/,
    "Master retry must recover the previously selected forwarding attempt.");
  assert.match(assign, /mobileMasterRoutingAttemptId\(/,
    "Master Forward must retain one stable attempt token.");
  assert.match(assign, /routingForwardAttemptId/);
  const protectedRecord = sectionBetween(assign, "protectedAttempt = unfinished || {", "if (unfinished) protectedAttempt");
  assert.match(protectedRecord, /targetActorId:\s*agent\.id/);
  assert.match(protectedRecord, /targetActorName:\s*agent\.name/);
  assert.match(protectedRecord, /dividerText:\s*effectiveDividerText/);
  assert.match(protectedRecord, /percentText:\s*effectivePercentText/,
    "The outbox must preserve the exact payer, divider, and percentage visible to Master.");
  assert.match(assign, /MSG-\$\{(?:routingForwardAttemptId|attemptId)\}/,
    "Forward retries must reuse a deterministic assignment-message ID.");

  const persistIndex = matchIndex(assign, /await\s+persistMobileRoutingAction\(/,
    "Master Forward must await its durable outbox.");
  const saveIndex = matchIndex(assign, /await\s+saveWorkspaceState\(/,
    "Master Forward authoritative save was not found.");
  const afterSave = assign.slice(saveIndex);
  const acknowledgementIndex = matchIndex(afterSave, /masterRoutingOrderMatches\(/,
    "Master Forward must verify the exact token, payer, and terms returned by the server.");
  const clearIndex = matchIndex(afterSave, /await\s+clearMobileRoutingAction\(/,
    "The acknowledged Master outbox clear was not found.");
  assert.ok(persistIndex < saveIndex,
    "Master Forward must reach AsyncStorage before the network save can be interrupted.");
  assert.ok(acknowledgementIndex < clearIndex,
    "Master recovery must be cleared only after exact server acknowledgement.");
});

test("mobile restart recovery reconciles server state before restoring explicit retry", async () => {
  const [recoverySource, appSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/src/domain/routingRecovery.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8")
  ]);

  assert.match(recoverySource, /readMobileRoutingAction\(/);
  assert.match(recoverySource, /loadWorkspaceState\(/,
    "Restart recovery must compare its outbox with authoritative server state.");
  assert.match(recoverySource, /brokerRoutingOrderMatches\(/);
  assert.match(recoverySource, /masterRoutingOrderMatches\(/);
  assert.match(recoverySource, /routingOrderIdentityMatches\([\s\S]*?routingOrderContentMatches\(/,
    "An active or archived ID alias must also match the protected order contents before resolving recovery.");
  assert.match(recoverySource, /candidate\.id\s*!==\s*action\.editingOrderId[\s\S]*?candidate\.state\s*!==\s*"Returned"/,
    "Recovery must retain an edited Returned-order retry by its exact original ID.");
  assert.match(recoverySource, /candidate\.brokerActorId\s*===\s*action\.order\.brokerActorId/,
    "An edited Returned-order retry must still belong to the same Broker before recovery keeps it.");
  assert.match(recoverySource, /effectiveCurrentOrder\s*=\s*currentOrder\s*\|\|\s*returnedOrder/,
    "Recovery must not discard a protected edit merely because the server still has the old Returned details.");
  assert.match(recoverySource, /clearMobileRoutingAction\(/);
  assert.match(recoverySource, /state\.archives/,
    "Recovery must not recreate an order that has already moved into a closed report.");
  assert.match(recoverySource, /deletedOrderIds/,
    "Recovery must accept an authoritative deletion instead of recreating the order.");
  assert.doesNotMatch(recoverySource, /submitTransferOrder\(|assignOrder\(/,
    "Opening the app must restore exact retry controls without automatically writing a financial action.");
  assert.match(recoverySource, /status:\s*"pending"/,
    "An unacknowledged action must remain protected for an explicit exact retry.");
  assert.match(appSource, /recoverMobileRoutingAction\(/,
    "App startup must reconcile unfinished routing instead of silently abandoning it.");
});

test("mobile Master UI locks Return and Cancel while the order is forwarding", async () => {
  const screenSource = await readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8");
  const ordersScreen = sectionBetween(screenSource, "export function OrdersScreen", "export function");

  assert.match(ordersScreen, /routingForward/i,
    "The Orders screen must track an order-specific forwarding state.");
  assert.match(jsxTagWithLabel(ordersScreen, "Forward order"), /disabled=\{[^}]*routingForward/i,
    "A second forwarding press must be blocked while the first attempt is unresolved.");
  assert.match(jsxTagWithLabel(ordersScreen, "Return"), /disabled=\{[^}]*routingForward/i,
    "Return must be disabled while the same order is forwarding.");
  assert.match(jsxTagWithLabel(ordersScreen, "Cancel"), /disabled=\{[^}]*routingForward/i,
    "Cancel must be disabled while the same order is forwarding.");
});
