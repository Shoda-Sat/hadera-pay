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

function acknowledgedSave(section, actionLabel) {
  const resultMatch = section.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+saveStateNow\([^\n;]*\)\s*;/);
  assert.ok(resultMatch, `${actionLabel} must await saveStateNow() and retain its acknowledgement result.`);
  const resultName = resultMatch[1];
  const failureGuard = new RegExp(
    `if\\s*\\(\\s*(?:!\\s*${resultName}|${resultName}\\s*!==?\\s*true|${resultName}\\s*===?\\s*false)\\s*\\)`
  );
  return {
    saveIndex: resultMatch.index,
    failureIndex: matchIndex(section, failureGuard, `${actionLabel} must stop its success path when saving is not acknowledged.`),
  };
}

function assertScopedPendingSave(section, actionLabel, { orderScoped }) {
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
    /await\s+saveStateNow\([^\n;]*\)/,
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
    'confirmAction("Send this order to Master for routing?"',
    "els.cancelTransferEditButton.addEventListener"
  );
  assert.match(brokerSend, /async\s*\(\s*\)\s*=>\s*\{/,
    "The confirmed Broker Send callback must be asynchronous.");
  assertScopedPendingSave(brokerSend, "Broker Send", { orderScoped: false });

  const { saveIndex, failureIndex } = acknowledgedSave(brokerSend, "Broker Send");
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

test("web Master Forward checks the save result before reporting success", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const masterForward = sectionBetween(
    index,
    'const forwardButton = event.target.closest(".forward-order")',
    'const masterReturnButton = event.target.closest(".master-return-order")'
  );
  assertScopedPendingSave(masterForward, "Master Forward", { orderScoped: true });

  const { saveIndex, failureIndex } = acknowledgedSave(masterForward, "Master Forward");
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

test("routing saves submit immutable snapshots and reconcile ambiguous results with authoritative state", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const queueSave = sectionBetween(index, "function queueRemoteStateSave", "function clientDeviceId");
  const immediateSave = sectionBetween(index, "async function saveStateNow", "function captureOrderActionRecord");
  assert.match(queueSave, /function queueRemoteStateSave\(stateSnapshot\s*=\s*null\)/);
  assert.match(queueSave, /const submittedState\s*=\s*stateSnapshot\s*\|\|\s*state\s*;/,
    "The queued request must close over the submitted snapshot, not read live state later.");
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

  const actionSections = [
    ["Broker Send", sectionBetween(index, 'confirmAction("Send this order to Master for routing?"', "els.cancelTransferEditButton.addEventListener")],
    ["Master Forward", sectionBetween(index, 'const forwardButton = event.target.closest(".forward-order")', 'const masterReturnButton = event.target.closest(".master-return-order")')],
  ];
  for (const [label, section] of actionSections) {
    assert.match(section, /await\s+saveStateNow\(\s*structuredClone\(state\)\s*\)/,
      `${label} must submit an immutable point-in-time workspace snapshot.`);
    const saveIndex = matchIndex(section, /await\s+saveStateNow\(/, `${label} save was not found.`);
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
  assert.match(brokerSend, /persistRoutingActionOutbox\([\s\S]*?await\s+saveStateNow/,
    "Broker refresh recovery must be durable before the network save begins.");
  assert.match(brokerSend, /clearRoutingActionOutbox\(order\.routingSubmissionId\)/,
    "Broker recovery data must be removed only after acknowledgement or an authoritative winner.");
  assert.match(index, /brokerInputMatchesRoutingRetry\(input,\s*retryAttempt\)/,
    "Broker must visibly restore an exact attempt instead of silently ignoring edited retry fields.");

  const masterForward = sectionBetween(index, 'const forwardButton = event.target.closest(".forward-order")', 'const masterReturnButton = event.target.closest(".master-return-order")');
  assert.match(masterForward, /masterRoutingRetryAttempts\.get\(order\.id\)/,
    "Master retry must be found by the unresolved order, even if visible routing fields changed.");
  assert.match(masterForward, /Object\.assign\(order,\s*structuredClone\(retryAttempt\.order\)\)/,
    "Master retry must restore the complete original forwarding attempt.");
  assert.match(masterForward, /persistRoutingActionOutbox\([\s\S]*?await\s+saveStateNow/,
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
    "async function authoritativeOrderActionState"
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
