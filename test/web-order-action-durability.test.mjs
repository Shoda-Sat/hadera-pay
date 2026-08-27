import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} was not found`);
  assert.notEqual(end, -1, `${endMarker} was not found after ${startMarker}`);
  return source.slice(start, end);
}

function matchIndex(source, expression, message) {
  const match = source.match(expression);
  assert.ok(match, message);
  return match.index;
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listenerBlock(source, registrationIndex) {
  const arrow = source.indexOf("=>", registrationIndex);
  const openingBrace = source.indexOf("{", arrow);
  assert.notEqual(arrow, -1, "The beforeunload listener must use a visible callback.");
  assert.notEqual(openingBrace, -1, "The beforeunload callback body was not found.");

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(registrationIndex, index + 1);
  }
  assert.fail("The beforeunload callback body was not closed.");
}

function acknowledgedSave(section, actionLabel, saveFunction = "saveStateNow") {
  const escapedSaveFunction = escapedRegExp(saveFunction);
  const resultMatch = section.match(new RegExp(
    `(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+${escapedSaveFunction}\\([\\s\\S]*?\\)\\s*;`
  ));
  assert.ok(resultMatch, `${actionLabel} must await ${saveFunction}() and retain its acknowledgement result.`);
  const resultName = resultMatch[1];
  const failureGuard = new RegExp(
    `if\\s*\\(\\s*(?:!\\s*${resultName}|${resultName}\\s*!==?\\s*true|${resultName}\\s*===?\\s*false)\\s*\\)`
  );
  return {
    saveIndex: resultMatch.index,
    failureIndex: matchIndex(section, failureGuard, `${actionLabel} must stop its success path when saving is not acknowledged.`),
  };
}

function assertScopedPendingSave(section, actionLabel, { orderScoped, saveFunction = "saveStateNow" }) {
  const addMatch = section.match(/pendingOrderActionSaves\.add\s*\(\s*([^\n;)]+)\s*\)/);
  assert.ok(addMatch, `${actionLabel} must register its own pending order action.`);
  const addIndex = addMatch.index;
  const addArgument = addMatch[1].trim();
  let keyExpression = addArgument;
  if (/^[A-Za-z_$][\w$]*$/.test(addArgument)) {
    const assignment = section.match(new RegExp(`(?:const|let)\\s+${escapedRegExp(addArgument)}\\s*=\\s*([^;]+);`));
    assert.ok(assignment, `${actionLabel} must expose how its pending action key is scoped.`);
    keyExpression = assignment[1];
  }
  assert.match(keyExpression, actionLabel === "Broker Send" ? /send/i : /forward/i,
    `${actionLabel} pending state must distinguish this action from other order work.`);
  if (orderScoped) {
    assert.match(keyExpression, /order\??\.id/,
      `${actionLabel} pending state must be scoped to the affected order ID.`);
  } else if (/order\??\.id/.test(keyExpression)) {
    const globalGuardIndex = matchIndex(
      section,
      /pendingOrderActionSaves[\s\S]*?\.some\s*\([\s\S]*?startsWith\(\s*["']broker-send:/,
      `${actionLabel} must reject a second send even before that click can create another order ID.`
    );
    const buildIndex = matchIndex(section, /buildOrderRecord\s*\(/,
      `${actionLabel} must expose where its new order ID is allocated.`);
    assert.ok(globalGuardIndex < buildIndex,
      `${actionLabel} must check the action-wide send guard before allocating a new order ID.`);
  }
  const saveIndex = matchIndex(
    section,
    new RegExp(`await\\s+${escapedRegExp(saveFunction)}\\(`),
    `${actionLabel} must wait for the authoritative save.`
  );
  const deleteIndex = matchIndex(
    section,
    /pendingOrderActionSaves\.delete\s*\(/,
    `${actionLabel} must release its pending order action.`
  );
  assert.ok(addIndex < saveIndex, `${actionLabel} must become pending before its save begins.`);
  assert.ok(deleteIndex > saveIndex, `${actionLabel} must remain pending until its save settles.`);
  assert.match(
    section,
    /finally\s*\{[\s\S]*?pendingOrderActionSaves\.delete\s*\(/,
    `${actionLabel} must release the pending marker in finally, including on network failures.`
  );
}

test("web Broker Send waits for acknowledged persistence before clearing or reporting success", async () => {
  const [index, preview] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
  ]);
  assert.equal(index, preview, "The served web app and preview must stay byte-identical.");
  assert.ok(/(?:const|let)\s+pendingOrderActionSaves\s*=\s*new\s+Set\s*\(\s*\)/.test(index),
    "Order durability must use an action-scoped pending Set, not a workspace-wide unload flag.");

  const brokerSend = sectionBetween(
    index,
    'document.getElementById("orderForm").addEventListener("submit"',
    "els.cancelTransferEditButton.addEventListener"
  );
  assert.match(brokerSend, /async\s*\(\s*\)\s*=>\s*\{/,
    "The confirmed Broker Send callback must be asynchronous.");
  assertScopedPendingSave(brokerSend, "Broker Send", { orderScoped: false, saveFunction: "saveBrokerSendNow" });

  const { saveIndex, failureIndex } = acknowledgedSave(brokerSend, "Broker Send", "saveBrokerSendNow");
  const clearIndex = matchIndex(brokerSend, /clearOrderDetails\(\)/,
    "Broker Send must clear the order form after a successful save.");
  const successIndex = matchIndex(brokerSend, /notifyEvent\(\s*"New order"/,
    "Broker Send must report success after a successful save.");
  const failureNoticeIndex = matchIndex(brokerSend, /notifyEvent\(\s*"Order not sent"/,
    "Broker Send must report a failed authoritative save.");

  assert.ok(failureIndex > saveIndex, "Broker Send must inspect the acknowledgement after awaiting it.");
  assert.ok(failureNoticeIndex > failureIndex, "Broker Send failure feedback must belong to the failed-save path.");
  assert.ok(clearIndex > failureIndex, "Broker Send must not clear the form until the save result is accepted.");
  assert.ok(successIndex > failureIndex, "Broker Send must not say the order was sent before acknowledgement.");

  const receivableSuccessIndex = brokerSend.indexOf('notifyEvent("Receivable registered"');
  if (receivableSuccessIndex !== -1) {
    assert.ok(receivableSuccessIndex > failureIndex,
      "Broker Send must not report a persisted receivable before the order save is acknowledged.");
  }
});

test("web Credit orders cannot queue a second confirmation or save", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const brokerSubmit = sectionBetween(
    index,
    'document.getElementById("orderForm").addEventListener("submit"',
    "els.cancelTransferEditButton.addEventListener"
  );
  const creditGuardIndex = matchIndex(
    brokerSubmit,
    /input\.fundingType\s*===\s*"credit"\s*&&\s*brokerCreditConfirmationPending/,
    "Credit Broker Send must reject a second confirmation for the same form action."
  );
  const routingGuardIndex = matchIndex(
    brokerSubmit,
    /if\s*\(routingActionIsBlocked\(actionKey\)\)\s*return\s*;/,
    "Broker Send must reject an already-running save before opening another confirmation."
  );
  const reserveIndex = matchIndex(
    brokerSubmit,
    /if\s*\(input\.fundingType\s*===\s*"credit"\)\s*brokerCreditConfirmationPending\s*=\s*true/,
    "Credit Broker Send must reserve its confirmation synchronously."
  );
  const confirmationIndex = matchIndex(
    brokerSubmit,
    /confirmAction\("Send this order to Master for routing\?"/,
    "Broker Send confirmation was not found."
  );
  assert.ok(creditGuardIndex < confirmationIndex && routingGuardIndex < confirmationIndex && reserveIndex < confirmationIndex,
    "Credit duplicate protection must run before the confirmation can queue another order ID.");
  const confirmedSend = brokerSubmit.slice(confirmationIndex);
  assert.match(confirmedSend, /async\s*\(\)\s*=>\s*\{\s*brokerCreditConfirmationPending\s*=\s*false/,
    "Starting the one protected save must release only its confirmation reservation.");
  assert.match(confirmedSend, /\},\s*\(\)\s*=>\s*\{\s*brokerCreditConfirmationPending\s*=\s*false/,
    "Rejecting the confirmation must release the Credit reservation without creating an order.");

  const resetSession = sectionBetween(index, "function resetOrderActionSession", "function routingActionIsBlocked");
  assert.match(resetSession, /brokerCreditConfirmationPending\s*=\s*false/,
    "Changing login or workspace must release the Credit confirmation reservation.");
});

test("web Master Forward checks the save result before reporting success", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const masterForward = sectionBetween(
    index,
    'const forwardButton = event.target.closest(".forward-order")',
    'const masterReturnButton = event.target.closest(".master-return-order")'
  );
  assertScopedPendingSave(masterForward, "Master Forward", { orderScoped: true, saveFunction: "saveMasterForwardNow" });

  const { saveIndex, failureIndex } = acknowledgedSave(masterForward, "Master Forward", "saveMasterForwardNow");
  const successIndex = matchIndex(masterForward, /notifyEvent\(\s*"Order forwarded"/,
    "Master Forward must report success after a successful save.");
  const failureNoticeIndex = matchIndex(masterForward, /notifyEvent\(\s*"Order not forwarded"/,
    "Master Forward must report a failed authoritative save.");

  assert.ok(failureIndex > saveIndex, "Master Forward must inspect the acknowledgement after awaiting it.");
  assert.ok(failureNoticeIndex > failureIndex, "Master Forward failure feedback must belong to the failed-save path.");
  assert.ok(successIndex > failureIndex, "Master Forward must not report success before acknowledgement.");
});

test("the unload warning is scoped only to pending or unconfirmed order actions", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const registrations = Array.from(index.matchAll(/(?:window|globalThis)\.addEventListener\(\s*["']beforeunload["']/g));
  assert.equal(registrations.length, 1, "The web app should install one clear order-save unload guard.");

  const unloadGuard = listenerBlock(index, registrations[0].index);
  assert.match(unloadGuard, /pendingOrderActionSaves\.size\s*>\s*0|pendingOrderActionSaves\.size\s*!==?\s*0|pendingOrderActionSaves\.size\s*===?\s*0/,
    "The unload guard must be controlled by pending order actions.");
  assert.match(unloadGuard, /unconfirmedOrderActions\.size/,
    "An ambiguous routing result must keep refresh protection active.");
  assert.match(unloadGuard, /preventDefault\(\)/);
  assert.match(unloadGuard, /returnValue\s*=/);
  assert.doesNotMatch(unloadGuard, /remoteSavePending|saveTimer|actorPermissionSavePending/,
    "Ordinary background saves must not cause disruptive unload warnings.");
});

test("Broker Send and Master Forward share one routing mutex and pause background refresh", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const brokerSend = sectionBetween(
    index,
    'confirmAction("Send this order to Master for routing?"',
    "els.cancelTransferEditButton.addEventListener"
  );
  const masterForward = sectionBetween(
    index,
    'const forwardButton = event.target.closest(".forward-order")',
    'const masterReturnButton = event.target.closest(".master-return-order")'
  );

  for (const [label, section, firstMutation] of [
    ["Broker Send", brokerSend, /localMutationApplied\s*=\s*true/],
    ["Master Forward", masterForward, /localMutationApplied\s*=\s*true/],
  ]) {
    const guardIndex = matchIndex(
      section,
      /if\s*\(\s*routingActionIsBlocked\(actionKey\)\s*\)\s*return\s*;/,
      `${label} must respect the global routing-action mutex.`
    );
    const mutationIndex = matchIndex(section, firstMutation, `${label} mutation point was not found.`);
    const addIndex = matchIndex(section, /pendingOrderActionSaves\.add\s*\(/,
      `${label} must acquire the shared mutex.`);
    assert.ok(guardIndex < mutationIndex, `${label} must check the mutex before changing order state.`);
    assert.ok(guardIndex < addIndex, `${label} must reject concurrent routing before acquiring its marker.`);
  }

  const refresh = sectionBetween(index, "async function refreshSharedState", "function startRemoteRefresh");
  const pendingGuards = Array.from(refresh.matchAll(/pendingOrderActionSaves\.size\s*>\s*0/g));
  assert.ok(pendingGuards.length >= 2,
    "Background refresh must check the routing mutex both before fetching and before merging remote state.");
  const versionIndex = matchIndex(refresh, /api\(\s*"\/api\/app-state\/version"/,
    "The background version request was not found.");
  const stateIndex = matchIndex(refresh, /api\(\s*"\/api\/app-state"/,
    "The background state request was not found.");
  const mergeIndex = matchIndex(refresh, /mergeSharedState\s*\(/,
    "The background merge point was not found.");
  assert.ok(pendingGuards[0].index < versionIndex,
    "A routing action must pause refresh before the first network request.");
  assert.ok(pendingGuards.some((guard) => guard.index > stateIndex && guard.index < mergeIndex),
    "A routing action that begins during the GET must prevent that response from merging into the action state.");
});

test("routing saves use scoped payloads and reconcile ambiguous results with authoritative state", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const queueSave = sectionBetween(index, "function queueRemoteStateSave", "function clientDeviceId");
  const immediateSave = sectionBetween(index, "async function saveStateNow", "function captureOrderActionRecord");
  assert.match(queueSave, /function queueRemoteStateSave\(stateSnapshot\s*=\s*null\)/);
  assert.match(queueSave, /const submittedState\s*=\s*structuredClone\(\s*stateSnapshot\s*\|\|\s*state\s*\)\s*;/,
    "The queued request must freeze the submitted state before waiting behind an earlier write.");
  assert.match(queueSave, /body:\s*\{\s*state:\s*submittedState,\s*expectedRevision:/,
    "The PUT body must use the captured submitted state.");
  assert.doesNotMatch(queueSave, /body:\s*\{\s*state,\s*expectedRevision:/,
    "A delayed queue entry must never serialize mutable live state.");
  assert.match(immediateSave, /queueRemoteStateSave\(stateSnapshot\)/,
    "saveStateNow must carry the immutable snapshot through to the queue.");

  const authoritative = sectionBetween(
    index,
    "async function authoritativeOrderActionState",
    "function adoptAuthoritativeOrderActionState"
  );
  assert.match(authoritative, /api\(\s*"\/api\/app-state"\s*\)/,
    "An ambiguous write result must be resolved by reading authoritative workspace state.");

  const brokerSend = sectionBetween(index, 'confirmAction("Send this order to Master for routing?"', "els.cancelTransferEditButton.addEventListener");
  const masterForward = sectionBetween(index, 'const forwardButton = event.target.closest(".forward-order")', 'const masterReturnButton = event.target.closest(".master-return-order")');
  const brokerRequest = sectionBetween(brokerSend, "let saveAcknowledged = await saveBrokerSendNow({", "if (!orderActionSessionIsCurrent(actionSession))");
  for (const field of [
    "attemptId",
    "order",
    "previousOrder",
    "receivable",
    "removeReceivable",
    "customers",
    "orderCounter",
    "receivableCounter",
    "customerCounter",
  ]) {
    assert.match(brokerRequest, new RegExp(`\\b${field}\\s*:`), `Broker Send must submit ${field}.`);
  }
  assert.doesNotMatch(brokerRequest, /\b(?:state|ledger|archives|transfers|settlements)\s*:/,
    "Broker Send must not upload the whole workspace or financial collections.");
  assert.match(brokerSend, /saveBrokerSendNow\([\s\S]*?\(\)\s*=>\s*structuredClone\(state\)/,
    "The full workspace fallback snapshot must be created lazily only when an old server needs it.");

  const masterRequest = sectionBetween(masterForward, "const masterForwardRequest = {", "let saveAcknowledged = await saveMasterForwardNow");
  for (const field of [
    "orderId",
    "targetActorId",
    "attemptId",
    "preferredChatId",
    "expectedRoutingSubmissionId",
    "expectedOrderUpdatedAt",
    "expectedOrder",
    "payoutDivider",
    "payoutPercent",
  ]) {
    assert.match(masterRequest, new RegExp(`\\b${field}\\s*:`), `Master Forward must submit ${field}.`);
  }
  assert.doesNotMatch(masterRequest, /\b(?:state|ledger|archives|transfers|settlements)\s*:/,
    "Master Forward must not upload the whole workspace or financial collections.");
  assert.match(masterForward, /await\s+saveMasterForwardNow\(\s*masterForwardRequest\s*,/,
    "Master Forward must use the scoped atomic action before its compatibility fallback.");
  assert.match(masterForward, /saveMasterForwardNow\(\s*masterForwardRequest\s*,\s*\(\)\s*=>\s*structuredClone\(state\)/,
    "The full workspace fallback snapshot must be created lazily only when an old server needs it.");

  const actionSections = [
    ["Broker Send", brokerSend, "saveBrokerSendNow"],
    ["Master Forward", masterForward, "saveMasterForwardNow"],
  ];
  for (const [label, section, saveFunction] of actionSections) {
    const savePattern = new RegExp(`await\\s+${escapedRegExp(saveFunction)}\\(`);
    assert.match(section, savePattern,
      `${label} must await its authoritative persistence action.`);
    const saveIndex = matchIndex(section, savePattern, `${label} save was not found.`);
    const afterSave = section.slice(saveIndex);
    const failureIndex = matchIndex(afterSave, /if\s*\(\s*!saveAcknowledged\s*\)/,
      `${label} ambiguous-save branch was not found.`);
    const authoritativeIndex = matchIndex(afterSave, /await\s+authoritativeOrderActionState\(\s*order\.id\s*,/,
      `${label} must read the server after an unacknowledged save.`);
    const rollbackIndex = matchIndex(afterSave, /rollbackLocalAction\(\)\s*;/,
      `${label} scoped rollback was not found.`);
    assert.ok(failureIndex < authoritativeIndex,
      `${label} should fetch authoritative state only after detecting an ambiguous acknowledgement.`);
    assert.ok(authoritativeIndex < rollbackIndex,
      `${label} must check whether the server committed before rolling back local state.`);
    assert.match(afterSave, /verification\.confirmed/,
      `${label} must require the expected routing attempt in authoritative state.`);
    assert.match(afterSave, /adoptAuthoritativeOrderActionState\(verification\.remote\)/,
      `${label} must adopt the authoritative winner, including a concurrent forward by another Master session.`);
  }
});

test("routing acknowledgement proves the exact attempt and stale snapshot conflicts are not resent", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const queueSave = sectionBetween(index, "function queueRemoteStateSave", "function clientDeviceId");
  assert.match(queueSave, /attempt\s*===\s*2\s*\|\|\s*stateSnapshot/,
    "An explicit routing snapshot must stop on revision conflict instead of overwriting a concurrent Master change.");

  const brokerCommit = sectionBetween(index, "function brokerRoutingCommitted", "function sameOptionalForwardingTerm");
  assert.match(brokerCommit, /routingSubmissionId\s*!==\s*submittedOrder\.routingSubmissionId/,
    "Broker acknowledgement must require this submission token, so an unchanged Returned order cannot pass.");
  assert.match(brokerCommit, /candidate\.state\s*===\s*"Pending Forward"/,
    "A direct Broker response must prove the Pending Forward transition.");

  const masterCommit = sectionBetween(index, "function masterRoutingCommitted", "async function authoritativeOrderActionState");
  assert.match(masterCommit, /routingForwardAttemptId\s*!==\s*submittedOrder\.routingForwardAttemptId/,
    "Master acknowledgement must require this forwarding token.");
  assert.match(masterCommit, /candidate\.agentActorId\s*!==\s*targetActor\.id/,
    "Master acknowledgement must require the selected stable Actor identity.");
  assert.match(masterCommit, /candidate\.state\s*===\s*"Assigned"/,
    "A direct Master response must prove the Assigned transition.");
  assert.match(masterCommit, /sameOptionalForwardingTerm[\s\S]*forwardedPayoutDivider/,
    "Master acknowledgement must validate the submitted forwarding terms.");

  const authoritative = sectionBetween(index, "async function authoritativeOrderActionState", "function adoptAuthoritativeOrderActionState");
  assert.match(authoritative, /for\s*\(let attempt\s*=\s*0;\s*attempt\s*<\s*5/,
    "Ambiguous writes must keep checking when an early GET still shows the old order.");
  assert.match(authoritative, /orderForActionId\(remote\.state\.orders,\s*orderId,\s*predicate\)/,
    "Reconciliation must poll for the exact expected attempt, not mere ID presence.");
});

test("Master Forward uses the atomic endpoint and adopts only its authoritative delta", async () => {
  const [index, preview] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
  ]);
  assert.equal(index, preview, "The served web app and preview must stay byte-identical.");

  const queueForward = sectionBetween(index, "function queueRemoteMasterForward", "function clientDeviceId");
  const apiSource = sectionBetween(index, "async function api", "function normalizedUploadMimeType");
  assert.match(queueForward, /api\(\s*"\/api\/app-state\/forward-order"/,
    "Master Forward must call the dedicated server action.");
  assert.match(queueForward, /method:\s*"POST"/);
  assert.match(queueForward, /keepalive:\s*true/,
    "The small forwarding request must be allowed to finish when the Master refreshes immediately after clicking Forward.");
  assert.match(apiSource, /keepalive:\s*options\.keepalive\s*===\s*true/,
    "The API wrapper must pass the forwarding keepalive option to the browser request.");
  assert.match(queueForward, /body:\s*\{\s*\.\.\.payload,\s*expectedRevision:\s*remoteStateRevision\s*\}/,
    "The queued action must use the latest known revision only as a synchronization hint.");
  assert.doesNotMatch(queueForward, /body:\s*\{\s*state\b/,
    "The atomic action must not upload the workspace state.");
  assert.match(queueForward, /remoteSaveChain\.then/,
    "The action must remain ordered behind earlier writes from the same browser.");

  const immediateForward = sectionBetween(index, "async function saveMasterForwardNow", "function orderActionIsOutstanding");
  assert.match(immediateForward, /await\s+queueRemoteMasterForward\(payload\)/);
  assert.match(immediateForward, /for\s*\(let attempt\s*=\s*0;\s*attempt\s*<\s*2/,
    "One ambiguous first response must automatically reuse the exact forwarding attempt.");
  assert.match(immediateForward, /masterForwardErrorIsDefinitive\(error\)\s*\|\|\s*attempt\s*===\s*1/,
    "Definitive rejections must not be retried, and the automatic retry must stay bounded.");
  assert.match(immediateForward, /\[404,\s*405\][\s\S]*typeof fallbackStateSnapshot\s*===\s*"function"[\s\S]*saveStateNow\(fallbackSnapshot,\s*fallbackConflictResolver\)/,
    "Only an unavailable endpoint may use the legacy full-state compatibility path.");

  const masterForward = sectionBetween(index, 'const forwardButton = event.target.closest(".forward-order")', 'const masterReturnButton = event.target.closest(".master-return-order")');
  assert.match(masterForward, /masterForwardErrorIsDefinitive\(error\)[\s\S]*unconfirmedOrderActions\.delete\(actionKey\)[\s\S]*clearRoutingActionOutbox\(routingForwardAttemptId\)/,
    "A definitive atomic rejection must clear its retry lock and durable outbox entry.");
  assert.match(masterForward, /Number\(error\?\.status\)\s*===\s*409[\s\S]*api\("\/api\/app-state"\)[\s\S]*adoptAuthoritativeOrderActionState\(remote\)/,
    "A same-order conflict must load the authoritative winner once before re-enabling actions.");
  assert.match(masterForward, /else if\s*\(saveAttempted\s*&&\s*!actionConfirmed\)[\s\S]*unconfirmedOrderActions\.add\(actionKey\)/,
    "Only an ambiguous network or server failure may remain protected as unconfirmed.");

  const adoption = sectionBetween(index, "function adoptAtomicMasterForwardResult", "function resolveMasterForwardConflict");
  assert.match(adoption, /result\.state\s*&&\s*!mergeSharedState\(result\.state\)/,
    "A stale caller must merge the concurrent server state returned by the atomic action.");
  assert.match(adoption, /state\.orders\[orderIndex\]\s*=\s*structuredClone\(result\.order\)/,
    "The exact server-derived order and payer number must replace the optimistic copy.");
  assert.match(adoption, /remoteStateRevision\s*=\s*String\(result\.revision\)/,
    "The browser may advance its revision only after adopting the authoritative response.");
  assert.match(adoption, /result\.archived\s*===\s*true[\s\S]*state\.orders\s*=\s*state\.orders\.filter[\s\S]*return true/,
    "An idempotent archived acknowledgement must remove its optimistic open copy without recreating a closed order.");
});

test("Master Forward automatically reuses the same attempt after one ambiguous response", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const forwardSaveSource = sectionBetween(index, "async function saveMasterForwardNow", "function orderActionIsOutstanding");
  const buildHarness = new Function(`
    let currentAuth = { workspace: { id: "WS-1" } };
    let remoteStateReady = true;
    let suppressRemoteSave = false;
    let saveTimer = null;
    let orderActionDeferredRemoteSave = false;
    let calls = 0;
    let fallbackCalls = 0;
    const submittedPayloads = [];
    const subscriptionIsReadOnly = () => false;
    const persistOrderActionStateLocally = () => {};
    const queueRemoteMasterForward = async (payload) => {
      calls += 1;
      submittedPayloads.push(structuredClone(payload));
      if (calls === 1) throw new Error("The first response was interrupted.");
      return { ok: true, revision: "revision-2", order: { id: payload.orderId } };
    };
    const saveStateNow = async () => { fallbackCalls += 1; return false; };
    ${forwardSaveSource}
    return {
      run: (payload) => saveMasterForwardNow(payload, () => ({ fallback: true }), () => null),
      result: () => ({ calls, fallbackCalls, submittedPayloads }),
    };
  `);
  const harness = buildHarness();
  const payload = { orderId: "ORD-1", attemptId: "ROUTE-FORWARD-1", targetActorId: "ACT-1" };
  const result = await harness.run(payload);
  assert.equal(result.atomicMasterForward, true);
  assert.equal(result.order.id, "ORD-1");
  assert.equal(harness.result().calls, 2);
  assert.equal(harness.result().fallbackCalls, 0);
  assert.deepEqual(harness.result().submittedPayloads, [payload, payload],
    "The automatic second request must reuse the exact order, target, and idempotency token.");
});

test("Broker Send uses the small atomic endpoint and adopts only its own collision-remapped records", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const queueBroker = sectionBetween(index, "function queueRemoteBrokerSend", "function queueRemoteMasterForward");
  assert.match(queueBroker, /api\(\s*"\/api\/app-state\/submit-order"/);
  assert.match(queueBroker, /method:\s*"POST"/);
  assert.match(queueBroker, /keepalive:\s*true/);
  assert.match(queueBroker, /body:\s*\{\s*\.\.\.payload,\s*expectedRevision:\s*remoteStateRevision\s*\}/);
  assert.doesNotMatch(queueBroker, /body:\s*\{\s*state\b/,
    "Atomic Broker Send must not upload the workspace snapshot.");

  const immediateBroker = sectionBetween(index, "async function saveBrokerSendNow", "async function saveMasterForwardNow");
  assert.match(immediateBroker, /for\s*\(let attempt\s*=\s*0;\s*attempt\s*<\s*2/);
  assert.match(immediateBroker, /\[404,\s*405\][\s\S]*saveStateNow\(fallbackSnapshot\)/,
    "Only an old server without the atomic endpoint may receive the legacy full-state save.");

  const adoptionSource = sectionBetween(index, "function brokerSendCustomerKey", "function adoptAtomicMasterForwardResult");
  const buildHarness = new Function(`
    let persisted = 0;
    let remoteStateRevision = "old";
    let state = {
      orders: [
        { id: "ORD-1", routingSubmissionId: "ROUTE-1", brokerActorId: "ACT-A", broker: "A", sourceCurrency: "USD", sourceAmountMinor: 100, payoutCurrency: "ETB", payoutAmountMinor: 5000, receiverName: "A receiver", accountNumber: "A-1", createdAt: "2026-01-01" },
        { id: "ORD-1", routingSubmissionId: "ROUTE-1", brokerActorId: "ACT-B", broker: "B", sourceCurrency: "USD", sourceAmountMinor: 200, payoutCurrency: "ETB", payoutAmountMinor: 6000, receiverName: "B receiver", accountNumber: "B-1", createdAt: "2026-01-02" }
      ],
      receivables: [
        { id: "REC-1", orderId: "ORD-1", borrowerActorId: "ACT-A", borrower: "A" },
        { id: "REC-1", orderId: "ORD-1", borrowerActorId: "ACT-B", borrower: "B" }
      ],
      savedCustomers: [
        { id: "CUST-1", actorId: "ACT-A", kind: "sender", name: "A sender" },
        { id: "CUST-1", actorId: "ACT-B", kind: "sender", name: "B sender" }
      ],
      orderCounter: 1,
      receivableCounter: 1,
      customerCounter: 1,
      orderState: "Pending Forward"
    };
    const mergeSharedState = () => true;
    const persistOrderActionStateLocally = () => { persisted += 1; };
    const recoveredOrderMatches = (left, right) => left?.brokerActorId === right?.brokerActorId
      && left?.createdAt === right?.createdAt
      && left?.sourceCurrency === right?.sourceCurrency
      && left?.sourceAmountMinor === right?.sourceAmountMinor
      && left?.payoutCurrency === right?.payoutCurrency
      && left?.payoutAmountMinor === right?.payoutAmountMinor
      && left?.receiverName === right?.receiverName
      && left?.accountNumber === right?.accountNumber;
    ${adoptionSource}
    return {
      run: (result, submittedOrder, submittedCustomers) => adoptAtomicBrokerSendResult(result, submittedOrder, "REC-1", submittedCustomers),
      result: () => ({ state, persisted, remoteStateRevision })
    };
  `);
  const harness = buildHarness();
  const submittedOrder = {
    id: "ORD-1", routingSubmissionId: "ROUTE-1", brokerActorId: "ACT-A", broker: "A",
    sourceCurrency: "USD", sourceAmountMinor: 100, payoutCurrency: "ETB", payoutAmountMinor: 5000,
    receiverName: "A receiver", accountNumber: "A-1", createdAt: "2026-01-01"
  };
  const submittedCustomers = [{ id: "CUST-1", actorId: "ACT-A", kind: "sender", name: "A sender" }];
  const committed = harness.run({
    atomicBrokerSend: true,
    revision: "new",
    order: { ...submittedOrder, id: "ORD-2", collisionSourceOrderId: "ORD-1", brokerOrderNumber: "A1", state: "Pending Forward" },
    receivable: { id: "REC-2", orderId: "ORD-2", borrowerActorId: "ACT-A", borrower: "A" },
    customers: [{ id: "CUST-2", actorId: "ACT-A", kind: "sender", name: "A sender" }],
    orderCounter: 2,
    receivableCounter: 2,
    customerCounter: 2,
    orderState: "Pending Forward"
  }, submittedOrder, submittedCustomers);
  assert.equal(committed.id, "ORD-2");
  const adopted = harness.result();
  assert.equal(adopted.state.orders.length, 2);
  assert.ok(adopted.state.orders.some((order) => order.brokerActorId === "ACT-B" && order.id === "ORD-1"));
  assert.ok(adopted.state.orders.some((order) => order.brokerActorId === "ACT-A" && order.id === "ORD-2"));
  assert.equal(adopted.state.receivables.length, 2);
  assert.ok(adopted.state.receivables.some((receivable) => receivable.borrowerActorId === "ACT-B" && receivable.id === "REC-1"));
  assert.ok(adopted.state.receivables.some((receivable) => receivable.borrowerActorId === "ACT-A" && receivable.id === "REC-2"));
  assert.equal(adopted.state.savedCustomers.length, 2);
  assert.ok(adopted.state.savedCustomers.some((customer) => customer.actorId === "ACT-B" && customer.id === "CUST-1"));
  assert.ok(adopted.state.savedCustomers.some((customer) => customer.actorId === "ACT-A" && customer.id === "CUST-2"));
  assert.equal(adopted.remoteStateRevision, "new");
  assert.equal(adopted.persisted, 1);
});

test("a queued generic save cannot absorb a later optimistic forwarding mutation", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const queueSave = sectionBetween(index, "function queueRemoteStateSave", "function queueRemoteMasterForward");
  const buildHarness = new Function(`
    let state = { orders: [{ id: "ORD-FROZEN", state: "Pending Forward" }] };
    let storageKey = "workspace-key";
    let remoteStateRevision = "revision-1";
    let releaseEarlierWrite;
    let remoteSaveChain = new Promise((resolve) => { releaseEarlierWrite = resolve; });
    let remoteSavePending = 0;
    let submittedBody = null;
    const localStorage = { setItem() {} };
    const mergeSharedState = () => true;
    const api = async (_path, options) => {
      submittedBody = structuredClone(options.body);
      return { revision: "revision-2" };
    };
    ${queueSave}
    return {
      queue: () => queueRemoteStateSave(),
      mutateLiveState: () => { state.orders[0].state = "Assigned"; },
      release: () => releaseEarlierWrite(),
      submitted: () => submittedBody,
    };
  `);
  const harness = buildHarness();
  const pending = harness.queue();
  harness.mutateLiveState();
  harness.release();
  await pending;
  assert.equal(harness.submitted().state.orders[0].state, "Pending Forward",
    "An older queued PUT must not serialize the forwarding change made after it was queued.");
});

test("atomic forwarding adoption preserves concurrent work and removes only its empty optimistic chat", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const adoptionSource = sectionBetween(index, "function removeEmptyOptimisticForwardChat", "function resolveMasterForwardConflict");
  const buildHarness = new Function(`
    const state = {
      orders: [
        { id: "ORD-DECOY", collisionSourceOrderId: "ORD-1", state: "Pending Forward", sourceAmountMinor: 999 },
        { id: "ORD-1", state: "Assigned", routingForwardAttemptId: "ATTEMPT", agentOrderNumber: "LOCAL-TEMP" }
      ],
      receivables: [{ id: "REC-1", orderId: "ORD-1", creditReminder: "local" }],
      chatConversations: [
        {
          id: "CHAT-OPTIMISTIC",
          type: "direct",
          members: ["Master", "Payer"],
          messages: [{ id: "MSG-ATTEMPT", orderId: "ORD-1" }]
        },
        {
          id: "CHAT-UNSAVED",
          type: "direct",
          members: ["Master", "Broker"],
          messages: [{ id: "MSG-UNSAVED", text: "keep me" }]
        }
      ],
      chatCounter: 2,
      orderState: "Assigned"
    };
    let remoteStateRevision = "revision-1";
    let persisted = 0;
    const persistOrderActionStateLocally = () => { persisted += 1; };
    const removeOrderActionChatMessage = (reference) => {
      const chat = state.chatConversations.find((candidate) => candidate.id === reference?.chatId);
      if (chat) chat.messages = (chat.messages || []).filter((message) => message.id !== reference?.messageId);
    };
    const recoveredOrderMatches = (left, right) => left?.id === right?.id;
    const mergeById = (left = [], right = []) => {
      const values = new Map();
      [...left, ...right].forEach((item) => values.set(item.id, { ...(values.get(item.id) || {}), ...structuredClone(item) }));
      return Array.from(values.values());
    };
    const mergeSharedState = (remote) => {
      state.orders = mergeById(state.orders, remote.orders || []);
      state.receivables = mergeById(state.receivables, remote.receivables || []);
      state.chatConversations = mergeById(state.chatConversations, remote.chatConversations || []).map((chat) => {
        const local = state.chatConversations.find((candidate) => candidate.id === chat.id);
        const incoming = (remote.chatConversations || []).find((candidate) => candidate.id === chat.id);
        return { ...chat, messages: mergeById(local?.messages || [], incoming?.messages || []) };
      });
      return true;
    };
    ${adoptionSource}
    return {
      adopt: adoptAtomicMasterForwardResult,
      result: () => ({ state: structuredClone(state), remoteStateRevision, persisted }),
    };
  `);
  const harness = buildHarness();
  const canonicalOrder = {
    id: "ORD-1",
    state: "Assigned",
    routingForwardAttemptId: "ATTEMPT",
    agentActorId: "ACT-PAYER",
    agentOrderNumber: "0007_BRK1"
  };
  const adopted = harness.adopt({
    atomicMasterForward: true,
    revision: "revision-3",
    state: {
      orders: [{ id: "ORD-2", state: "Pending Forward" }],
      receivables: [{ id: "REC-1", orderId: "ORD-1", creditReminder: "concurrent Broker reminder" }],
      chatConversations: [{
        id: "CHAT-SERVER",
        type: "direct",
        members: ["Master", "Payer"],
        messages: [{ id: "MSG-OTHER", text: "server message" }]
      }]
    },
    order: canonicalOrder,
    receivable: { id: "REC-1", orderId: "ORD-1", creditReminder: "concurrent Broker reminder", agentOrderNumber: "0007_BRK1" },
    chat: { id: "CHAT-SERVER", type: "direct", members: ["Master", "Payer"] },
    message: { id: "MSG-ATTEMPT", orderId: "ORD-1", orderNumber: "0007_BRK1" },
    chatCounter: 3,
    orderState: "Assigned"
  }, { chatId: "CHAT-OPTIMISTIC", messageId: "MSG-ATTEMPT" }, "REC-1");
  assert.equal(adopted, true);
  const result = harness.result();
  assert.equal(result.remoteStateRevision, "revision-3");
  assert.equal(result.state.orders.find((order) => order.id === "ORD-1").agentOrderNumber, "0007_BRK1");
  assert.equal(result.state.orders.find((order) => order.id === "ORD-DECOY").sourceAmountMinor, 999,
    "An alias collision must not cause the authoritative delta to replace another order.");
  assert.ok(result.state.orders.some((order) => order.id === "ORD-2"));
  assert.equal(result.state.receivables.find((item) => item.id === "REC-1").creditReminder, "concurrent Broker reminder");
  assert.ok(result.state.chatConversations.some((chat) => (chat.messages || []).some((message) => message.id === "MSG-UNSAVED")));
  assert.equal(result.state.chatConversations.some((chat) => chat.id === "CHAT-OPTIMISTIC"), false);
  assert.deepEqual(
    result.state.chatConversations.find((chat) => chat.id === "CHAT-SERVER").messages.map((message) => message.id).sort(),
    ["MSG-ATTEMPT", "MSG-OTHER"]
  );
  assert.equal(result.persisted, 1);

  const archivedHarness = buildHarness();
  assert.equal(archivedHarness.adopt({
    atomicMasterForward: true,
    archived: true,
    revision: "revision-4",
    state: { orders: [], receivables: [], chatConversations: [] },
    order: { ...canonicalOrder, state: "Paid", journal: "JRN-9" },
    receivable: { id: "REC-CLOSED", orderId: "ORD-1" },
    chat: { id: "CHAT-SERVER", type: "direct", members: ["Master", "Payer"] },
    message: { id: "MSG-ATTEMPT", orderId: "ORD-1" }
  }, { chatId: "CHAT-OPTIMISTIC", messageId: "MSG-ATTEMPT" }, "REC-1"), true);
  const archivedResult = archivedHarness.result();
  assert.equal(archivedResult.state.orders.some((order) => order.id === "ORD-1"), false,
    "An acknowledged closed order must not be resurrected in the open order book.");
  assert.equal(archivedResult.state.receivables.some((item) => item.id === "REC-CLOSED"), false,
    "Archived replay adoption must not upsert a response delta into closed financial state.");
  assert.equal(archivedResult.state.receivables.some((item) => item.id === "REC-1"), false,
    "A stale optimistic receivable must be removed when the server reports that its order is already closed.");

  const liveWithoutReceivableHarness = buildHarness();
  assert.equal(liveWithoutReceivableHarness.adopt({
    atomicMasterForward: true,
    archived: false,
    revision: "revision-5",
    state: { orders: [canonicalOrder], receivables: [], chatConversations: [] },
    order: canonicalOrder,
    receivable: null,
    chat: null,
    message: null,
    orderState: "Assigned"
  }, { chatId: "CHAT-OPTIMISTIC", messageId: "MSG-ATTEMPT" }, "REC-1"), true);
  assert.equal(liveWithoutReceivableHarness.result().state.receivables.some((item) => item.id === "REC-1"), false,
    "A current-order replay must not retain a local receivable that exists only in a closed report.");
});

test("the legacy full-save fallback still rebases only its routing delta", async () => {
  const [index, preview] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
  ]);
  assert.equal(index, preview, "The served web app and preview must stay byte-identical.");

  const retrySave = sectionBetween(index, "async function retryStateSnapshotAfterConflict", "function orderActionIsOutstanding");
  assert.match(retrySave, /for\s*\(let attempt\s*=\s*0;\s*attempt\s*<\s*3/,
    "A bounded retry should tolerate another revision arriving during the first rebase.");
  assert.match(retrySave, /const remote\s*=\s*await api\("\/api\/app-state"\)/,
    "A stale Master snapshot must first load the latest Broker changes.");
  assert.match(retrySave, /conflictResolver\(remote,\s*attempt\)/,
    "The latest state must be rebuilt by the action-specific resolver.");
  assert.match(retrySave, /queueRemoteStateSave\(resolution\.state\)/,
    "Only the newly rebased snapshot may be submitted after a conflict.");

  const helperSource = sectionBetween(index, "const masterForwardConflictOrderFields", "function rollbackCachedRoutingAction");
  const resolveMasterForwardConflict = new Function(`
    const orderForActionId = (orders, id, predicate = () => true) =>
      (orders || []).find((order) => order?.id === id && predicate(order)) || null;
    const recoveredOrderMatches = (left, right) => left?.id === right?.id
      && left?.brokerActorId === right?.brokerActorId
      && left?.sourceAmountMinor === right?.sourceAmountMinor
      && left?.payoutAmountMinor === right?.payoutAmountMinor;
    const masterRoutingCommitted = (candidate, submitted, target) => candidate?.routingForwardAttemptId === submitted?.routingForwardAttemptId
      && candidate?.agentActorId === target?.id
      && ["Assigned", "Returned", "Paid", "Void Requested", "Voided"].includes(candidate?.state);
    ${helperSource}
    return resolveMasterForwardConflict;
  `)();

  const previousOrder = {
    id: "ORD-1",
    state: "Pending Forward",
    brokerActorId: "ACT-BROKER",
    broker: "Broker One",
    routingSubmissionId: "ROUTE-SEND-1",
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 550_000,
    receiverName: "Receiver"
  };
  const submittedOrder = {
    ...previousOrder,
    state: "Assigned",
    routingForwardAttemptId: "ROUTE-FORWARD-1",
    agent: "Payer One",
    agentActorId: "ACT-PAYER",
    agentOrderNumber: "001_BRK001",
    agentOrderActor: "Payer One",
    agentOrderNumbers: { "Payer One": "001_BRK001" },
    agentOrderNumberCycles: { "Payer One": 0 },
    forwardedPayoutDivider: 2,
    assignedAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z"
  };
  const concurrentBrokerOrder = {
    id: "ORD-2",
    state: "Pending Forward",
    brokerActorId: "ACT-OTHER-BROKER",
    routingSubmissionId: "ROUTE-SEND-2",
    sourceAmountMinor: 20_000,
    payoutAmountMinor: 1_100_000
  };
  const remoteState = {
    orders: [structuredClone(previousOrder), structuredClone(concurrentBrokerOrder)],
    archives: [],
    receivables: [
      { id: "REC-1", orderId: "ORD-1", creditReminder: "new server reminder", agentOrderNumber: "" },
      { id: "REC-2", orderId: "ORD-2", creditReminder: "concurrent Broker credit" }
    ],
    chatConversations: [{
      id: "CHAT-PAYER",
      messages: [{ id: "MSG-BROKER", text: "Concurrent Broker message" }]
    }],
    orderCounter: 47,
    messageCounter: 88
  };
  const context = {
    previousOrder,
    submittedOrder,
    submittedReceivable: {
      id: "REC-1",
      orderId: "ORD-1",
      creditReminder: "old local reminder",
      brokerOrderNumber: "BRK001",
      agentOrderNumber: "001_BRK001",
      updatedAt: "2026-08-24T10:00:00.000Z"
    },
    submittedMessage: {
      id: "MSG-ROUTE-FORWARD-1",
      orderId: "ORD-1",
      text: "Order 001_BRK001 assigned to you."
    },
    submittedChat: {
      id: "CHAT-PAYER",
      type: "direct",
      members: ["Master", "Payer One"],
      messages: []
    },
    messageReference: { chatId: "CHAT-PAYER", messageId: "MSG-ROUTE-FORWARD-1" },
    targetActor: { id: "ACT-PAYER", name: "Payer One" }
  };
  const beforeRemote = structuredClone(remoteState);
  const resolution = resolveMasterForwardConflict({ state: remoteState, revision: "r2" }, context);
  assert.ok(resolution?.state, "An unchanged pending order should be safely rebased after a Broker save.");
  assert.deepEqual(remoteState, beforeRemote, "Building the retry must not mutate the authoritative GET response.");
  assert.deepEqual(resolution.state.orders.find((order) => order.id === "ORD-2"), concurrentBrokerOrder,
    "The simultaneous Broker order must be preserved byte-for-byte.");
  assert.equal(resolution.state.orders.find((order) => order.id === "ORD-1").state, "Assigned");
  assert.equal(resolution.state.orders.find((order) => order.id === "ORD-1").routingForwardAttemptId, "ROUTE-FORWARD-1");
  assert.equal(resolution.state.orderState, "Assigned");
  assert.equal(resolution.state.receivables.find((item) => item.id === "REC-1").creditReminder, "new server reminder",
    "Forwarding must not overwrite a Broker's concurrent credit reminder.");
  assert.deepEqual(resolution.state.receivables.find((item) => item.id === "REC-2"), remoteState.receivables[1]);
  assert.deepEqual(resolution.state.chatConversations[0].messages.map((message) => message.id),
    ["MSG-BROKER", "MSG-ROUTE-FORWARD-1"],
    "The assignment message must be appended without losing the concurrent Broker message.");
  assert.equal(resolution.state.orderCounter, 47);
  assert.equal(resolution.state.messageCounter, 88);

  const withoutExistingChat = resolveMasterForwardConflict({
    state: { ...structuredClone(remoteState), chatConversations: [] }
  }, context);
  assert.deepEqual(withoutExistingChat?.state?.chatConversations?.[0]?.messages?.map((message) => message.id),
    ["MSG-ROUTE-FORWARD-1"],
    "A newly created payer chat must carry only the deterministic assignment message into the rebase.");

  const committed = resolveMasterForwardConflict({
    state: { ...structuredClone(remoteState), orders: [structuredClone(submittedOrder), structuredClone(concurrentBrokerOrder)] }
  }, context);
  assert.equal(committed?.acknowledged, true, "The exact already-committed attempt must not be sent twice.");

  const otherMasterWon = resolveMasterForwardConflict({
    state: {
      ...structuredClone(remoteState),
      orders: [{ ...previousOrder, state: "Assigned", routingForwardAttemptId: "OTHER", agentActorId: "ACT-OTHER" }, concurrentBrokerOrder]
    }
  }, context);
  assert.equal(otherMasterWon, null, "A concurrent change to the same order must never be overwritten.");

  const numberCollision = resolveMasterForwardConflict({
    state: {
      ...structuredClone(remoteState),
      orders: [previousOrder, {
        ...concurrentBrokerOrder,
        state: "Assigned",
        agent: "Payer One",
        agentActorId: "ACT-PAYER",
        agentOrderNumber: "001_BRK001",
        agentOrderNumbers: { "Payer One": "001_BRK001" }
      }]
    }
  }, context);
  assert.equal(numberCollision, null, "A payer-number collision must stay blocked for review.");
});

test("ordinary saves are deferred while a routing result is pending or unconfirmed", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const saveState = sectionBetween(index, "function saveState()", "function handleRemoteSaveError");
  assert.match(saveState, /pendingOrderActionSaves\.size\s*>\s*0\s*\|\|\s*unconfirmedOrderActions\.size\s*>\s*0/,
    "Generic saves must not independently commit an optimistic routing mutation.");
  assert.match(saveState, /orderActionDeferredRemoteSave\s*=\s*true/,
    "Unrelated local work must be remembered for a later safe save.");

  const flush = sectionBetween(index, "function flushDeferredOrderActionSave", "function beginOrderActionUi");
  assert.match(flush, /pendingOrderActionSaves\.size\s*>\s*0\s*\|\|\s*unconfirmedOrderActions\.size\s*>\s*0/,
    "Deferred work must stay local until routing is confirmed or explicitly retried.");
  assert.match(index, /beforeunload[\s\S]*unconfirmedOrderActions\.size\s*===\s*0/,
    "An unresolved routing attempt must retain refresh protection.");

  const immediateSave = sectionBetween(index, "async function saveStateNow", "function captureOrderActionRecord");
  const barrierIndex = matchIndex(immediateSave, /!stateSnapshot\s*&&\s*orderActionIsOutstanding\(\)/,
    "Immediate non-routing saves must respect the same routing barrier.");
  const queuedSaveIndex = matchIndex(immediateSave, /queueRemoteStateSave\(stateSnapshot\)/,
    "The immediate remote-save call was not found.");
  assert.ok(barrierIndex < queuedSaveIndex,
    "An unrelated saveStateNow() call must be deferred before it can serialize optimistic routing state.");
});

test("unfinished routing survives reload and stays isolated to its workspace session", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const outboxHelpers = sectionBetween(index, "function routingActionOutboxKey", "function captureOrderActionRecord");
  assert.match(outboxHelpers, /workspaceId[\s\S]*userId[\s\S]*haderapay\.routing-action/,
    "The recovery marker must be namespaced by workspace and signed-in user.");
  assert.match(outboxHelpers, /localStorage\.setItem\(key,\s*JSON\.stringify/,
    "The exact unfinished attempt must be persisted before a refresh can interrupt it.");

  const recovery = sectionBetween(index, "function rollbackCachedRoutingAction", "async function authoritativeOrderActionState");
  assert.match(recovery, /restoreRoutingActionOutbox\(remoteWasLoaded\)/);
  assert.match(recovery, /brokerRoutingCommitted\(currentOrder,\s*submittedOrder,\s*true\)/,
    "Reload recovery must first recognize a Broker action that already reached the server.");
  assert.match(recovery, /masterRoutingCommitted\(currentOrder,\s*submittedOrder,\s*targetActor,\s*true\)/,
    "Reload recovery must first recognize a Master action that already reached the server.");
  assert.match(recovery, /unconfirmedOrderActions\.add\(\s*"broker-send"\s*\)/);
  assert.match(recovery, /unconfirmedOrderActions\.add\(actionKey\)/);

  const applySession = sectionBetween(index, "async function applyAuthSession", "function showAuthError");
  assert.match(applySession, /restoreRoutingActionOutbox\(Boolean\(remote\.state\)\)/,
    "Login/reload must reconcile the durable routing marker with authoritative state.");
  assert.match(applySession, /showBrokerRoutingRetryControls\(brokerRoutingRetryAttempts\.get\(routingRecovery\.order\.id\)\)/,
    "An interrupted Broker form must be restored for an exact retry.");

  const resetSession = sectionBetween(index, "function resetOrderActionSession", "function routingActionIsBlocked");
  assert.match(resetSession, /orderActionSessionGeneration\s*\+=\s*1/);
  assert.match(resetSession, /pendingOrderActionSaves\.clear\(\)/);
  assert.match(resetSession, /unconfirmedOrderActions\.clear\(\)/);
  const endSession = sectionBetween(index, "async function endAuthSession", "function signedInRole");
  assert.match(endSession, /resetOrderActionSession\(\)/,
    "Logout must invalidate old routing callbacks without deleting the durable recovery marker.");
});

test("an ambiguous retry reuses the complete original routing attempt", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const brokerSend = sectionBetween(index, 'confirmAction("Send this order to Master for routing?"', "els.cancelTransferEditButton.addEventListener");
  assert.match(brokerSend, /order\s*=\s*retryAttempt\?\.order\s*\?\s*structuredClone\(retryAttempt\.order\)/,
    "Broker retry must use the original complete order, not edited form values.");
  assert.match(brokerSend, /persistRoutingActionOutbox\([\s\S]*?await\s+saveBrokerSendNow/,
    "Broker refresh recovery must be durable before the network save begins.");
  assert.match(brokerSend, /actingActorId:\s*actor\.id/,
    "Master-managed Broker sends must identify the selected controlled profile.");
  assert.match(brokerSend, /clearRoutingActionOutbox\(order\.routingSubmissionId\)/,
    "Broker recovery data must be removed only after acknowledgement or an authoritative winner.");
  assert.match(index, /brokerInputMatchesRoutingRetry\(input,\s*retryAttempt\)/,
    "Broker must visibly restore an exact attempt instead of silently ignoring edited retry fields.");

  const masterForward = sectionBetween(index, 'const forwardButton = event.target.closest(".forward-order")', 'const masterReturnButton = event.target.closest(".master-return-order")');
  assert.match(masterForward, /masterRoutingRetryAttempts\.get\(order\.id\)/,
    "Master retry must be found by the unresolved order, even if visible routing fields changed.");
  assert.match(masterForward, /Object\.assign\(order,\s*structuredClone\(retryAttempt\.order\)\)/,
    "Master retry must restore the complete original forwarding attempt.");
  assert.match(masterForward, /persistRoutingActionOutbox\([\s\S]*?await\s+saveMasterForwardNow/,
    "Master refresh recovery must be durable before the network save begins.");
  assert.match(masterForward, /clearRoutingActionOutbox\(routingForwardAttemptId\)/,
    "Master recovery data must be removed only after acknowledgement or an authoritative winner.");
  assert.match(masterForward, /masterRoutingControlsMatchRetry\(requestedTargetAgent,\s*requestedDividerText,\s*requestedPercentText,\s*retryAttempt\)/,
    "Master must refuse a retry when the visible payout actor or terms differ from the stored attempt.");

  const retryControls = sectionBetween(index, "function setRoutingActionButtonLabel", 'window.addEventListener("beforeunload"');
  assert.match(retryControls, /showBrokerRoutingRetryControls[\s\S]*fillOrderForm\(order\)/,
    "Broker recovery must visibly restore the exact submitted details.");
  assert.match(retryControls, /showMasterRoutingRetryControls[\s\S]*targetInput\.value\s*=\s*retryAttempt\.targetAgent/,
    "Master recovery must display the exact payout actor.");
  assert.match(retryControls, /showMasterRoutingRetryControls[\s\S]*\.filter\([\s\S]*buttons\.forEach/,
    "Master recovery must update every rendered copy of the routing row, including the visible responsive row.");
  assert.match(retryControls, /dividerInput\.value\s*=\s*retryAttempt\.dividerText/,
    "Master recovery must display the exact divider.");
  assert.match(retryControls, /percentInput\.value\s*=\s*retryAttempt\.percentText/,
    "Master recovery must display the exact percentage.");
  assert.match(retryControls, /querySelectorAll\("\.master-return-order, \.cancel-order"\)[\s\S]*conflictingButton\.disabled\s*=\s*true/,
    "An unresolved Master forwarding must disable Return and Cancel in every rendered routing row.");

  const renderedOrderActions = sectionBetween(index, "function orderActionsHtml", "function lineBelongsToActor");
  assert.match(renderedOrderActions, /routingUnconfirmed[\s\S]*conflictingActionState[\s\S]*disabled/,
    "A later render must preserve the unresolved-forwarding lock instead of exposing conflicting actions again.");
  assert.match(index, /masterReturnButton[\s\S]*masterRoutingActionBlocksOtherActions\(order\.id\)[\s\S]*cancelButton[\s\S]*masterRoutingActionBlocksOtherActions\(order\.id\)/,
    "Master Return and Cancel handlers must reject unresolved forwarding even if invoked outside the visible controls.");
});

test("an old workspace response is rejected before it can merge into a new login", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const queueSave = sectionBetween(index, "function queueRemoteStateSave", "function clientDeviceId");
  assert.match(queueSave, /const submittedStorageKey\s*=\s*storageKey/,
    "Queued saves must retain the cache key belonging to their original workspace.");
  const putIndex = matchIndex(queueSave, /const result\s*=\s*await\s+api\(\s*"\/api\/app-state"/,
    "The queued PUT was not found.");
  const postPutCheck = queueSave.indexOf("assertSubmittedSession();", putIndex);
  const mergeIndex = matchIndex(queueSave, /mergeSharedState\(result\.state\)/,
    "The authoritative merge was not found.");
  assert.ok(postPutCheck > putIndex && postPutCheck < mergeIndex,
    "The session must be rechecked after the PUT and before any global merge.");
  const versionIndex = matchIndex(queueSave, /const version\s*=\s*await\s+api\(\s*"\/api\/app-state\/version"/,
    "The conflict version fetch was not found.");
  const postVersionCheck = queueSave.indexOf("assertSubmittedSession();", versionIndex);
  const revisionIndex = queueSave.indexOf("remoteStateRevision =", versionIndex);
  assert.ok(postVersionCheck > versionIndex && postVersionCheck < revisionIndex,
    "The session must be rechecked after a conflict fetch and before changing the revision.");
  assert.match(queueSave, /localStorage\.setItem\(submittedStorageKey/,
    "A late response must never write through a newly selected workspace's cache key.");

  const buildHarness = new Function(`
    let state = { marker: "workspace-a" };
    let storageKey = "workspace-a-key";
    let remoteStateRevision = "revision-a";
    let remoteSaveChain = Promise.resolve();
    let remoteSavePending = 0;
    let generation = 1;
    let workspaceId = "workspace-a";
    let userId = "user-a";
    let releasePut;
    let markPutStarted;
    const putStarted = new Promise((resolve) => { markPutStarted = resolve; });
    const writes = [];
    let merged = null;
    const localStorage = { setItem(key, value) { writes.push({ key, value }); } };
    const mergeSharedState = (value) => { merged = value; return true; };
    const currentOrderActionSession = () => ({ generation, workspaceId, userId });
    const orderActionSessionIsCurrent = (session) => session.generation === generation
      && session.workspaceId === workspaceId
      && session.userId === userId;
    const api = async () => {
      markPutStarted();
      return new Promise((resolve) => { releasePut = resolve; });
    };
    ${queueSave}
    return {
      run: () => queueRemoteStateSave({ marker: "submitted-a" }),
      waitUntilStarted: () => putStarted,
      switchWorkspace() {
        generation = 2;
        workspaceId = "workspace-b";
        userId = "user-b";
        storageKey = "workspace-b-key";
        state = { marker: "workspace-b" };
      },
      release: () => releasePut({ revision: "revision-from-a", state: { marker: "server-a" } }),
      result: () => ({ remoteStateRevision, remoteSavePending, writes, merged }),
    };
  `);
  const harness = buildHarness();
  const pending = harness.run();
  await harness.waitUntilStarted();
  harness.switchWorkspace();
  harness.release();
  await assert.rejects(pending, (error) => error?.code === "ORDER_ACTION_SESSION_CHANGED");
  assert.deepEqual(harness.result(), {
    remoteStateRevision: "revision-a",
    remoteSavePending: 0,
    writes: [],
    merged: null,
  });
});

test("routing rollback restores only touched records and never rewinds workspace counters", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  assert.doesNotMatch(index, /function\s+(?:snapshotOrderActionState|restoreOrderActionState)\b/,
    "Routing failure must not restore a whole workspace snapshot.");

  const rollbackHelpers = sectionBetween(
    index,
    "function captureOrderActionRecord",
    "function brokerSendCustomerKey"
  );
  assert.match(rollbackHelpers, /record:\s*index\s*>=\s*0\s*\?\s*structuredClone\(collection\[index\]\)\s*:\s*null/,
    "Rollback snapshots must clone an individual matching record.");
  assert.match(rollbackHelpers, /const touchedIds\s*=\s*Array\.from\(new Set\(/,
    "Customer rollback must be limited to records touched by this send.");
  assert.doesNotMatch(rollbackHelpers, /state\.(?:orders|receivables|savedCustomers|chatConversations)\s*=\s*snapshot\./,
    "Rollback helpers must not replace whole financial collections from an old snapshot.");
  assert.doesNotMatch(rollbackHelpers, /state\.(?:orderCounter|receivableCounter|customerCounter|messageCounter)\s*=/,
    "Rollback helpers must never rewind shared ID counters.");

  const brokerSend = sectionBetween(
    index,
    'confirmAction("Send this order to Master for routing?"',
    "els.cancelTransferEditButton.addEventListener"
  );
  const masterForward = sectionBetween(
    index,
    'const forwardButton = event.target.closest(".forward-order")',
    'const masterReturnButton = event.target.closest(".master-return-order")'
  );
  assert.match(brokerSend, /restoreOrderActionRecord\(orderSnapshot/);
  assert.match(brokerSend, /restoreOrderActionRecord\(receivableSnapshot/);
  assert.match(brokerSend, /restoreTouchedSavedCustomers\(customersBefore,\s*touchedCustomers\)/);
  assert.match(masterForward, /restoreOrderActionRecord\(orderSnapshot/);
  assert.match(masterForward, /restoreOrderActionRecord\(receivableSnapshot/);
  assert.match(masterForward, /removeOrderActionChatMessage\(messageReference\)/,
    "A failed forward must remove only the assignment message created by that action.");
  for (const [label, section] of [["Broker Send", brokerSend], ["Master Forward", masterForward]]) {
    assert.doesNotMatch(section, /state\.(?:orderCounter|receivableCounter|customerCounter|messageCounter)\s*=/,
      `${label} rollback must not rewind a shared counter.`);
    assert.doesNotMatch(section, /replaceState\s*\(/,
      `${label} rollback must preserve unrelated concurrent workspace changes.`);
  }
});

test("routing completion renders under remote-save suppression", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const suppressedRender = sectionBetween(
    index,
    "function renderOrderActionStateWithoutRemoteSave",
    "function beginOrderActionUi"
  );
  const suppressIndex = matchIndex(suppressedRender, /suppressRemoteSave\s*=\s*true/,
    "The order render must enable save suppression.");
  const renderIndex = matchIndex(suppressedRender, /renderAll\(\)/,
    "The order render helper must refresh the UI.");
  const releaseIndex = matchIndex(suppressedRender, /finally\s*\{[\s\S]*?suppressRemoteSave\s*=\s*false/,
    "The order render helper must always release save suppression.");
  assert.ok(suppressIndex < renderIndex && renderIndex < releaseIndex,
    "The complete render must remain inside the suppression window.");

  const adoptAuthoritative = sectionBetween(
    index,
    "function adoptAuthoritativeOrderActionState",
    "function persistOrderActionStateLocally"
  );
  assert.match(adoptAuthoritative, /renderOrderActionStateWithoutRemoteSave\(\)/,
    "Adopting the server winner must not schedule another PUT.");

  for (const [label, section] of [
    ["Broker Send", sectionBetween(index, 'confirmAction("Send this order to Master for routing?"', "els.cancelTransferEditButton.addEventListener")],
    ["Master Forward", sectionBetween(index, 'const forwardButton = event.target.closest(".forward-order")', 'const masterReturnButton = event.target.closest(".master-return-order")')],
  ]) {
    assert.match(section, /renderOrderActionStateWithoutRemoteSave\(\)/,
      `${label} must render its acknowledged result without queuing a duplicate save.`);
    assert.doesNotMatch(section, /\brenderAll\(\)/,
      `${label} must not call the auto-saving renderer directly.`);
  }
});
