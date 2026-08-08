import type { Currency, InternalTransferRecord, LedgerLine, MasterBankEntryRecord, OrderRecord, WorkspaceState } from "../types";

export type LedgerDisplayState = "Voided" | "Reversed";

export interface LedgerDisplayAmount {
  currency: Currency;
  signedMinor: number;
}

export type LedgerDisplayLine = LedgerLine & {
  displayState?: LedgerDisplayState;
  displayAmounts?: LedgerDisplayAmount[];
  displayDetails?: string;
  displayRawLineCount?: number;
};

export type MasterBankDisplayEntry = MasterBankEntryRecord & {
  runningMinor: number;
  displayReversed?: boolean;
  moneyInMinor?: number;
  moneyOutMinor?: number;
};

type TransferLike = Partial<InternalTransferRecord> & Record<string, unknown>;

function orderIsVoided(order: OrderRecord | undefined): boolean {
  return Boolean(
    order && (
      order.state === "Voided" ||
      order.excludedFromCalculations === true ||
      order.voidedAt ||
      order.voidJournal
    )
  );
}

function orderForLine(state: WorkspaceState, line: LedgerLine): OrderRecord | undefined {
  if (!String(line.source || "").startsWith("ORDER_")) return undefined;
  const orders = [
    ...state.orders,
    ...state.archives.flatMap((archive) => archive.orders || []),
  ];
  return orders.find((order) =>
    (line.orderId && (order.id === line.orderId || order.internalOrderId === line.orderId)) ||
    (line.journal && (order.journal === line.journal || order.voidJournal === line.journal))
  );
}

function transferIdentity(transfer: TransferLike | undefined): string {
  if (!transfer) return "";
  return String(transfer.recordKey || [
    "TRX",
    transfer.id || "",
    transfer.createdAt || transfer.sentAt || "",
    transfer.from || "",
    transfer.to || "",
    transfer.sourceCurrency || transfer.currency || "",
    transfer.sourceAmountMinor || transfer.amountMinor || 0,
  ].join(":"));
}

function transfersInState(state: WorkspaceState): TransferLike[] {
  return [
    ...state.transfers,
    ...state.archives.flatMap((archive) => archive.transfers || []),
  ] as TransferLike[];
}

function transferForLine(state: WorkspaceState, line: LedgerLine): TransferLike | undefined {
  if (!["TRANSFER", "TRANSFER_REVERSAL"].includes(String(line.source || ""))) return undefined;
  const transfers = transfersInState(state);
  const recordKey = String(line.transferRecordKey || "");
  if (recordKey) {
    const exact = transfers.find((transfer) => transferIdentity(transfer) === recordKey);
    if (exact) return exact;
  }
  return transfers.find((transfer) =>
    (line.journal && (transfer.journal === line.journal || transfer.reversalJournal === line.journal)) ||
    (line.transferId && transfer.id === line.transferId)
  );
}

function transferIsReversed(transfer: TransferLike | undefined): boolean {
  return Boolean(
    transfer && (
      transfer.state === "Reversed" ||
      transfer.reversalJournal ||
      transfer.reversedAt
    )
  );
}

function uniqueText(values: unknown[]): string {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).join(" / ");
}

function originalAmounts(lines: LedgerLine[], originalSource: "ORDER_PAYMENT" | "TRANSFER"): LedgerDisplayAmount[] {
  const originals = lines.filter((line) => line.source === originalSource);
  const byCurrency = new Map<Currency, number>();
  originals.forEach((line) => {
    const signedMinor = line.direction === "Debit"
      ? Number(line.amountMinor || 0)
      : -Number(line.amountMinor || 0);
    byCurrency.set(line.currency, (byCurrency.get(line.currency) || 0) + signedMinor);
  });
  const amounts = Array.from(byCurrency, ([currency, signedMinor]) => ({ currency, signedMinor }))
    .filter((item) => item.signedMinor !== 0);
  if (amounts.length) return amounts;

  const fallback = originals
    .slice()
    .sort((left, right) => Number(right.amountMinor || 0) - Number(left.amountMinor || 0))[0];
  return fallback
    ? [{
        currency: fallback.currency,
        signedMinor: fallback.direction === "Debit"
          ? Number(fallback.amountMinor || 0)
          : -Number(fallback.amountMinor || 0),
      }]
    : [];
}

function displayDirection(amounts: LedgerDisplayAmount[], fallback: LedgerLine["direction"]): LedgerLine["direction"] {
  if (amounts.length && amounts.every((amount) => amount.signedMinor >= 0)) return "Debit";
  if (amounts.length && amounts.every((amount) => amount.signedMinor <= 0)) return "Credit";
  return fallback;
}

function consolidatedOrderLine(order: OrderRecord, lines: LedgerLine[]): LedgerDisplayLine {
  const originals = lines.filter((line) => line.source === "ORDER_PAYMENT");
  const primary = originals[0] || lines[0];
  const amounts = originalAmounts(lines, "ORDER_PAYMENT");
  const names = [
    order.senderName ? `Sender: ${order.senderName}` : "",
    order.receiverName ? `Receiver: ${order.receiverName}` : "",
  ].filter(Boolean);
  return {
    ...primary,
    journal: uniqueText([order.journal, order.voidJournal, ...lines.map((line) => line.journal)]),
    orderId: order.id,
    source: "ORDER_VOID",
    direction: displayDirection(amounts, primary.direction),
    currency: amounts[0]?.currency || primary.currency,
    amountMinor: Math.abs(amounts[0]?.signedMinor ?? Number(primary.amountMinor || 0)),
    actorLedgerNumber: originals.find((line) => line.actorLedgerNumber)?.actorLedgerNumber || primary.actorLedgerNumber,
    postedAt: order.voidedAt || lines.find((line) => line.source === "ORDER_VOID")?.postedAt || primary.postedAt,
    details: primary.details,
    displayState: "Voided",
    displayAmounts: amounts,
    displayDetails: ["VOIDED - Excluded from all calculations", ...names].join(" - "),
    displayRawLineCount: lines.length,
  };
}

