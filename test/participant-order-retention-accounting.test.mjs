import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeActorBalance } from "../src/closeActorBalance.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const brokerClosedAt = "2026-08-15T10:00:00.000Z";
const agentClosedAt = "2026-08-15T11:00:00.000Z";
const frozenProfitMinor = 2_500;

function stateWithPaidSharedOrder() {
  return {
    actors: [
      { id: "ACT-MASTER", name: "Master", role: "Master", currency: "USD", active: true },
      { id: "ACT-PPP", name: "PPP", role: "Broker", currency: "EUR", active: true, numberingCycle: 0 },
      { id: "ACT-AGENT", name: "Agent", role: "Agent", currency: "ETB", active: true, numberingCycle: 0 },
    ],
    orders: [{
      id: "ORD-PPP500",
      internalOrderId: "ORD-PPP500",
      brokerOrderNumber: "PPP500",
      brokerActorId: "ACT-PPP",
      agentOrderNumber: "0001_PPP500",
      agentOrderNumbers: { Agent: "0001_PPP500" },
      agentActorId: "ACT-AGENT",
      broker: "PPP",
      agent: "Agent",
      sourceCurrency: "EUR",
      sourceAmountMinor: 50_000,
      payoutCurrency: "ETB",
      payoutAmountMinor: 98_500,
      state: "Paid",
      journal: "JRN-2000",
      createdAt: "2026-08-15T09:30:00.000Z",
      paidAt: "2026-08-15T09:45:00.000Z",
      incomeBaseCurrency: "USD",
      incomeBaseAmountMinor: 57_500,
      incomeCollectedCurrency: "EUR",
      incomeCollectedOriginalMinor: 50_000,
      incomeCollectedUsdMinor: 60_000,
      incomeProfitMinor: frozenProfitMinor,
    }],
    archives: [],
    ledger: [
      { journal: "JRN-2000", orderId: "ORD-PPP500", source: "ORDER_PAYMENT", account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "EUR", amountMinor: 50_000, postedAt: "2026-08-15T09:45:00.000Z" },
      { journal: "JRN-2000", orderId: "ORD-PPP500", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "EUR", amountMinor: 50_000, postedAt: "2026-08-15T09:45:00.000Z" },
      { journal: "JRN-2000", orderId: "ORD-PPP500", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ETB", amountMinor: 98_500, postedAt: "2026-08-15T09:45:00.000Z" },
      { journal: "JRN-2000", orderId: "ORD-PPP500", source: "ORDER_PAYMENT", account: "Agent ACTOR_CLEARING", direction: "Credit", currency: "ETB", amountMinor: 98_500, postedAt: "2026-08-15T09:45:00.000Z" },
    ],
    transfers: [],
    receivables: [],
    settlements: [
      { actor: "PPP", currency: "EUR", netMinor: 50_000 },
      { actor: "Agent", currency: "ETB", netMinor: -98_500 },
    ],
    masterBankEntries: [],
    journalCounter: 1_000,
  };
}

function previousCloseLines(state, actor) {
  return state.ledger.filter((line) =>
    line.source === "PREVIOUS_CLOSE" && line.details === `Previous Close for ${actor}`
  );
}

function settlement(state, actor, currency) {
  return state.settlements.find((item) => item.actor === actor && item.currency === currency)?.netMinor;
}

function accountingProjection(state) {
  return {
    ledger: state.ledger,
    settlements: state.settlements,
    archiveAccounting: state.archives.map((archive) => ({
      id: archive.id,
      actor: archive.actor,
      actorId: archive.actorId,
      actorRole: archive.actorRole,
      balances: archive.balances,
      incomeProfitMinor: archive.incomeProfitMinor,
      incomeProfitCurrency: archive.incomeProfitCurrency,
    })),
    journalCounter: state.journalCounter,
  };
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

async function syncMasterBankFor(state) {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const source = sourceBetween(index, "function masterBankSignedMinor", "function fillTransferForm");
  const sync = new Function(
    "state",
    "normalizeMasterBankEntries",
    "masterActor",
    "transferIdentity",
    "masterTransactionBankKey",
    "transferLedgerDetails",
    "transferCommissionMinor",
    "normalizedCommissionLiability",
    "originalSenderCommissionMinor",
    "actorNameFromAccount",
    `${source}\nreturn syncMasterBankAccount;`,
  )(
    state,
    (entries) => Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : [],
    () => state.actors.find((actor) => actor.role === "Master"),
    (transfer) => transfer?.recordKey || transfer?.id || "",
    (reference, cycle) => `${cycle || 0}-${reference || ""}`,
    () => "",
    () => 0,
    (value) => value || "",
    () => 0,
    (account) => String(account || "").replace(/ ACTOR_CLEARING$/, ""),
  );
  sync();
  return state.masterBankEntries;
}

test("participant retention preserves close balances, openings, settlements, and Master Bank income", async () => {
  const initial = stateWithPaidSharedOrder();
  const brokerClose = closeActorBalance(initial, {
    actorId: "ACT-PPP",
    cancelledOrderPolicy: "omit",
    closedAt: brokerClosedAt,
    archiveId: "ARC-PPP",
  });

  assert.equal(brokerClose.closed, true);
  assert.deepEqual(brokerClose.state.orders.map((order) => order.id), ["ORD-PPP500"], "The paid order must remain live until Agent also closes it.");
  assert.deepEqual(brokerClose.state.archives[0].balances, { EUR: 50_000 }, "Debit means PPP owes Master EUR 500.");
  assert.equal(brokerClose.state.archives[0].incomeProfitMinor, frozenProfitMinor);
  assert.equal(brokerClose.state.archives[0].orders[0].payerCurrency, "");
  assert.equal(brokerClose.state.archives[0].orders[0].payerAmountMinor, 0);
  assert.deepEqual(previousCloseLines(brokerClose.state, "PPP").map((line) => ({
    account: line.account,
    direction: line.direction,
    currency: line.currency,
    amountMinor: line.amountMinor,
  })), [
    { account: "PPP ACTOR_CLEARING", direction: "Debit", currency: "EUR", amountMinor: 50_000 },
    { account: "MASTER_PREVIOUS_CLOSE", direction: "Credit", currency: "EUR", amountMinor: 50_000 },
  ]);
  assert.equal(settlement(brokerClose.state, "PPP", "EUR"), 50_000);
  assert.equal(settlement(brokerClose.state, "Agent", "ETB"), -98_500, "Agent's unclosed Credit remains an active amount Master owes.");
  assert.equal(brokerClose.state.ledger.find((line) => line.account === "Agent ACTOR_CLEARING" && line.source === "ORDER_PAYMENT").archived, undefined);
  assert.deepEqual(await syncMasterBankFor(structuredClone(brokerClose.state)), [], "A Broker close must not book income to Master Bank.");

  const agentClose = closeActorBalance(brokerClose.state, {
    actorId: "ACT-AGENT",
    cancelledOrderPolicy: "omit",
    closedAt: agentClosedAt,
    archiveId: "ARC-AGENT",
  });

  assert.equal(agentClose.closed, true);
  assert.deepEqual(agentClose.state.orders, [], "The live order is removed only after both participant reports contain it.");
  assert.deepEqual(agentClose.state.archives[0].balances, { ETB: -98_500 }, "Credit means Master owes Agent ETB 98,500.");
  assert.equal(agentClose.state.archives[0].incomeProfitMinor, frozenProfitMinor);
  assert.equal(agentClose.state.archives[0].orders[0].payerCurrency, "ETB");
  assert.equal(agentClose.state.archives[0].orders[0].payerAmountMinor, 98_500);
  assert.deepEqual(previousCloseLines(agentClose.state, "Agent").map((line) => ({
    account: line.account,
    direction: line.direction,
    currency: line.currency,
    amountMinor: line.amountMinor,
  })), [
    { account: "Agent ACTOR_CLEARING", direction: "Credit", currency: "ETB", amountMinor: 98_500 },
    { account: "MASTER_PREVIOUS_CLOSE", direction: "Debit", currency: "ETB", amountMinor: 98_500 },
  ]);
  assert.equal(settlement(agentClose.state, "PPP", "EUR"), 50_000);
  assert.equal(settlement(agentClose.state, "Agent", "ETB"), -98_500);

  const bankEntries = await syncMasterBankFor(structuredClone(agentClose.state));
  assert.deepEqual(bankEntries, [{
    id: "BANK-INCOME-ARC-AGENT",
    type: "Income Statement Close",
    reference: "ARC-AGENT",
    direction: "Credit",
    currency: "USD",
    amountMinor: frozenProfitMinor,
    details: "Agent closed Income Statement",
    postedAt: agentClosedAt,
  }], "Frozen profit is booked once, from the Agent close only.");

  const historicalWithoutLiveOrder = structuredClone(brokerClose.state);
  historicalWithoutLiveOrder.orders = [];
  const historicalAgentClose = closeActorBalance(historicalWithoutLiveOrder, {
    actorId: "ACT-AGENT",
    cancelledOrderPolicy: "omit",
    closedAt: agentClosedAt,
    archiveId: "ARC-AGENT",
  });
  assert.equal(historicalAgentClose.closed, true, "An unclosed participant can recover the order from the first participant's archive.");
  assert.deepEqual(
    accountingProjection(historicalAgentClose.state),
    accountingProjection(agentClose.state),
    "Historical recovery may restore display data but must not alter any ledger, balance, opening, settlement, profit, or counter math.",
  );
});
