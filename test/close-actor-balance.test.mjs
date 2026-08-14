import assert from "node:assert/strict";
import test from "node:test";

import { closeActorBalance } from "../src/closeActorBalance.mjs";

const closedAt = "2026-08-13T18:00:00.000Z";

function baseState() {
  return {
    actors: [
      { id: "ACT-0", name: "Master", role: "Master", currency: "USD", active: true },
      { id: "ACT-PPP", name: "PPP", role: "Broker", currency: "EUR", active: true, numberingCycle: 0 },
      { id: "ACT-WALTA", name: "Walta", role: "Agent", currency: "ETB", active: true, numberingCycle: 0 },
      { id: "ACT-OTHER", name: "Other", role: "Broker", currency: "USD", active: true, numberingCycle: 0 },
    ],
    orders: [],
    archives: [],
    ledger: [],
    transfers: [],
    receivables: [],
    settlements: [
      { actor: "PPP", currency: "EUR", netMinor: 0 },
      { actor: "Walta", currency: "ETB", netMinor: 0 },
      { actor: "Other", currency: "USD", netMinor: 0 },
    ],
    journalCounter: 0,
    unrelated: { keep: true },
  };
}

function cancelledOrder(overrides = {}) {
  return {
    id: "ORD-CANCELLED",
    brokerOrderNumber: "PPP360",
    brokerActorId: "ACT-PPP",
    broker: "PPP",
    agentActorId: "",
    agent: "Cancelled",
    senderName: "Sender",
    receiverName: "Receiver",
    sourceCurrency: "EUR",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 1_970_000,
    state: "Cancelled",
    createdAt: "2026-08-13T16:00:00.000Z",
    cancelledAt: "2026-08-13T16:05:00.000Z",
    cancelledBy: "PPP",
    updatedAt: "2026-08-13T16:05:00.000Z",
    incomeProfitMinor: 999_999,
    ...overrides,
  };
}

function paidOrder(overrides = {}) {
  return {
    id: "ORD-PAID",
    internalOrderId: "ORD-PAID",
    brokerOrderNumber: "PPP359",
    brokerActorId: "ACT-PPP",
    agentOrderNumber: "0494_PPP359",
    agentOrderNumbers: { Walta: "0494_PPP359" },
    agentActorId: "ACT-WALTA",
    broker: "PPP",
    agent: "Walta",
    sourceCurrency: "EUR",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 1_970_000,
    state: "Paid",
    journal: "JRN-1826",
    paidAt: "2026-08-13T15:40:01.000Z",
    createdAt: "2026-08-13T15:30:01.000Z",
    incomeBaseAmountMinor: 1_000,
    incomeCollectedUsdMinor: 1_321,
    incomeProfitMinor: 321,
    ...overrides,
  };
}

function paidLedger() {
  return [
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "EUR", amountMinor: 10_000, postedAt: "2026-08-13T15:40:01.000Z" },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "EUR", amountMinor: 10_000, postedAt: "2026-08-13T15:40:01.000Z" },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ETB", amountMinor: 1_970_000, postedAt: "2026-08-13T15:40:01.000Z" },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "Walta ACTOR_CLEARING", direction: "Credit", currency: "ETB", amountMinor: 1_970_000, postedAt: "2026-08-13T15:40:01.000Z" },
  ];
}

