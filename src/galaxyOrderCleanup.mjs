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
const repairPostedAt = "2026-08-20T15:25:50.000Z";

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

function actorNameMatches(value, allowedActor) {
  const candidate = normalized(value);
  const allowed = normalized(allowedActor);
  return Boolean(
    candidate && allowed && (
      candidate === allowed
      || candidate.split("/")[0].trim() === allowed
    )
  );
}

function orderMatchesActors(order, allowedActors) {
  return [order?.broker, order?.agent]
    .some((actorName) => [...allowedActors].some((allowed) => actorNameMatches(actorName, allowed)));
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

function isGalaxyWorkspace(workspaceName) {
  const compact = normalized(workspaceName).replace(/[^a-z0-9]+/g, "");
  return compact === "galaxy" || compact === "galaxyworkspace";
}

function correctionKey(journal, actorName, currency) {
  return ["GALAXY-DUPLICATE-ORDER", clean(journal), normalized(actorName), clean(currency)].join(":");
}

function correctionJournal(journal, actorName, currency) {
  const safe = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `CORR-${safe(journal)}-${safe(actorName)}-${safe(currency)}`;
}

function currentActorForApprovedName(state, approvedName) {
  return asArray(state.actors).find((actor) =>
    actor?.active !== false
    && clean(actor?.role) !== "Master"
    && actorNameMatches(actor?.name, approvedName)
  ) || null;
}

function archivedCorrectionLines(state, targets) {
  const ledger = asArray(state.ledger);
  const existingKeys = new Set(ledger.map((line) => clean(line?.repairKey)).filter(Boolean));
  const corrections = [];

  targets.forEach((allowedActors, journal) => {
    allowedActors.forEach((approvedName) => {
      const actor = currentActorForApprovedName(state, approvedName);
      if (!actor) return;
      const balances = new Map();
      ledger.forEach((line) => {
        if (
          line?.archived !== true
          || clean(line?.source) !== "ORDER_PAYMENT"
          || clean(line?.journal) !== journal
          || line?.voided === true
          || line?.excludedFromCalculations === true
          || !actorNameMatches(actorNameFromAccount(line?.account), approvedName)
        ) return;
        const currency = clean(line?.currency);
        if (!currency) return;
        const sign = clean(line?.direction) === "Debit" ? 1 : -1;
        balances.set(currency, Number(balances.get(currency) || 0) + sign * Number(line?.amountMinor || 0));
      });

      balances.forEach((netMinor, currency) => {
        if (!Number.isFinite(netMinor) || netMinor === 0) return;
        const repairKey = correctionKey(journal, approvedName, currency);
        if (existingKeys.has(repairKey)) return;
        const amountMinor = Math.abs(netMinor);
        const actorDirection = netMinor > 0 ? "Credit" : "Debit";
        const masterDirection = actorDirection === "Debit" ? "Credit" : "Debit";
        const correctionId = correctionJournal(journal, approvedName, currency);
        const details = `Balance correction for duplicate order ${journal}; closed report retained unchanged`;
        corrections.push(
          {
            journal: correctionId,
            entryId: correctionId,
            repairKey,
            source: "DUPLICATE_ORDER_CORRECTION",
            account: `${actor.name} ACTOR_CLEARING`,
            direction: actorDirection,
            currency,
            amountMinor,
            details,
            postedAt: repairPostedAt,
          },
          {
            journal: correctionId,
            entryId: correctionId,
            repairKey,
            source: "DUPLICATE_ORDER_CORRECTION",
            account: "MASTER_DUPLICATE_ORDER_CORRECTION",
            direction: masterDirection,
            currency,
            amountMinor,
            details,
            postedAt: repairPostedAt,
          }
        );
        existingKeys.add(repairKey);
      });
    });
  });
  return corrections;
}

/**
 * Applies the explicitly approved Galaxy Workspace repair. Open ORDER_* rows
 * are removed directly. When an approved duplicate is already inside a closed
 * period, a one-time current-period correction removes its balance effect while
 * the closed report and every archived row remain unchanged.
 */
export function removeGalaxySpecifiedOpenOrders(state = {}, workspaceName = "") {
  if (!isGalaxyWorkspace(workspaceName)) {
    return {
      removedCount: 0,
      removedLedgerLineCount: 0,
      removedReceivableCount: 0,
      correctionLineCount: 0,
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

    eligibleJournals.add(journal);
    matchingRecordIds.forEach((id) => candidateOrderIds.add(id));
    linkedLines
      .filter((line) => clean(line?.journal) === journal)
      .map((line) => clean(line?.orderId))
      .filter(Boolean)
      .forEach((id) => candidateOrderIds.add(id));
  });

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
  const correctionLines = archivedCorrectionLines(state, targets);
  if (correctionLines.length) state.ledger.unshift(...correctionLines);
  const removedCount = ordersBefore.length - state.orders.length;
  const removedLedgerLineCount = ledgerBefore.length - state.ledger.length + correctionLines.length;
  const removedReceivableCount = receivablesBefore.length - state.receivables.length;
  if (removedCount || removedLedgerLineCount || removedReceivableCount || correctionLines.length) {
    recalculateSettlementsFromLedger(state);
  }

  return {
    removedCount,
    removedLedgerLineCount,
    removedReceivableCount,
    correctionLineCount: correctionLines.length,
    removedOrderIds,
    journals: [...eligibleJournals],
  };
}
