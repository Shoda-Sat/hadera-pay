import assert from "node:assert/strict";
import test from "node:test";

import {
  orderHasOpenParticipantLine,
  participantArchiveCoverage,
  resolveParticipantOrderForLedgerLine,
  retainOrdersForOpenParticipants,
} from "../src/orderParticipantRetention.mjs";

const brokerClose = "2026-08-14T10:00:00.000Z";
const agentClose = "2026-08-14T11:00:00.000Z";

function paidOrder(overrides = {}) {
  return {
    id: "ORD-341-OLD",
    internalOrderId: "ORD-341-OLD",
    brokerOrderNumber: "PPP341",
    brokerActorId: "ACT-PPP",
    agentActorId: "ACT-DEKEMHARE",
    broker: "PPP",
    agent: "Dekemhare",
    state: "Paid",
    journal: "JRN-1768",
    sourceCurrency: "EUR",
    sourceAmountMinor: 50_000,
    payoutCurrency: "ERN",
    payoutAmountMinor: 75_000,
    commissionMinor: 0,
    grossMinor: 50_000,
    senderName: "Sender",
    receiverName: "Receiver",
    paidAt: "2026-08-13T11:26:02.000Z",
    locked: true,
    ...overrides,
  };
}

function archive(actor, actorId, id, closedAt, orders) {
  return {
    id,
    actor,
    actorId,
    actorRole: actor === "PPP" ? "Broker" : "Agent",
    closedAt,
    balances: {},
    incomeProfitMinor: 0,
    orders,
    ledger: [],
    transfers: [],
    receivables: [],
  };
}

function paymentLine(actor, direction, archived, closedAt = "") {
  return {
    source: "ORDER_PAYMENT",
    journal: "JRN-1768",
    orderId: "ORD-341-REWRITTEN",
    account: `${actor} ACTOR_CLEARING`,
    direction,
    currency: actor === "PPP" ? "EUR" : "ERN",
    amountMinor: actor === "PPP" ? 50_000 : 75_000,
    archived,
    ...(closedAt ? { closedAt } : {}),
  };
}

function baseState() {
  return {
    actors: [
      { id: "ACT-MASTER", name: "Master", role: "Master" },
      { id: "ACT-PPP", name: "PPP", role: "Broker" },
      { id: "ACT-DEKEMHARE", name: "Dekemhare", role: "Agent" },
    ],
    orders: [],
    archives: [],
    ledger: [],
    settlements: [{ actor: "Dekemhare", currency: "ERN", netMinor: -75_000 }],
    unrelated: { keep: true },
  };
}

test("keeps a completed live order until every distinct participant has an archive", () => {
  const state = baseState();
  const live = paidOrder({ id: "ORD-341-REWRITTEN", internalOrderId: "ORD-341-REWRITTEN" });
  state.orders = [live];
  state.archives = [archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [paidOrder({ actor: "PPP", archivedAt: brokerClose })])];
  state.ledger = [
    paymentLine("PPP", "Debit", true, brokerClose),
    paymentLine("Dekemhare", "Credit", true, agentClose),
  ];

  const partialCoverage = participantArchiveCoverage(live, state);
  assert.equal(partialCoverage.complete, false);
  assert.deepEqual(partialCoverage.participants.map((item) => [item.actorName, item.covered]), [
    ["PPP", true],
    ["Dekemhare", false],
  ]);
  const retained = retainOrdersForOpenParticipants(state);
  assert.deepEqual(retained.orders, [live]);
  assert.equal(retained.removedCount, 0);

  state.archives.push(archive("Dekemhare", "ACT-DEKEMHARE", "ARC-DEKEMHARE", agentClose, [
    paidOrder({
      id: "ORD-341-REWRITTEN",
      internalOrderId: "ORD-341-REWRITTEN",
      actor: "Dekemhare",
      archivedAt: agentClose,
      payerCurrency: "ERN",
      payerAmountMinor: 75_000,
    }),
  ]));
  state.ledger[1] = paymentLine("Dekemhare", "Credit", false);
  const stillOpen = retainOrdersForOpenParticipants(state);
  assert.deepEqual(stillOpen.orders, [live], "Even complete archives cannot prune against a still-open participant line.");

  state.ledger[1] = paymentLine("Dekemhare", "Credit", true, agentClose);
  const complete = retainOrdersForOpenParticipants(state);
  assert.deepEqual(complete.orders, []);
  assert.equal(complete.removedCount, 1);
  assert.deepEqual(complete.removedOrderIds, ["ORD-341-REWRITTEN"]);
});

