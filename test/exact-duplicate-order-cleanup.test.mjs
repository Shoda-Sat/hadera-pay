import assert from "node:assert/strict";
import test from "node:test";

import { removeExactDuplicateOrders } from "../src/exactDuplicateOrderCleanup.mjs";

function paidOrder(id, journal, overrides = {}) {
  return {
    id,
    internalOrderId: id,
    brokerActorId: "ACT-NAHOM",
    broker: "Nahom",
    agentActorId: "ACT-PAYER",
    agent: "Payer",
    senderName: "Sender One",
    receiverName: "Receiver One",
    receiverCity: "Addis Ababa",
    accountNumber: "100200300",
    phoneNumber: "0911000000",
    remarks: "Family support",
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 1_000_000,
    rate: 100,
    commissionPercent: 2,
    commissionMinor: 200,
    orderCommissionLiability: "Broker",
    grossMinor: 10_200,
    fundingType: "cash",
    state: "Paid",
    journal,
    paidAt: "2026-08-16T09:00:00.000Z",
    ...overrides,
  };
}

function paymentLines(orderId, journal, archived = false) {
  return [
    { orderId, journal, source: "ORDER_PAYMENT", account: "Nahom ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 10_000, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: "Nahom ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 200, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "USD", amountMinor: 10_000, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: "MASTER_FEE_REVENUE", direction: "Credit", currency: "USD", amountMinor: 200, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ETB", amountMinor: 1_000_000, archived },
    { orderId, journal, source: "ORDER_PAYMENT", account: "Payer ACTOR_CLEARING", direction: "Credit", currency: "ETB", amountMinor: 1_000_000, archived },
  ];
}

test("removes exact (1) duplicate effects, rebuilds balances, and preserves closed reports", () => {
  const original = paidOrder("ORD-BASE", "JRN-1552", { paidAt: "2026-08-16T08:00:00.000Z" });
  const duplicate = paidOrder("ORD-DUP", "JRN-1552 (1)", {
    collisionSourceOrderId: "ORD-BASE",
    paidAt: "2026-08-16T09:00:00.000Z",
  });
  const different = paidOrder("ORD-DIFFERENT", "JRN-2000 (1)", {
    sourceAmountMinor: 20_000,
    grossMinor: 20_200,
  });
  const state = {
    actors: [
      { id: "ACT-MASTER", name: "Master", role: "Master", currency: "USD" },
      { id: "ACT-NAHOM", name: "Nahom", role: "Broker", currency: "USD" },
      { id: "ACT-PAYER", name: "Payer", role: "Agent", currency: "ETB" },
    ],
    orders: [duplicate, different],
    archives: [
      { id: "ARC-BASE", actor: "Nahom", orders: [original], ledger: paymentLines("ORD-BASE", "JRN-1552", true) },
      { id: "ARC-DUP", actor: "Payer", orders: [structuredClone(duplicate)], ledger: paymentLines("ORD-DUP", "JRN-1552 (1)", true) },
    ],
    ledger: [
      ...paymentLines("ORD-BASE", "JRN-1552"),
      ...paymentLines("ORD-DUP", "JRN-1552 (1)"),
      { ...paymentLines("ORD-DUP", "JRN-1552 (1)", true)[0], details: "Closed snapshot reference" },
      { journal: "JRN-3000", source: "JOURNAL", account: "Nahom ACTOR_CLEARING", direction: "Credit", currency: "USD", amountMinor: 100 },
    ],
    receivables: [
      { id: "REC-DUP", orderId: "ORD-DUP", journal: "JRN-1552 (1)" },
      { id: "REC-DUP-CLOSED", orderId: "ORD-DUP", journal: "JRN-1552 (1)", archivedAt: "2026-08-18T00:00:00.000Z" },
    ],
    settlements: [
      { actor: "Nahom", currency: "USD", netMinor: 20_300 },
      { actor: "Payer", currency: "ETB", netMinor: -2_000_000 },
    ],
    deletedOrderIds: [],
  };
  const closedReportsBefore = structuredClone(state.archives);

  const result = removeExactDuplicateOrders(state);

  assert.equal(result.removedCount, 1);
  assert.equal(result.removedLedgerLineCount, 6);
  assert.equal(result.removedReceivableCount, 1);
  assert.deepEqual(result.duplicateJournals, ["JRN-1552 (1)"]);
  assert.deepEqual(result.removedOrderIds, ["ORD-DUP"]);
  assert.deepEqual(state.archives, closedReportsBefore);
  assert.deepEqual(state.orders.map((order) => order.id), ["ORD-DIFFERENT"]);
  assert.equal(state.ledger.filter((line) => line.journal === "JRN-1552 (1)").length, 1, "Archived active-store evidence is retained.");
  assert.equal(state.ledger.some((line) => line.orderId === "ORD-BASE"), true, "The canonical order ledger remains.");
  assert.deepEqual(state.receivables.map((item) => item.id), ["REC-DUP-CLOSED"]);
  assert.deepEqual(state.deletedOrderIds, ["ORD-DUP"]);
  assert.deepEqual(state.settlements, [
    { actor: "Nahom", currency: "USD", netMinor: 10_100 },
    { actor: "Payer", currency: "ETB", netMinor: -1_000_000 },
  ]);

  assert.deepEqual(removeExactDuplicateOrders(state), {
    removedCount: 0,
    removedLedgerLineCount: 0,
    removedReceivableCount: 0,
    removedOrderIds: [],
    duplicateJournals: [],
  });
  assert.deepEqual(state.archives, closedReportsBefore);
});

test("does not remove a (1) order when any order detail or amount differs", () => {
  const original = paidOrder("ORD-BASE", "JRN-1700");
  const differentAmount = paidOrder("ORD-AMOUNT", "JRN-1700 (1)", { payoutAmountMinor: 999_999 });
  const differentDetails = paidOrder("ORD-DETAIL", "JRN-1800 (1)", { receiverName: "Another Receiver" });
  const state = {
    actors: [],
    orders: [original, differentAmount, differentDetails, paidOrder("ORD-OTHER-BASE", "JRN-1800")],
    archives: [],
    ledger: [
      ...paymentLines("ORD-AMOUNT", "JRN-1700 (1)"),
      ...paymentLines("ORD-DETAIL", "JRN-1800 (1)"),
    ],
    receivables: [],
    settlements: [],
  };
  const before = structuredClone(state);

  assert.equal(removeExactDuplicateOrders(state).removedCount, 0);
  assert.deepEqual(state, before);
});

test("cleans an open ledger duplicate recoverable only from immutable reports", () => {
  const original = paidOrder("ORD-BASE", "JRN-1900");
  const duplicate = paidOrder("ORD-HISTORIC-DUP", "JRN-1900 (1)");
  const state = {
    actors: [
      { id: "ACT-NAHOM", name: "Nahom", role: "Broker", currency: "USD" },
      { id: "ACT-PAYER", name: "Payer", role: "Agent", currency: "ETB" },
    ],
    orders: [],
    archives: [
      { id: "ARC-ONE", actor: "Nahom", orders: [original] },
      { id: "ARC-TWO", actor: "Payer", orders: [duplicate] },
    ],
    ledger: paymentLines("ORD-HISTORIC-DUP", "JRN-1900 (1)"),
    receivables: [],
    settlements: [],
  };
  const reportsBefore = structuredClone(state.archives);

  const result = removeExactDuplicateOrders(state);

  assert.equal(result.removedCount, 0);
  assert.equal(result.removedLedgerLineCount, 6);
  assert.deepEqual(state.deletedOrderIds, ["ORD-HISTORIC-DUP"]);
  assert.deepEqual(state.archives, reportsBefore);
  assert.deepEqual(state.settlements, [
    { actor: "Nahom", currency: "USD", netMinor: 0 },
    { actor: "Payer", currency: "ETB", netMinor: 0 },
  ]);
});

test("a deleted duplicate ID prevents stale devices from restoring its open accounting", () => {
  const state = {
    actors: [
      { id: "ACT-NAHOM", name: "Nahom", role: "Broker", currency: "USD" },
      { id: "ACT-PAYER", name: "Payer", role: "Agent", currency: "ETB" },
    ],
    orders: [],
    archives: [{ id: "ARC-CLOSED", actor: "Nahom", orders: [] }],
    ledger: paymentLines("ORD-DUP", "JRN-1552 (1)"),
    receivables: [{ id: "REC-DUP", orderId: "ORD-DUP", journal: "JRN-1552 (1)" }],
    settlements: [
      { actor: "Nahom", currency: "USD", netMinor: 10_200 },
      { actor: "Payer", currency: "ETB", netMinor: -1_000_000 },
    ],
    deletedOrderIds: ["ORD-DUP"],
  };
  const reportsBefore = structuredClone(state.archives);

  const result = removeExactDuplicateOrders(state);

  assert.equal(result.removedCount, 0);
  assert.equal(result.removedLedgerLineCount, 6);
  assert.equal(result.removedReceivableCount, 1);
  assert.deepEqual(state.archives, reportsBefore);
  assert.deepEqual(state.settlements, [
    { actor: "Nahom", currency: "USD", netMinor: 0 },
    { actor: "Payer", currency: "ETB", netMinor: 0 },
  ]);
});
