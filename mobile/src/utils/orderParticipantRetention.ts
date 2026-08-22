import type { ActorRecord, ArchiveRecord, LedgerLine, OrderRecord, WorkspaceState } from "../types";

type ParticipantRole = "broker" | "agent";
type ParticipantIdentity = { actorId: string; actorName: string; role?: ParticipantRole };
type ParticipantIdentityLink = NonNullable<WorkspaceState["orderParticipantIdentityLinks"]>[number];

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLocaleLowerCase();
}

function participantIdentitiesMatch(left: ParticipantIdentity, right: ParticipantIdentity): boolean {
  if (left.actorId || right.actorId) return Boolean(left.actorId && right.actorId && left.actorId === right.actorId);
  return Boolean(left.actorName && normalized(left.actorName) === normalized(right.actorName));
}

function recordsMatch(left: OrderRecord, right: OrderRecord): boolean {
  const leftIds = new Set([left.id, left.internalOrderId, left.collisionSourceOrderId].map(clean).filter(Boolean));
  const rightIds = new Set([right.id, right.internalOrderId, right.collisionSourceOrderId].map(clean).filter(Boolean));
  if (leftIds.size && rightIds.size) return [...leftIds].some((id) => rightIds.has(id));
  const leftJournal = clean(left.journal);
  const rightJournal = clean(right.journal);
  return Boolean(leftJournal && rightJournal && leftJournal === rightJournal);
}

function participantIdentityLinkMatches(
  order: OrderRecord,
  actor: ActorRecord,
  role: ParticipantRole,
  identityLinks: ParticipantIdentityLink[],
  workspaceId: string
): boolean {
  const actorId = clean(actor.id);
  const actorName = normalized(actor.name);
  const participantActorId = clean(role === "broker" ? order.brokerActorId : order.agentActorId);
  const participantName = normalized(role === "broker" ? order.broker : order.agent);
  const journal = clean(order.journal);
  const actorRole = clean(actor.role);
  const roleSupported = role === "broker"
    ? ["Broker", "Special Broker"].includes(actorRole)
    : ["Agent", "Special Agent", "Special Broker"].includes(actorRole);
  const stableIds = new Set([order.id, order.internalOrderId, order.collisionSourceOrderId].map(clean).filter(Boolean));
  if (!actorId || !actorName || !participantName || !journal || !stableIds.size || !roleSupported) return false;
  return identityLinks.some((link) => {
    const linkedIds = new Set((link.orderIds || []).map(clean).filter(Boolean));
    const linkWorkspace = normalized(link.workspace).replace(/[^a-z0-9]+/g, "").replace(/workspace$/, "");
    return clean(link.repairId) === "galaxy-nahom-jrn-1739-participant-v1" &&
      linkWorkspace === "galaxy" &&
      Boolean(clean(workspaceId)) &&
      clean(link.workspaceId) === clean(workspaceId) &&
      clean(link.actorId) === actorId &&
      normalized(link.actorName) === actorName &&
      clean(link.role) === role &&
      normalized(link.participantName) === participantName &&
      Boolean(clean(link.legacyActorId)) &&
      clean(link.legacyActorId) === participantActorId &&
      clean(link.journal) === journal &&
      [...stableIds].some((id) => linkedIds.has(id));
  });
}

function orderParticipants(
  order: OrderRecord,
  actors: ActorRecord[],
  identityLinks: ParticipantIdentityLink[],
  workspaceId: string
): ParticipantIdentity[] {
  const participants = [
    { role: "broker" as const, actorId: clean(order.brokerActorId), actorName: clean(order.broker) },
    { role: "agent" as const, actorId: clean(order.agentActorId), actorName: clean(order.agent) },
  ].map((participant) => {
    const linkedActor = actors.find((actor) => participantIdentityLinkMatches(order, actor, participant.role, identityLinks, workspaceId));
    return linkedActor
      ? { ...participant, actorId: clean(linkedActor.id), actorName: clean(linkedActor.name) || participant.actorName }
      : participant;
  }).filter((participant) => {
    if (!participant.actorId && !participant.actorName) return false;
    if (["master", "master transactions", "unassigned", "cancelled"].includes(normalized(participant.actorName))) return false;
    const actor = participant.actorId
      ? actors.find((item) => item.id === participant.actorId)
      : actors.find((item) => normalized(item.name) === normalized(participant.actorName));
    return actor?.role !== "Master";
  });
  return participants.filter((participant, index) =>
    participants.findIndex((candidate) => participantIdentitiesMatch(candidate, participant)) === index
  );
}