test("recovers a missing paid order for an open participant by journal despite a remapped hidden ID", () => {
  const state = baseState();
  const brokerSnapshot = paidOrder({ actor: "PPP", archivedAt: brokerClose });
  state.archives = [archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [brokerSnapshot])];
  state.ledger = [
    paymentLine("PPP", "Debit", true, brokerClose),
    paymentLine("Dekemhare", "Credit", false),
    { source: "ORDER_PAYMENT", journal: "JRN-1768", orderId: "ORD-341-REWRITTEN", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ERN", amountMinor: 75_000 },
  ];
  const before = structuredClone(state);

  const resolved = resolveParticipantOrderForLedgerLine(state.ledger[1], [], state.archives);
  assert.equal(resolved.conflict, false);
  assert.equal(resolved.order, brokerSnapshot);
  const result = retainOrdersForOpenParticipants(state);
  assert.equal(result.recoveredCount, 1);
  assert.deepEqual(result.recoveredOrderIds, ["ORD-341-REWRITTEN"]);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].id, "ORD-341-REWRITTEN");
  assert.equal(result.orders[0].internalOrderId, "ORD-341-REWRITTEN");
  assert.equal(result.orders[0].collisionSourceOrderId, "ORD-341-OLD");
  assert.equal(result.orders[0].journal, "JRN-1768");
  assert.equal("archivedAt" in result.orders[0], false);
  assert.equal("actor" in result.orders[0], false);
  assert.equal("locked" in result.orders[0], false);
  assert.equal(orderHasOpenParticipantLine(result.orders[0], state), true);
  assert.deepEqual(state, before, "Orders, ledger, settlements, and all accounting state must remain immutable.");
  assert.equal(result.orders.includes(brokerSnapshot), false, "A recovered live record must be a clone, not the archive object.");
});

test("does not recover a historically missing row after every matching Actor line is closed", () => {
  const state = baseState();
  state.archives = [archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [paidOrder({ actor: "PPP", archivedAt: brokerClose })])];
  state.ledger = [
    paymentLine("PPP", "Debit", true, brokerClose),
    paymentLine("Dekemhare", "Credit", true, agentClose),
  ];

  const result = retainOrdersForOpenParticipants(state);
  assert.deepEqual(result.orders, []);
  assert.equal(result.recoveredCount, 0, "Closed-report repair, not live retention, owns this historical repair.");
  assert.equal(result.removedCount, 0);
});

test("uses stable participant IDs before legacy names and supports a genuine legacy archive", () => {
  const state = baseState();
  const live = paidOrder({ id: "ORD-341-REWRITTEN", internalOrderId: "ORD-341-REWRITTEN" });
  state.orders = [live];
  state.ledger = [];
  state.archives = [
    archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [paidOrder()]),
    archive("Dekemhare", "ACT-OTHER", "ARC-WRONG-DEKEMHARE", agentClose, [paidOrder()]),
  ];
  assert.equal(participantArchiveCoverage(live, state).complete, false, "A reused name cannot override conflicting stable IDs.");
  assert.deepEqual(retainOrdersForOpenParticipants(state).orders, [live]);

  delete live.agentActorId;
  delete state.archives[1].actorId;
  delete state.archives[0].orders[0].agentActorId;
  delete state.archives[1].orders[0].agentActorId;
  assert.equal(participantArchiveCoverage(live, state).complete, true, "A name-only archive may be used only as legacy fallback.");
  assert.deepEqual(retainOrdersForOpenParticipants(state).orders, []);
});

test("treats deleted order IDs as absolute tombstones for input and recovery", () => {
  const state = baseState();
  const live = paidOrder({ id: "ORD-341-REWRITTEN", internalOrderId: "ORD-341-REWRITTEN" });
  state.orders = [live];
  state.archives = [archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [paidOrder()])];
  state.ledger = [paymentLine("Dekemhare", "Credit", false)];
  state.deletedOrderIds = ["ORD-341-REWRITTEN"];
  const before = structuredClone(state);

  const inputTombstone = retainOrdersForOpenParticipants(state);
  assert.deepEqual(inputTombstone.orders, []);
  assert.equal(inputTombstone.recoveredCount, 0);
  assert.deepEqual(inputTombstone.removedOrderIds, ["ORD-341-REWRITTEN"]);
  assert.deepEqual(state, before);

  state.orders = [];
  state.deletedOrderIds = ["ORD-341-OLD"];
  const archiveTombstone = retainOrdersForOpenParticipants(state);
  assert.deepEqual(archiveTombstone.orders, []);
  assert.equal(archiveTombstone.recoveredCount, 0, "A tombstoned archived source must never be resurrected.");
});

