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
  if (evidenceJournal && journals.size) return journalMatches;
  return idMatches;
}

function snapshotCoreSignature(order) {
  return [
    cleanText(order?.id),
    cleanText(order?.internalOrderId),
    cleanText(order?.collisionSourceOrderId),
    cleanText(order?.journal),
    cleanText(order?.brokerActorId),
    cleanText(order?.agentActorId),
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
  const targetLegacyOnly = target?.legacyOnly === true;
  const allowLegacyNameFallback = target?.allowLegacyNameFallback !== false;
  const destinationIsTargeted = (archive) => {
    const archiveActorId = cleanText(archive?.actorId);
    if (targetLegacyOnly) {
      return !archiveActorId && Boolean(targetActorName && sameName(archive?.actor, targetActorName));
    }
    if (!targetActorId && !targetActorName) return true;
    if (targetActorId && archiveActorId) return archiveActorId === targetActorId;
    if (targetActorId && !allowLegacyNameFallback) return false;
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

function archiveIsClosedActorReport(archive, actors) {
  if (!archive || typeof archive !== "object" || !timestampKey(archive.closedAt)) return false;
  if (archive.kind === "master-transactions" || sameName(archive.actor, "Master Transactions")) return false;
  if (cleanText(archive.actorRole) === "Master") return false;
  const archiveActorId = cleanText(archive.actorId);
  const archiveActorName = cleanText(archive.actor);
  if (!archiveActorId && !archiveActorName) return false;
  const knownActor = archiveActorId
    ? actorById(actors, archiveActorId)
    : actors.find((actor) => sameName(actor?.name, archiveActorName));
  return cleanText(knownActor?.role) !== "Master";
}

function closedActorRepairTargets(workspaceState) {
  const actors = Array.isArray(workspaceState?.actors) ? workspaceState.actors : [];
  const targets = new Map();
  (Array.isArray(workspaceState?.archives) ? workspaceState.archives : [])
    .filter((archive) => archiveIsClosedActorReport(archive, actors))
    .forEach((archive) => {
      const actorId = cleanText(archive.actorId);
      const actorName = cleanText(actorById(actors, actorId)?.name || archive.actor);
      const key = actorId ? `id:${actorId}` : `name:${normalizedName(actorName)}`;
      if (!key || targets.has(key)) return;
      targets.set(key, {
        actorId,
        actorName,
        legacyIdentity: !actorId,
        repairTarget: actorId
          ? { actorId, actorName, allowLegacyNameFallback: false }
          : { actorName, legacyOnly: true },
      });
    });
  return Array.from(targets.values());
}

function activeNonMasterActorIdentities(workspaceState) {
  const actors = Array.isArray(workspaceState?.actors) ? workspaceState.actors : [];
  const identities = new Map();
  actors
    .filter((actor) => actor?.active !== false && cleanText(actor?.role) !== "Master")
    .forEach((actor) => {
      const actorId = cleanText(actor?.id);
      const actorName = cleanText(actor?.name);
      if (!actorId && !actorName) return;
      const key = actorId ? `id:${actorId}` : `name:${normalizedName(actorName)}`;
      if (!identities.has(key)) identities.set(key, { actorId, actorName });
    });
  return Array.from(identities.values());
}

function actorIdentityMatchesTarget(actor, target) {
  if (actor.actorId && target.actorId) return actor.actorId === target.actorId;
  return Boolean(actor.actorName && target.actorName && sameName(actor.actorName, target.actorName));
}

function emptyWorkspaceRepairResult(workspaceState) {
  return {
    state: workspaceState,
    repairedCount: 0,
    repaired: [],
    safeActorCount: 0,
    blockedActorCount: 0,
    blockedActors: [],
    closedActorCount: 0,
    unclosedActorCount: 0,
    actorResults: [],
    repairedActorCount: 0,
    skippedCount: 0,
    orphanCount: 0,
    existingCount: 0,
    evidenceCount: 0,
  };
}

/**
 * Safely repairs every existing closed Actor report in one workspace. Targets are
 * derived only from closed non-Master archives. A target with ambiguous or orphaned
 * evidence is left completely untouched while independent safe targets can proceed.
 */
export function backfillAllClosedActorOrderSnapshots(workspaceState = {}) {
  if (!workspaceState || typeof workspaceState !== "object") {
    return emptyWorkspaceRepairResult(workspaceState);
  }

  const targets = closedActorRepairTargets(workspaceState);
  const activeActors = activeNonMasterActorIdentities(workspaceState);
  const unclosedActorCount = activeActors.filter((actor) =>
    !targets.some((target) => actorIdentityMatchesTarget(actor, target))
  ).length;
  let workingState = workspaceState;
  const repaired = [];
  const blockedActors = [];
  const actorResults = [];
  let repairedActorCount = 0;
  let skippedCount = 0;
  let orphanCount = 0;
  let existingCount = 0;
  let evidenceCount = 0;

  targets.forEach((target) => {
    const plan = backfillClosedParticipantOrderSnapshots(workingState, target.repairTarget);
    // A name-only historical archive cannot be proven to belong to a currently
    // active Actor if that name was reused. Keep it available for manual review,
    // but never include it in an automatic workspace-wide repair.
    const blocked = target.legacyIdentity || plan.skippedCount > 0 || plan.orphanCount > 0;
    skippedCount += plan.skippedCount;
    orphanCount += plan.orphanCount;
    existingCount += plan.existingCount;
    evidenceCount += plan.evidenceCount;
    const actorResult = {
      actorId: target.actorId,
      actorName: target.actorName,
      name: target.actorName,
      status: blocked ? "blocked" : "safe",
      candidateCount: plan.repairedCount,
      repairedCount: blocked ? 0 : plan.repairedCount,
      skippedCount: plan.skippedCount,
      orphanCount: plan.orphanCount,
      existingCount: plan.existingCount,
      evidenceCount: plan.evidenceCount,
    };
    actorResults.push(actorResult);
    if (blocked) {
      blockedActors.push({ ...actorResult });
      return;
    }
    if (plan.repairedCount > 0) {
      workingState = plan.state;
      repaired.push(...plan.repaired);
      repairedActorCount += 1;
    }
  });

  return {
    state: workingState,
    repairedCount: repaired.length,
    repaired,
    safeActorCount: targets.length - blockedActors.length,
    blockedActorCount: blockedActors.length,
    blockedActors,
    closedActorCount: targets.length,
    unclosedActorCount,
    actorResults,
    repairedActorCount,
    skippedCount,
    orphanCount,
    existingCount,
    evidenceCount,
  };
}
