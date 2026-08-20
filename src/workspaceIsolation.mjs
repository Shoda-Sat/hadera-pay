import { recalculateSettlementsFromLedger } from "./exactDuplicateOrderCleanup.mjs";

export const siemGalaxyIsolationRepairId = "siem-galaxy-workspace-isolation-v1";
export const explicitlyConfirmedSiemActorsInGalaxy = Object.freeze(["Europe", "Asdc"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLocaleLowerCase();
}

function compact(value) {
  return normalized(value).replace(/[^a-z0-9]+/g, "");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function workspaceOwnerName(db, workspace) {
  return clean(asArray(db?.users).find((user) => user?.id === workspace?.ownerUserId)?.name);
}

function workspaceMatchesMaster(db, workspace, masterName) {
  const expected = compact(masterName);
  return compact(workspaceOwnerName(db, workspace)) === expected
    || compact(workspace?.name) === expected
    || compact(workspace?.name) === `${expected}workspace`;
}

function canonicalJson(value, omittedKeys = new Set()) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, omittedKeys)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => !omittedKeys.has(key) && value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], omittedKeys)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const actorDerivedKeys = new Set(["workspaceId", "managedByMaster", "actorLedgerNumber"]);

function actorFingerprint(actor) {
  if (!actor || clean(actor.role) === "Master") return "";
  return canonicalJson(actor, actorDerivedKeys);
}

function actorIdentity(actor) {
  return [clean(actor?.id), normalized(actor?.name), clean(actor?.role)].join(":");
}

function actorAccountNames(actors) {
  return new Set(actors.flatMap((actor) => {
    const name = clean(actor?.name);
    return name ? [name, `${name} ACTOR_CLEARING`] : [];
  }));
}

function targetMembershipProtectsActor(db, workspaceId, actor) {
  return asArray(db?.memberships).some((membership) =>
    membership?.workspaceId === workspaceId
    && membership?.role !== "Master"
    && clean(membership?.actorId) === clean(actor?.id)
    && normalized(membership?.actorName) === normalized(actor?.name)
  );
}

function foreignActorMatchesRecord(record, actors, safeActorIds) {
  const names = new Set(actors.map((actor) => normalized(actor?.name)).filter(Boolean));
  const ids = new Set(actors.map((actor) => clean(actor?.id)).filter((id) => id && safeActorIds.has(id)));
  return [record?.broker, record?.agent, record?.borrower, record?.from, record?.to, record?.initiatedBy]
    .some((name) => names.has(normalized(name)))
    || [record?.brokerActorId, record?.agentActorId, record?.borrowerActorId, record?.fromActorId, record?.toActorId, record?.actorId]
      .some((id) => ids.has(clean(id)));
}

function mergeTombstones(existing = {}, removed = {}) {
  const keys = ["orders", "receivables", "transfers", "customers", "messages"];
  return Object.fromEntries(keys.map((key) => [
    key,
    Array.from(new Set([
      ...asArray(existing?.[key]).map(clean),
      ...asArray(removed?.[key]).map(clean),
    ].filter(Boolean))),
  ]));
}

function removedActorBalanceTotals(lines, actorAccounts) {
  const totals = new Map();
  lines.forEach((line) => {
    if (!actorAccounts.has(clean(line?.account))) return;
    const actor = clean(line.account).replace(/ ACTOR_CLEARING$/, "");
    const currency = clean(line.currency);
    if (!actor || !currency) return;
    const key = `${actor}:${currency}`;
    const sign = clean(line.direction) === "Debit" ? 1 : -1;
    totals.set(key, Number(totals.get(key) || 0) + sign * Number(line.amountMinor || 0));
  });
  return Array.from(totals.entries()).map(([key, netMinor]) => {
    const separator = key.lastIndexOf(":");
    return { actor: key.slice(0, separator), currency: key.slice(separator + 1), netMinor };
  }).filter((item) => item.netMinor !== 0);
}

/**
 * Repairs the explicitly reported leak of Siem's actors into Galaxy. Only live
 * Galaxy data connected to an actor profile that is an exact copy of a Siem
 * profile is removed. Closed reports and archived ledger rows are immutable.
 */