test("include policy closes a cancellation-only period without changing accounting", () => {
  const state = baseState();
  state.orders = [
    cancelledOrder(),
    cancelledOrder({ id: "ORD-CONFLICT", brokerActorId: "ACT-OTHER", brokerOrderNumber: "OTH001" }),
  ];
  const before = structuredClone(state);

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    actorName: "PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-PPP-CANCELLED",
  });

  assert.deepEqual(state, before, "The input state must remain untouched.");
  assert.deepEqual({
    closed: result.closed,
    actorName: result.actorName,
    archiveId: result.archiveId,
    cancelledOrderCount: result.cancelledOrderCount,
    includedCancelledOrderCount: result.includedCancelledOrderCount,
    omittedCancelledOrderCount: result.omittedCancelledOrderCount,
  }, {
    closed: true,
    actorName: "PPP",
    archiveId: "ARC-PPP-CANCELLED",
    cancelledOrderCount: 1,
    includedCancelledOrderCount: 1,
    omittedCancelledOrderCount: 0,
  });
  assert.deepEqual(result.state.orders.map((order) => order.id), ["ORD-CONFLICT"], "A conflicting stable Broker ID must beat the reused name.");
  const archive = result.state.archives[0];
  assert.equal(archive.orders.length, 1);
  assert.equal(archive.orders[0].state, "Cancelled");
  assert.equal(archive.orders[0].locked, true);
  assert.equal(archive.orders[0].excludedFromCalculations, true);
  assert.equal(archive.orders[0].cancelledBy, "PPP");
  assert.equal(archive.incomeProfitMinor, 0, "Cancelled data cannot contribute frozen profit.");
  assert.deepEqual(archive.balances, {});
  assert.deepEqual(result.state.ledger, before.ledger);
  assert.deepEqual(result.state.settlements, before.settlements);
  assert.deepEqual(result.state.receivables, before.receivables);
  assert.equal(result.state.journalCounter, before.journalCounter);
  assert.equal(result.state.actors.find((actor) => actor.id === "ACT-PPP").numberingCycle, 1);
  assert.deepEqual(result.state.deletedOrderIds, ["ORD-CANCELLED"]);
});

test("omit policy removes cancelled orders and records durable tombstones", () => {
  const state = baseState();
  state.deletedOrderIds = ["ORD-OLD", "ORD-OLD"];
  state.orders = [cancelledOrder()];
  const receivablesBefore = structuredClone(state.receivables);
  const settlementsBefore = structuredClone(state.settlements);

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "omit",
    closedAt,
    archiveId: "ARC-PPP-OMIT",
  });

  assert.equal(result.closed, true);
  assert.equal(result.cancelledOrderCount, 1);
  assert.equal(result.includedCancelledOrderCount, 0);
  assert.equal(result.omittedCancelledOrderCount, 1);
  assert.deepEqual(result.state.orders, []);
  assert.deepEqual(result.state.archives[0].orders, []);
  assert.deepEqual(result.state.deletedOrderIds, ["ORD-OLD", "ORD-CANCELLED"]);
  assert.equal(result.state.archives[0].incomeProfitMinor, 0);
  assert.deepEqual(result.state.receivables, receivablesBefore);
  assert.deepEqual(result.state.settlements, settlementsBefore);
  assert.equal(result.state.actors.find((actor) => actor.id === "ACT-PPP").numberingCycle, 1);
});

test("legacy cancelled orders may fall back to Broker name only when their stable ID is absent", () => {
  const state = baseState();
  state.orders = [
    cancelledOrder({ id: "ORD-OLD-ID", brokerActorId: "ACT-OLD-PPP" }),
    cancelledOrder({ id: "ORD-LEGACY", brokerActorId: "" }),
  ];

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    actorName: "PPP",
    cancelledOrderPolicy: "omit",
    closedAt,
    archiveId: "ARC-PPP-LEGACY",
  });

  assert.equal(result.cancelledOrderCount, 1);
  assert.deepEqual(result.state.orders.map((order) => order.id), ["ORD-OLD-ID"]);
  assert.deepEqual(result.state.deletedOrderIds, ["ORD-LEGACY"]);
});

