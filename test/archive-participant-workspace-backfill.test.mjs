import assert from "node:assert/strict";
import test from "node:test";

import { backfillAllClosedActorOrderSnapshots } from "../src/archiveParticipantBackfill.mjs";

const payerClose = "2026-08-03T13:28:00.000Z";
const brokerClose = "2026-08-04T16:23:11.000Z";

function paidOrder(overrides = {}) {
  return {
    id: "ORD-PPP061",
    internalOrderId: "ORD-PPP061",
    brokerOrderNumber: "PPP061",
    agentOrderNumber: "0005_PPP061",
    agentOrderNumbers: { Gbxi: "0005_PPP061" },
    brokerActorId: "ACT-PPP",
    agentActorId: "ACT-GBXI",
    broker: "PPP",
    agent: "Gbxi",
    sourceCurrency: "USD",
    sourceAmountMinor: 10_150,
    payoutCurrency: "USD",
    payoutAmountMinor: 10_150,
    state: "Paid",
    journal: "JRN-1188",
    paidAt: "2026-08-03T13:27:30.000Z",
    locked: true,
    ...overrides,
  };
}

function payerFirstState() {
  return {
    actors: [
      { id: "ACT-MASTER", name: "Master", role: "Master", currency: "USD" },
      { id: "ACT-PPP", name: "PPP", role: "Broker", currency: "USD" },
      { id: "ACT-GBXI", name: "Gbxi", role: "Agent", currency: "USD" },
    ],
    orders: [],
    archives: [
      {
        id: "ARC-GBXI-FIRST",
        actor: "Gbxi",
        actorId: "ACT-GBXI",
        actorRole: "Agent",
        closedAt: payerClose,
        balances: { USD: -10_150 },
        incomeProfitMinor: 0,
        orders: [paidOrder({
          actor: "Gbxi",
          archivedAt: payerClose,
          payerCurrency: "USD",
          payerAmountMinor: 10_150,
        })],
        ledger: [],
        transfers: [],
        receivables: [],
      },
      {
        id: "ARC-PPP-SECOND",
        actor: "PPP",
        actorId: "ACT-PPP",
        actorRole: "Broker",
        closedAt: brokerClose,
        balances: { USD: 10_150 },
        incomeProfitMinor: 250,
        orders: [],
        ledger: [],
        transfers: [],
        receivables: [],
      },
    ],
    ledger: [
      {
        journal: "JRN-1188",
        orderId: "ORD-PPP061",
        source: "ORDER_PAYMENT",
        account: "Gbxi ACTOR_CLEARING",
        direction: "Credit",
        currency: "USD",
        amountMinor: 10_150,
        archived: true,
        closedAt: payerClose,
      },
      {
        journal: "JRN-1188",
        orderId: "ORD-PPP061",
        source: "ORDER_PAYMENT",
        account: "PPP ACTOR_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 10_150,
        archived: true,
        closedAt: brokerClose,
      },
      {
        journal: "JRN-1188",
        orderId: "ORD-PPP061",
        source: "ORDER_PAYMENT",
        account: "MASTER_CASH",
        direction: "Credit",
        currency: "USD",
        amountMinor: 10_150,
      },
    ],
    settlements: [{ actor: "PPP", currency: "USD", netMinor: 10_150 }],
    receivables: [{ id: "REC-KEEP", principalMinor: 10_150 }],
    transfers: [{ id: "TRX-KEEP", state: "Approved" }],
    orderCounter: 61,
    journalCounter: 188,
    unrelated: { keep: true },
  };
}

function withoutArchivedOrders(state) {
  return {
    ...state,
    archives: (state.archives || []).map((archive) => {
      const { orders, ...withoutOrders } = archive;
      return withoutOrders;
    }),
  };
}

test("workspace-wide repair restores a payer-first broker report without changing accounting", () => {
  const state = payerFirstState();
  const before = structuredClone(state);
  const result = backfillAllClosedActorOrderSnapshots(state);

  assert.deepEqual(state, before, "The input workspace must remain immutable.");
  assert.equal(result.repairedCount, 1);
  assert.equal(result.repairedActorCount, 1);
  assert.equal(result.safeActorCount, 2);
  assert.equal(result.blockedActorCount, 0);
  assert.equal(result.closedActorCount, 2);
  assert.equal(result.unclosedActorCount, 0);
  assert.deepEqual(result.repaired.map((item) => item.archiveId), ["ARC-PPP-SECOND"]);

  const brokerSnapshot = result.state.archives.find((archive) => archive.id === "ARC-PPP-SECOND").orders[0];
  assert.equal(brokerSnapshot.agentOrderNumber, "0005_PPP061");
  assert.equal(brokerSnapshot.actor, "PPP");
  assert.equal(brokerSnapshot.payerCurrency, "");
  assert.equal(brokerSnapshot.payerAmountMinor, 0);
  assert.equal(brokerSnapshot.archivedAt, brokerClose);
  assert.deepEqual(withoutArchivedOrders(result.state), withoutArchivedOrders(before));
  assert.equal(result.state.ledger, state.ledger);
  assert.equal(result.state.settlements, state.settlements);

  const rerun = backfillAllClosedActorOrderSnapshots(result.state);
  assert.equal(rerun.repairedCount, 0);
  assert.equal(rerun.blockedActorCount, 0);
  assert.equal(rerun.state, result.state, "An idempotent rerun must retain the same state object.");
});