function consolidatedTransferLine(transfer: TransferLike, lines: LedgerLine[]): LedgerDisplayLine {
  const originals = lines.filter((line) => line.source === "TRANSFER");
  const primary = originals[0] || lines[0];
  const amounts = originalAmounts(lines, "TRANSFER");
  const participants = transfer.from || transfer.to
    ? `${String(transfer.from || "Unknown")} -> ${String(transfer.to || "Unknown")}`
    : "";
  return {
    ...primary,
    journal: uniqueText([transfer.journal, transfer.reversalJournal, ...lines.map((line) => line.journal)]),
    transferId: String(transfer.id || primary.transferId || ""),
    transferRecordKey: String(primary.transferRecordKey || transferIdentity(transfer)),
    source: "TRANSFER_REVERSAL",
    direction: displayDirection(amounts, primary.direction),
    currency: amounts[0]?.currency || primary.currency,
    amountMinor: Math.abs(amounts[0]?.signedMinor ?? Number(primary.amountMinor || 0)),
    actorLedgerNumber: originals.find((line) => line.actorLedgerNumber)?.actorLedgerNumber || primary.actorLedgerNumber,
    postedAt: String(transfer.reversedAt || lines.find((line) => line.source === "TRANSFER_REVERSAL")?.postedAt || primary.postedAt || ""),
    details: primary.details,
    displayState: "Reversed",
    displayAmounts: amounts,
    displayDetails: ["REVERSED - Original and reversal net to zero", participants].filter(Boolean).join(" - "),
    displayRawLineCount: lines.length,
  };
}

function displayGroup(state: WorkspaceState, line: LedgerLine): {
  key: string;
  kind: "order" | "transfer";
  order?: OrderRecord;
  transfer?: TransferLike;
} | null {
  const order = orderForLine(state, line);
  if (orderIsVoided(order)) {
    return { key: `void-order:${order?.internalOrderId || order?.id}`, kind: "order", order };
  }
  const transfer = transferForLine(state, line);
  if (transferIsReversed(transfer)) {
    return { key: `reversed-transfer:${transferIdentity(transfer)}`, kind: "transfer", transfer };
  }
  return null;
}

/**
 * Combines only the visible compensating rows. The source ledger array is never
 * changed and must still be used for balances and settlements.
 */
export function consolidatedLedgerDisplayLines(
  state: WorkspaceState,
  lines: LedgerLine[]
): LedgerDisplayLine[] {
  const groups = new Map<string, {
    kind: "order" | "transfer";
    order?: OrderRecord;
    transfer?: TransferLike;
    lines: LedgerLine[];
  }>();
  lines.forEach((line) => {
    const group = displayGroup(state, line);
    if (!group) return;
    const current = groups.get(group.key) || { ...group, lines: [] };
    current.lines.push(line);
    groups.set(group.key, current);
  });

  const renderedGroups = new Set<string>();
  return lines.flatMap((line) => {
    const group = displayGroup(state, line);
    if (!group) return [line];
    if (renderedGroups.has(group.key)) return [];
    renderedGroups.add(group.key);
    const collected = groups.get(group.key);
    if (!collected?.lines.length) return [line];
    if (collected.kind === "order" && collected.order) {
      return [consolidatedOrderLine(collected.order, collected.lines)];
    }
    if (collected.kind === "transfer" && collected.transfer) {
      return [consolidatedTransferLine(collected.transfer, collected.lines)];
    }
    return [line];
  });
}

/** Combines a Transfer Out and its compensating bank reversal for display only. */
export function consolidatedMasterBankDisplayEntries(
  entries: MasterBankDisplayEntry[]
): MasterBankDisplayEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const consumed = new Set<string>();
  const output: MasterBankDisplayEntry[] = [];
  entries.forEach((entry) => {
    if (consumed.has(entry.id)) return;
    if (!entry.id.endsWith("-OUT")) {
      if (!entry.id.endsWith("-REVERSAL")) output.push(entry);
      else {
        const outId = `${entry.id.slice(0, -"-REVERSAL".length)}-OUT`;
        if (!byId.has(outId)) output.push(entry);
      }
      consumed.add(entry.id);
      return;
    }
    const reversalId = `${entry.id.slice(0, -"-OUT".length)}-REVERSAL`;
    const reversal = byId.get(reversalId);
    if (!reversal || reversal.currency !== entry.currency) {
      output.push(entry);
      consumed.add(entry.id);
      return;
    }
    consumed.add(entry.id);
    consumed.add(reversal.id);
    output.push({
      ...entry,
      id: `${entry.id}-REVERSED-DISPLAY`,
      type: "Reversed Transfer",
      postedAt: reversal.postedAt || entry.postedAt,
      details: reversal.details || entry.details,
      runningMinor: reversal.runningMinor,
      displayReversed: true,
      moneyInMinor: Number(reversal.amountMinor || 0),
      moneyOutMinor: Number(entry.amountMinor || 0),
    });
  });
  return output.sort((left, right) => {
    const timeDifference = new Date(left.postedAt || 0).getTime() - new Date(right.postedAt || 0).getTime();
    return timeDifference || String(left.id).localeCompare(String(right.id));
  });
}