test("a paid shared order closes once for each participant while a cancellation stays Broker-only", () => {
  const state = baseState();
  state.orders = [paidOrder(), cancelledOrder()];
  state.ledger = paidLedger();

  const brokerClose = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-PPP",
  });
  assert.equal(brokerClose.closed, true);
  assert.equal(brokerClose.state.archives[0].incomeProfitMinor, 321, "The frozen order profit must be used exactly.");
  assert.deepEqual(new Set(brokerClose.state.archives[0].orders.map((order) => order.id)), new Set(["ORD-PAID", "ORD-CANCELLED"]));
  assert.deepEqual(brokerClose.state.orders.map((order) => order.id), ["ORD-PAID"], "The shared paid order remains live for Walta until Walta closes.");
  assert.equal(brokerClose.state.archives[0].balances.EUR, 10_000);
  assert.equal(brokerClose.state.ledger.find((line) => line.account === "PPP ACTOR_CLEARING" && line.source === "ORDER_PAYMENT").archived, true);
  assert.equal(brokerClose.state.ledger.find((line) => line.account === "Walta ACTOR_CLEARING" && line.source === "ORDER_PAYMENT").archived, undefined);

  const payerClose = closeActorBalance(brokerClose.state, {
    actorId: "ACT-WALTA",
    cancelledOrderPolicy: "omit",
    closedAt: "2026-08-13T19:00:00.000Z",
    archiveId: "ARC-WALTA",
  });
  assert.equal(payerClose.closed, true);
  assert.equal(payerClose.cancelledOrderCount, 0);
  assert.equal(payerClose.state.archives[0].incomeProfitMinor, 321);
  assert.deepEqual(payerClose.state.archives[0].orders.map((order) => order.id), ["ORD-PAID"]);
  const reportedPaid = payerClose.state.archives.flatMap((archive) => archive.orders).filter((order) => order.id === "ORD-PAID");
  assert.equal(reportedPaid.length, 2);
  assert.deepEqual(new Set(reportedPaid.map((order) => order.actor)), new Set(["PPP", "Walta"]));
  assert.equal(payerClose.state.archives.flatMap((archive) => archive.orders).filter((order) => order.id === "ORD-CANCELLED").length, 1);

  const repeat = closeActorBalance(payerClose.state, {
    actorId: "ACT-WALTA",
    cancelledOrderPolicy: "omit",
    closedAt: "2026-08-13T20:00:00.000Z",
    archiveId: "ARC-WALTA-REPEAT",
  });
  assert.equal(repeat.closed, false);
  assert.equal(repeat.state.archives.length, payerClose.state.archives.length);
});

test("the second participant closes a journal-matched archived order after its hidden ID was remapped", () => {
  const state = baseState();
  state.archives = [{
    id: "ARC-PPP-FIRST",
    actor: "PPP",
    actorId: "ACT-PPP",
    actorRole: "Broker",
    closedAt,
    balances: { EUR: 10_000 },
    incomeProfitMinor: 321,
    orders: [paidOrder({
      id: "ORD-OLD-HIDDEN-ID",
      internalOrderId: "ORD-OLD-HIDDEN-ID",
      actor: "PPP",
      locked: true,
      archivedAt: closedAt,
    })],
    ledger: [],
    transfers: [],
    receivables: [],
  }];
  state.ledger = paidLedger().map((line) => ({
    ...line,
    orderId: line.account === "PPP ACTOR_CLEARING" ? "ORD-OLD-HIDDEN-ID" : "ORD-NEW-HIDDEN-ID",
    ...(line.account === "PPP ACTOR_CLEARING" ? { archived: true, closedAt } : {}),
  }));

  const result = closeActorBalance(state, {
    actorId: "ACT-WALTA",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-13T19:00:00.000Z",
    archiveId: "ARC-WALTA-SECOND",
  });

  assert.equal(result.closed, true);
  const payerArchive = result.state.archives.find((archive) => archive.id === "ARC-WALTA-SECOND");
  assert.equal(payerArchive.orders.length, 1);
  assert.equal(payerArchive.orders[0].journal, "JRN-1826");
  assert.equal(payerArchive.orders[0].actor, "Walta");
  assert.equal(payerArchive.orders[0].payerCurrency, "ETB");
  assert.equal(payerArchive.orders[0].payerAmountMinor, 1_970_000);
  assert.equal(payerArchive.balances.ETB, -1_970_000);
});

