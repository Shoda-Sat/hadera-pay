import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("dashboard Open orders counts only unpaid assignments for the paying Actor", async () => {
  const [index, preview, mobileApp] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(index, /function orderIsAssignedUnpaid\(order\)/);
  assert.match(index, /order\?\.state === "Assigned"/);
  assert.match(index, /order\.agentActorId === actor\.id/);
  assert.match(index, /els\.metricOrders\.textContent = String\(openOrders\.length\)/);
  assert.match(mobileApp, /function assignedUnpaidOrdersFor/);
  assert.match(mobileApp, /order\.agentActorId === session\.actorId/);
  assert.match(mobileApp, /<Metric label="Open orders" value=\{String\(openOrders\.length\)\}/);

  const orders = [
    { id: "assigned-a-1", state: "Assigned", agentActorId: "ACT-A", agent: "Agent A" },
    { id: "assigned-a-2", state: "Assigned", agentActorId: "ACT-A", agent: "Agent A" },
    { id: "assigned-b-1", state: "Assigned", agentActorId: "ACT-B", agent: "Agent B" },
    { id: "paid-a", state: "Paid", agentActorId: "ACT-A", agent: "Agent A", paidAt: "2026-07-31T08:00:00.000Z", journal: "JNL-1" },
    { id: "cancelled-a", state: "Cancelled", agentActorId: "ACT-A", agent: "Agent A", cancelledAt: "2026-07-31T09:00:00.000Z" },
    { id: "stale-paid-a", state: "Assigned", agentActorId: "ACT-A", agent: "Agent A", paidAt: "2026-07-31T10:00:00.000Z", journal: "JNL-2" },
  ];
  const isAssignedUnpaid = (order) => order.state === "Assigned" && !order.paidAt && !order.journal && !order.cancelledAt && !order.voidedAt;
  const openForMaster = orders.filter(isAssignedUnpaid);
  const openForAgentA = openForMaster.filter((order) => order.agentActorId === "ACT-A");

  assert.deepEqual(openForMaster.map((order) => order.id), ["assigned-a-1", "assigned-a-2", "assigned-b-1"]);
  assert.deepEqual(openForAgentA.map((order) => order.id), ["assigned-a-1", "assigned-a-2"]);
});
