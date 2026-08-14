import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function orderResolver(state) {
  return (line) => {
    const live = line.orderId
      ? state.orders.find((order) => order.id === line.orderId)
      : state.orders.find((order) => order.journal === line.journal);
    if (live) return live;
    const reported = state.archives.flatMap((archive) => archive.orders || []);
    return line.orderId
      ? reported.find((order) => order.id === line.orderId || order.internalOrderId === line.orderId)
      : reported.find((order) => order.journal === line.journal);
  };
}

function paidOrder() {
  return {
    id: "ORD-PPP359",
    brokerOrderNumber: "PPP359",
    brokerActorId: "ACT-PPP",
    agentActorId: "ACT-WALTA",
    agentOrderNumber: "0494_PPP359",
    broker: "PPP",
    agent: "Walta",
    sourceCurrency: "EUR",
    sourceAmountMinor: 10_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 1_970_000,
    state: "Paid",
    journal: "JRN-1826",
    paidAt: "2026-08-13T15:40:01.000Z",
  };
}

test("a paid order is archived once for each participant regardless of close order", async () => {
  const [index, preview] = await Promise.all([
    readRepositoryFile("index.html"),
    readRepositoryFile("preview.html"),
  ]);
  assert.equal(index, preview, "The production and preview web clients must remain identical.");

  const helperSource = sourceBetween(
    index,
    "function orderArchiveIdentityValues",
    "function closeCurrentBalanceForActor",
  );
  const state = { orders: [paidOrder()], archives: [] };
  const helpers = new Function(
    "state",
    "orderForLedgerLine",
    `${helperSource}\nreturn { completedOrdersForActorClose, orderArchivedForActor };`,
  )(state, orderResolver(state));

  const ppp = { id: "ACT-PPP", name: "PPP" };
  const walta = { id: "ACT-WALTA", name: "Walta" };
  const pppLine = {
    source: "ORDER_PAYMENT",
    orderId: "ORD-PPP359",
    journal: "JRN-1826",
    account: "PPP ACTOR_CLEARING",
    direction: "Debit",
    currency: "EUR",
    amountMinor: 10_000,
  };
  const waltaLine = {
    source: "ORDER_PAYMENT",
    orderId: "ORD-PPP359",
    journal: "JRN-1826",
    account: "Walta ACTOR_CLEARING",
    direction: "Credit",
    currency: "ETB",
    amountMinor: 1_970_000,
  };

  const firstClose = helpers.completedOrdersForActorClose(ppp, [pppLine]);
  assert.deepEqual(firstClose.map((order) => order.id), ["ORD-PPP359"]);
  state.archives.unshift({
    id: "ARC-PPP",
    actor: "PPP",
    actorId: "ACT-PPP",
    orders: [{ ...firstClose[0], internalOrderId: firstClose[0].id, locked: true }],
  });
  state.orders = [];

  const secondClose = helpers.completedOrdersForActorClose(walta, [waltaLine]);
  assert.deepEqual(secondClose.map((order) => order.id), ["ORD-PPP359"], "Walta must recover the order from PPP's archive while Walta's payment line is still active.");
  assert.equal(helpers.orderArchivedForActor(secondClose[0], ppp), true);
  assert.equal(helpers.orderArchivedForActor(secondClose[0], walta), false);

  state.archives.unshift({
    id: "ARC-WALTA",
    actor: "Walta",
    actorId: "ACT-WALTA",
    orders: [{ ...secondClose[0], actor: "Walta", internalOrderId: secondClose[0].id, locked: true }],
  });
  assert.deepEqual(helpers.completedOrdersForActorClose(walta, [waltaLine]), [], "Repeating the close must not archive the order twice for Walta.");
  assert.deepEqual(helpers.completedOrdersForActorClose(walta, []), [], "An order from an already closed ledger period must not move into a later period.");

  const reverseState = { orders: [paidOrder()], archives: [] };
  const reverseHelpers = new Function(
    "state",
    "orderForLedgerLine",
    `${helperSource}\nreturn { completedOrdersForActorClose };`,
  )(reverseState, orderResolver(reverseState));
  const waltaFirst = reverseHelpers.completedOrdersForActorClose(walta, [waltaLine]);
  reverseState.archives.unshift({ id: "ARC-WALTA-FIRST", actor: "Walta", actorId: "ACT-WALTA", orders: waltaFirst });
  reverseState.orders = [];
  assert.deepEqual(
    reverseHelpers.completedOrdersForActorClose(ppp, [pppLine]).map((order) => order.id),
    ["ORD-PPP359"],
    "PPP must also recover the shared order when Walta closes first.",
  );
});

