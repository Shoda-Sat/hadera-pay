import assert from "node:assert/strict";
import test from "node:test";

import {
  galaxyOpenOrderCleanupTargets,
  removeGalaxySpecifiedOpenOrders,
} from "../src/galaxyOrderCleanup.mjs";

function order(id, journal, broker, agent, overrides = {}) {
  return {
    id,
    internalOrderId: id,
    journal,
    broker,
    agent,
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 1_000_000,
    state: "Paid",
    ...overrides,
  };
}

function orderLines(orderId, journal, broker, agent, archived = false) {
  return [
    { orderId, journal, source: "ORDER_PAYMENT", account: `${broker} ACTOR_CLEARING`, direction: "Debit", currency: "USD", amountMinor: 10_000, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "USD", amountMinor: 10_000, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ETB", amountMinor: 1_000_000, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: `${agent} ACTOR_CLEARING`, direction: "Credit", currency: "ETB", amountMinor: 1_000_000, archived },
  ];
}

test("Galaxy repair list exactly matches the approved journals and Actors", () => {
  assert.deepEqual(galaxyOpenOrderCleanupTargets, [
    { journal: "JRN-2131 (1)", actors: ["Goitom"] },
    { journal: "JRN-2063 (1)", actors: ["Goitom", "Nahom"] },
    { journal: "JRN-1739 (1)", actors: ["Goitom", "Nahom"] },
    { journal: "JRN-1648 (1)", actors: ["Goitom", "Kampala"] },
    { journal: "JRN-1580 (3)", actors: ["Goitom"] },
    { journal: "JRN-1580 (1)", actors: ["Goitom"] },
    { journal: "JRN-1868 (1)", actors: ["PPP", "Nahom"] },
    { journal: "JRN-2041 (1)", actors: ["PPP", "Walta"] },
    { journal: "JRN-2062 (1)", actors: ["PPP", "Dekemhare"] },
    { journal: "JRN-1555 (1)", actors: ["Gbxi"] },
    { journal: "JRN-1649 (1)", actors: ["Grmay", "Kampala"] },
    { journal: "JRN-1251 (2)", actors: ["Habtom"] },
    { journal: "JRN-1251 (1)", actors: ["Habtom"] },
    { journal: "JRN-1252 (2)", actors: ["Habtom"] },
    { journal: "JRN-1252 (1)", actors: ["Habtom"] },
  ]);
});
test("removes only approved open Galaxy journals and rebuilds balances without changing reports", () => {
  const goitomDuplicate = order("ORD-GOITOM-DUP", "JRN-1648 (1)", "Goitom", "Kampala");
  const habtomDuplicate = order("ORD-HABTOM-DUP", "JRN-1251 (2)", "Habtom", "Remote Payer");
  const wrongActor = order("ORD-WRONG-ACTOR", "JRN-1555 (1)", "Else", "Remote Payer", {
    sourceAmountMinor: 500,
    payoutAmountMinor: 50_000,
  });
  const closedDuplicate = order("ORD-CLOSED", "JRN-2063 (1)", "Goitom", "Nahom");
  const state = {
    actors: [
      { id: "ACT-MASTER", name: "Master", role: "Master", currency: "USD" },
      { id: "ACT-GOITOM", name: "Goitom", role: "Broker", currency: "USD" },
      { id: "ACT-KAMPALA", name: "Kampala", role: "Agent", currency: "ETB" },
      { id: "ACT-HABTOM", name: "Habtom", role: "Broker", currency: "USD" },
      { id: "ACT-ELSE", name: "Else", role: "Broker", currency: "USD" },
    ],
    orders: [goitomDuplicate, wrongActor],
    archives: [
      { id: "ARC-HABTOM", actor: "Habtom", orders: [habtomDuplicate], ledger: [] },
      { id: "ARC-CLOSED", actor: "Goitom", orders: [closedDuplicate], ledger: orderLines("ORD-CLOSED", "JRN-2063 (1)", "Goitom", "Nahom", true) },
    ],
    ledger: [
      ...orderLines("ORD-GOITOM-DUP", "JRN-1648 (1)", "Goitom", "Kampala"),
      ...orderLines("ORD-HABTOM-DUP", "JRN-1251 (2)", "Habtom", "Remote Payer"),
      ...orderLines("ORD-CLOSED", "JRN-2063 (1)", "Goitom", "Nahom", true),
      { orderId: "ORD-WRONG-ACTOR", journal: "JRN-1555 (1)", source: "ORDER_PAYMENT", account: "Else ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 500 },
      { orderId: "ORD-WRONG-ACTOR", journal: "JRN-1555 (1)", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "USD", amountMinor: 500 },
      { journal: "JRN-MANUAL", source: "JOURNAL", account: "Goitom ACTOR_CLEARING", direction: "Credit", currency: "USD", amountMinor: 100 },
    ],
    receivables: [
      { id: "REC-GOITOM", orderId: "ORD-GOITOM-DUP", journal: "JRN-1648 (1)" },
      { id: "REC-HABTOM-CLOSED", orderId: "ORD-HABTOM-DUP", journal: "JRN-1251 (2)", archivedAt: "2026-08-19T10:00:00.000Z" },
    ],
    settlements: [{ actor: "Goitom", currency: "USD", netMinor: 9_900 }],
    deletedOrderIds: [],
  };
  const reportsBefore = structuredClone(state.archives);

  const result = removeGalaxySpecifiedOpenOrders(state, "Galaxy Workspace");

  assert.equal(result.removedCount, 1);
  assert.equal(result.removedLedgerLineCount, 8);
  assert.equal(result.removedReceivableCount, 1);
  assert.deepEqual(result.journals, ["JRN-1648 (1)", "JRN-1251 (2)"]);
  assert.deepEqual(new Set(result.removedOrderIds), new Set(["ORD-GOITOM-DUP", "ORD-HABTOM-DUP"]));
  assert.deepEqual(state.archives, reportsBefore);
  assert.deepEqual(state.orders.map((item) => item.id), ["ORD-WRONG-ACTOR"]);
  assert.equal(state.ledger.filter((line) => line.journal === "JRN-2063 (1)").length, 4, "Archived closed-order rows remain.");
  assert.equal(state.ledger.filter((line) => line.journal === "JRN-1555 (1)").length, 2, "A listed journal with the wrong Actor is not removed.");
  assert.deepEqual(state.receivables.map((item) => item.id), ["REC-HABTOM-CLOSED"]);
  assert.deepEqual(state.settlements, [
    { actor: "Goitom", currency: "USD", netMinor: -100 },
    { actor: "Kampala", currency: "ETB", netMinor: 0 },
    { actor: "Habtom", currency: "USD", netMinor: 0 },
    { actor: "Else", currency: "USD", netMinor: 500 },
  ]);
});

test("same journal data outside Galaxy Workspace is never changed", () => {
  const duplicate = order("ORD-OTHER-WORKSPACE", "JRN-2131 (1)", "Goitom", "Kampala");
  const state = {
    actors: [],
    orders: [duplicate],
    archives: [],
    ledger: orderLines(duplicate.id, duplicate.journal, duplicate.broker, duplicate.agent),
    receivables: [],
    settlements: [],
  };
  const before = structuredClone(state);

  assert.equal(removeGalaxySpecifiedOpenOrders(state, "Another Workspace").removedCount, 0);
  assert.deepEqual(state, before);
});

test("a shared hidden ID does not remove the canonical base journal", () => {
  const targeted = order("ORD-SHARED", "JRN-1868 (1)", "PPP", "Nahom");
  const canonical = order("ORD-SHARED", "JRN-1868", "PPP", "Nahom");
  const state = {
    actors: [
      { name: "PPP", role: "Broker", currency: "USD" },
      { name: "Nahom", role: "Agent", currency: "ETB" },
    ],
    orders: [targeted],
    archives: [{ id: "ARC-CANONICAL", actor: "PPP", orders: [canonical] }],
    ledger: [
      ...orderLines("ORD-SHARED", "JRN-1868 (1)", "PPP", "Nahom"),
      ...orderLines("ORD-SHARED", "JRN-1868", "PPP", "Nahom"),
    ],
    receivables: [{ id: "REC-TARGET", orderId: "ORD-SHARED", journal: "JRN-1868 (1)" }],
    settlements: [],
    deletedOrderIds: [],
  };
  const reportsBefore = structuredClone(state.archives);

  const result = removeGalaxySpecifiedOpenOrders(state, "Galaxy Workspace");

  assert.equal(result.removedLedgerLineCount, 4);
  assert.deepEqual(result.removedOrderIds, [], "The canonical order ID is protected from a tombstone.");
  assert.equal(state.ledger.length, 4);
  assert.equal(state.ledger.every((line) => line.journal === "JRN-1868"), true);
  assert.deepEqual(state.archives, reportsBefore);
  assert.deepEqual(state.settlements, [
    { actor: "PPP", currency: "USD", netMinor: 10_000 },
    { actor: "Nahom", currency: "ETB", netMinor: -1_000_000 },
  ]);
});
