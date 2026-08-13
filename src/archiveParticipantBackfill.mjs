function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizedName(value) {
  return cleanText(value).toLocaleLowerCase();
}

function sameName(left, right) {
  const leftName = normalizedName(left);
  return Boolean(leftName && leftName === normalizedName(right));
}

function timestampKey(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? String(timestamp) : "";
}

function actorNameFromAccount(account) {
  const value = cleanText(account);
  if (!value || value.startsWith("MASTER_")) return "";
  return value.endsWith(" ACTOR_CLEARING")
    ? value.slice(0, -" ACTOR_CLEARING".length).trim()
    : value;
}

function orderIds(order) {
  return new Set([
    cleanText(order?.id),
    cleanText(order?.internalOrderId),
  ].filter(Boolean));
}

function orderJournals(order) {
  return new Set([
    cleanText(order?.journal),
    cleanText(order?.voidJournal),
  ].filter(Boolean));
}

function orderMatchesEvidence(order, line) {
  if (!order || !line) return false;
  const evidenceOrderId = cleanText(line.orderId);
  const evidenceJournal = cleanText(line.journal);
  const ids = orderIds(order);
  const journals = orderJournals(order);
  const idMatches = Boolean(evidenceOrderId && ids.has(evidenceOrderId));
  const journalMatches = Boolean(evidenceJournal && journals.has(evidenceJournal));
  if (evidenceOrderId && evidenceJournal && ids.size && journals.size) return idMatches && journalMatches;
  return idMatches || journalMatches;
}

function snapshotCoreSignature(order) {
  return [
    cleanText(order?.id || order?.internalOrderId),
    cleanText(order?.journal),
    normalizedName(order?.broker),
    normalizedName(order?.agent),
    cleanText(order?.sourceCurrency),
    Number(order?.sourceAmountMinor || 0),
    cleanText(order?.payoutCurrency),
    Number(order?.payoutAmountMinor || 0),
  ].join("|");
}

function snapshotCompleteness(order) {
  return [
    order?.id,
    order?.internalOrderId,
    order?.brokerOrderNumber,
    order?.agentOrderNumber,
    order?.brokerActorId,
    order?.agentActorId,
    order?.broker,
    order?.agent,
    order?.senderName,
    order?.receiverName,
    order?.receiverCity,
    order?.accountNumber,
    order?.phoneNumber,
    order?.remarks,
    order?.sourceCurrency,
    order?.sourceAmountMinor,
    order?.payoutCurrency,
    order?.payoutAmountMinor,
    order?.journal,
    order?.paidAt,
  ].filter((value) => value !== undefined && value !== null && value !== "").length;
}

function sourceSnapshotForEvidence(archives, line) {
  const candidates = archives
    .flatMap((archive) => Array.isArray(archive?.orders) ? archive.orders : [])
    .filter((order) => orderMatchesEvidence(order, line));
  if (!candidates.length) return { order: null, ambiguous: false };
  const signatures = new Set(candidates.map(snapshotCoreSignature));
  if (signatures.size !== 1) return { order: null, ambiguous: true };
  const order = candidates.slice().sort((left, right) => snapshotCompleteness(right) - snapshotCompleteness(left))[0];
  return { order, ambiguous: false };
}

function actorById(actors, actorId) {
  const id = cleanText(actorId);
  return id ? actors.find((actor) => cleanText(actor?.id) === id) : undefined;
}

function actorIdByName(actors, actorName) {
  const actor = actors.find((candidate) => sameName(candidate?.name, actorName));
  return cleanText(actor?.id);
}

