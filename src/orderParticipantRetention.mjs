const completedOrderStates = new Set(["Paid", "Voided"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLocaleLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sameName(left, right) {
  const value = normalized(left);
  return Boolean(value && value === normalized(right));
}

function orderIsCompleted(order) {
  return completedOrderStates.has(clean(order?.state));
}

function orderStableIds(order) {
  return new Set([
    clean(order?.id),
    clean(order?.internalOrderId),
    clean(order?.collisionSourceOrderId),
  ].filter(Boolean));
}

function orderJournal(order) {
  return clean(order?.journal);
}

function recordsMatchOrder(left, right) {
  const leftJournal = orderJournal(left);
  const rightJournal = orderJournal(right);
  if (leftJournal && rightJournal) return leftJournal === rightJournal;
  const rightIds = orderStableIds(right);
  return Array.from(orderStableIds(left)).some((id) => rightIds.has(id));
}

function orderMatchesLedgerLine(order, line) {
  const lineJournal = clean(line?.journal);
  const candidateJournal = orderJournal(order);
  if (lineJournal && candidateJournal) return lineJournal === candidateJournal;
  const lineOrderId = clean(line?.orderId);
  return Boolean(lineOrderId && orderStableIds(order).has(lineOrderId));
}

function actorNameFromAccount(account) {
  const value = clean(account);
  if (!value) return "";
  return value.endsWith(" ACTOR_CLEARING")
    ? value.slice(0, -" ACTOR_CLEARING".length).trim()
    : value;
}

function actorForIdentity(actors, actorId, actorName) {
  const id = clean(actorId);
  if (id) return actors.find((actor) => clean(actor?.id) === id);
  return actors.find((actor) => sameName(actor?.name, actorName));
}

function paymentLineIsForNonMasterActor(line, actors) {
  if (line?.source !== "ORDER_PAYMENT") return false;
  const account = clean(line?.account);
  if (!account || account.startsWith("MASTER_")) return false;
  const actorName = actorNameFromAccount(account);
  const actor = actorForIdentity(actors, line?.actorId, actorName);
  return clean(actor?.role) !== "Master" &&
    !sameName(actorName, "Master") &&
    !sameName(actorName, "Master Transactions");
}

function participantForRole(order, role, actors) {
  const actorId = clean(role === "broker" ? order?.brokerActorId : order?.agentActorId);
  const actorName = clean(role === "broker" ? order?.broker : order?.agent);
  if (!actorId && !actorName) return null;
  if (role === "agent" && ["unassigned", "cancelled"].includes(normalized(actorName))) return null;
  const actor = actorForIdentity(actors, actorId, actorName);
  if (clean(actor?.role) === "Master" || sameName(actorName, "Master") || sameName(actorName, "Master Transactions")) return null;
  return { role, actorId, actorName: actorName || clean(actor?.name) };
}

function participantIdentitiesMatch(left, right) {
  if (left?.actorId || right?.actorId) {
    return Boolean(left?.actorId && right?.actorId && left.actorId === right.actorId);
  }
  return Boolean(left?.actorName && right?.actorName && sameName(left.actorName, right.actorName));
}

function orderParticipants(order, actors) {
  const participants = [
    participantForRole(order, "broker", actors),
    participantForRole(order, "agent", actors),
  ].filter(Boolean);
  return participants.filter((participant, index) =>
    participants.findIndex((candidate) => participantIdentitiesMatch(candidate, participant)) === index
  );
}

function archiveIdentity(archive) {
  return { actorId: clean(archive?.actorId), actorName: clean(archive?.actor) };
}

function archiveBelongsToParticipant(archive, participant, actors) {
  if (!archive || archive?.kind === "master-transactions" || clean(archive?.actorRole) === "Master") return false;
  const identity = archiveIdentity(archive);
  const actor = actorForIdentity(actors, identity.actorId, identity.actorName);
  if (clean(actor?.role) === "Master" || sameName(identity.actorName, "Master")) return false;
  return participantIdentitiesMatch(identity, participant);
}

function valuesConflict(orders, selector, normalizeValue = clean) {
  const values = new Set(orders
    .map((order) => selector(order))
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(normalizeValue));
  return values.size > 1;
}

function participantFactsConflict(orders, idField, nameField) {
  const ids = new Set(orders.map((order) => clean(order?.[idField])).filter(Boolean));
  if (ids.size > 1) return true;
  if (ids.size === 1) return false;
  return valuesConflict(orders, (order) => order?.[nameField], normalized);
}

function archivedSnapshotsConflict(orders) {
  if (orders.length < 2) return false;
  if (participantFactsConflict(orders, "brokerActorId", "broker")) return true;
  if (participantFactsConflict(orders, "agentActorId", "agent")) return true;
  const textFields = [
    "journal",
    "brokerOrderNumber",
    "sourceCurrency",
    "payoutCurrency",
    "state",
    "voidJournal",
  ];
  if (textFields.some((field) => valuesConflict(orders, (order) => order?.[field]))) return true;
  const numericFields = [
    "sourceAmountMinor",
    "payoutAmountMinor",
    "commissionMinor",
    "grossMinor",
  ];
  return numericFields.some((field) => valuesConflict(
    orders,
    (order) => order?.[field],
    (value) => Number(value)
  ));
}

function snapshotCompleteness(order) {
  return [
    order?.journal,
    order?.id,
    order?.internalOrderId,
    order?.brokerActorId,
    order?.agentActorId,
    order?.brokerOrderNumber,
    order?.agentOrderNumber,
    order?.broker,
    order?.agent,
    order?.sourceCurrency,
    order?.sourceAmountMinor,
    order?.payoutCurrency,
    order?.payoutAmountMinor,
    order?.senderName,
    order?.receiverName,
    order?.accountNumber,
    order?.phoneNumber,
    order?.paidAt,
  ].filter((value) => value !== undefined && value !== null && value !== "").length;
}

function archivedOrders(archives) {
  return asArray(archives).flatMap((archive) =>
    asArray(archive?.orders).map((order) => ({ archive, order }))
  );
}

/**
 * Resolves one completed order for an Actor payment line. A shared journal is the
 * primary identity; stable hidden IDs are used only when one side has no journal.
 */
export function resolveParticipantOrderForLedgerLine(line, liveOrders = [], archives = []) {
  const candidates = [
    ...asArray(liveOrders).map((order) => ({ source: "live", archive: null, order })),
    ...archivedOrders(archives).map(({ archive, order }) => ({ source: "archive", archive, order })),
  ].filter(({ order }) => orderIsCompleted(order) && orderMatchesLedgerLine(order, line));
  if (!candidates.length) {
    return { order: null, source: "", archive: null, conflict: false, reason: "not-found" };
  }
  const archived = candidates.filter((candidate) => candidate.source === "archive").map((candidate) => candidate.order);
  if (archivedSnapshotsConflict(archived) || archivedSnapshotsConflict(candidates.map((candidate) => candidate.order))) {
    return { order: null, source: "", archive: null, conflict: true, reason: "conflicting-snapshots" };
  }
  const selected = candidates.slice().sort((left, right) => {
    if (left.source !== right.source) return left.source === "live" ? -1 : 1;
    return snapshotCompleteness(right.order) - snapshotCompleteness(left.order);
  })[0];
  return { ...selected, conflict: false, reason: "" };
}

function lineMatchesParticipant(line, participant, actors) {
  const lineActorName = actorNameFromAccount(line?.account);
  const lineActorId = clean(line?.actorId || actorForIdentity(actors, "", lineActorName)?.id);
  if (participant.actorId && lineActorId) return participant.actorId === lineActorId;
  return Boolean(participant.actorName && lineActorName && sameName(participant.actorName, lineActorName));
}

/** Returns whether an unarchived Actor payment line still belongs to this order. */
export function orderHasOpenParticipantLine(order, workspaceState = {}) {
  const actors = asArray(workspaceState?.actors);
  const participants = orderParticipants(order, actors);
  return asArray(workspaceState?.ledger).some((line) =>
    line?.archived !== true &&
    paymentLineIsForNonMasterActor(line, actors) &&
    orderMatchesLedgerLine(order, line) &&
    participants.some((participant) => lineMatchesParticipant(line, participant, actors))
  );
}

/**
 * Reports whether every distinct Broker/Agent participant has this completed order
 * in their own archive. Actor IDs take priority; names are legacy fallback only.
 */
export function participantArchiveCoverage(order, workspaceState = {}) {
  const actors = asArray(workspaceState?.actors);
  const archives = asArray(workspaceState?.archives);
  const participants = orderParticipants(order, actors);
  const participantResults = participants.map((participant) => {
    const matches = archives
      .filter((archive) => archiveBelongsToParticipant(archive, participant, actors))
      .flatMap((archive) => asArray(archive?.orders)
        .filter((snapshot) => orderIsCompleted(snapshot) && recordsMatchOrder(order, snapshot))
        .map((snapshot) => ({ archive, snapshot }))
      );
    return {
      ...participant,
      covered: matches.length > 0 && !archivedSnapshotsConflict(matches.map((match) => match.snapshot)),
      archiveIds: matches.map((match) => clean(match.archive?.id)).filter(Boolean),
      snapshots: matches.map((match) => match.snapshot),
    };
  });
  const allSnapshots = participantResults.flatMap((participant) => participant.snapshots);
  const conflict = archivedSnapshotsConflict(allSnapshots);
  return {
    complete: participants.length > 0 && !conflict && participantResults.every((participant) => participant.covered),
    conflict,
    participants: participantResults.map(({ snapshots, ...participant }) => participant),
  };
}

function liveOrderConflictsWithRecovery(liveOrder, sourceOrder, canonicalId) {
  if (recordsMatchOrder(liveOrder, sourceOrder)) return !orderIsCompleted(liveOrder);
  return Boolean(canonicalId && orderStableIds(liveOrder).has(canonicalId));
}

function liveOrderFromArchive(sourceOrder, line) {
  const recovered = {
    ...sourceOrder,
    agentOrderNumbers: sourceOrder?.agentOrderNumbers && typeof sourceOrder.agentOrderNumbers === "object"
      ? { ...sourceOrder.agentOrderNumbers }
      : {},
    agentOrderNumberCycles: sourceOrder?.agentOrderNumberCycles && typeof sourceOrder.agentOrderNumberCycles === "object"
      ? { ...sourceOrder.agentOrderNumberCycles }
      : {},
  };
  const sourceId = clean(sourceOrder?.id || sourceOrder?.internalOrderId);
  const canonicalId = clean(line?.orderId || sourceId);
  if (canonicalId) {
    recovered.id = canonicalId;
    recovered.internalOrderId = canonicalId;
  }
  if (sourceId && canonicalId && sourceId !== canonicalId) recovered.collisionSourceOrderId = sourceId;
  delete recovered.actor;
  delete recovered.archiveId;
  delete recovered.archivedAt;
  delete recovered.locked;
  return recovered;
}

function conflictRecord(line, reason) {
  return {
    journal: clean(line?.journal),
    orderId: clean(line?.orderId),
    actor: actorNameFromAccount(line?.account),
    reason,
  };
}

/**
 * Keeps completed live orders until every participant owns an archive snapshot and
 * recovers a missing live order only when an unarchived participant payment line
 * proves that participant still needs to close. All accounting arrays are read-only.
 */
export function retainOrdersForOpenParticipants(workspaceState = {}) {
  const tombstones = new Set(asArray(workspaceState?.deletedOrderIds).map(clean).filter(Boolean));
  const orderIsTombstoned = (order) => Array.from(orderStableIds(order)).some((id) => tombstones.has(id));
  const removedOrderIds = [];
  const inputOrders = asArray(workspaceState?.orders).filter((order) => {
    if (!orderIsTombstoned(order)) return true;
    removedOrderIds.push(clean(order?.id || order?.internalOrderId));
    return false;
  });
  const archives = asArray(workspaceState?.archives);
  const actors = asArray(workspaceState?.actors);
  const nextOrders = [...inputOrders];
  const recoveredOrderIds = [];
  const skippedConflicts = [];

  asArray(workspaceState?.ledger)
    .filter((line) => line?.archived !== true && paymentLineIsForNonMasterActor(line, actors))
    .forEach((line) => {
      const liveMatch = resolveParticipantOrderForLedgerLine(line, nextOrders, []);
      if (liveMatch.order) return;
      if (liveMatch.conflict) {
        skippedConflicts.push(conflictRecord(line, liveMatch.reason));
        return;
      }

      const source = resolveParticipantOrderForLedgerLine(line, [], archives);
      if (!source.order) {
        if (source.conflict) skippedConflicts.push(conflictRecord(line, source.reason));
        return;
      }
      if (tombstones.has(clean(line?.orderId)) || orderIsTombstoned(source.order)) return;
      const participants = orderParticipants(source.order, actors);
      const lineParticipants = participants.filter((participant) => lineMatchesParticipant(line, participant, actors));
      if (lineParticipants.length !== 1) {
        skippedConflicts.push(conflictRecord(line, "participant-identity-conflict"));
        return;
      }
      const targetCoverage = participantArchiveCoverage(source.order, workspaceState).participants
        .find((participant) => participantIdentitiesMatch(participant, lineParticipants[0]));
      if (targetCoverage?.covered) return;

      const canonicalId = clean(line?.orderId || source.order?.id || source.order?.internalOrderId);
      if (nextOrders.some((order) => liveOrderConflictsWithRecovery(order, source.order, canonicalId))) {
        skippedConflicts.push(conflictRecord(line, "live-order-identity-conflict"));
        return;
      }
      const recovered = liveOrderFromArchive(source.order, line);
      if (orderIsTombstoned(recovered)) return;
      nextOrders.push(recovered);
      recoveredOrderIds.push(clean(recovered.id || recovered.internalOrderId));
    });

  const orders = nextOrders.filter((order) => {
    if (orderIsTombstoned(order)) {
      removedOrderIds.push(clean(order?.id || order?.internalOrderId));
      return false;
    }
    if (!orderIsCompleted(order)) return true;
    const coverage = participantArchiveCoverage(order, workspaceState);
    if (!coverage.complete || coverage.conflict || orderHasOpenParticipantLine(order, workspaceState)) return true;
    removedOrderIds.push(clean(order?.id || order?.internalOrderId));
    return false;
  });

  const uniqueConflicts = Array.from(new Map(skippedConflicts.map((conflict) => [
    [conflict.journal, conflict.orderId, conflict.actor, conflict.reason].join("|"),
    conflict,
  ])).values());
  return {
    orders,
    recoveredCount: recoveredOrderIds.length,
    recoveredOrderIds,
    removedCount: removedOrderIds.length,
    removedOrderIds,
    skippedConflictCount: uniqueConflicts.length,
    skippedConflicts: uniqueConflicts,
  };
}
