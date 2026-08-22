import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function paidOrder() {
  return {
    id: "ORD-PPP341",
    internalOrderId: "ORD-PPP341",
    brokerActorId: "ACT-PPP",
    agentActorId: "ACT-DEKEMHARE",
    broker: "PPP",
    agent: "Dekemhare",
    state: "Paid",
    journal: "JRN-1768",
    createdAt: "2026-08-13T09:58:39.000Z",
  };
}

test("web keeps a shared order after the first close and removes it after the second", async () => {
  const [index, preview] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
  ]);
  assert.equal(index, preview);
  const source = sourceBetween(index, "function participantOrderIdentityMatches", "function normalizeSavedCustomers");
  const removeOrdersAlreadyArchived = new Function(
    "normalizeArchiveSnapshots",
    `${source}\nreturn removeOrdersAlreadyArchived;`,
  )((archives) => (archives || []).map((archive) => ({ ...archive, orders: archive.orders || [] })));

  const order = paidOrder();
  const actors = [
    { id: "ACT-PPP", name: "PPP", role: "Broker" },
    { id: "ACT-DEKEMHARE", name: "Dekemhare", role: "Agent" },
  ];
  const brokerArchive = { id: "ARC-PPP", actor: "PPP", actorId: "ACT-PPP", closedAt: "2026-08-13T10:00:00.000Z", orders: [order] };
  const agentArchive = { id: "ARC-DEKEMHARE", actor: "Dekemhare", actorId: "ACT-DEKEMHARE", closedAt: "2026-08-13T11:00:00.000Z", orders: [order] };
  const ledger = [
    { source: "ORDER_PAYMENT", journal: "JRN-1768", orderId: order.id, account: "PPP ACTOR_CLEARING", archived: true },
    { source: "ORDER_PAYMENT", journal: "JRN-1768", orderId: order.id, account: "Dekemhare ACTOR_CLEARING" },
  ];

  assert.deepEqual(removeOrdersAlreadyArchived([order], [brokerArchive], [], ledger, actors), [order]);
  ledger[1].archived = true;
  assert.deepEqual(removeOrdersAlreadyArchived([order], [brokerArchive, agentArchive], [], ledger, actors), []);

  const collidingSnapshot = {
    ...order,
    id: "ORD-OTHER",
    internalOrderId: "ORD-OTHER",
  };
  const collisionArchives = [
    { ...brokerArchive, orders: [collidingSnapshot] },
    { ...agentArchive, orders: [collidingSnapshot] },
  ];
  assert.deepEqual(
    removeOrdersAlreadyArchived([order], collisionArchives, [], [], actors),
    [order],
    "A different stable order ID must stay live even when its journal collides with an archive",
  );

  const renamedSnapshot = { ...order, journal: "JRN-1768 (1)" };
  const renamedArchives = [
    { ...brokerArchive, orders: [renamedSnapshot] },
    { ...agentArchive, orders: [renamedSnapshot] },
  ];
  assert.deepEqual(
    removeOrdersAlreadyArchived([order], renamedArchives, [], [], actors),
    [],
    "The same stable order ID must match after a journal rename",
  );
  assert.deepEqual(
    removeOrdersAlreadyArchived([order], renamedArchives, [], [{
      source: "ORDER_PAYMENT",
      journal: order.journal,
      orderId: "ORD-OTHER",
      account: "PPP ACTOR_CLEARING",
    }], actors),
    [],
    "An open ledger line for another stable order ID must not attach through a shared journal",
  );
  assert.deepEqual(
    removeOrdersAlreadyArchived([order], renamedArchives, [], [{
      source: "ORDER_PAYMENT",
      journal: "JRN-1768 (2)",
      orderId: order.id,
      account: "PPP ACTOR_CLEARING",
    }], actors),
    [order],
    "An open ledger line with the same stable order ID must attach after a journal rename",
  );

  const closeIdentitySource = sourceBetween(index, "function orderArchiveIdentityValues", "function orderParticipantMatchesActor");
  const ordersReferToSameRecord = new Function(`${closeIdentitySource}\nreturn ordersReferToSameRecord;`)();
  assert.equal(ordersReferToSameRecord(order, collidingSnapshot), false);
  assert.equal(ordersReferToSameRecord(order, renamedSnapshot), true);
  assert.equal(ordersReferToSameRecord(order, { journal: order.journal }), true, "Journal remains a fallback for legacy records without IDs");

  const repairedOrder = {
    ...order,
    id: "ORD-NAHOM-1739",
    internalOrderId: "ORD-NAHOM-1739",
    agentActorId: "ACT-NAHOM-LEGACY",
    agent: "Nahom",
    journal: "JRN-1739",
  };
  const repairedActors = [
    actors[0],
    { id: "ACT-NAHOM-CURRENT", name: "Nahom", role: "Agent" },
  ];
  const repairedArchives = [
    { ...brokerArchive, orders: [repairedOrder] },
    { ...agentArchive, actor: "Nahom", actorId: "ACT-NAHOM-CURRENT", orders: [repairedOrder] },
  ];
  const repairedLedger = [
    { source: "ORDER_PAYMENT", journal: "JRN-1739", orderId: repairedOrder.id, account: "PPP ACTOR_CLEARING", archived: true },
    { source: "ORDER_PAYMENT", journal: "JRN-1739", orderId: repairedOrder.id, account: "Nahom ACTOR_CLEARING", archived: true },
  ];
  const identityLink = {
    repairId: "galaxy-nahom-jrn-1739-participant-v1",
    workspace: "galaxy",
    workspaceId: "WS-GALAXY",
    journal: "JRN-1739",
    orderIds: [repairedOrder.id],
    role: "agent",
    actorId: "ACT-NAHOM-CURRENT",
    actorName: "Nahom",
    participantName: "Nahom",
    legacyActorId: "ACT-NAHOM-LEGACY",
  };
  assert.deepEqual(
    removeOrdersAlreadyArchived([repairedOrder], repairedArchives, [], repairedLedger, repairedActors),
    [repairedOrder],
    "A stale ID must not fall back to the matching name without an approved identity link",
  );
  assert.deepEqual(
    removeOrdersAlreadyArchived([repairedOrder], repairedArchives, [], repairedLedger, repairedActors, [identityLink], "WS-GALAXY"),
    [],
    "The exact approved link should let the client recognize complete participant coverage",
  );
  assert.deepEqual(
    removeOrdersAlreadyArchived(
      [repairedOrder],
      repairedArchives,
      [],
      repairedLedger,
      repairedActors,
      [{ ...identityLink, orderIds: ["ORD-DIFFERENT"] }],
      "WS-GALAXY",
    ),
    [repairedOrder],
    "A link for another stable order ID must not affect retention",
  );
  assert.deepEqual(
    removeOrdersAlreadyArchived(
      [repairedOrder],
      repairedArchives,
      [],
      repairedLedger,
      repairedActors,
      [identityLink],
      "WS-OTHER",
    ),
    [repairedOrder],
    "A valid Galaxy link transplanted to another workspace must not affect client retention",
  );
  assert.deepEqual(
    removeOrdersAlreadyArchived(
      [repairedOrder],
      repairedArchives,
      [],
      repairedLedger,
      repairedActors,
      [{ ...identityLink, legacyActorId: "" }],
      "WS-GALAXY",
    ),
    [repairedOrder],
    "A link without the exact historic participant ID must not affect client retention",
  );
  assert.deepEqual(
    removeOrdersAlreadyArchived(
      [repairedOrder],
      repairedArchives,
      [],
      repairedLedger,
      repairedActors.map((actor) => actor.id === "ACT-NAHOM-CURRENT" ? { ...actor, role: "Broker" } : actor),
      [identityLink],
      "WS-GALAXY",
    ),
    [repairedOrder],
    "An Actor with an incompatible role must not consume the approved Agent link",
  );
  assert.match(index, /!orderArchivedForActor\(order, actor\)/, "The first closer must not see a duplicate live row beside Report.");
  const searchSource = sourceBetween(index, "function buildGlobalSearchResults", "function searchStatusClass");
  assert.match(searchSource, /orderParticipantMatchesActor\(order, actor, "broker"\)/);
  assert.match(searchSource, /orderParticipantMatchesActor\(order, actor, "agent"\)/);
  assert.match(searchSource, /!orderArchivedForActor\(order, actor\)/);
  assert.doesNotMatch(searchSource, /order\.broker === actor\.name \|\| order\.agent === actor\.name/);
});