function participantRolesForArchive(order, archive, actors) {
  const roles = new Set();
  const archiveActorId = cleanText(archive?.actorId);
  const archiveNames = [
    cleanText(archive?.actor),
    cleanText(actorById(actors, archiveActorId)?.name),
  ].filter(Boolean);
  const brokerActorId = cleanText(order?.brokerActorId) || actorIdByName(actors, order?.broker);
  const agentActorId = cleanText(order?.agentActorId) || actorIdByName(actors, order?.agent);
  if (archiveActorId && brokerActorId && archiveActorId === brokerActorId) roles.add("broker");
  if (archiveActorId && agentActorId && archiveActorId === agentActorId) roles.add("agent");
  if ((!archiveActorId || !brokerActorId) && archiveNames.some((name) => sameName(name, order?.broker))) roles.add("broker");
  if ((!archiveActorId || !agentActorId) && archiveNames.some((name) => sameName(name, order?.agent))) roles.add("agent");
  return roles;
}

function evidenceBelongsToArchiveActor(line, order, archive, actors, roles) {
  const lineActorName = actorNameFromAccount(line?.account);
  if (!lineActorName || !roles.size) return false;
  const archiveActor = actorById(actors, archive?.actorId);
  const aliases = new Set([
    cleanText(archive?.actor),
    cleanText(archiveActor?.name),
    roles.has("broker") ? cleanText(order?.broker) : "",
    roles.has("agent") ? cleanText(order?.agent) : "",
  ].map(normalizedName).filter(Boolean));
  if (!aliases.has(normalizedName(lineActorName))) return false;
  if (roles.has("agent") && !roles.has("broker")) {
    return line?.direction === "Credit" && Number(line?.amountMinor || 0) > 0;
  }
  return Number(line?.amountMinor || 0) > 0;
}

function inferredParticipantActorId(order, role, archive, actors, archiveRoles) {
  const existing = cleanText(role === "broker" ? order?.brokerActorId : order?.agentActorId);
  if (existing) return existing;
  const participantName = role === "broker" ? order?.broker : order?.agent;
  return actorIdByName(actors, participantName) || (archiveRoles.has(role) ? cleanText(archive?.actorId) : "");
}

function repairedSnapshot(source, archive, evidence, roles, actors) {
  const payerEvidence = roles.has("agent") && evidence?.direction === "Credit";
  return {
    ...source,
    agentOrderNumbers: source?.agentOrderNumbers && typeof source.agentOrderNumbers === "object"
      ? { ...source.agentOrderNumbers }
      : {},
    agentOrderNumberCycles: source?.agentOrderNumberCycles && typeof source.agentOrderNumberCycles === "object"
      ? { ...source.agentOrderNumberCycles }
      : {},
    id: cleanText(source?.id || source?.internalOrderId || evidence?.orderId),
    internalOrderId: cleanText(source?.internalOrderId || source?.id || evidence?.orderId),
    brokerActorId: inferredParticipantActorId(source, "broker", archive, actors, roles),
    agentActorId: inferredParticipantActorId(source, "agent", archive, actors, roles),
    actor: cleanText(archive?.actor),
    journal: cleanText(source?.journal || evidence?.journal),
    payerCurrency: payerEvidence ? cleanText(evidence?.currency) : "",
    payerAmountMinor: payerEvidence ? Number(evidence?.amountMinor || 0) : 0,
    locked: true,
    archivedAt: archive?.closedAt || source?.archivedAt || "",
  };
}

/**
 * Restores order display snapshots that were lost when one participant's balance
 * was closed before the other participant's balance. The function is pure: only
 * archive.orders arrays in the returned state can differ from the input state.
 */