function archiveBelongsToParticipant(archive: ArchiveRecord, participant: ParticipantIdentity): boolean {
  if (archive.actorRole === "Master") return false;
  return participantIdentitiesMatch(participant, {
    actorId: clean(archive.actorId),
    actorName: clean(archive.actor),
  });
}

function participantCoverage(
  order: OrderRecord,
  archives: ArchiveRecord[],
  actors: ActorRecord[],
  identityLinks: ParticipantIdentityLink[],
  workspaceId: string
): boolean {
  const participants = orderParticipants(order, actors, identityLinks, workspaceId);
  return participants.length > 0 && participants.every((participant) => archives.some((archive) =>
    archiveBelongsToParticipant(archive, participant) &&
    (archive.orders || []).some((snapshot) => recordsMatch(order, snapshot))
  ));
}

function hasOpenParticipantLine(
  order: OrderRecord,
  ledger: LedgerLine[],
  actors: ActorRecord[],
  identityLinks: ParticipantIdentityLink[],
  workspaceId: string
): boolean {
  const participants = orderParticipants(order, actors, identityLinks, workspaceId);
  const journal = clean(order.journal);
  const ids = new Set([order.id, order.internalOrderId, order.collisionSourceOrderId].map(clean).filter(Boolean));
  return ledger.some((line) => {
    if (line.source !== "ORDER_PAYMENT" || line.archived === true || clean(line.account).startsWith("MASTER_")) return false;
    const lineJournal = clean(line.journal);
    const lineOrderId = clean(line.orderId);
    const sameOrder = lineOrderId && ids.size
      ? ids.has(lineOrderId)
      : Boolean(lineJournal && journal && lineJournal === journal);
    if (!sameOrder) return false;
    const accountName = normalized(clean(line.account).replace(/ ACTOR_CLEARING$/, ""));
    return participants.some((participant) => {
      const actor = participant.actorId ? actors.find((item) => item.id === participant.actorId) : undefined;
      return [participant.actorName, actor?.name].some((name) => normalized(name) === accountName);
    });
  });
}

export function orderArchivedForActor(
  order: OrderRecord,
  actorId: string | undefined,
  actorName: string | undefined,
  archives: ArchiveRecord[]
): boolean {
  const participant = { actorId: clean(actorId), actorName: clean(actorName) };
  return archives.some((archive) =>
    archiveBelongsToParticipant(archive, participant) &&
    (archive.orders || []).some((snapshot) => recordsMatch(order, snapshot))
  );
}

export function retainOrdersForUnclosedParticipants(
  orders: OrderRecord[] | undefined,
  archives: ArchiveRecord[],
  ledger: LedgerLine[],
  actors: ActorRecord[],
  deletedOrderIds: string[] = [],
  identityLinks: ParticipantIdentityLink[] = [],
  workspaceId: string = ""
): OrderRecord[] {
  const deletedIds = new Set(deletedOrderIds.map(clean).filter(Boolean));
  return (orders || []).filter((order) => {
    if (deletedIds.has(clean(order.id))) return false;
    const matchingArchives = archives.filter((archive) => (archive.orders || []).some((snapshot) => recordsMatch(order, snapshot)));
    if (!matchingArchives.length) return true;
    const latestClose = Math.max(...matchingArchives.map((archive) => new Date(archive.closedAt || 0).getTime() || 0));
    const createdAt = new Date(order.createdAt || order.sentAt || 0).getTime();
    if (Number.isFinite(createdAt) && createdAt > latestClose) return true;
    if (order.state !== "Paid" && order.state !== "Voided") return false;
    return !participantCoverage(order, archives, actors, identityLinks, workspaceId) ||
      hasOpenParticipantLine(order, ledger, actors, identityLinks, workspaceId);
  });
}
