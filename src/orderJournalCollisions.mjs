function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableOrderIds(order = {}) {
  return new Set([
    order.id,
    order.internalOrderId,
    order.collisionSourceOrderId,
  ].map(clean).filter(Boolean));
}

function valuesOverlap(left, right) {
  return [...left].some((value) => right.has(value));
}

// A shared hidden ID means these are copies of one order. We intentionally do
// not split copies with the same ID but inconsistent accounting values: that is
// historic data damage, not a collision that can be safely renamed.
function sameOrderRecord(left = {}, right = {}) {
  const leftIds = stableOrderIds(left);
  const rightIds = stableOrderIds(right);
  if (leftIds.size && rightIds.size) return valuesOverlap(leftIds, rightIds);

  const leftBroker = clean(left.brokerActorId || left.broker).toLocaleLowerCase();
  const rightBroker = clean(right.brokerActorId || right.broker).toLocaleLowerCase();
  const leftNumber = clean(left.brokerOrderNumber);
  const rightNumber = clean(right.brokerOrderNumber);
  const leftCreated = clean(left.createdAt || left.sentAt);
  const rightCreated = clean(right.createdAt || right.sentAt);
  return Boolean(
    leftBroker && leftBroker === rightBroker &&
    leftNumber && leftNumber === rightNumber &&
    (!leftCreated || !rightCreated || leftCreated === rightCreated)
  );
}

function allOrders(state = {}) {
  return [
    ...asArray(state.orders),
    ...asArray(state.archives).flatMap((archive) => asArray(archive?.orders)),
  ];
}

function allReceivables(state = {}) {
  return [
    ...asArray(state.receivables),
    ...asArray(state.archives).flatMap((archive) => asArray(archive?.receivables)),
  ];
}

function allLedger(state = {}) {
  return [
    ...asArray(state.ledger),
    ...asArray(state.archives).flatMap((archive) => asArray(archive?.ledger)),
  ];
}

function journalBase(journal) {
  return clean(journal).replace(/\s+\(\d+\)$/, "");
}

function orderMoment(order = {}) {
  const timestamp = new Date(order.paidAt || order.voidedAt || order.createdAt || order.sentAt || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Number.MAX_SAFE_INTEGER;
}

function orderSortKey(order = {}) {
  return [
    String(orderMoment(order)).padStart(16, "0"),
    [...stableOrderIds(order)].sort().join("|"),
    clean(order.brokerOrderNumber),
    clean(order.broker),
  ].join("|");
}

function journalValues(state = {}) {
  const values = new Set();
  const add = (value) => {
    const journal = clean(value);
    if (journal) values.add(journal);
  };
  allOrders(state).forEach((order) => {
    add(order?.journal);
    add(order?.voidJournal);
  });
  allReceivables(state).forEach((receivable) => {
    add(receivable?.journal);
    add(receivable?.voidJournal);
  });
  allLedger(state).forEach((line) => add(line?.journal));
  asArray(state.transfers).forEach((transfer) => {
    add(transfer?.journal);
    add(transfer?.reversalJournal);
  });
  asArray(state.archives).flatMap((archive) => asArray(archive?.transfers)).forEach((transfer) => {
    add(transfer?.journal);
    add(transfer?.reversalJournal);
  });
  return values;
}

function nextDuplicateJournal(base, used) {
  let suffix = 1;
  let candidate = `${base} (${suffix})`;
  while (used.has(candidate)) candidate = `${base} (${++suffix})`;
  used.add(candidate);
  return candidate;
}

function lineBelongsToOrderGroup(line, orderIds, source) {
  if (clean(line?.source) !== source) return false;
  const orderId = clean(line?.orderId);
  return Boolean(orderId && orderIds.has(orderId));
}

function renameOrderGroup(state, group, duplicateJournal, replacement) {
  const entriesForField = (field) => group.filter((entry) => entry.field === field);
  const sourceOrdersForField = (field) => entriesForField(field).map((entry) => entry.order);
  const orderIdsForField = (field) => new Set(sourceOrdersForField(field)
    .flatMap((order) => [...stableOrderIds(order)]));
  const paymentOrderIds = orderIdsForField("journal");
  const voidOrderIds = orderIdsForField("voidJournal");
  let changed = 0;

  allOrders(state).forEach((order) => {
    ["journal", "voidJournal"].forEach((field) => {
      if (!sourceOrdersForField(field).some((source) => sameOrderRecord(source, order))) return;
      if (clean(order?.[field]) !== duplicateJournal) return;
      order[field] = replacement;
      if (field === "journal") order.journalCollisionBase = journalBase(duplicateJournal);
      changed += 1;
    });
  });
  allReceivables(state).forEach((receivable) => {
    const orderId = clean(receivable?.orderId);
    [
      ["journal", paymentOrderIds],
      ["voidJournal", voidOrderIds],
    ].forEach(([field, orderIds]) => {
      if (!orderIds.has(orderId) || clean(receivable?.[field]) !== duplicateJournal) return;
      receivable[field] = replacement;
      changed += 1;
    });
  });
  allLedger(state).forEach((line) => {
    if (clean(line?.journal) !== duplicateJournal) return;
    const belongsToPayment = lineBelongsToOrderGroup(line, paymentOrderIds, "ORDER_PAYMENT");
    const belongsToVoid = lineBelongsToOrderGroup(line, voidOrderIds, "ORDER_VOID");
    if (!belongsToPayment && !belongsToVoid) return;
    line.journal = replacement;
    changed += 1;
  });
  return changed;
}

/**
 * Renames only provably distinct orders that have been assigned one journal ID.
 * Copies of the same order stay together. Ambiguous same-ID corruption remains
 * visible to the close guard instead of altering financial history.
 */
export function repairOrderJournalCollisions(state = {}) {
  const entriesByJournal = new Map();
  allOrders(state).forEach((order, index) => {
    if (!order || typeof order !== "object") return;
    ["journal", "voidJournal"].forEach((field) => {
      const journal = clean(order[field]);
      if (!journal) return;
      const entries = entriesByJournal.get(journal) || [];
      entries.push({ order, field, index });
      entriesByJournal.set(journal, entries);
    });
  });

  const used = journalValues(state);
  const repairs = [];
  entriesByJournal.forEach((entries, duplicateJournal) => {
    if (entries.length < 2) return;
    const groups = [];
    entries.forEach((entry) => {
      const matchingGroups = groups.filter((group) => group.some((candidate) => sameOrderRecord(candidate.order, entry.order)));
      if (!matchingGroups.length) {
        groups.push([entry]);
        return;
      }
      const primary = matchingGroups[0];
      primary.push(entry);
      matchingGroups.slice(1).forEach((other) => {
        other.forEach((candidate) => primary.push(candidate));
        groups.splice(groups.indexOf(other), 1);
      });
    });
    if (groups.length < 2) return;
    groups.sort((left, right) => orderSortKey(left[0].order).localeCompare(orderSortKey(right[0].order)));
    const base = journalBase(duplicateJournal);
    groups.slice(1).forEach((group) => {
      const journal = nextDuplicateJournal(base, used);
      const changed = renameOrderGroup(state, group, duplicateJournal, journal);
      if (changed) repairs.push({ from: duplicateJournal, to: journal, records: changed });
    });
  });
  return { repairedCount: repairs.length, repairs };
}