export function backfillClosedParticipantOrderSnapshots(workspaceState = {}, target = {}) {
  if (!workspaceState || typeof workspaceState !== "object") {
    return {
      state: workspaceState,
      repairedCount: 0,
      repaired: [],
      skippedCount: 0,
      orphanCount: 0,
      existingCount: 0,
      evidenceCount: 0,
    };
  }
  const actors = Array.isArray(workspaceState.actors) ? workspaceState.actors : [];
  const inputArchives = Array.isArray(workspaceState.archives) ? workspaceState.archives : [];
  const ledger = Array.isArray(workspaceState.ledger) ? workspaceState.ledger : [];
  const workingArchives = inputArchives.map((archive) => ({
    ...archive,
    orders: Array.isArray(archive?.orders) ? [...archive.orders] : [],
  }));
  const repaired = [];
  let skippedCount = 0;
  let orphanCount = 0;
  let existingCount = 0;
  let evidenceCount = 0;
  const targetActorId = cleanText(target?.actorId);
  const targetActorName = cleanText(target?.actorName);
  const destinationIsTargeted = (archive) => {
    if (!targetActorId && !targetActorName) return true;
    const archiveActorId = cleanText(archive?.actorId);
    if (targetActorId && archiveActorId) return archiveActorId === targetActorId;
    return Boolean(targetActorName && sameName(archive?.actor, targetActorName));
  };
  const targetAliases = new Set([
    targetActorName,
    cleanText(actorById(actors, targetActorId)?.name),
    ...workingArchives.filter(destinationIsTargeted).map((archive) => cleanText(archive?.actor)),
  ].map(normalizedName).filter(Boolean));
  const sourceParticipantMatchesTarget = (order, lineActorName) => {
    if (!order || (!targetActorId && !targetActorName)) return false;
    const participantMatches = (role) => {
      const actorId = cleanText(role === "broker" ? order?.brokerActorId : order?.agentActorId);
      const actorName = cleanText(role === "broker" ? order?.broker : order?.agent);
      const targetMatches = targetActorId && actorId
        ? actorId === targetActorId
        : Boolean(targetActorName && sameName(actorName, targetActorName));
      return targetMatches && sameName(lineActorName, actorName);
    };
    return participantMatches("broker") || participantMatches("agent");
  };

  const evidenceLines = ledger.filter((line) =>
    line?.source === "ORDER_PAYMENT" &&
    line?.archived === true &&
    timestampKey(line?.closedAt) &&
    actorNameFromAccount(line?.account) &&
    Number(line?.amountMinor || 0) > 0
  );

  evidenceLines.forEach((line) => {
    const source = sourceSnapshotForEvidence(inputArchives, line);
    const lineActorName = actorNameFromAccount(line?.account);
    const targetedEvidence = (!targetActorId && !targetActorName) ||
      targetAliases.has(normalizedName(lineActorName)) ||
      sourceParticipantMatchesTarget(source.order, lineActorName);
    if (!targetedEvidence) return;
    evidenceCount += 1;
    if (!source.order) {
      if (source.ambiguous) skippedCount += 1;
      else orphanCount += 1;
      return;
    }
    if (!["Paid", "Voided"].includes(cleanText(source.order.state))) {
      orphanCount += 1;
      return;
    }
    const closedAtKey = timestampKey(line.closedAt);
    const destinations = workingArchives
      .map((archive, index) => ({ archive, index, roles: participantRolesForArchive(source.order, archive, actors) }))
      .filter(({ archive, roles }) =>
        destinationIsTargeted(archive) &&
        archive?.kind !== "master-transactions" &&
        timestampKey(archive?.closedAt) === closedAtKey &&
        evidenceBelongsToArchiveActor(line, source.order, archive, actors, roles)
      );
    if (destinations.length !== 1) {
      if (destinations.length > 1) skippedCount += 1;
      else orphanCount += 1;
      return;
    }
    const destination = destinations[0];
    if (destination.archive.orders.some((order) => orderMatchesEvidence(order, line))) {
      existingCount += 1;
      return;
    }
    const snapshot = repairedSnapshot(source.order, destination.archive, line, destination.roles, actors);
    destination.archive.orders.push(snapshot);
    repaired.push({
      archiveId: cleanText(destination.archive.id),
      actorId: cleanText(destination.archive.actorId),
      actor: cleanText(destination.archive.actor),
      orderId: cleanText(snapshot.internalOrderId || snapshot.id),
      journal: cleanText(snapshot.journal),
      closedAt: destination.archive.closedAt || "",
    });
  });

  return {
    state: repaired.length ? { ...workspaceState, archives: workingArchives } : workspaceState,
    repairedCount: repaired.length,
    repaired,
    skippedCount,
    orphanCount,
    existingCount,
    evidenceCount,
  };
}
