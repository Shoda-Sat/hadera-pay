import assert from "node:assert/strict";
import test from "node:test";

import { closeActorBalance } from "../src/closeActorBalance.mjs";
import {
  applyApprovedOrderParticipantIdentityRepair,
  orderParticipantIdentityLinkForLedgerLine,
  orderParticipantIdentityLinkMatches,
} from "../src/orderParticipantIdentity.mjs";

function paidOrder(id, journal) {
  return {
    id,
    internalOrderId: id,
    brokerOrderNumber: "GOI401",
    brokerActorId: "ACT-GOITOM",
    broker: "Goitom",
    agentActorId: "ACT-NAHOM-LEGACY",
    agent: "Nahom",
    sourceCurrency: "USD",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 2_000_000,
    commissionMinor: 0,
    state: "Paid",
    journal,
    createdAt: "2026-08-01T10:00:00.000Z",
    paidAt: "2026-08-01T10:05:00.000Z",
    incomeProfitMinor: 0,
  };
}

function fixture({ includeCorroboration = true } = {}) {
  const canonical = paidOrder("ORD-1739", "JRN-1739");
  const duplicate = paidOrder("ORD-1739-DUP", "JRN-1739 (1)");
  return {
    actors: [
      { id: "ACT-0", name: "Master", role: "Master", currency: "USD", active: true },
      { id: "ACT-GOITOM", name: "Goitom", role: "Broker", currency: "USD", active: true },
      { id: "ACT-NAHOM", name: "Nahom", role: "Agent", currency: "ETB", active: true },
    ],
    orders: includeCorroboration ? [duplicate] : [],
    archives: [{
      id: "ARC-GOITOM",
      actor: "Goitom",
      actorId: "ACT-GOITOM",
      actorRole: "Broker",
      actorCurrency: "USD",
      closedAt: "2026-08-02T00:00:00.000Z",
      balances: { USD: 10_000 },
      incomeProfitMinor: 0,
      orders: [canonical],
      ledger: [],
      transfers: [],
      receivables: [],
    }],
    ledger: [
      {
        journal: "JRN-1739",
        orderId: "ORD-1739",
        source: "ORDER_PAYMENT",
        account: "MASTER_FX_CLEARING",
        direction: "Debit",
        currency: "ETB",
        amountMinor: 2_000_000,
        postedAt: "2026-08-01T10:05:00.000Z",
      },
      {
        journal: "JRN-1739",
        orderId: "ORD-1739",
        source: "ORDER_PAYMENT",
        account: "Nahom ACTOR_CLEARING",
        direction: "Credit",
        currency: "ETB",
        amountMinor: 2_000_000,
        postedAt: "2026-08-01T10:05:00.000Z",
      },
    ],
    transfers: [],
    receivables: [],
    settlements: [
      { actor: "Goitom", currency: "USD", netMinor: 0 },
      { actor: "Nahom", currency: "ETB", netMinor: -2_000_000 },
    ],
    deletedOrderIds: [],
    journalCounter: 800,
  };
}

function financialLedgerProjection(ledger) {
  return ledger.map(({ journal, source, account, direction, currency, amountMinor, archived }) => ({
    journal,
    source,
    account,
    direction,
    currency,
    amountMinor,
    archived,
  }));
}

test("Galaxy Nahom JRN-1739 receives a balance-neutral, report-neutral identity link", () => {
  const state = fixture();
  const ledgerBefore = structuredClone(state.ledger);
  const settlementsBefore = structuredClone(state.settlements);
  const ordersBefore = structuredClone(state.orders);
  const archivesBefore = structuredClone(state.archives);

  const repair = applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });

  assert.equal(repair.repaired, true);
  assert.deepEqual(state.ledger, ledgerBefore);
  assert.deepEqual(state.settlements, settlementsBefore);
  assert.deepEqual(state.orders, ordersBefore);
  assert.deepEqual(state.archives, archivesBefore);
  assert.equal(orderParticipantIdentityLinkMatches(
    state,
    archivesBefore[0].orders[0],
    state.actors.find((actor) => actor.id === "ACT-NAHOM"),
    "agent"
  ), true);
  const repairedState = structuredClone(state);
  const repeated = applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });
  assert.equal(repeated.repaired, false);
  assert.equal(repeated.reason, "already-repaired");
  assert.deepEqual(state, repairedState);
});

