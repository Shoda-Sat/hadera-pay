import { recalculateSettlementsFromLedger } from "./exactDuplicateOrderCleanup.mjs";

const targetEntries = [
  ["JRN-2131 (1)", ["Goitom"]],
  ["JRN-2063 (1)", ["Goitom", "Nahom"]],
  ["JRN-1739 (1)", ["Goitom", "Nahom"]],
  ["JRN-1648 (1)", ["Goitom", "Kampala"]],
  ["JRN-1580 (3)", ["Goitom"]],
  ["JRN-1580 (1)", ["Goitom"]],
  ["JRN-1868 (1)", ["PPP", "Nahom"]],
  ["JRN-2041 (1)", ["PPP", "Walta"]],
  ["JRN-2062 (1)", ["PPP", "Dekemhare"]],
  ["JRN-1555 (1)", ["Gbxi"]],
  ["JRN-1649 (1)", ["Grmay", "Kampala"]],
  ["JRN-1251 (2)", ["Habtom"]],
  ["JRN-1251 (1)", ["Habtom"]],
  ["JRN-1252 (2)", ["Habtom"]],
  ["JRN-1252 (1)", ["Habtom"]],
];

export const galaxyOpenOrderCleanupTargets = Object.freeze(
  targetEntries.map(([journal, actors]) => Object.freeze({ journal, actors: Object.freeze([...actors]) }))
);

function clean(value) {
  return String(value ?? "").trim();
}
function normalized(value) {
  return clean(value).toLocaleLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function ownOrderIds(order = {}) {
  return new Set([order?.id, order?.internalOrderId].map(clean).filter(Boolean));
}

function valuesOverlap(left, right) {
  return [...left].some((value) => right.has(value));
}

function actorNameFromAccount(account) {
  const value = clean(account);
  return value.endsWith(" ACTOR_CLEARING")
    ? value.slice(0, -" ACTOR_CLEARING".length).trim()
    : value;
}

function orderMatchesActors(order, allowedActors) {
  return [order?.broker, order?.agent]
    .map(normalized)
    .some((actorName) => actorName && allowedActors.has(actorName));
}

function allOrderRecords(state = {}) {
  return [
    ...asArray(state.orders).map((order) => ({ order, live: true })),
    ...asArray(state.archives).flatMap((archive) =>
      asArray(archive?.orders).map((order) => ({ order, live: false }))
    ),
  ].filter(({ order }) => order && typeof order === "object");
}

function targetMap() {
  return new Map(galaxyOpenOrderCleanupTargets.map(({ journal, actors }) => [
    journal,
    new Set(actors.map(normalized)),
  ]));
}

/**
 * Applies the explicitly approved Galaxy Workspace repair. Only open ORDER_*
 * accounting is removed. Closed report snapshots, archived ledger rows, and
 * archived receivables remain untouched.
 */
export function removeGalaxySpecifiedOpenOrders(state = {}, workspaceName = "") {
  if (normalized(workspaceName) !== "galaxy workspace") {
    return {
      removedCount: 0,
      removedLedgerLineCount: 0,
      removedReceivableCount: 0,
      removedOrderIds: [],
      journals: [],
    };
  }

  const targets = targetMap();
  const records = allOrderRecords(state);
  const openOrderLines = asArray(state.ledger).filter((line) =>
    line?.archived !== true && clean(line?.source).startsWith("ORDER_")
  );
  const eligibleJournals = new Set();
  const candidateOrderIds = new Set();

  targets.forEach((allowedActors, journal) => {
    const matchingRecords = records.filter(({ order }) =>
      clean(order?.journal) === journal && orderMatchesActors(order, allowedActors)
    );
    const matchingRecordIds = new Set(
      matchingRecords.flatMap(({ order }) => [...ownOrderIds(order)])
    );
    const linkedLines = openOrderLines.filter((line) =>
      clean(line?.journal) === journal
      || (clean(line?.orderId) && matchingRecordIds.has(clean(line.orderId)))
    );
    if (!linkedLines.length) return;

    const actorEvidence = matchingRecords.length > 0 || linkedLines.some((line) =>
      allowedActors.has(normalized(actorNameFromAccount(line?.account)))
    );
    if (!actorEvidence) return;

    eligibleJournals.add(journal);
    matchingRecordIds.forEach((id) => candidateOrderIds.add(id));
    linkedLines
      .filter((line) => clean(line?.journal) === journal)
      .map((line) => clean(line?.orderId))
      .filter(Boolean)
      .forEach((id) => candidateOrderIds.add(id));
  });

  if (!eligibleJournals.size) {
    return {
      removedCount: 0,
      removedLedgerLineCount: 0,
      removedReceivableCount: 0,
      removedOrderIds: [],
      journals: [],
    };
  }

  const protectedOrderIds = new Set(
    records
      .filter(({ order }) => !eligibleJournals.has(clean(order?.journal)))
      .flatMap(({ order }) => [...ownOrderIds(order)])
  );
  const removedOrderIds = [...candidateOrderIds].filter((id) => !protectedOrderIds.has(id));
  const removableOrderIds = new Set(removedOrderIds);

  const ordersBefore = asArray(state.orders);
  state.orders = ordersBefore.filter((order) =>
    !eligibleJournals.has(clean(order?.journal))
    && !valuesOverlap(ownOrderIds(order), removableOrderIds)
  );

  const ledgerBefore = asArray(state.ledger);
  state.ledger = ledgerBefore.filter((line) => {
    if (line?.archived === true || !clean(line?.source).startsWith("ORDER_")) return true;
    const orderId = clean(line?.orderId);
    return !eligibleJournals.has(clean(line?.journal))
      && !(orderId && removableOrderIds.has(orderId));
  });

  const receivablesBefore = asArray(state.receivables);
  state.receivables = receivablesBefore.filter((receivable) => {
    if (clean(receivable?.archivedAt)) return true;
    const orderId = clean(receivable?.orderId);
    return !eligibleJournals.has(clean(receivable?.journal))
      && !(orderId && removableOrderIds.has(orderId));
  });

  state.deletedOrderIds = Array.from(new Set([
    ...asArray(state.deletedOrderIds).map(clean).filter(Boolean),
    ...removedOrderIds,
  ]));
  recalculateSettlementsFromLedger(state);

  return {
    removedCount: ordersBefore.length - state.orders.length,
    removedLedgerLineCount: ledgerBefore.length - state.ledger.length,
    removedReceivableCount: receivablesBefore.length - state.receivables.length,
    removedOrderIds,
    journals: [...eligibleJournals],
  };
}
