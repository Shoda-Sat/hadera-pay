import assert from "node:assert/strict";
import test from "node:test";

import { backfillClosedParticipantOrderSnapshots } from "../src/archiveParticipantBackfill.mjs";

const brokerClose = "2026-08-13T15:41:00.000Z";
const payerClose = "2026-08-13T15:45:00.000Z";

function paidOrder(overrides = {}) {
  return {
    id: "ORD-359",
    internalOrderId: "ORD-359",
    brokerOrderNumber: "PPP359",
    brokerActorId: "ACT-PPP",
    agentOrderNumber: "0494_PPP359",
    agentOrderNumbers: { Walta: "0494_PPP359" },
    broker: "PPP",
    agent: "Walta",
    sourceCurrency: "EUR",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 1_970_000,
    state: "Paid",
    journal: "JRN-1826",
    sentAt: "2026-08-13T14:53:47.000Z",
    paidAt: "2026-08-13T15:40:01.000Z",
    locked: true,
    archivedAt: brokerClose,
    actor: "PPP",
    payerCurrency: "",
    payerAmountMinor: 0,
    ...overrides,
  };
}

function baseState() {
  return {
    actors: [
      { id: "ACT-PPP", name: "PPP", role: "Broker", currency: "EUR" },
      { id: "ACT-WALTA", name: "Walta", role: "Agent", currency: "ETB" },
    ],
    orders: [],
    archives: [
      {
        id: "ARC-PPP",
        actor: "PPP",
        actorId: "ACT-PPP",
        actorRole: "Broker",
        closedAt: brokerClose,
        balances: { EUR: 10_000 },
        incomeProfitMinor: 1_234,
        orders: [paidOrder()],
        ledger: [],
        transfers: [],
        receivables: [],
      },
      {
        id: "ARC-WALTA",
        actor: "Walta",
        actorId: "ACT-WALTA",
        actorRole: "Agent",
        closedAt: payerClose,
        balances: { ETB: -1_970_000 },
        incomeProfitMinor: 0,
        orders: [],
        ledger: [],
        transfers: [],
        receivables: [],
      },
    ],
    ledger: [
      {
        journal: "JRN-1826",
        orderId: "ORD-359",
        source: "ORDER_PAYMENT",
        account: "PPP ACTOR_CLEARING",
        direction: "Debit",
        currency: "EUR",
        amountMinor: 10_000,
        archived: true,
        closedAt: brokerClose,
      },
      {
        journal: "JRN-1826",
        orderId: "ORD-359",
        source: "ORDER_PAYMENT",
        account: "Walta ACTOR_CLEARING",
        direction: "Credit",
        currency: "ETB",
        amountMinor: 1_970_000,
        archived: true,
        closedAt: payerClose,
      },
      {
        journal: "JRN-1826",
        orderId: "ORD-359",
        source: "ORDER_PAYMENT",
        account: "MASTER_FX_CLEARING",
        direction: "Debit",
        currency: "ETB",
        amountMinor: 1_970_000,
      },
    ],
    settlements: [{ actor: "Walta", currency: "ETB", netMinor: -1_970_000 }],
    orderCounter: 359,
    journalCounter: 826,
    actorNumberingCycle: 4,
    unrelated: { keep: true },
  };
}

test("backfills the payer's exact closed statement without changing accounting state", () => {
  const original = baseState();
  const before = structuredClone(original);
  const result = backfillClosedParticipantOrderSnapshots(original);

  assert.deepEqual(original, before, "The persisted input state must not be mutated.");
  assert.equal(result.repairedCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.repaired, [{
    archiveId: "ARC-WALTA",
    actorId: "ACT-WALTA",
    actor: "Walta",
    orderId: "ORD-359",
    journal: "JRN-1826",
    closedAt: payerClose,
  }]);

  const repairedWalta = result.state.archives.find((archive) => archive.id === "ARC-WALTA");
  assert.equal(repairedWalta.orders.length, 1);
  assert.deepEqual(repairedWalta.orders[0], {
    ...paidOrder(),
    agentActorId: "ACT-WALTA",
    agentOrderNumberCycles: {},
    actor: "Walta",
    payerCurrency: "ETB",
    payerAmountMinor: 1_970_000,
    archivedAt: payerClose,
  });

  for (const field of ["ledger", "balances", "settlements", "orderCounter", "journalCounter", "actorNumberingCycle", "unrelated"]) {
    if (field === "balances") {
      assert.deepEqual(repairedWalta.balances, before.archives.find((archive) => archive.id === "ARC-WALTA").balances);
    } else {
      assert.deepEqual(result.state[field], before[field], `${field} must remain unchanged.`);
    }
  }
  assert.equal(result.state.ledger, original.ledger);
  assert.equal(result.state.settlements, original.settlements);
  assert.equal(repairedWalta.incomeProfitMinor, 0, "The historical profit owner must not change.");

  const second = backfillClosedParticipantOrderSnapshots(result.state);
  assert.equal(second.repairedCount, 0);
  assert.equal(second.state, result.state, "An idempotent rerun should return the unchanged state object.");
  assert.deepEqual(second.state, result.state);
});