test("Nahom closes JRN-1739 without changing its balance or any existing report", () => {
  const state = fixture();
  const legacyActorLine = state.ledger.find((line) => line.account === "Nahom ACTOR_CLEARING");
  legacyActorLine.actorId = "ACT-NAHOM-LEGACY";
  legacyActorLine.participantRole = "agent";
  const existingArchives = structuredClone(state.archives);
  const duplicateBefore = structuredClone(state.orders[0]);
  const ledgerBefore = financialLedgerProjection(state.ledger);

  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-JRN-1739",
  });

  assert.equal(result.closed, true, result.error);
  assert.deepEqual(result.state.archives.slice(1), existingArchives, "Existing closed reports remain byte-for-byte unchanged.");
  const nahomArchive = result.state.archives[0];
  assert.equal(nahomArchive.actorId, "ACT-NAHOM");
  assert.deepEqual(nahomArchive.orders.map((order) => order.journal), ["JRN-1739"]);
  assert.equal(nahomArchive.orders[0].agentActorId, "ACT-NAHOM");
  assert.equal(nahomArchive.orders[0].agent, "Nahom");
  assert.equal(nahomArchive.balances.ETB, -2_000_000);
  assert.deepEqual(result.state.orders.find((order) => order.journal === "JRN-1739 (1)"), duplicateBefore);
  assert.equal(nahomArchive.orders.some((order) => order.journal === "JRN-1739 (1)"), false);
  assert.deepEqual(
    financialLedgerProjection(result.state.ledger)
      .filter((line) => line.journal === "JRN-1739")
      .map(({ archived, ...line }) => line),
    ledgerBefore.map(({ archived, ...line }) => line),
    "No existing ledger amount, direction, currency, account, journal, or source changes.",
  );
  assert.equal(result.state.settlements.find((item) => item.actor === "Nahom" && item.currency === "ETB")?.netMinor, -2_000_000);
  assert.equal(
    result.state.ledger.find((line) => line.journal === "JRN-1739" && line.account === "Nahom ACTOR_CLEARING")?.actorId,
    "ACT-NAHOM-LEGACY",
    "The approved identity link selects the historical row without rewriting it.",
  );
});

test("an unrelated legacy Actor ID cannot use Nahom's approved identity link", () => {
  const state = fixture();
  const actorLine = state.ledger.find((line) => line.account === "Nahom ACTOR_CLEARING");
  actorLine.actorId = "ACT-UNRELATED";
  actorLine.participantRole = "agent";
  const before = structuredClone(state);

  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-WRONG-LEGACY-ID",
  });

  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-1739.*Actor identity conflict/i);
  assert.deepEqual(state, before);
});

test("the historic exception stays blocked without the corroborating duplicate order", () => {
  const state = fixture({ includeCorroboration: false });
  const before = structuredClone(state);
  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-BLOCKED",
  });
  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-1739.*Actor identity conflict/i);
  assert.deepEqual(result.state, before);
  assert.deepEqual(state, before);
});

test("unbalanced duplicate Actor rows cannot authorize the historic identity link", () => {
  const state = fixture();
  state.ledger.push({ ...state.ledger[1] });
  const before = structuredClone(state);
  const repair = applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });
  assert.equal(repair.repaired, false);
  assert.equal(repair.reason, "ledger-evidence-missing");
  assert.deepEqual(state, before);
});

test("a remapped ledger order ID may be corroborated by the preserved exact duplicate", () => {
  const state = fixture();
  state.ledger.forEach((line) => {
    line.orderId = "ORD-1739-DUP";
  });
  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-REMAPPED",
  });
  assert.equal(result.closed, true, result.error);
  assert.deepEqual(result.state.archives[0].orders.map((order) => order.journal), ["JRN-1739"]);
});

test("a similar but non-exact duplicate cannot authorize the identity link", () => {
  const state = fixture();
  state.orders[0].receiverName = "Different receiver";
  const before = structuredClone(state);
  const repair = applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });
  assert.equal(repair.repaired, false);
  assert.equal(repair.reason, "corroborating-order-missing");
  assert.deepEqual(state, before);
});

test("mixed blank and legacy participant IDs cannot authorize the historic identity link", () => {
  const state = fixture();
  state.orders.push({
    ...state.archives[0].orders[0],
    id: "ORD-1739-BLANK-ID",
    internalOrderId: "ORD-1739-BLANK-ID",
    agentActorId: "",
  });
  const before = structuredClone(state);
  const repair = applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });
  assert.equal(repair.repaired, false);
  assert.equal(repair.reason, "ambiguous-identity");
  assert.deepEqual(state, before);
});

test("an identity still owned by another active Actor remains blocked", () => {
  const state = fixture();
  state.actors.push({
    id: "ACT-NAHOM-LEGACY",
    name: "Another active Actor",
    role: "Agent",
    currency: "ETB",
    active: true,
  });
  const before = structuredClone(state);
  const repair = applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });
  assert.equal(repair.repaired, false);
  assert.equal(repair.reason, "legacy-identity-is-active");
  assert.deepEqual(state, before);
});

