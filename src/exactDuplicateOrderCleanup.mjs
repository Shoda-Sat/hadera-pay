import { resolveParticipantOrderForLedgerLine } from "./orderParticipantRetention.mjs";

const supportedCurrencies = ["USD", "ETB", "EUR", "ERN", "SSP", "SDG", "LYD"];

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

function allOrderIds(order = {}) {
  return new Set([
    ...ownOrderIds(order),
    clean(order?.collisionSourceOrderId),
  ].filter(Boolean));
}

function valuesOverlap(left, right) {
  return [...left].some((value) => right.has(value));
}

function participantMatches(left, right, role) {
  const idField = role === "broker" ? "brokerActorId" : "agentActorId";
  const nameField = role === "broker" ? "broker" : "agent";
  const leftId = clean(left?.[idField]);
  const rightId = clean(right?.[idField]);
  if (leftId && rightId) return leftId === rightId;
  return normalized(left?.[nameField]) === normalized(right?.[nameField]);
}

function numericValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizedFundingType(value) {
  return normalized(value || "cash");
}

function normalizedCommissionLiability(order = {}) {
  const explicit = normalized(order?.orderCommissionLiability);
  if (explicit) return explicit;
  return numericValue(order?.commissionPercent) < 0 || numericValue(order?.commissionMinor) < 0
    ? "master"
    : "broker";
}

function orderDetailsExactlyMatch(left = {}, right = {}) {
  if (!participantMatches(left, right, "broker") || !participantMatches(left, right, "agent")) return false;

  const textFields = [
    "senderName",
    "receiverName",
    "receiverCity",
    "accountNumber",
    "phoneNumber",
    "remarks",
    "sourceCurrency",
    "payoutCurrency",
  ];
  if (textFields.some((field) => normalized(left?.[field]) !== normalized(right?.[field]))) return false;

  const numericFields = [
    "sourceAmountMinor",
    "payoutAmountMinor",
    "rate",
    "commissionPercent",
    "commissionMinor",
    "grossMinor",
    "forwardedPayoutDivider",
    "forwardedPayoutPercent",
    "manualSpecialPayoutDivider",
    "manualSpecialPayoutPercent",
    "manualMasterRateDivider",
    "manualMasterRatePercent",
  ];
  if (numericFields.some((field) => numericValue(left?.[field]) !== numericValue(right?.[field]))) return false;

  return normalizedFundingType(left?.fundingType) === normalizedFundingType(right?.fundingType)
    && normalizedCommissionLiability(left) === normalizedCommissionLiability(right);
}

function baseJournalForDuplicate(journal) {
  const match = clean(journal).match(/^(.*?)\s+\(1\)$/);
  return match ? clean(match[1]) : "";
}

function orderHasServerResolvedJournalCollision(order, baseJournal) {
  return Boolean(
    clean(order?.journalCollisionBase)
    && clean(order.journalCollisionBase) === clean(baseJournal)
  );
}

function allOrderRecords(state = {}) {
  return [
    ...asArray(state.orders).map((order) => ({ order, live: true })),
    ...asArray(state.archives).flatMap((archive) =>
      asArray(archive?.orders).map((order) => ({ order, live: false }))
    ),
  ].filter(({ order }) => order && typeof order === "object");
}

function orderIsVoided(order) {
  return Boolean(
    order && (
      clean(order?.state) === "Voided"
      || order?.voided === true
      || order?.excludedFromCalculations === true
      || clean(order?.voidJournal)
      || clean(order?.voidedAt)
    )
  );
}

function lineIsForVoidedOrder(state, line) {
  if (line?.voided === true || line?.excludedFromCalculations === true) return true;
  if (clean(line?.source) !== "ORDER_PAYMENT") return false;
  const resolved = resolveParticipantOrderForLedgerLine(line, state.orders, state.archives, state);
  return !resolved.conflict && orderIsVoided(resolved.order);
}