test("a recreated Actor cannot inherit an old participant's order by name", async () => {
  const index = await readRepositoryFile("index.html");
  const helperSource = sourceBetween(
    index,
    "function orderArchiveIdentityValues",
    "function closeCurrentBalanceForActor",
  );
  const order = paidOrder();
  const state = {
    orders: [order],
    archives: [{
      id: "ARC-WALTA-OLD",
      actor: "Walta",
      actorId: "ACT-WALTA",
      orders: [order],
    }],
  };
  const helpers = new Function(
    "state",
    "orderForLedgerLine",
    `${helperSource}\nreturn { completedOrdersForActorClose, orderArchivedForActor };`,
  )(state, orderResolver(state));
  const recreatedWalta = { id: "ACT-WALTA-NEW", name: "Walta" };
  const oldWaltaLine = {
    source: "ORDER_PAYMENT",
    orderId: order.id,
    journal: order.journal,
    account: "Walta ACTOR_CLEARING",
    direction: "Credit",
    currency: "ETB",
    amountMinor: 1_970_000,
  };

  assert.equal(helpers.orderArchivedForActor(order, recreatedWalta), false);
  assert.deepEqual(
    helpers.completedOrdersForActorClose(recreatedWalta, [oldWaltaLine]),
    [],
    "A conflicting stable Actor ID must take priority over a reused participant name.",
  );

  const legacyOrder = { ...order };
  delete legacyOrder.agentActorId;
  const legacyState = { orders: [legacyOrder], archives: [] };
  const legacyHelpers = new Function(
    "state",
    "orderForLedgerLine",
    `${helperSource}\nreturn { completedOrdersForActorClose };`,
  )(legacyState, orderResolver(legacyState));
  assert.deepEqual(
    legacyHelpers.completedOrdersForActorClose(recreatedWalta, [{ ...oldWaltaLine, orderId: legacyOrder.id }]).map((item) => item.id),
    [legacyOrder.id],
    "Legacy orders without an Actor ID may still use the participant name.",
  );
});

test("server and Android normalization preserve a shared order in both actor archives", async () => {
  const [server, mobileClient] = await Promise.all([
    readRepositoryFile("server.mjs"),
    readRepositoryFile("mobile/src/api/client.ts"),
  ]);
  const normalizationSource = sourceBetween(
    server,
    "function archiveSnapshotItemKey",
    "function mergeArchiveSnapshots",
  );
  const normalizeArchiveSnapshots = new Function(
    `${normalizationSource}\nreturn normalizeArchiveSnapshots;`,
  )();
  const order = paidOrder();
  const archives = normalizeArchiveSnapshots([
    { id: "ARC-PPP", actor: "PPP", actorId: "ACT-PPP", closedAt: "2026-08-13T15:40:01.000Z", orders: [order] },
    { id: "ARC-WALTA", actor: "Walta", actorId: "ACT-WALTA", closedAt: "2026-08-13T16:40:01.000Z", orders: [order] },
    { id: "ARC-WALTA-DUPLICATE", actor: "Walta", actorId: "ACT-WALTA", closedAt: "2026-08-13T17:40:01.000Z", orders: [order] },
  ]);

  assert.equal(archives.find((archive) => archive.id === "ARC-PPP").orders.length, 1);
  assert.equal(archives.find((archive) => archive.id === "ARC-WALTA").orders.length, 1);
  assert.equal(archives.find((archive) => archive.id === "ARC-WALTA-DUPLICATE").orders.length, 0, "Duplicates must still be removed within the same actor's reports.");

  const mobileNormalization = sourceBetween(
    mobileClient,
    "function normalizeArchiveSnapshots",
    "function recoveredOrderMatches",
  );
  assert.match(mobileNormalization, /const actorKey = String\(archive\.actorId \|\| archive\.actor \|\| "Unknown Actor"\)/);
  assert.match(mobileNormalization, /const seen = seenByActor\.get\(actorKey\)/);
  assert.match(mobileNormalization, /seenByActor\.set\(actorKey, seen\)/);
});

test("future order snapshots retain payer identity and frozen financial facts", async () => {
  const index = await readRepositoryFile("index.html");
  const snapshotSource = sourceBetween(
    index,
    "function archiveOrderSnapshot",
    "function archiveReceivableSnapshot",
  );
  for (const field of [
    "agentActorId",
    "rate",
    "commissionPercent",
    "commissionMinor",
    "orderCommissionLiability",
    "incomeCollectedCurrency",
    "incomeCollectedOriginalMinor",
    "incomeCollectedUsdMinor",
    "incomeProfitMinor",
    "incomeMasterRateSnapshot",
    "incomeUsdAgentRateSnapshot",
  ]) {
    assert.match(snapshotSource, new RegExp(`\\b${field}:`), `Archived orders must retain ${field}.`);
  }

  const incomeSource = sourceBetween(index, "function incomeStatementRows", "function ledgerLineDetails");
  assert.match(incomeSource, /orderForLedgerLine\(\{ source: "ORDER_PAYMENT", journal \}\)/, "A participant close must resolve income facts from an earlier participant archive.");
});

test("a regular Agent's closed Report uses the payer-side amount recorded in the ledger", async () => {
  const index = await readRepositoryFile("index.html");
  const amountSource = sourceBetween(index, "function archivedOrderAmount", "function archiveStatementBalances");
  const archivedOrderAmount = new Function(
    "state",
    `${amountSource}\nreturn archivedOrderAmount;`,
  )({ actors: [{ id: "ACT-WALTA", name: "Walta", role: "Agent", currency: "ETB" }] });
  const amount = archivedOrderAmount({ actor: "Walta", actorId: "ACT-WALTA", actorRole: "Agent", actorCurrency: "ETB" }, {
    ...paidOrder(),
    actor: "Walta",
    payerCurrency: "ETB",
    payerAmountMinor: 1_970_000,
  });
  assert.deepEqual(amount, { currency: "ETB", amountMinor: 1_970_000 });
});