export function repairSiemActorsLeakedIntoGalaxy(db, targetWorkspaceId, state = {}) {
  const targetWorkspace = asArray(db?.workspaces).find((workspace) => workspace?.id === targetWorkspaceId);
  if (!targetWorkspace || !workspaceMatchesMaster(db, targetWorkspace, "Galaxy")) {
    return { repaired: false, leakedActorCount: 0, balanceMerged: false, removedLedgerLineCount: 0 };
  }
  const sourceWorkspace = asArray(db?.workspaces).find((workspace) =>
    workspace?.id !== targetWorkspaceId && workspaceMatchesMaster(db, workspace, "Siem")
  );
  if (!sourceWorkspace) {
    return { repaired: false, leakedActorCount: 0, balanceMerged: false, removedLedgerLineCount: 0 };
  }

  const sourceState = db?.appStates?.[sourceWorkspace.id] || {};
  const previousAudit = asArray(state.workspaceIsolationRepairs)
    .find((repair) => clean(repair?.id) === siemGalaxyIsolationRepairId);
  const sourceFingerprints = new Map(asArray(sourceState.actors)
    .map((actor) => [actorFingerprint(actor), actor])
    .filter(([fingerprint]) => fingerprint));
  const explicitlyConfirmedNames = new Set(explicitlyConfirmedSiemActorsInGalaxy.map(normalized));
  const leakedActors = asArray(state.actors).filter((actor) => {
    const fingerprint = actorFingerprint(actor);
    const explicitlyConfirmedManagedActor = actor?.managedByMaster === true
      && explicitlyConfirmedNames.has(normalized(actor?.name));
    return (Boolean(fingerprint && sourceFingerprints.has(fingerprint)) || explicitlyConfirmedManagedActor)
      && !targetMembershipProtectsActor(db, targetWorkspaceId, actor);
  });
  const previouslyLeakedNames = new Set(asArray(previousAudit?.leakedActors).map(normalized).filter(Boolean));
  const repairActorsByIdentity = new Map([
    ...leakedActors,
    ...asArray(sourceState.actors).filter((actor) => previouslyLeakedNames.has(normalized(actor?.name))),
  ].map((actor) => [actorIdentity(actor), actor]));
  const repairActors = Array.from(repairActorsByIdentity.values()).filter((actor) => clean(actor?.role) !== "Master");
  if (!repairActors.length) {
    return { repaired: false, leakedActorCount: 0, balanceMerged: false, removedLedgerLineCount: 0 };
  }

  const leakedActorIdentities = new Set(leakedActors.map(actorIdentity));
  const targetMembershipActorIds = new Set(asArray(db?.memberships)
    .filter((membership) => membership?.workspaceId === targetWorkspaceId)
    .map((membership) => clean(membership?.actorId))
    .filter(Boolean));
  const safeActorIds = new Set(repairActors
    .map((actor) => clean(actor?.id))
    .filter((actorId) => actorId && !targetMembershipActorIds.has(actorId)));
  const actorAccounts = actorAccountNames(repairActors);

  const activeLedger = asArray(state.ledger).filter((line) => line?.archived !== true);
  const directlyForeignLines = activeLedger.filter((line) => actorAccounts.has(clean(line?.account)));
  const linkedJournals = new Set(directlyForeignLines.map((line) => clean(line?.journal)).filter(Boolean));
  const linkedEntryIds = new Set(directlyForeignLines.map((line) => clean(line?.entryId)).filter(Boolean));
  const linkedOrderIds = new Set(directlyForeignLines.map((line) => clean(line?.orderId || line?.sourceId)).filter(Boolean));
  const linkedTransferIds = new Set(directlyForeignLines.map((line) => clean(line?.transferId || line?.sourceId)).filter(Boolean));
  const removedLedgerLines = activeLedger.filter((line) =>
    actorAccounts.has(clean(line?.account))
    || (clean(line?.journal) && linkedJournals.has(clean(line.journal)))
    || (clean(line?.entryId) && linkedEntryIds.has(clean(line.entryId)))
    || (clean(line?.orderId || line?.sourceId) && linkedOrderIds.has(clean(line.orderId || line.sourceId)))
    || (clean(line?.transferId || line?.sourceId) && linkedTransferIds.has(clean(line.transferId || line.sourceId)))
  );
  const removedLedgerKeys = new Set(removedLedgerLines.map((line) => canonicalJson(line)));
  state.ledger = asArray(state.ledger).filter((line) => line?.archived === true || !removedLedgerKeys.has(canonicalJson(line)));

  const removedOrders = asArray(state.orders).filter((order) =>
    foreignActorMatchesRecord(order, repairActors, safeActorIds)
    || linkedJournals.has(clean(order?.journal))
    || linkedOrderIds.has(clean(order?.id || order?.internalOrderId))
  );
  const removedOrderKeys = new Set(removedOrders.map((order) => canonicalJson(order)));
  state.orders = asArray(state.orders).filter((order) => !removedOrderKeys.has(canonicalJson(order)));

  const removedReceivables = asArray(state.receivables).filter((receivable) =>
    !clean(receivable?.archivedAt) && (
      foreignActorMatchesRecord(receivable, repairActors, safeActorIds)
      || linkedJournals.has(clean(receivable?.journal))
      || linkedOrderIds.has(clean(receivable?.orderId))
    )
  );
  const removedReceivableKeys = new Set(removedReceivables.map((receivable) => canonicalJson(receivable)));
  state.receivables = asArray(state.receivables).filter((receivable) =>
    clean(receivable?.archivedAt) || !removedReceivableKeys.has(canonicalJson(receivable))
  );

  const removedTransfers = asArray(state.transfers).filter((transfer) =>
    !clean(transfer?.masterTransactionClosedAt) && (
      foreignActorMatchesRecord(transfer, repairActors, safeActorIds)
      || linkedJournals.has(clean(transfer?.journal))
      || linkedTransferIds.has(clean(transfer?.id))
    )
  );
  const removedTransferKeys = new Set(removedTransfers.map((transfer) => canonicalJson(transfer)));
  state.transfers = asArray(state.transfers).filter((transfer) =>
    clean(transfer?.masterTransactionClosedAt) || !removedTransferKeys.has(canonicalJson(transfer))
  );

  const removedCustomers = asArray(state.savedCustomers).filter((customer) =>
    safeActorIds.has(clean(customer?.actorId))
  );
  const removedCustomerIds = new Set(removedCustomers.map((customer) => clean(customer?.id)).filter(Boolean));
  state.savedCustomers = asArray(state.savedCustomers).filter((customer) => !removedCustomerIds.has(clean(customer?.id)));

  const leakedNames = new Set(repairActors.map((actor) => normalized(actor?.name)).filter(Boolean));
  const removedChats = asArray(state.chatConversations).filter((chat) =>
    asArray(chat?.members).some((member) => leakedNames.has(normalized(member)))
  );
  const removedChatIds = new Set(removedChats.map((chat) => clean(chat?.id)).filter(Boolean));
  const removedMessageIds = removedChats.flatMap((chat) => asArray(chat?.messages).map((message) => clean(message?.id)).filter(Boolean));
  state.chatConversations = asArray(state.chatConversations).filter((chat) => !removedChatIds.has(clean(chat?.id)));
  state.deletedChatIds = Array.from(new Set([...asArray(state.deletedChatIds).map(clean), ...removedChatIds].filter(Boolean)));

  const repairedAnything = leakedActors.length > 0
    || removedLedgerLines.length > 0
    || removedOrders.length > 0
    || removedReceivables.length > 0
    || removedTransfers.length > 0
    || removedCustomers.length > 0
    || removedChats.length > 0;
  if (!repairedAnything) {
    return { repaired: false, leakedActorCount: 0, balanceMerged: false, removedLedgerLineCount: 0 };
  }

  state.actors = asArray(state.actors).filter((actor) => !leakedActorIdentities.has(actorIdentity(actor)));
  state.deletedActorIds = Array.from(new Set([
    ...asArray(state.deletedActorIds).map(clean),
    ...leakedActors.map((actor) => clean(actor?.id)).filter((actorId) => safeActorIds.has(actorId)),
  ].filter(Boolean)));
  state.deletedOrderIds = Array.from(new Set([
    ...asArray(state.deletedOrderIds).map(clean),
    ...removedOrders.flatMap((order) => [clean(order?.id), clean(order?.internalOrderId)]),
  ].filter(Boolean)));
  state.actorResetTombstones = mergeTombstones(state.actorResetTombstones, {
    orders: removedOrders.map((order) => order?.id),
    receivables: removedReceivables.map((receivable) => receivable?.id),
    transfers: removedTransfers.map((transfer) => transfer?.id),
    customers: removedCustomers.map((customer) => customer?.id),
    messages: removedMessageIds,
  });
  if (safeActorIds.has(clean(state.selectedActorId))) state.selectedActorId = "ACT-0";
  if (leakedNames.has(normalized(state.selectedLedgerActor))) state.selectedLedgerActor = "";

  recalculateSettlementsFromLedger(state);
  const balanceAdjustments = removedActorBalanceTotals(removedLedgerLines, actorAccounts);
  const previousRepairs = asArray(state.workspaceIsolationRepairs)
    .filter((repair) => clean(repair?.id) !== siemGalaxyIsolationRepairId);
  const auditedActorNames = Array.from(new Set([
    ...asArray(previousAudit?.leakedActors).map(clean),
    ...leakedActors.map((actor) => clean(actor?.name)),
  ].filter(Boolean)));
  state.workspaceIsolationRepairs = [...previousRepairs, {
    id: siemGalaxyIsolationRepairId,
    appliedAt: new Date().toISOString(),
    sourceMaster: "Siem",
    targetMaster: "Galaxy",
    leakedActorCount: auditedActorNames.length,
    leakedActors: auditedActorNames,
    balanceMerged: previousAudit?.balanceMerged === true || directlyForeignLines.length > 0,
    removedLedgerLineCount: removedLedgerLines.length,
    removedOrderCount: removedOrders.length,
    removedReceivableCount: removedReceivables.length,
    removedTransferCount: removedTransfers.length,
    balanceAdjustments,
    closedReportsChanged: false,
  }];

  return {
    repaired: true,
    leakedActorCount: auditedActorNames.length,
    leakedActors: auditedActorNames,
    balanceMerged: previousAudit?.balanceMerged === true || directlyForeignLines.length > 0,
    removedLedgerLineCount: removedLedgerLines.length,
    removedOrderCount: removedOrders.length,
    removedReceivableCount: removedReceivables.length,
    removedTransferCount: removedTransfers.length,
    balanceAdjustments,
  };
}

export function stateDeclaresAnotherWorkspace(state, workspaceId) {
  const declared = clean(state?._workspaceId);
  return Boolean(declared && declared !== clean(workspaceId));
}