export function recalculateSettlementsFromLedger(state = {}) {
  const actors = asArray(state.actors).filter((actor) => actor?.active !== false);
  const balances = new Map(
    actors
      .filter((actor) => clean(actor?.role) !== "Master")
      .map((actor) => [clean(actor?.name), {}])
  );
  const actorsByAccount = new Map();
  actors.forEach((actor) => {
    const name = clean(actor?.name);
    if (!name || clean(actor?.role) === "Master") return;
    actorsByAccount.set(name, actor);
    actorsByAccount.set(`${name} ACTOR_CLEARING`, actor);
  });

  asArray(state.ledger).forEach((line) => {
    if (line?.archived === true || lineIsForVoidedOrder(state, line)) return;
    const actor = actorsByAccount.get(clean(line?.account));
    const actorName = clean(actor?.name);
    const currency = clean(line?.currency);
    if (!actorName || !currency) return;
    const sign = clean(line?.direction) === "Debit" ? 1 : -1;
    const actorBalances = balances.get(actorName) || {};
    actorBalances[currency] = numericValue(actorBalances[currency]) + sign * numericValue(line?.amountMinor);
    balances.set(actorName, actorBalances);
  });

  state.settlements = [];
  actors.forEach((actor) => {
    if (clean(actor?.role) === "Master") return;
    const actorName = clean(actor?.name);
    supportedCurrencies.forEach((currency) => {
      const netMinor = numericValue(balances.get(actorName)?.[currency]);
      if (netMinor !== 0 || currency === clean(actor?.currency)) {
        state.settlements.push({ actor: actorName, currency, netMinor });
      }
    });
  });
  return state.settlements;
}

function duplicateGroups(state) {
  const records = allOrderRecords(state);
  const recordsByJournal = new Map();
  records.forEach((record) => {
    const journal = clean(record.order?.journal);
    if (!journal) return;
    const entries = recordsByJournal.get(journal) || [];
    entries.push(record);
    recordsByJournal.set(journal, entries);
  });

  const groups = [];
  recordsByJournal.forEach((candidates, duplicateJournal) => {
    const baseJournal = baseJournalForDuplicate(duplicateJournal);
    if (!baseJournal) return;
    const originals = recordsByJournal.get(baseJournal) || [];
    const protectedOrderIds = new Set(candidates
      .filter(({ order }) => orderHasServerResolvedJournalCollision(order, baseJournal))
      .flatMap(({ order }) => [...ownOrderIds(order)]));
    const removableCandidates = candidates.filter(({ order }) =>
      !orderHasServerResolvedJournalCollision(order, baseJournal)
      && !valuesOverlap(ownOrderIds(order), protectedOrderIds)
    );
    const candidate = removableCandidates.find(({ order }) =>
      originals.some(({ order: original }) => orderDetailsExactlyMatch(order, original))
    );
    if (!candidate) return;
    const original = originals.find(({ order }) => orderDetailsExactlyMatch(candidate.order, order));
    if (!original) return;
    const matchingCandidates = removableCandidates.filter(({ order }) => orderDetailsExactlyMatch(order, original.order));
    groups.push({
      duplicateJournal,
      baseJournal,
      candidates: matchingCandidates,
      originals: originals.filter(({ order }) => orderDetailsExactlyMatch(candidate.order, order)),
    });
  });
  return groups;
}

function groupHasOpenEffects(state, group) {
  if (group.candidates.some((candidate) => candidate.live)) return true;
  const orderIds = new Set(group.candidates.flatMap(({ order }) => [...ownOrderIds(order)]));
  const voidJournals = new Set(group.candidates.map(({ order }) => clean(order?.voidJournal)).filter(Boolean));
  const linked = (record) => {
    const journal = clean(record?.journal);
    const orderId = clean(record?.orderId);
    return journal === group.duplicateJournal || voidJournals.has(journal) || (orderId && orderIds.has(orderId));
  };
  return asArray(state.ledger).some((line) =>
    line?.archived !== true && clean(line?.source).startsWith("ORDER_") && linked(line)
  ) || asArray(state.receivables).some((receivable) =>
    !clean(receivable?.archivedAt) && (
      linked(receivable) || voidJournals.has(clean(receivable?.voidJournal))
    )
  );
}

function preservedJournalSet(options = {}) {
  return new Set(asArray(options?.preserveOrderJournals).map(clean).filter(Boolean));
}

function removeTombstonedOpenOrderEffects(state, options = {}) {
  const preservedJournals = preservedJournalSet(options);
  const deletedIds = new Set(asArray(state.deletedOrderIds).map(clean).filter(Boolean));
  if (!deletedIds.size) return { orders: 0, ledger: 0, receivables: 0 };

  const ordersBefore = asArray(state.orders);
  const preservedOrderIds = new Set(ordersBefore
    .filter((order) => preservedJournals.has(clean(order?.journal)))
    .flatMap((order) => [...ownOrderIds(order)]));
  preservedOrderIds.forEach((orderId) => deletedIds.delete(orderId));
  state.deletedOrderIds = asArray(state.deletedOrderIds)
    .map(clean)
    .filter((orderId) => orderId && !preservedOrderIds.has(orderId));
  state.orders = ordersBefore.filter((order) =>
    preservedJournals.has(clean(order?.journal)) || !valuesOverlap(ownOrderIds(order), deletedIds)
  );
  const ledgerBefore = asArray(state.ledger);
  state.ledger = ledgerBefore.filter((line) => !(
    line?.archived !== true
    && clean(line?.source).startsWith("ORDER_")
    && !preservedJournals.has(clean(line?.journal))
    && deletedIds.has(clean(line?.orderId))
  ));
  const receivablesBefore = asArray(state.receivables);
  state.receivables = receivablesBefore.filter((receivable) => !(
    !clean(receivable?.archivedAt)
    && !preservedJournals.has(clean(receivable?.journal))
    && deletedIds.has(clean(receivable?.orderId))
  ));
  return {
    orders: ordersBefore.length - state.orders.length,
    ledger: ledgerBefore.length - state.ledger.length,
    receivables: receivablesBefore.length - state.receivables.length,
  };
}