test("does not treat an account named Master as an open participant", () => {
  const state = baseState();
  state.archives = [archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [paidOrder()])];
  state.ledger = [{
    ...paymentLine("Master", "Credit", false),
    actorId: "",
  }];

  const result = retainOrdersForOpenParticipants(state);
  assert.deepEqual(result.orders, []);
  assert.equal(result.recoveredCount, 0);
});

test("rejects conflicting archive snapshots instead of recovering or pruning", () => {
  const state = baseState();
  const source = paidOrder({ actor: "PPP", archivedAt: brokerClose });
  const conflicting = paidOrder({
    actor: "PPP",
    archivedAt: brokerClose,
    payoutAmountMinor: 99_999,
  });
  state.archives = [
    archive("PPP", "ACT-PPP", "ARC-PPP-A", brokerClose, [source]),
    archive("PPP", "ACT-PPP", "ARC-PPP-B", brokerClose, [conflicting]),
  ];
  state.ledger = [paymentLine("Dekemhare", "Credit", false)];
  const before = structuredClone(state);

  const result = retainOrdersForOpenParticipants(state);
  assert.equal(result.recoveredCount, 0);
  assert.deepEqual(result.orders, []);
  assert.equal(result.skippedConflictCount, 1);
  assert.equal(result.skippedConflicts[0].reason, "conflicting-snapshots");
  assert.deepEqual(state, before);

  state.orders = [paidOrder({ id: "ORD-341-REWRITTEN", internalOrderId: "ORD-341-REWRITTEN" })];
  const retained = retainOrdersForOpenParticipants(state);
  assert.equal(retained.orders.length, 1, "Conflicting archives must never authorize pruning a live order.");
});

test("preserves a pending ID collision instead of overwriting it with recovered history", () => {
  const state = baseState();
  const pending = {
    id: "ORD-341-REWRITTEN",
    internalOrderId: "ORD-341-REWRITTEN",
    brokerActorId: "ACT-OTHER",
    broker: "Other Broker",
    brokerOrderNumber: "OTH001",
    agent: "Unassigned",
    state: "Pending Forward",
    journal: "JRN-NEW",
    sourceCurrency: "USD",
    sourceAmountMinor: 1_000,
    payoutCurrency: "USD",
    payoutAmountMinor: 1_000,
  };
  state.orders = [pending];
  state.archives = [archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [paidOrder()])];
  state.ledger = [paymentLine("Dekemhare", "Credit", false)];

  const result = retainOrdersForOpenParticipants(state);
  assert.deepEqual(result.orders, [pending]);
  assert.equal(result.recoveredCount, 0);
  assert.equal(result.skippedConflictCount, 1);
  assert.equal(result.skippedConflicts[0].reason, "live-order-identity-conflict");
});

test("falls back to stable order IDs only when a journal is unavailable", () => {
  const state = baseState();
  const noJournal = paidOrder({ journal: "" });
  state.archives = [archive("PPP", "ACT-PPP", "ARC-PPP", brokerClose, [noJournal])];
  state.ledger = [{
    ...paymentLine("Dekemhare", "Credit", false),
    journal: "",
    orderId: "ORD-341-OLD",
  }];
  const result = retainOrdersForOpenParticipants(state);
  assert.equal(result.recoveredCount, 1);
  assert.equal(result.orders[0].id, "ORD-341-OLD");

  state.archives[0].orders[0] = paidOrder({ journal: "JRN-SOURCE" });
  state.ledger[0].journal = "JRN-DIFFERENT";
  assert.equal(retainOrdersForOpenParticipants(state).recoveredCount, 0, "Two present mismatching journals must not fall back to the ID.");
});

test("deduplicates a Special Broker acting as both order participants", () => {
  const state = baseState();
  state.actors = [
    { id: "ACT-MASTER", name: "Master", role: "Master" },
    { id: "ACT-SPECIAL", name: "Special", role: "Special Broker" },
  ];
  const selfPaid = paidOrder({
    id: "ORD-SELF",
    internalOrderId: "ORD-SELF",
    brokerActorId: "ACT-SPECIAL",
    agentActorId: "ACT-SPECIAL",
    broker: "Special",
    agent: "Special",
    journal: "JRN-SELF",
  });
  state.orders = [selfPaid];
  state.archives = [archive("Special", "ACT-SPECIAL", "ARC-SPECIAL", brokerClose, [selfPaid])];
  state.ledger = [];

  const coverage = participantArchiveCoverage(selfPaid, state);
  assert.equal(coverage.participants.length, 1);
  assert.equal(coverage.complete, true);
  assert.deepEqual(retainOrdersForOpenParticipants(state).orders, []);
});