test("server and Android use participant-aware order retention", async () => {
  const [server, mobileClient, mobileHelper, mobileDomain, mobileScreens, mobileApp] = await Promise.all([
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/orderParticipantRetention.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
  ]);

  assert.match(server, /retainOrdersForOpenParticipants/);
  assert.match(server, /nextState\.ledger,\s*nextState\.actors/);
  assert.match(mobileClient, /retainOrdersForUnclosedParticipants/);
  assert.match(mobileClient, /state\?\.orderParticipantIdentityLinks/);
  assert.match(mobileHelper, /participants\.every/);
  assert.match(mobileHelper, /line\.archived === true/);
  assert.match(mobileHelper, /function participantIdentityLinkMatches/);
  assert.match(mobileHelper, /galaxy-nahom-jrn-1739-participant-v1/);
  assert.match(mobileHelper, /clean\(link\.workspaceId\) === clean\(workspaceId\)/);
  assert.match(mobileHelper, /roleSupported/);
  assert.match(mobileHelper, /Boolean\(clean\(link\.legacyActorId\)\)/);
  assert.match(mobileHelper, /legacyActorId/);
  assert.match(mobileHelper, /linkedIds\.has\(id\)/);
  assert.match(mobileHelper, /if \(leftIds\.size && rightIds\.size\) return \[\.\.\.leftIds\]\.some\(\(id\) => rightIds\.has\(id\)\)/);
  assert.match(mobileHelper, /const sameOrder = lineOrderId && ids\.size\s*\? ids\.has\(lineOrderId\)\s*:\s*Boolean\(lineJournal && journal && lineJournal === journal\)/);
  assert.match(mobileDomain, /const evidenceJournal = String\(line\.journal \|\| ""\)\.trim\(\)/);
  assert.match(mobileDomain, /const journalMatch = candidateOrders\.find/);
  assert.match(mobileScreens, /!orderArchivedForActor\(order, session\.actorId, session\.actorName, state\.archives\)/);
  assert.match(mobileScreens, /function orderAgentMatchesActor/);
  assert.match(mobileApp, /!orderArchivedForActor\(order, session\.actorId, session\.actorName/);
  assert.match(mobileApp, /function orderAgentMatchesSession/);
  assert.match(server, /function orderParticipantMatchesIdentity/);
});