test("conflicting archived snapshots block the second participant close without touching accounting", () => {
  const state = baseState();
  const source = paidOrder({
    id: "ORD-OLD-HIDDEN-ID",
    internalOrderId: "ORD-OLD-HIDDEN-ID",
    actor: "PPP",
    locked: true,
    archivedAt: closedAt,
  });
  state.archives = [
    {
      id: "ARC-PPP-FIRST",
      actor: "PPP",
      actorId: "ACT-PPP",
      actorRole: "Broker",
      closedAt,
      balances: { EUR: 10_000 },
      incomeProfitMinor: 321,
      orders: [source],
    },
    {
      id: "ARC-CONFLICT",
      actor: "Other",
      actorId: "ACT-OTHER",
      actorRole: "Broker",
      closedAt,
      balances: {},
      incomeProfitMinor: 0,
      orders: [{ ...source, payoutAmountMinor: 9_999_999 }],
    },
  ];
  state.ledger = paidLedger().map((line) => ({
    ...line,
    orderId: line.account === "PPP ACTOR_CLEARING" ? "ORD-OLD-HIDDEN-ID" : "ORD-NEW-HIDDEN-ID",
    ...(line.account === "PPP ACTOR_CLEARING" ? { archived: true, closedAt } : {}),
  }));
  const before = structuredClone(state);

  const result = closeActorBalance(state, {
    actorId: "ACT-WALTA",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-13T19:00:00.000Z",
    archiveId: "ARC-WALTA-BLOCKED",
  });

  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-1826.*conflicting archived records/i);
  assert.deepEqual(result.state, before);
  assert.deepEqual(state, before);
});

test("a recreated same-name Actor cannot inherit an old participant's payment balance", () => {
  const state = baseState();
  state.actors = state.actors.map((actor) =>
    actor.id === "ACT-WALTA" ? { ...actor, id: "ACT-WALTA-NEW" } : actor
  );
  state.archives = [{
    id: "ARC-PPP-FIRST",
    actor: "PPP",
    actorId: "ACT-PPP",
    actorRole: "Broker",
    closedAt,
    balances: { EUR: 10_000 },
    incomeProfitMinor: 321,
    orders: [paidOrder({
      agentActorId: "ACT-WALTA-OLD",
      actor: "PPP",
      locked: true,
      archivedAt: closedAt,
    })],
  }];
  state.ledger = paidLedger().map((line) => ({
    ...line,
    ...(line.account === "PPP ACTOR_CLEARING" ? { archived: true, closedAt } : {}),
  }));
  const before = structuredClone(state);

  const result = closeActorBalance(state, {
    actorId: "ACT-WALTA-NEW",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-13T19:00:00.000Z",
    archiveId: "ARC-WALTA-NEW-BLOCKED",
  });

  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-1826.*Actor identity conflict/i);
  assert.deepEqual(result.state, before);
  assert.deepEqual(state, before);
});

test("an Actor payment without any recoverable order record blocks balance closure", () => {
  const state = baseState();
  state.ledger = [{
    journal: "JRN-MISSING",
    orderId: "ORD-MISSING",
    source: "ORDER_PAYMENT",
    account: "Walta ACTOR_CLEARING",
    direction: "Credit",
    currency: "ETB",
    amountMinor: 500,
  }];
  const before = structuredClone(state);

  const result = closeActorBalance(state, {
    actorId: "ACT-WALTA",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-13T19:00:00.000Z",
    archiveId: "ARC-WALTA-MISSING-BLOCKED",
  });

  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-MISSING.*no recoverable order record/i);
  assert.deepEqual(result.state, before);
  assert.deepEqual(state, before);
});