test("backfills a closed participant by unique journal after a hidden order ID remap", () => {
  const state = baseState();
  state.archives[0].orders[0] = paidOrder({
    id: "ORD-OLD-HIDDEN-ID",
    internalOrderId: "ORD-OLD-HIDDEN-ID",
  });
  state.ledger = state.ledger.map((line) =>
    line.account === "Walta ACTOR_CLEARING"
      ? { ...line, orderId: "ORD-NEW-HIDDEN-ID" }
      : line
  );

  const result = backfillClosedParticipantOrderSnapshots(state);

  assert.equal(result.repairedCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.orphanCount, 0);
  const payerArchive = result.state.archives.find((archive) => archive.id === "ARC-WALTA");
  assert.equal(payerArchive.orders.length, 1);
  assert.equal(payerArchive.orders[0].journal, "JRN-1826");
  assert.equal(payerArchive.orders[0].payerCurrency, "ETB");
  assert.equal(payerArchive.orders[0].payerAmountMinor, 1_970_000);
});

test("restores a broker snapshot after the payer closed first and removes payer-only amounts", () => {
  const state = baseState();
  const source = paidOrder({
    actor: "Walta",
    archivedAt: brokerClose,
    payerCurrency: "ETB",
    payerAmountMinor: 1_970_000,
  });
  state.archives = [
    { ...state.archives[1], id: "ARC-WALTA-FIRST", closedAt: brokerClose, orders: [source] },
    { ...state.archives[0], id: "ARC-PPP-SECOND", closedAt: payerClose, orders: [] },
  ];
  state.ledger = state.ledger.map((line) => {
    if (line.account === "Walta ACTOR_CLEARING") return { ...line, closedAt: brokerClose };
    if (line.account === "PPP ACTOR_CLEARING") return { ...line, closedAt: payerClose };
    return line;
  });

  const result = backfillClosedParticipantOrderSnapshots(state);
  assert.equal(result.repairedCount, 1);
  const brokerSnapshot = result.state.archives.find((archive) => archive.id === "ARC-PPP-SECOND").orders[0];
  assert.equal(brokerSnapshot.actor, "PPP");
  assert.equal(brokerSnapshot.payerCurrency, "");
  assert.equal(brokerSnapshot.payerAmountMinor, 0);
  assert.equal(brokerSnapshot.archivedAt, payerClose);
});

test("uses stable IDs with legacy participant names and preserved legacy accounts", () => {
  const state = baseState();
  state.actors = [
    { id: "ACT-PPP", name: "PPP New", role: "Broker", currency: "EUR" },
    { id: "ACT-WALTA", name: "Walta New", role: "Agent", currency: "ETB" },
  ];
  state.archives[0].orders[0] = paidOrder({ broker: "PPP Old", agent: "Walta Old", agentActorId: "ACT-WALTA" });
  state.archives[1] = { ...state.archives[1], actor: "Walta New" };
  state.ledger[1] = { ...state.ledger[1], account: "Walta Old ACTOR_CLEARING" };

  const result = backfillClosedParticipantOrderSnapshots(state);
  assert.equal(result.repairedCount, 1);
  const snapshot = result.state.archives.find((archive) => archive.id === "ARC-WALTA").orders[0];
  assert.equal(snapshot.actor, "Walta New");
  assert.equal(snapshot.agent, "Walta Old");
  assert.equal(snapshot.agentActorId, "ACT-WALTA");
  assert.equal(snapshot.payerAmountMinor, 1_970_000);
});

test("does not give an old order to a recreated Actor with the same name", () => {
  const state = baseState();
  state.actors = [
    { id: "ACT-PPP", name: "PPP", role: "Broker", currency: "EUR" },
    { id: "ACT-WALTA-NEW", name: "Walta", role: "Agent", currency: "ETB" },
  ];
  state.archives[0].orders[0] = paidOrder({ agentActorId: "ACT-WALTA-OLD" });
  state.archives[1] = { ...state.archives[1], actorId: "ACT-WALTA-NEW" };

  const result = backfillClosedParticipantOrderSnapshots(state, {
    actorId: "ACT-WALTA-NEW",
    actorName: "Walta",
  });
  assert.equal(result.repairedCount, 0);
  assert.equal(result.orphanCount, 1, "The conflicting stable identity must stop rather than use the shared name.");
  assert.equal(result.state, state);

  delete state.archives[0].orders[0].agentActorId;
  const legacy = backfillClosedParticipantOrderSnapshots(state, {
    actorId: "ACT-WALTA-NEW",
    actorName: "Walta",
  });
  assert.equal(legacy.repairedCount, 1, "A genuinely legacy source without an Actor ID may still use the name fallback.");
  assert.equal(legacy.orphanCount, 0);
});

