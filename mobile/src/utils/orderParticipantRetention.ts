import type { ActorRecord, ArchiveRecord, LedgerLine, OrderRecord } from "../types";

type ParticipantIdentity = { actorId: string; actorName: string };

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
  const leftJournal = clean(left.journal);
  const rightJournal = clean(right.journal);
  if (leftJournal && rightJournal) return leftJournal === rightJournal;
  const rightIds = new Set([right.id, right.internalOrderId, right.collisionSourceOrderId].map(clean).filter(Boolean));
  return [left.id, left.internalOrderId, left.collisionSourceOrderId].map(clean).filter(Boolean).some((id) => rightIds.has(id));
}

function orderParticipants(order: OrderRecord, actors: ActorRecord[]): ParticipantIdentity[] {
  const participants = [
    { actorId: clean(order.brokerActorId), actorName: clean(order.broker) },
    { actorId: clean(order.agentActorId), actorName: clean(order.agent) },
  ].filter((participant) => {
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

function participantCoverage(order: OrderRecord, archives: ArchiveRecord[], actors: ActorRecord[]): boolean {
  const participants = orderParticipants(order, actors);
  return participants.length > 0 && participants.every((participant) => archives.some((archive) =>
    archiveBelongsToParticipant(archive, participant) &&
    (archive.orders || []).some((snapshot) => recordsMatch(order, snapshot))
  ));
}

function hasOpenParticipantLine(order: OrderRecord, ledger: LedgerLine[], actors: ActorRecord[]): boolean {
  const participants = orderParticipants(order, actors);
  const journal = clean(order.journal);
  const ids = new Set([order.id, order.internalOrderId, order.collisionSourceOrderId].map(clean).filter(Boolean));
  return ledger.some((line) => {
    if (line.source !== "ORDER_PAYMENT" || line.archived === true || clean(line.account).startsWith("MASTER_")) return false;
    const lineJournal = clean(line.journal);
    const sameOrder = lineJournal && journal ? lineJournal === journal : Boolean(clean(line.orderId) && ids.has(clean(line.orderId)));
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
  deletedOrderIds: string[] = []
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
    return !participantCoverage(order, archives, actors) || hasOpenParticipantLine(order, ledger, actors);
  });
}