test("legacy USD paid orders calculate missing profit from ledger, commission, and USD Agent settings", () => {
  const state = baseState();
  Object.assign(state.actors.find((actor) => actor.id === "ACT-PPP"), { currency: "USD" });
  Object.assign(state.actors.find((actor) => actor.id === "ACT-WALTA"), {
    currency: "USD",
    incomeUsdPayoutSetting: { divider: 2, percent: 10 },
  });
  state.orders = [paidOrder({
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "USD",
    payoutAmountMinor: 8_000,
    commissionPercent: 5,
    commissionMinor: 500,
    incomeBaseAmountMinor: 123,
    incomeCollectedUsdMinor: 456,
    incomeProfitMinor: undefined,
  })];
  state.ledger = [
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 10_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 500 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "USD", amountMinor: 10_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FEE_REVENUE", direction: "Credit", currency: "USD", amountMinor: 500 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "USD", amountMinor: 8_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "Walta ACTOR_CLEARING", direction: "Credit", currency: "USD", amountMinor: 8_000 },
  ];

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-LEGACY-USD",
  });

  assert.equal(result.closed, true);
  assert.equal(result.state.archives[0].incomeProfitMinor, 6_100, "USD 105 collected minus the configured USD 44 Agent base must be USD 61 profit.");

  const payerClose = closeActorBalance(result.state, {
    actorId: "ACT-WALTA",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-13T19:00:00.000Z",
    archiveId: "ARC-LEGACY-USD-PAYER",
  });
  assert.equal(payerClose.closed, true);
  assert.equal(payerClose.state.archives[0].incomeProfitMinor, 6_100, "The same fallback must work from the first participant's archived order and partially archived journal.");
});

test("legacy EUR paid orders calculate buying profit from normalized workspace rates", () => {
  const state = baseState();
  state.buyingRates = { eurToUsd: 1.2, usdToEtb: 197 };
  state.orders = [paidOrder({
    payoutAmountMinor: 19_700,
    commissionPercent: 0,
    commissionMinor: 0,
    incomeBaseAmountMinor: undefined,
    incomeCollectedUsdMinor: undefined,
    incomeProfitMinor: undefined,
  })];
  state.ledger = paidLedger().map((line) =>
    line.currency === "ETB" ? { ...line, amountMinor: 19_700 } : line
  );

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-LEGACY-EUR",
  });

  assert.equal(result.closed, true);
  assert.equal(result.state.archives[0].incomeProfitMinor, 2_000, "EUR 100 bought at USD 1.20 and paid as USD 100 must retain USD 20 profit.");
});

test("legacy local-currency payouts use the workspace Master divider fallback", () => {
  const state = baseState();
  Object.assign(state.actors.find((actor) => actor.id === "ACT-PPP"), { currency: "USD" });
  state.masterRateDivisorSettings = { ETB: { enabled: true, divider: 197, percent: 0 } };
  state.orders = [paidOrder({
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 15_760,
    commissionPercent: 0,
    commissionMinor: 0,
    incomeBaseAmountMinor: undefined,
    incomeCollectedUsdMinor: undefined,
    incomeProfitMinor: undefined,
  })];
  state.ledger = [
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 10_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "USD", amountMinor: 10_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ETB", amountMinor: 15_760 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "Walta ACTOR_CLEARING", direction: "Credit", currency: "ETB", amountMinor: 15_760 },
  ];

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-LEGACY-DIVIDER",
  });

  assert.equal(result.closed, true);
  assert.equal(result.state.archives[0].incomeProfitMinor, 2_000, "USD 100 collected minus an ETB payout valued at USD 80 must be USD 20 profit.");
});

test("an explicit frozen zero profit wins over the legacy calculation fallback", () => {
  const state = baseState();
  Object.assign(state.actors.find((actor) => actor.id === "ACT-PPP"), { currency: "USD" });
  state.orders = [paidOrder({
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "USD",
    payoutAmountMinor: 8_000,
    incomeBaseAmountMinor: undefined,
    incomeCollectedUsdMinor: undefined,
    incomeProfitMinor: 0,
  })];
  state.ledger = [
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 10_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "USD", amountMinor: 10_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "USD", amountMinor: 8_000 },
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "Walta ACTOR_CLEARING", direction: "Credit", currency: "USD", amountMinor: 8_000 },
  ];

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-FROZEN-ZERO",
  });
  assert.equal(result.state.archives[0].incomeProfitMinor, 0);
});

test("malformed legacy income inputs block close instead of silently recording zero", () => {
  const state = baseState();
  state.orders = [paidOrder({
    sourceCurrency: "USD",
    sourceAmountMinor: "not-a-number",
    payoutCurrency: "USD",
    payoutAmountMinor: 8_000,
    incomeBaseAmountMinor: undefined,
    incomeCollectedUsdMinor: undefined,
    incomeProfitMinor: undefined,
  })];
  state.ledger = [
    { journal: "JRN-1826", orderId: "ORD-PAID", source: "ORDER_PAYMENT", account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 10_000 },
  ];
  const before = structuredClone(state);

  assert.throws(() => closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-MALFORMED-INCOME",
  }), /Income profit could not be calculated safely/);
  assert.deepEqual(state, before);
});