test("targets only closed Actor archives and reports active unclosed Actors without touching them", () => {
  const state = payerFirstState();
  state.actors.push({ id: "ACT-OPEN", name: "Open Agent", role: "Agent", currency: "USD" });
  state.orders.push(paidOrder({
    id: "ORD-OPEN",
    internalOrderId: "ORD-OPEN",
    journal: "JRN-OPEN",
    agent: "Open Agent",
    agentActorId: "ACT-OPEN",
    state: "Paid",
  }));
  state.ledger.push({
    journal: "JRN-OPEN",
    orderId: "ORD-OPEN",
    source: "ORDER_PAYMENT",
    account: "Open Agent ACTOR_CLEARING",
    direction: "Credit",
    currency: "USD",
    amountMinor: 10_150,
  });
  state.archives.push({
    id: "ARC-MASTER",
    kind: "master-transactions",
    actor: "Master Transactions",
    actorRole: "Master",
    closedAt: brokerClose,
    orders: [],
  });

  const result = backfillAllClosedActorOrderSnapshots(state);
  assert.equal(result.closedActorCount, 2, "Master archives must never become repair targets.");
  assert.equal(result.unclosedActorCount, 1);
  assert.ok(result.actorResults.every((item) => item.actorId !== "ACT-OPEN"));
  assert.equal(result.state.orders.find((order) => order.id === "ORD-OPEN"), state.orders.find((order) => order.id === "ORD-OPEN"));
  assert.equal(result.state.archives.some((archive) => archive.actorId === "ACT-OPEN"), false);
});

test("applies safe Actor repairs while leaving a blocked closed Actor report untouched", () => {
  const state = payerFirstState();
  const blockedClose = "2026-08-05T09:00:00.000Z";
  state.actors.push({ id: "ACT-BLOCKED", name: "Blocked Agent", role: "Agent", currency: "USD" });
  state.archives.push({
    id: "ARC-BLOCKED",
    actor: "Blocked Agent",
    actorId: "ACT-BLOCKED",
    actorRole: "Agent",
    closedAt: blockedClose,
    balances: { USD: -500 },
    incomeProfitMinor: 0,
    orders: [],
    ledger: [],
    transfers: [],
    receivables: [],
  });
  state.ledger.push({
    journal: "JRN-ORPHAN",
    orderId: "ORD-ORPHAN",
    source: "ORDER_PAYMENT",
    account: "Blocked Agent ACTOR_CLEARING",
    direction: "Credit",
    currency: "USD",
    amountMinor: 500,
    archived: true,
    closedAt: blockedClose,
  });
  const beforeBlocked = structuredClone(state.archives.find((archive) => archive.id === "ARC-BLOCKED"));

  const result = backfillAllClosedActorOrderSnapshots(state);
  assert.equal(result.repairedCount, 1, "The independent PPP repair should still be applied.");
  assert.equal(result.safeActorCount, 2);
  assert.equal(result.blockedActorCount, 1);
  assert.equal(result.closedActorCount, 3);
  assert.equal(result.blockedActors[0].actorId, "ACT-BLOCKED");
  assert.equal(result.blockedActors[0].name, "Blocked Agent");
  assert.equal(result.blockedActors[0].skippedCount, 0);
  assert.equal(result.blockedActors[0].orphanCount, 1);
  assert.deepEqual(result.state.archives.find((archive) => archive.id === "ARC-BLOCKED"), beforeBlocked);
  assert.equal(result.state.archives.find((archive) => archive.id === "ARC-PPP-SECOND").orders.length, 1);
  assert.deepEqual(withoutArchivedOrders(result.state), withoutArchivedOrders(state));
});

test("repairs a closed archive for an Actor that has since been removed", () => {
  const state = payerFirstState();
  state.actors = state.actors.filter((actor) => actor.id !== "ACT-PPP");

  const result = backfillAllClosedActorOrderSnapshots(state);
  assert.equal(result.repairedCount, 1);
  assert.equal(result.closedActorCount, 2, "A stable archived Actor remains a valid closed-report target.");
  assert.equal(result.blockedActorCount, 0);
  assert.equal(result.repaired[0].actorId, "ACT-PPP");
  assert.equal(result.state.archives.find((archive) => archive.id === "ARC-PPP-SECOND").orders.length, 1);
});

test("leaves name-only legacy closed reports for manual review", () => {
  const state = payerFirstState();
  const brokerArchive = state.archives.find((archive) => archive.id === "ARC-PPP-SECOND");
  delete brokerArchive.actorId;
  state.actors = state.actors.filter((actor) => actor.id !== "ACT-PPP");

  const result = backfillAllClosedActorOrderSnapshots(state);
  assert.equal(result.repairedCount, 0);
  assert.equal(result.blockedActorCount, 1);
  assert.equal(result.blockedActors[0].actorId, "");
  assert.equal(result.blockedActors[0].actorName, "PPP");
  assert.equal(result.state, state, "An automatic batch must not modify a name-only historical identity.");
});

test("does not give a name-only legacy report to a recreated Actor with the same name", () => {
  const state = payerFirstState();
  const brokerArchive = state.archives.find((archive) => archive.id === "ARC-PPP-SECOND");
  delete brokerArchive.actorId;
  state.actors = state.actors.map((actor) => actor.id === "ACT-PPP"
    ? { ...actor, id: "ACT-PPP-NEW" }
    : actor);

  const result = backfillAllClosedActorOrderSnapshots(state);
  assert.equal(result.repairedCount, 0);
  assert.equal(result.blockedActorCount, 1);
  assert.equal(result.blockedActors[0].actorName, "PPP");
  assert.deepEqual(result.state.archives.find((archive) => archive.id === "ARC-PPP-SECOND").orders, []);
});
