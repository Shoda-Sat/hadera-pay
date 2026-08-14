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
  assert.match(mobileHelper, /participants\.every/);
  assert.match(mobileHelper, /line\.archived === true/);
  assert.match(mobileDomain, /const evidenceJournal = String\(line\.journal \|\| ""\)\.trim\(\)/);
  assert.match(mobileDomain, /const journalMatch = candidateOrders\.find/);
  assert.match(mobileScreens, /!orderArchivedForActor\(order, session\.actorId, session\.actorName, state\.archives\)/);
  assert.match(mobileScreens, /function orderAgentMatchesActor/);
  assert.match(mobileApp, /!orderArchivedForActor\(order, session\.actorId, session\.actorName/);
  assert.match(mobileApp, /function orderAgentMatchesSession/);
  assert.match(server, /function orderParticipantMatchesIdentity/);
});