test("shared paid orders also survive the reverse participant close order", () => {
  const state = baseState();
  state.orders = [paidOrder(), cancelledOrder()];
  state.ledger = paidLedger();

  const payerFirst = closeActorBalance(state, {
    actorId: "ACT-WALTA",
    cancelledOrderPolicy: "omit",
    closedAt,
    archiveId: "ARC-WALTA-FIRST",
  });
  assert.equal(payerFirst.closed, true);
  assert.deepEqual(payerFirst.state.archives[0].orders.map((order) => order.id), ["ORD-PAID"]);
  assert.deepEqual(payerFirst.state.orders.map((order) => order.id), ["ORD-PAID", "ORD-CANCELLED"], "PPP must retain the paid order after Walta closes first.");

  const brokerSecond = closeActorBalance(payerFirst.state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "omit",
    closedAt: "2026-08-13T19:00:00.000Z",
    archiveId: "ARC-PPP-SECOND",
  });
  assert.equal(brokerSecond.closed, true);
  assert.deepEqual(brokerSecond.state.archives[0].orders.map((order) => order.id), ["ORD-PAID"]);
  assert.deepEqual(brokerSecond.state.orders, []);
  assert.deepEqual(brokerSecond.state.deletedOrderIds, ["ORD-CANCELLED"]);
  const paidReports = brokerSecond.state.archives.flatMap((archive) => archive.orders).filter((order) => order.id === "ORD-PAID");
  assert.equal(paidReports.length, 2);
  assert.deepEqual(new Set(paidReports.map((order) => order.actor)), new Set(["PPP", "Walta"]));
});

test("include and omit policies have identical financial effects, and voided amounts stay excluded", () => {
  const state = baseState();
  state.orders = [
    cancelledOrder({ journal: "JRN-LEGACY-CANCELLED" }),
    paidOrder({
      id: "ORD-VOIDED",
      internalOrderId: "ORD-VOIDED",
      brokerOrderNumber: "PPP358",
      state: "Voided",
      voidJournal: "JRN-1827",
      voidedAt: "2026-08-13T17:00:00.000Z",
      incomeProfitMinor: 77_777,
    }),
  ];
  state.ledger = paidLedger().map((line) => ({
    ...line,
    orderId: "ORD-VOIDED",
    voided: true,
    excludedFromCalculations: true,
  }));
  state.ledger.push({
    journal: "JRN-LEGACY-CANCELLED",
    orderId: "ORD-CANCELLED",
    source: "ORDER_PAYMENT",
    account: "PPP ACTOR_CLEARING",
    direction: "Debit",
    currency: "EUR",
    amountMinor: 10_000,
    postedAt: "2026-08-13T16:05:00.000Z",
    excludedFromCalculations: true,
  });
  state.receivables = [{
    id: "REC-OPEN",
    orderId: "ORD-CANCELLED",
    borrower: "PPP",
    borrowerActorId: "ACT-PPP",
    currency: "EUR",
    principalMinor: 10_000,
    payments: [],
  }];

  const include = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
    archiveId: "ARC-INCLUDE",
  });
  const omit = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "omit",
    closedAt,
    archiveId: "ARC-OMIT",
  });

  for (const result of [include, omit]) {
    assert.equal(result.closed, true);
    assert.deepEqual(result.state.archives[0].balances, {});
    assert.equal(result.state.archives[0].incomeProfitMinor, 0);
    assert.deepEqual(result.state.receivables, state.receivables, "An open receivable linked to a cancellation must remain untouched.");
    assert.deepEqual(result.state.settlements, state.settlements);
    const voided = result.state.archives[0].orders.find((order) => order.id === "ORD-VOIDED");
    assert.equal(voided.excludedFromCalculations, true);
  }
  assert.deepEqual(include.state.ledger, omit.state.ledger);
  assert.deepEqual(include.state.settlements, omit.state.settlements);
  assert.deepEqual(include.state.receivables, omit.state.receivables);
  assert.equal(include.state.archives[0].incomeProfitMinor, omit.state.archives[0].incomeProfitMinor);
});

