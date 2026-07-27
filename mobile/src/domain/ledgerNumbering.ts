import type { LedgerLine, OrderRecord, WorkspaceState } from "../types";

function actorOrderPrefix(name: string): string {
  const clean = String(name || "ACT").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${clean}XXX`.slice(0, 3);
}

function latestCloseForActor(state: WorkspaceState, actorName: string): number {
  return state.archives
    .filter((archive) => archive.actor === actorName)
    .reduce((latest, archive) => Math.max(latest, new Date(archive.closedAt || 0).getTime() || 0), 0);
}

function allNumberedOrders(state: WorkspaceState): Array<{ order: OrderRecord; current: boolean; closedAt: string }> {
  return [
    ...state.orders.map((order) => ({ order, current: true, closedAt: "" })),
    ...state.archives.flatMap((archive) => (archive.orders || []).map((order) => ({
      order,
      current: false,
      closedAt: archive.closedAt || ""
    })))
  ];
}

function orderIsReserved(
  record: { order: OrderRecord; current: boolean; closedAt: string },
  latestClose: number
): boolean {
  return record.current ||
    record.order.state === "Voided" ||
    Boolean(record.order.voidJournal) ||
    !latestClose ||
    new Date(record.closedAt || 0).getTime() > latestClose;
}

function actorOrderReferences(
  state: WorkspaceState,
  actorName: string
): Array<{ reference: string; postedAt: string }> {
  const actor = state.actors.find((candidate) => candidate.name === actorName);
  const latestClose = latestCloseForActor(state, actorName);
  const references: Array<{ reference: string; postedAt: string }> = [];
  allNumberedOrders(state).forEach((record) => {
    if (!orderIsReserved(record, latestClose)) return;
    const order = record.order;
    const postedAt = order.paidAt || order.assignedAt || order.sentAt || order.createdAt || record.closedAt || "";
    const isBroker = actor?.id && order.brokerActorId
      ? order.brokerActorId === actor.id
      : order.broker === actorName;
    if (isBroker && (order.brokerOrderNumber || order.id)) {
      references.push({ reference: order.brokerOrderNumber || order.id, postedAt });
    }
    const agentNumbers = new Set<string>();
    const mappedNumber = order.agentOrderNumbers?.[actorName];
    if (mappedNumber) agentNumbers.add(mappedNumber);
    if ((order.agentOrderActor === actorName || order.agent === actorName) && order.agentOrderNumber) {
      agentNumbers.add(order.agentOrderNumber);
    }
    agentNumbers.forEach((reference) => references.push({ reference, postedAt }));
  });
  return references;
}

function sequenceDetails(reference: string, actorName: string): { value: number; width: number } | null {
  const leading = String(reference || "").match(/^(\d+)_/);
  if (leading) return { value: Number(leading[1]), width: leading[1].length };
  const prefix = actorOrderPrefix(actorName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const broker = String(reference || "").match(new RegExp(`^${prefix}(\\d+)$`, "i"));
  return broker ? { value: Number(broker[1]), width: broker[1].length } : null;
}

function lineBelongsToActor(line: LedgerLine, actorName: string): boolean {
  return line.account === actorName || line.account === `${actorName} ACTOR_CLEARING`;
}

export function actorLedgerUsedSequences(state: WorkspaceState, actorName: string): Set<number> {
  const used = new Set<number>();
  actorOrderReferences(state, actorName).forEach(({ reference }) => {
    const details = sequenceDetails(reference, actorName);
    if (details && Number.isFinite(details.value) && details.value > 0) used.add(details.value);
  });
  state.ledger
    .filter((line) => line.archived !== true && lineBelongsToActor(line, actorName))
    .forEach((line) => {
      const match = String(line.actorLedgerNumber || "").match(/^(\d+)_/);
      if (match) used.add(Number(match[1]));
    });
  return used;
}

export function nextActorLedgerSequence(state: WorkspaceState, actorName: string): number {
  const used = actorLedgerUsedSequences(state, actorName);
  return Math.max(0, ...used) + 1;
}

export function actorLedgerSequenceWidth(state: WorkspaceState, actorName: string): number {
  const existingLedgerWidth = state.ledger
    .filter((line) => line.archived !== true && lineBelongsToActor(line, actorName))
    .map((line) => String(line.actorLedgerNumber || "").match(/^(\d+)_/)?.[1]?.length || 0)
    .find((width) => width > 0);
  if (existingLedgerWidth) return existingLedgerWidth;
  const numberedReferences = actorOrderReferences(state, actorName)
    .map((item) => ({ ...item, details: sequenceDetails(item.reference, actorName) }))
    .filter((item): item is { reference: string; postedAt: string; details: { value: number; width: number } } => Boolean(item.details))
    .sort((left, right) => new Date(right.postedAt || 0).getTime() - new Date(left.postedAt || 0).getTime());
  if (numberedReferences[0]) return Math.max(1, numberedReferences[0].details.width);
  const role = state.actors.find((actor) => actor.name === actorName)?.role;
  return ["Agent", "Special Agent", "Special Broker"].includes(String(role)) ? 4 : 3;
}

export function formattedLedgerTransactionReference(reference: string): string {
  return String(reference || "").replace(/^(TRF|JNL|WDL)-(\d+)$/i, (_match, prefix: string, value: string) =>
    `${prefix.toUpperCase()}-${value.padStart(2, "0")}`
  );
}

export function nextActorLedgerNumber(state: WorkspaceState, actorName: string, reference: string): string {
  const actor = state.actors.find((candidate) => candidate.name === actorName);
  if (!actor || actor.role === "Master") return "";
  const sequence = nextActorLedgerSequence(state, actorName);
  const width = actorLedgerSequenceWidth(state, actorName);
  return `${String(sequence).padStart(width, "0")}_${formattedLedgerTransactionReference(reference)}`;
}

export function ensureActorLedgerNumbers(state: WorkspaceState): boolean {
  let changed = false;
  state.actors
    .filter((actor) => actor.active !== false && actor.role !== "Master")
    .forEach((actor) => {
      const groups = new Map<string, { lines: LedgerLine[]; reference: string; postedAt: string }>();
      state.ledger
        .filter((line) =>
          line.archived !== true &&
          ["TRANSFER", "TRANSFER_REVERSAL", "JOURNAL", "WITHDRAWAL"].includes(String(line.source || "")) &&
          lineBelongsToActor(line, actor.name)
        )
        .forEach((line) => {
          const reference = String(line.transferId || line.entryId || line.journal || "");
          if (!reference) return;
          const key = `${line.source}:${reference}`;
          const group = groups.get(key) || { lines: [], reference, postedAt: String(line.postedAt || "") };
          group.lines.push(line);
          if (!group.postedAt || new Date(line.postedAt || 0).getTime() < new Date(group.postedAt || 0).getTime()) {
            group.postedAt = String(line.postedAt || "");
          }
          groups.set(key, group);
        });
      const orderedGroups = Array.from(groups.values())
        .sort((left, right) => new Date(left.postedAt || 0).getTime() - new Date(right.postedAt || 0).getTime());
      orderedGroups.forEach((group) => {
        const existing = group.lines.find((line) => line.actorLedgerNumber)?.actorLedgerNumber;
        if (existing) {
          group.lines.forEach((line) => {
            if (line.actorLedgerNumber) return;
            line.actorLedgerNumber = existing;
            changed = true;
          });
          return;
        }
        const actorLedgerNumber = nextActorLedgerNumber(state, actor.name, group.reference);
        group.lines.forEach((line) => {
          line.actorLedgerNumber = actorLedgerNumber;
          changed = true;
        });
      });
    });
  return changed;
}

export function actorLedgerReferenceForLine(
  state: WorkspaceState,
  line: LedgerLine,
  actorName: string
): string {
  const order = String(line.source || "").startsWith("ORDER_")
    ? state.orders.find((item) => item.id === line.orderId || item.journal === line.journal || item.voidJournal === line.journal) ||
      state.archives.flatMap((archive) => archive.orders || []).find((item) =>
        item.id === line.orderId ||
        item.internalOrderId === line.orderId ||
        item.journal === line.journal ||
        item.voidJournal === line.journal
      )
    : undefined;
  if (order) {
    if (order.agent === actorName || order.agentActorId === state.actors.find((actor) => actor.name === actorName)?.id) {
      return order.agentOrderNumbers?.[actorName] || order.agentOrderNumber || order.brokerOrderNumber || order.id;
    }
    return order.brokerOrderNumber || order.id;
  }
  if (line.actorLedgerNumber) return String(line.actorLedgerNumber);
  return formattedLedgerTransactionReference(String(line.transferId || line.entryId || line.orderId || line.journal || ""));
}