/**
 * Removes only open accounting effects for exact order duplicates whose journal
 * has the explicit Windows-style "(1)" suffix. Closed archive snapshots and
 * archived ledger/receivable records are never edited or removed.
 */
export function removeExactDuplicateOrders(state = {}, options = {}) {
  const preservedJournals = preservedJournalSet(options);
  const groups = duplicateGroups(state).filter((group) =>
    !preservedJournals.has(group.duplicateJournal) && groupHasOpenEffects(state, group)
  );
  if (!groups.length) {
    const tombstoned = removeTombstonedOpenOrderEffects(state, options);
    if (tombstoned.orders || tombstoned.ledger || tombstoned.receivables) {
      recalculateSettlementsFromLedger(state);
    }
    return {
      removedCount: tombstoned.orders,
      removedLedgerLineCount: tombstoned.ledger,
      removedReceivableCount: tombstoned.receivables,
      removedOrderIds: [],
      duplicateJournals: [],
    };
  }

  const duplicateJournals = new Set(groups.map((group) => group.duplicateJournal));
  const duplicateVoidJournals = new Set();
  const duplicateOwnIds = new Set();
  const canonicalIds = new Set();
  groups.forEach((group) => {
    group.candidates.forEach(({ order }) => {
      ownOrderIds(order).forEach((id) => duplicateOwnIds.add(id));
      const voidJournal = clean(order?.voidJournal);
      if (voidJournal) duplicateVoidJournals.add(voidJournal);
    });
    group.originals.forEach(({ order }) => allOrderIds(order).forEach((id) => canonicalIds.add(id)));
  });
  const removedOrderIds = [...duplicateOwnIds].filter((id) => !canonicalIds.has(id));
  const removableDuplicateIds = new Set(removedOrderIds);

  const liveOrdersBefore = asArray(state.orders);
  state.orders = liveOrdersBefore.filter((order) => {
    const journal = clean(order?.journal);
    if (!duplicateJournals.has(journal)) return true;
    const group = groups.find((candidate) => candidate.duplicateJournal === journal);
    return !group?.candidates.some(({ order: duplicate }) => orderDetailsExactlyMatch(order, duplicate));
  });

  const ledgerBefore = asArray(state.ledger);
  state.ledger = ledgerBefore.filter((line) => {
    if (line?.archived === true || !clean(line?.source).startsWith("ORDER_")) return true;
    const journal = clean(line?.journal);
    const orderId = clean(line?.orderId);
    return !duplicateJournals.has(journal)
      && !duplicateVoidJournals.has(journal)
      && !(orderId && removableDuplicateIds.has(orderId));
  });

  const receivablesBefore = asArray(state.receivables);
  state.receivables = receivablesBefore.filter((receivable) => {
    if (clean(receivable?.archivedAt)) return true;
    const journal = clean(receivable?.journal);
    const voidJournal = clean(receivable?.voidJournal);
    const orderId = clean(receivable?.orderId);
    return !duplicateJournals.has(journal)
      && !duplicateVoidJournals.has(voidJournal)
      && !(orderId && removableDuplicateIds.has(orderId));
  });

  state.deletedOrderIds = Array.from(new Set([
    ...asArray(state.deletedOrderIds).map(clean).filter(Boolean),
    ...removedOrderIds,
  ]));
  removeTombstonedOpenOrderEffects(state, options);
  recalculateSettlementsFromLedger(state);

  return {
    removedCount: liveOrdersBefore.length - state.orders.length,
    removedLedgerLineCount: ledgerBefore.length - state.ledger.length,
    removedReceivableCount: receivablesBefore.length - state.receivables.length,
    removedOrderIds,
    duplicateJournals: [...duplicateJournals],
  };
}