test("completed transfers, collected receivables, and manual ledger lines retain existing close semantics", () => {
  const state = baseState();
  state.orders = [cancelledOrder()];
  state.transfers = [{
    id: "TRF-1",
    from: "PPP",
    to: "Master",
    sourceCurrency: "EUR",
    sourceAmountMinor: 2_000,
    currency: "EUR",
    amountMinor: 2_000,
    state: "Approved",
    journal: "JRN-1800",
    createdAt: "2026-08-13T14:00:00.000Z",
  }];
  state.receivables = [{
    id: "REC-1",
    orderId: "ORD-CREDIT",
    borrower: "PPP",
    borrowerActorId: "ACT-PPP",
    currency: "EUR",
    principalMinor: 5_000,
    payments: [{ id: "PAY-1", amountMinor: 5_000, paidAt: "2026-08-13T15:00:00.000Z" }],
    createdAt: "2026-08-13T13:00:00.000Z",
  }];
  state.ledger = [
    { journal: "JRN-1800", transferId: "TRF-1", source: "TRANSFER", account: "PPP", direction: "Debit", currency: "EUR", amountMinor: 2_000, postedAt: "2026-08-13T14:00:00.000Z" },
    { journal: "JRN-1801", entryId: "JNL-1", source: "JOURNAL", account: "PPP", direction: "Credit", currency: "EUR", amountMinor: 500, postedAt: "2026-08-13T14:30:00.000Z", details: "Adjustment" },
  ];

  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "omit",
    closedAt,
    archiveId: "ARC-PPP-MIXED",
  });

  const archive = result.state.archives[0];
  assert.equal(archive.transfers.length, 1);
  assert.equal(archive.receivables.length, 1);
  assert.equal(archive.ledger.length, 1, "Only the manual line belongs in the compact ledger snapshot.");
  assert.equal(archive.ledger[0].source, "JOURNAL");
  assert.equal(archive.balances.EUR, 1_500);
  assert.equal(result.state.transfers[0].archivedAt, closedAt);
  assert.deepEqual(result.state.transfers[0].archivedActorIds, ["ACT-PPP"]);
  assert.equal(result.state.receivables[0].archiveId, "ARC-PPP-MIXED");
  assert.equal(result.state.ledger.filter((line) => line.source === "PREVIOUS_CLOSE").length, 2);
  assert.deepEqual(result.state.deletedOrderIds, ["ORD-CANCELLED"]);
});

test("an unresolved void request blocks even a cancellation-only close", () => {
  const state = baseState();
  state.orders = [
    cancelledOrder(),
    paidOrder({ id: "ORD-VOID-REQUEST", state: "Void Requested", journal: "JRN-1900" }),
  ];
  const before = structuredClone(state);
  const result = closeActorBalance(state, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "omit",
    closedAt,
    archiveId: "ARC-BLOCKED",
  });
  assert.equal(result.closed, false);
  assert.equal(result.cancelledOrderCount, 1);
  assert.equal(result.includedCancelledOrderCount, 0);
  assert.equal(result.omittedCancelledOrderCount, 0);
  assert.match(result.error, /Order .*approve or reject.*before closing PPP's balance/i);
  assert.deepEqual(result.state, before);
});

test("invalid policy and missing deterministic close identifiers are rejected", () => {
  assert.throws(() => closeActorBalance(baseState(), {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "archive",
    closedAt,
    archiveId: "ARC-X",
  }), /include.*omit/);
  assert.throws(() => closeActorBalance(baseState(), {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    archiveId: "ARC-X",
  }), /closedAt is required/);
  assert.throws(() => closeActorBalance(baseState(), {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "include",
    closedAt,
  }), /archiveId is required/);
});
