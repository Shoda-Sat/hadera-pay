import assert from "node:assert/strict";
import test from "node:test";

import { authorizeActorWorkspaceUpdate } from "../src/workspace-security.mjs";

test("an assigned Agent can return an older order by stable Actor ID", () => {
  const master = { id: "master-1", name: "Master", role: "Master", currency: "USD", active: true };
  const broker = { id: "broker-1", name: "Broker", role: "Broker", currency: "EUR", active: true };
  const agent = { id: "agent-1", name: "Renamed Agent", role: "Agent", currency: "ETB", active: true };
  const assignedAt = "2026-08-04T08:00:00.000Z";
  const order = {
    id: "ORD-1",
    brokerOrderNumber: "BRO001",
    brokerActorId: broker.id,
    broker: broker.name,
    agent: "Previous Agent Name",
    agentActorId: agent.id,
    sourceCurrency: "EUR",
    payoutCurrency: "ETB",
    sourceAmountMinor: 20000,
    payoutAmountMinor: 38800,
    commissionMinor: 0,
    grossMinor: 20000,
    rate: 194,
    commissionPercent: 0,
    fundingType: "cash",
    state: "Assigned",
    journal: "",
    createdAt: assignedAt,
    sentAt: assignedAt,
    assignedAt,
    updatedAt: assignedAt,
    returnedReason: ""
  };
  const currentState = {
    actors: [master, broker, agent],
    orders: [order],
    receivables: [],
    savedCustomers: [],
    transfers: [],
    ledger: [],
    archives: [],
    settlements: [],
    chatConversations: []
  };
  const incomingState = structuredClone(currentState);
  Object.assign(incomingState.orders[0], {
    state: "Returned",
    agent: "Unassigned",
    agentActorId: "",
    returnedBy: agent.name,
    returnedReason: "Receiver details need correction",
    returnedAt: "2026-08-04T08:05:00.000Z",
    updatedAt: "2026-08-04T08:05:00.000Z"
  });

  const result = authorizeActorWorkspaceUpdate({
    currentState,
    incomingState,
    session: {
      membership: { role: "Actor", actorId: agent.id, actorName: agent.name },
      workspace: { id: "workspace-1" },
      user: { id: "user-1" }
    },
    files: []
  });

  const returned = result.state.orders.find((item) => item.id === order.id);
  assert.equal(returned.state, "Returned");
  assert.equal(returned.agent, "Unassigned");
  assert.equal(returned.agentActorId, "");
  assert.equal(returned.returnedBy, agent.name);
  assert.equal(returned.returnedReason, "Receiver details need correction");
  assert.deepEqual(result.actions, ["returned order ORD-1"]);
});
