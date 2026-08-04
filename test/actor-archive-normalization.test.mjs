import assert from "node:assert/strict";
import test from "node:test";

import { authorizeActorWorkspaceUpdate } from "../src/workspace-security.mjs";

test("legacy closed-report normalization does not block a Broker order", () => {
  const master = { id: "master-1", name: "Master", role: "Master", currency: "USD", active: true };
  const broker = { id: "broker-1", name: "Brhin Ros", role: "Broker", currency: "EUR", active: true };
  const legacyArchive = {
    id: "ARCH-1",
    actorId: broker.id,
    actor: broker.name,
    closedAt: "2026-08-01T00:00:00.000Z",
    orders: []
  };
  const currentState = {
    actors: [master, broker],
    orders: [],
    receivables: [],
    savedCustomers: [],
    transfers: [],
    ledger: [],
    archives: [legacyArchive],
    settlements: [],
    chatConversations: [],
    orderCounter: 0
  };
  const incomingState = structuredClone(currentState);
  Object.assign(incomingState.archives[0], { receivables: [], transfers: [], ledger: [] });
  incomingState.orders.unshift({
    id: "ORD-1",
    brokerOrderNumber: "BRH001",
    brokerActorId: broker.id,
    broker: broker.name,
    agent: "Unassigned",
    agentActorId: "",
    sourceCurrency: "EUR",
    payoutCurrency: "ETB",
    sourceAmountMinor: 20000,
    payoutAmountMinor: 38800,
    commissionMinor: 0,
    grossMinor: 20000,
    moneyUnitVersion: 2,
    rate: 194,
    commissionPercent: 0,
    senderName: "Natu",
    receiverName: "Yosan kahsay",
    receiverCity: "Adis",
    accountNumber: "247762957",
    phoneNumber: "",
    remarks: "",
    amount: "EUR200",
    fundingType: "cash",
    state: "Pending Forward",
    journal: "",
    createdAt: "2026-08-04T08:00:00.000Z",
    sentAt: "2026-08-04T08:00:00.000Z",
    updatedAt: "2026-08-04T08:00:00.000Z"
  });
  incomingState.orderCounter = 1;

  const result = authorizeActorWorkspaceUpdate({
    currentState,
    incomingState,
    session: {
      membership: { role: "Actor", actorId: broker.id, actorName: broker.name },
      workspace: { id: "workspace-1" },
      user: { id: "user-1" }
    },
    files: []
  });

  assert.equal(result.state.orders.some((order) => order.id === "ORD-1" && order.state === "Pending Forward"), true);
  assert.deepEqual(result.state.archives, [legacyArchive]);
  assert.deepEqual(result.actions, ["created order ORD-1"]);
});