test("skips ambiguous archive destinations and conflicting source snapshots", () => {
  const ambiguousDestination = baseState();
  ambiguousDestination.archives.push({
    ...ambiguousDestination.archives[1],
    id: "ARC-WALTA-DUPLICATE",
    orders: [],
  });
  const originalDestinationState = structuredClone(ambiguousDestination);
  const destinationResult = backfillClosedParticipantOrderSnapshots(ambiguousDestination);
  assert.equal(destinationResult.repairedCount, 0);
  assert.ok(destinationResult.skippedCount >= 1);
  assert.equal(destinationResult.state, ambiguousDestination);
  assert.deepEqual(destinationResult.state, originalDestinationState);

  const conflictingSource = baseState();
  conflictingSource.archives.push({
    id: "ARC-CONFLICT",
    actor: "Other",
    closedAt: brokerClose,
    orders: [paidOrder({ payoutAmountMinor: 1_999_999 })],
  });
  const sourceResult = backfillClosedParticipantOrderSnapshots(conflictingSource);
  assert.equal(sourceResult.repairedCount, 0);
  assert.ok(sourceResult.skippedCount >= 1);
  assert.equal(sourceResult.state, conflictingSource);
});

test("conflicting stable participant IDs make a same-journal historical source ambiguous", () => {
  const state = baseState();
  state.archives[0].orders[0] = paidOrder({ agentActorId: "ACT-WALTA" });
  state.archives.push({
    id: "ARC-CONFLICTING-IDENTITY",
    actor: "Other",
    actorId: "ACT-OTHER",
    closedAt: brokerClose,
    orders: [paidOrder({ agentActorId: "ACT-WALTA-RECREATED" })],
  });
  const before = structuredClone(state);

  const result = backfillClosedParticipantOrderSnapshots(state, {
    actorId: "ACT-WALTA",
    actorName: "Walta",
  });

  assert.equal(result.repairedCount, 0);
  assert.ok(result.skippedCount >= 1);
  assert.equal(result.state, state);
  assert.deepEqual(result.state, before);
});

test("an optional Actor target cannot repair another participant's archive", () => {
  const state = baseState();
  state.actors.push({ id: "ACT-OTHER", name: "Other Agent", role: "Agent", currency: "ETB" });
  state.archives.push({
    id: "ARC-OTHER",
    actor: "Other Agent",
    actorId: "ACT-OTHER",
    actorRole: "Agent",
    closedAt: payerClose,
    balances: { ETB: -500_000 },
    orders: [],
    ledger: [],
    transfers: [],
    receivables: [],
  });
  state.archives[0].orders.push(paidOrder({
    id: "ORD-OTHER",
    internalOrderId: "ORD-OTHER",
    brokerOrderNumber: "PPP360",
    agentOrderNumber: "001_PPP360",
    agentOrderNumbers: { "Other Agent": "001_PPP360" },
    agent: "Other Agent",
    agentActorId: "ACT-OTHER",
    journal: "JRN-1827",
    payoutAmountMinor: 500_000,
  }));
  state.ledger.push({
    journal: "JRN-1827",
    orderId: "ORD-OTHER",
    source: "ORDER_PAYMENT",
    account: "Other Agent ACTOR_CLEARING",
    direction: "Credit",
    currency: "ETB",
    amountMinor: 500_000,
    archived: true,
    closedAt: payerClose,
  });

  const targeted = backfillClosedParticipantOrderSnapshots(state, { actorId: "ACT-WALTA", actorName: "Walta" });
  assert.equal(targeted.repairedCount, 1);
  assert.equal(targeted.state.archives.find((archive) => archive.id === "ARC-WALTA").orders.length, 1);
  assert.equal(targeted.state.archives.find((archive) => archive.id === "ARC-OTHER").orders.length, 0);

  const otherOnly = backfillClosedParticipantOrderSnapshots(state, { actorName: "Other Agent" });
  assert.equal(otherOnly.repairedCount, 1);
  assert.equal(otherOnly.repaired[0].archiveId, "ARC-OTHER");
  assert.equal(otherOnly.state.archives.find((archive) => archive.id === "ARC-WALTA").orders.length, 0);

  const mismatchedName = backfillClosedParticipantOrderSnapshots(state, { actorId: "ACT-WALTA", actorName: "Other Agent" });
  assert.equal(mismatchedName.repairedCount, 1, "A stable target ID must take priority over a mismatched name.");
  assert.equal(mismatchedName.repaired[0].archiveId, "ARC-WALTA");
  assert.equal(mismatchedName.state.archives.find((archive) => archive.id === "ARC-OTHER").orders.length, 0);

  const missingLegacyId = structuredClone(state);
  delete missingLegacyId.archives.find((archive) => archive.id === "ARC-OTHER").actorId;
  const legacyNameFallback = backfillClosedParticipantOrderSnapshots(missingLegacyId, { actorId: "ACT-OTHER", actorName: "Other Agent" });
  assert.equal(legacyNameFallback.repairedCount, 1, "A legacy archive without an Actor ID may use the target name.");
  assert.equal(legacyNameFallback.repaired[0].archiveId, "ARC-OTHER");
});
