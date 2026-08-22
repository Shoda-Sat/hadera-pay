const clean = (value) => String(value ?? "").trim();
const normalized = (value) => clean(value).toLocaleLowerCase();
const asArray = (value) => Array.isArray(value) ? value : [];

export const approvedOrderParticipantIdentityRepairs = Object.freeze([
  Object.freeze({
    repairId: "galaxy-nahom-jrn-1739-participant-v1",
    workspace: "galaxy",
    actorName: "Nahom",
    role: "agent",
    journal: "JRN-1739",
    corroboratingJournal: "JRN-1739 (1)",
  }),
]);

function workspaceKey(value) {
  return normalized(value).replace(/[^a-z0-9]+/g, "").replace(/workspace$/, "");
}

function setRepairWorkspaceContext(state, workspaceName, workspaceId) {
  if (!state || typeof state !== "object") return;
  Object.defineProperty(state, "__orderParticipantIdentityWorkspace", {
    value: workspaceKey(workspaceName),
    configurable: true,
    enumerable: false,
    writable: true,
  });
  Object.defineProperty(state, "__orderParticipantIdentityWorkspaceId", {
    value: clean(workspaceId || state?._workspaceId),
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function linkMatchesWorkspace(state, link, approval) {
  if (workspaceKey(link?.workspace) !== workspaceKey(approval?.workspace)) return false;
  const stateWorkspaceId = clean(state?._workspaceId || state?.__orderParticipantIdentityWorkspaceId);
  const linkWorkspaceId = clean(link?.workspaceId);
  if (stateWorkspaceId || linkWorkspaceId) {
    return Boolean(stateWorkspaceId && linkWorkspaceId && stateWorkspaceId === linkWorkspaceId);
  }
  return workspaceKey(state?.__orderParticipantIdentityWorkspace) === workspaceKey(approval?.workspace);
}

function actorNameFromAccount(account) {
  const value = clean(account);
  return value.endsWith(" ACTOR_CLEARING")
    ? value.slice(0, -" ACTOR_CLEARING".length).trim()
    : value;
}

function participantFields(role) {
  return role === "broker"
    ? { id: "brokerActorId", name: "broker" }
    : { id: "agentActorId", name: "agent" };
}

function actorRoleSupportsParticipant(role, actorRole) {
  if (role === "broker") return ["Broker", "Special Broker"].includes(clean(actorRole));
  return ["Agent", "Special Agent", "Special Broker"].includes(clean(actorRole));
}

function orderIds(order = {}) {
  return new Set([
    order.id,
    order.internalOrderId,
    order.collisionSourceOrderId,
  ].map(clean).filter(Boolean));
}

function linkMatchesOrder(link, order) {
  if (!clean(link?.journal) || clean(link.journal) !== clean(order?.journal)) return false;
  const linkedIds = new Set(asArray(link?.orderIds).map(clean).filter(Boolean));
  if (!linkedIds.size) return false;
  return [...orderIds(order)].some((id) => linkedIds.has(id));
}

function orderSignature(order = {}) {
  return [
    normalized(order.broker),
    normalized(order.agent),
    normalized(order.senderName),
    normalized(order.receiverName),
    normalized(order.receiverCity),
    normalized(order.accountNumber),
    normalized(order.phoneNumber),
    normalized(order.remarks),
    clean(order.sourceCurrency),
    Number(order.sourceAmountMinor || 0),
    clean(order.payoutCurrency),
    Number(order.payoutAmountMinor || 0),
    Number(order.rate || 0),
    Number(order.commissionPercent || 0),
    Number(order.commissionMinor || 0),
    Number(order.grossMinor || 0),
    Number(order.forwardedPayoutDivider || 0),
    Number(order.forwardedPayoutPercent || 0),
    Number(order.manualSpecialPayoutDivider || 0),
    Number(order.manualSpecialPayoutPercent || 0),
    Number(order.manualMasterRateDivider || 0),
    Number(order.manualMasterRatePercent || 0),
    normalized(order.fundingType || "cash"),
    normalized(order.orderCommissionLiability || (
      Number(order.commissionPercent || 0) < 0 || Number(order.commissionMinor || 0) < 0 ? "Master" : "Broker"
    )),
  ].join("|");
}

function completedOrderRecords(state, journal) {
  return [
    ...asArray(state?.orders).map((order) => ({ order, live: true })),
    ...asArray(state?.archives).flatMap((archive) =>
      asArray(archive?.orders).map((order) => ({ order, live: false }))
    ),
  ].filter(({ order }) =>
    ["Paid", "Voided"].includes(clean(order?.state))
    && clean(order?.journal) === clean(journal)
  );
}

function hasBalancedLedgerEvidence(state, actor, journal) {
  const activeLines = asArray(state?.ledger).filter((line) =>
    line?.archived !== true
    && clean(line?.source) === "ORDER_PAYMENT"
    && clean(line?.journal) === clean(journal)
  );
  const actorLines = activeLines.filter((line) =>
    normalized(actorNameFromAccount(line?.account)) === normalized(actor?.name)
  );
  if (!actorLines.length || actorLines.some((line) => Number(line?.amountMinor || 0) <= 0)) return false;
  const actorCurrencies = new Set(actorLines.map((line) => clean(line?.currency)).filter(Boolean));
  const signedAmount = (line) => (clean(line?.direction) === "Debit" ? 1 : -1) * Number(line?.amountMinor || 0);
  return [...actorCurrencies].every((currency) => {
    const actorNet = actorLines
      .filter((line) => clean(line?.currency) === currency)
      .reduce((sum, line) => sum + signedAmount(line), 0);
    const masterNet = activeLines
      .filter((line) =>
        normalized(line?.account).startsWith("master")
        && clean(line?.currency) === currency
      )
      .reduce((sum, line) => sum + signedAmount(line), 0);
    return actorNet !== 0 && actorNet + masterNet === 0;
  });
}

export function orderParticipantIdentityLinkFor(state, order, actor, role) {
  const actorId = clean(actor?.id);
  const actorName = normalized(actor?.name);
  if (!actorId || !actorName) return null;
  const fields = participantFields(role);
  const participantId = clean(order?.[fields.id]);
  const participantName = normalized(order?.[fields.name]);
  return asArray(state?.orderParticipantIdentityLinks).find((link) => {
    const approval = approvedOrderParticipantIdentityRepairs.find((candidate) =>
      clean(candidate.repairId) === clean(link?.repairId)
      && linkMatchesWorkspace(state, link, candidate)
      && clean(candidate.journal) === clean(link?.journal)
      && normalized(candidate.actorName) === normalized(link?.actorName)
      && clean(candidate.role) === clean(link?.role)
    );
    return Boolean(
      approval
      && clean(link?.actorId) === actorId
      && actorRoleSupportsParticipant(role, actor?.role)
      && normalized(link?.actorName) === actorName
      && clean(link?.role) === role
      && normalized(link?.participantName) === participantName
      && clean(link?.legacyActorId)
      && clean(link.legacyActorId) === participantId
      && linkMatchesOrder(link, order)
    );
  }) || null;
}

export function orderParticipantIdentityLinkMatches(state, order, actor, role) {
  return Boolean(orderParticipantIdentityLinkFor(state, order, actor, role));
}

/**
 * Matches the one approved historic link to its original payment evidence.
 * This is deliberately narrower than ordinary order resolution: the journal
 * must be the approved canonical journal and a supplied order ID must be one
 * of the IDs corroborated while the repair was created.
 */
export function orderParticipantIdentityLinkForLedgerLine(state, order, line) {
  if (clean(line?.source) !== "ORDER_PAYMENT") return null;
  return asArray(state?.actors).flatMap((actor) => ["broker", "agent"].map((role) => ({ actor, role })))
    .map(({ actor, role }) => ({ actor, role, link: orderParticipantIdentityLinkFor(state, order, actor, role) }))
    .find(({ actor, role, link }) => {
      if (!link || clean(line?.journal) !== clean(link.journal)) return false;
      if (normalized(actorNameFromAccount(line?.account)) !== normalized(actor?.name)) return false;
      const lineActorId = clean(line?.actorId);
      if (lineActorId && ![clean(link.actorId), clean(link.legacyActorId)].includes(lineActorId)) return false;
      const participantRole = clean(line?.participantRole);
      if (participantRole && participantRole !== role) return false;
      const lineOrderId = clean(line?.orderId);
      if (!lineOrderId) return true;
      return asArray(link?.orderIds).map(clean).includes(lineOrderId);
    })?.link || null;
}

/**
 * Records the one explicitly approved historic identity correction without
 * editing orders, ledger accounting fields, settlements, or closed archives.
 */
export function applyApprovedOrderParticipantIdentityRepair(state = {}, options = {}) {
  setRepairWorkspaceContext(state, options.workspaceName, options.workspaceId);
  const requestedActor = asArray(state.actors).find((candidate) =>
    candidate?.active !== false
    && clean(candidate?.role) !== "Master"
    && clean(candidate?.id) === clean(options.actorId)
  );
  if (!requestedActor) return { repaired: false, reason: "actor-not-found" };
  const requestedName = normalized(options.actorName || requestedActor?.name);
  const actorsWithName = asArray(state.actors).filter((candidate) =>
    candidate?.active !== false
    && clean(candidate?.role) !== "Master"
    && normalized(candidate?.name) === requestedName
  );
  if (actorsWithName.length !== 1 || clean(actorsWithName[0]?.id) !== clean(requestedActor.id)) {
    return { repaired: false, reason: "actor-identity-ambiguous" };
  }
  const actor = requestedActor;

  const approval = approvedOrderParticipantIdentityRepairs.find((candidate) =>
    workspaceKey(candidate.workspace) === workspaceKey(options.workspaceName)
    && normalized(candidate.actorName) === normalized(actor.name)
  );
  if (!approval) return { repaired: false, reason: "not-approved" };
  if (!actorRoleSupportsParticipant(approval.role, actor.role)) {
    return { repaired: false, reason: "actor-role-conflict" };
  }
  if (!hasBalancedLedgerEvidence(state, actor, approval.journal)) {
    return { repaired: false, reason: "ledger-evidence-missing" };
  }

  const records = completedOrderRecords(state, approval.journal);
  if (!records.length || new Set(records.map(({ order }) => orderSignature(order))).size !== 1) {
    return { repaired: false, reason: "ambiguous-order" };
  }

  const matchingRoles = ["broker", "agent"].filter((role) => {
    const fields = participantFields(role);
    return records.every(({ order }) => normalized(order?.[fields.name]) === normalized(actor.name));
  });
  if (matchingRoles.length !== 1 || matchingRoles[0] !== approval.role) {
    return { repaired: false, reason: "ambiguous-role" };
  }
  const role = matchingRoles[0];
  const fields = participantFields(role);
  const legacyIds = new Set(records.map(({ order }) => clean(order?.[fields.id])).filter(Boolean));
  if (legacyIds.size !== 1) return { repaired: false, reason: "ambiguous-identity" };
  const legacyActorId = [...legacyIds][0];
  if (records.some(({ order }) => clean(order?.[fields.id]) !== legacyActorId)) {
    return { repaired: false, reason: "ambiguous-identity" };
  }
  if (!legacyActorId || legacyActorId === clean(actor.id)) {
    return { repaired: false, reason: "identity-already-current" };
  }
  if (asArray(state.actors).some((candidate) =>
    candidate?.active !== false
    && clean(candidate?.id) === legacyActorId
    && clean(candidate?.id) !== clean(actor.id)
  )) {
    return { repaired: false, reason: "legacy-identity-is-active" };
  }

  const sourceSignature = orderSignature(records[0].order);
  const corroboratingRecords = completedOrderRecords(state, approval.corroboratingJournal);
  if (!corroboratingRecords.length || corroboratingRecords.some(({ order }) =>
    orderSignature(order) !== sourceSignature
    || normalized(order?.[fields.name]) !== normalized(actor.name)
    || clean(order?.[fields.id]) !== legacyActorId
  )) {
    return { repaired: false, reason: "corroborating-order-missing" };
  }

  const activeActorLineOrderIds = new Set(asArray(state.ledger)
    .filter((line) =>
      line?.archived !== true
      && clean(line?.source) === "ORDER_PAYMENT"
      && clean(line?.journal) === approval.journal
      && normalized(actorNameFromAccount(line?.account)) === normalized(actor.name)
    )
    .map((line) => clean(line?.orderId))
    .filter(Boolean));
  const candidateOrderIds = new Set(records.flatMap(({ order }) => [...orderIds(order)]));
  if (!candidateOrderIds.size) return { repaired: false, reason: "order-reference-missing" };
  const corroboratingOrderIds = new Set(corroboratingRecords.flatMap(({ order }) => [...orderIds(order)]));
  const evidenceOrderIds = new Set([...candidateOrderIds, ...corroboratingOrderIds]);
  if (activeActorLineOrderIds.size && ![...activeActorLineOrderIds].every((id) => evidenceOrderIds.has(id))) {
    return { repaired: false, reason: "order-reference-conflict" };
  }

  const existingLinks = asArray(state.orderParticipantIdentityLinks);
  if (existingLinks.some((link) => clean(link?.repairId) === approval.repairId)) {
    return { repaired: false, reason: "already-repaired" };
  }
  const preferredOrder = records.find(({ live }) => live)?.order || records[0].order;
  const link = {
    repairId: approval.repairId,
    workspace: workspaceKey(approval.workspace),
    ...(clean(options.workspaceId || state?._workspaceId)
      ? { workspaceId: clean(options.workspaceId || state?._workspaceId) }
      : {}),
    journal: approval.journal,
    orderIds: [...evidenceOrderIds].sort(),
    role,
    actorId: clean(actor.id),
    actorName: clean(actor.name),
    participantName: clean(preferredOrder?.[fields.name]),
    legacyActorId,
  };
  state.orderParticipantIdentityLinks = [...existingLinks, link];
  return { repaired: true, link };
}