test("the historic exception is never applied outside Galaxy", () => {
  const state = fixture();
  const before = structuredClone(state);
  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Another Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-BLOCKED",
  });
  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-1739.*Actor identity conflict/i);
  assert.equal(result.state.orderParticipantIdentityLinks, undefined);
  assert.deepEqual(state, before, "The rejected close cannot change the persisted input state.");
});

test("a valid Galaxy identity link cannot authorize the exception after workspace transplantation", () => {
  const galaxyState = fixture();
  const repair = applyApprovedOrderParticipantIdentityRepair(galaxyState, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });
  assert.equal(repair.repaired, true);

  const transplanted = fixture();
  transplanted.orderParticipantIdentityLinks = structuredClone(galaxyState.orderParticipantIdentityLinks);
  const before = structuredClone(transplanted);
  const result = closeActorBalance(transplanted, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Another Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-TRANSPLANTED-LINK",
  });

  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-1739.*Actor identity conflict/i);
  assert.deepEqual(result.state.archives, before.archives);
  assert.deepEqual(result.state.ledger, before.ledger);
  assert.deepEqual(result.state.settlements, before.settlements);
  assert.deepEqual(transplanted, before);
});

test("a workspace ID context is effective immediately and remains isolated", () => {
  const state = fixture();
  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    workspaceId: "WS-GALAXY",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-WORKSPACE-ID",
  });
  assert.equal(result.closed, true, result.error);
  assert.equal(result.state.orderParticipantIdentityLinks[0].workspaceId, "WS-GALAXY");

  const wrongWorkspace = fixture();
  wrongWorkspace._workspaceId = "WS-OTHER";
  wrongWorkspace.orderParticipantIdentityLinks = structuredClone(result.state.orderParticipantIdentityLinks);
  const blocked = closeActorBalance(wrongWorkspace, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    workspaceId: "WS-OTHER",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-WRONG-WORKSPACE-ID",
  });
  assert.equal(blocked.closed, false);
  assert.match(blocked.error, /JRN-1739.*Actor identity conflict/i);
});

test("the approved ledger exception cannot resolve another Actor's row", () => {
  const state = fixture();
  state.actors.push({ id: "ACT-OTHER", name: "Other", role: "Agent", currency: "ETB", active: true });
  const repair = applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: "Galaxy Workspace",
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
  });
  assert.equal(repair.repaired, true);
  const canonical = state.archives[0].orders[0];
  assert.equal(orderParticipantIdentityLinkForLedgerLine(state, canonical, {
    source: "ORDER_PAYMENT",
    journal: "JRN-1739",
    orderId: "ORD-1739-DUP",
    account: "Other ACTOR_CLEARING",
    actorId: "ACT-OTHER",
    participantRole: "agent",
  }), null);
});

test("duplicate active Nahom identities keep the historic repair blocked", () => {
  const state = fixture();
  state.actors.push({ id: "ACT-NAHOM-SECOND", name: "Nahom", role: "Agent", currency: "ETB", active: true });
  const before = structuredClone(state);
  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-AMBIGUOUS-ACTIVE-ID",
  });
  assert.equal(result.closed, false);
  assert.match(result.error, /Actor.*identity conflict/i);
  assert.deepEqual(result.state.archives, before.archives);
  assert.deepEqual(result.state.ledger, before.ledger);
  assert.deepEqual(state, before);
});

test("duplicate active names block a legacy blank-ID close before name fallback", () => {
  const state = fixture();
  state.actors.push({ id: "ACT-NAHOM-SECOND", name: "nahom", role: "Agent", currency: "ETB", active: true });
  state.archives[0].orders[0].agentActorId = "";
  state.orders[0].agentActorId = "";
  state.ledger.find((line) => line.account === "Nahom ACTOR_CLEARING").actorId = "";
  const before = structuredClone(state);
  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-BLANK-ID-DUPLICATE-NAME",
  });
  assert.equal(result.closed, false);
  assert.match(result.error, /Actor.*identity conflict/i);
  assert.deepEqual(result.state.archives, before.archives);
  assert.deepEqual(result.state.ledger, before.ledger);
  assert.deepEqual(state, before);
});

test("an incompatible current Actor role cannot consume the approved Agent repair", () => {
  const state = fixture();
  state.actors.find((actor) => actor.id === "ACT-NAHOM").role = "Broker";
  const before = structuredClone(state);
  const result = closeActorBalance(state, {
    actorId: "ACT-NAHOM",
    actorName: "Nahom",
    workspaceName: "Galaxy Workspace",
    cancelledOrderPolicy: "include",
    closedAt: "2026-08-22T18:30:00.000Z",
    archiveId: "ARC-NAHOM-WRONG-ROLE",
  });
  assert.equal(result.closed, false);
  assert.match(result.error, /JRN-1739.*Actor identity conflict/i);
  assert.deepEqual(result.state.archives, before.archives);
  assert.deepEqual(result.state.ledger, before.ledger);
  assert.deepEqual(state, before);
});
