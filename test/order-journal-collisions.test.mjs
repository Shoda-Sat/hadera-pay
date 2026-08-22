import assert from "node:assert/strict";
import test from "node:test";

import { repairOrderJournalCollisions } from "../src/orderJournalCollisions.mjs";

function order(id, journal, createdAt, overrides = {}) {
  return {
    id,
    internalOrderId: id,
    brokerActorId: `ACT-${id}`,
    broker: `Broker ${id}`,
    brokerOrderNumber: id,
    agentActorId: "ACT-PAYER",
    agent: "Payer",
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 1_000_000,
    state: "Paid",
    journal,
    createdAt,
    paidAt: createdAt,
    ...overrides,
  };
}

test("repairs a distinct duplicate order journal and rewrites only its linked records", () => {
  const first = order("ORD-FIRST", "JRN-1552", "2026-08-16T08:00:00.000Z");
  const duplicate = order("ORD-NAHOM", "JRN-1552", "2026-08-16T09:00:00.000Z");
  const state = {
    orders: [duplicate],
    archives: [{
      id: "ARC-FIRST",
      actor: "Broker ORD-FIRST",
      orders: [first],
      receivables: [],
      ledger: [],
    }],
    receivables: [{ id: "REC-NAHOM", orderId: "ORD-NAHOM", journal: "JRN-1552" }],
    ledger: [
      { source: "ORDER_PAYMENT", journal: "JRN-1552", orderId: "ORD-FIRST", account: "Broker ORD-FIRST ACTOR_CLEARING" },
      { source: "ORDER_PAYMENT", journal: "JRN-1552", orderId: "ORD-NAHOM", account: "Payer ACTOR_CLEARING" },
    ],
  };

  const result = repairOrderJournalCollisions(state);

  assert.deepEqual(result.repairs, [{ from: "JRN-1552", to: "JRN-1552 (1)", records: 3 }]);
  assert.equal(state.archives[0].orders[0].journal, "JRN-1552");
  assert.equal(state.orders[0].journal, "JRN-1552 (1)");
  assert.equal(state.receivables[0].journal, "JRN-1552 (1)");
  assert.equal(state.ledger[0].journal, "JRN-1552");
  assert.equal(state.ledger[1].journal, "JRN-1552 (1)");
});

test("does not rewrite conflicting copies that have one hidden order ID", () => {
  const original = order("ORD-ONE", "JRN-1552", "2026-08-16T08:00:00.000Z");
  const state = {
    orders: [],
    archives: [
      { id: "ARC-ONE", actor: "First", orders: [original] },
      { id: "ARC-TWO", actor: "Second", orders: [{ ...original, payoutAmountMinor: 9_999_999 }] },
    ],
    ledger: [],
  };

  const result = repairOrderJournalCollisions(state);

  assert.equal(result.repairedCount, 0);
  assert.equal(state.archives[1].orders[0].journal, "JRN-1552");
});

test("keeps a renamed void journal linked to its exact reversal rows", () => {
  const original = order("ORD-ORIGINAL", "JRN-COLLIDE", "2026-08-16T08:00:00.000Z");
  const voided = order("ORD-VOIDED", "JRN-VOIDED-PAYMENT", "2026-08-16T09:00:00.000Z", {
    state: "Voided",
    voidJournal: "JRN-COLLIDE",
    voidedAt: "2026-08-16T10:00:00.000Z",
  });
  const state = {
    orders: [original, voided],
    archives: [],
    receivables: [{ id: "REC-VOIDED", orderId: voided.id, voidJournal: "JRN-COLLIDE" }],
    ledger: [
      { source: "ORDER_PAYMENT", journal: "JRN-COLLIDE", orderId: original.id, direction: "Debit", currency: "USD", amountMinor: 10_000 },
      { source: "ORDER_PAYMENT", journal: "JRN-VOIDED-PAYMENT", orderId: voided.id, direction: "Debit", currency: "USD", amountMinor: 10_000 },
      { source: "ORDER_VOID", journal: "JRN-COLLIDE", orderId: voided.id, direction: "Credit", currency: "USD", amountMinor: 10_000 },
    ],
  };
  const financialBefore = state.ledger.map(({ direction, currency, amountMinor }) => ({ direction, currency, amountMinor }));

  const result = repairOrderJournalCollisions(state);

  assert.equal(result.repairedCount, 1);
  assert.equal(original.journal, "JRN-COLLIDE");
  assert.equal(voided.journal, "JRN-VOIDED-PAYMENT");
  assert.equal(voided.voidJournal, "JRN-COLLIDE (1)");
  assert.equal(state.receivables[0].voidJournal, "JRN-COLLIDE (1)");
  assert.equal(state.ledger.find((line) => line.source === "ORDER_PAYMENT" && line.orderId === original.id).journal, "JRN-COLLIDE");
  assert.equal(state.ledger.find((line) => line.source === "ORDER_VOID" && line.orderId === voided.id).journal, "JRN-COLLIDE (1)");
  assert.deepEqual(
    state.ledger.map(({ direction, currency, amountMinor }) => ({ direction, currency, amountMinor })),
    financialBefore,
    "Journal repair must not change any balance-affecting field.",
  );
});
