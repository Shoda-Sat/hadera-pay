import type { ActorRecord, ArchiveRecord, Currency, OrderRecord, UserSession } from "../types";
import { formatDate, formatDateTime, formatMonthYear } from "../utils/date";
import { currencies, currencyDecimals, majorFromMinor } from "../utils/money";

type ArchivedTransfer = NonNullable<ArchiveRecord["transfers"]>[number];
type ArchivedOrder = OrderRecord & {
  payerCurrency?: Currency;
  payerAmountMinor?: number;
};

export interface ReportPdfRow {
  date: string;
  statement: string;
  actor: string;
  type: string;
  reference: string;
  direction: string;
  details: string;
  amount: string;
  paidOut: string;
  currencyAmounts: Partial<Record<Currency, string>>;
  status: string;
  voided: boolean;
}

function archiveMonthKey(value: string | undefined): string {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function archiveBaseCurrency(archive: ArchiveRecord, actors: ActorRecord[]): Currency {
  const actor = actors.find((item) => item.id === archive.actorId || item.name === archive.actor);
  return archive.actorCurrency || actor?.currency || "USD";
}

function archiveActorRole(archive: ArchiveRecord, actors: ActorRecord[]): ActorRecord["role"] | "" {
  const actor = actors.find((item) => item.id === archive.actorId || item.name === archive.actor);
  return archive.actorRole || actor?.role || "";
}

function formattedMinor(currency: Currency, amountMinor: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: currencyDecimals(currency),
    maximumFractionDigits: currencyDecimals(currency),
  }).format(majorFromMinor(Number(amountMinor || 0), currency));
}

function moneyLabel(currency: Currency, amountMinor: number): string {
  return `${formattedMinor(currency, amountMinor)} ${currency}`;
}

function reportOrderNumber(order: OrderRecord, viewer: UserSession): string {
  const isPayingActor = ["Agent", "Special Agent", "Special Broker"].includes(viewer.actorRole) &&
    (order.agentActorId === viewer.actorId || order.agent === viewer.actorName);
  return isPayingActor
    ? order.agentOrderNumbers?.[viewer.actorName] || order.agentOrderNumber || order.brokerOrderNumber || order.id
    : order.brokerOrderNumber || order.id;
}

function reportOrderAmount(
  archive: ArchiveRecord,
  order: ArchivedOrder,
  actors: ActorRecord[]
): { currency: Currency; amountMinor: number } {
  const baseCurrency = archiveBaseCurrency(archive, actors);
  const role = archiveActorRole(archive, actors);
  const sourceCurrency = order.sourceCurrency || "USD";
  const payoutCurrency = order.payoutCurrency || sourceCurrency;
  if (role === "Special Agent") {
    if ((order.incomeBaseCurrency || "USD") === baseCurrency && Number(order.incomeBaseAmountMinor || 0) > 0) {
      return { currency: baseCurrency, amountMinor: Number(order.incomeBaseAmountMinor || 0) };
    }
    if (order.payerCurrency === baseCurrency && Number(order.payerAmountMinor || 0) > 0) {
      return { currency: baseCurrency, amountMinor: Number(order.payerAmountMinor || 0) };
    }
    if (payoutCurrency === baseCurrency && Number(order.payoutAmountMinor || 0) > 0) {
      return { currency: baseCurrency, amountMinor: Number(order.payoutAmountMinor || 0) };
    }
  }
  return { currency: sourceCurrency, amountMinor: Number(order.sourceAmountMinor || 0) };
}

export function specialAgentTransferBaseAmountMinor(
  archive: ArchiveRecord,
  transfer: ArchivedTransfer,
  actors: ActorRecord[]
): number | null {
  if (archiveActorRole(archive, actors) !== "Special Agent") return null;
  const baseCurrency = archiveBaseCurrency(archive, actors);
  const sourceCurrency = transfer.sourceCurrency || transfer.currency || "USD";
  const payoutCurrency = transfer.currency || sourceCurrency;
  const sourceAmountMinor = Number(transfer.sourceAmountMinor || transfer.amountMinor || 0);
  const payoutAmountMinor = Number(transfer.amountMinor || 0);
  if (sourceCurrency === baseCurrency && Number.isFinite(sourceAmountMinor)) return sourceAmountMinor;
  if (payoutCurrency === baseCurrency && Number.isFinite(payoutAmountMinor)) return payoutAmountMinor;
  return null;
}

function statementLabel(archive: ArchiveRecord): string {
  const month = archiveMonthKey(archive.closedAt);
  return `${month ? formatMonthYear(month) : "Unknown month"} / ${archive.id || "Reported close"}`;
}

function orderRow(
  archive: ArchiveRecord,
  order: ArchivedOrder,
  actors: ActorRecord[],
  viewer: UserSession
): ReportPdfRow {
  const amount = reportOrderAmount(archive, order, actors);
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency || "USD";
  const payoutAmountMinor = Number(order.payoutAmountMinor || order.sourceAmountMinor || 0);
  const paidOut = ["Special Agent", "Special Broker"].includes(archiveActorRole(archive, actors))
    ? moneyLabel(payoutCurrency, payoutAmountMinor)
    : "";
  const voided = order.state === "Voided" || Boolean(
    order.voidedAt || order.voidJournal || order.excludedFromCalculations
  );
  return {
    date: formatDate(order.sentAt || order.createdAt || archive.closedAt),
    statement: statementLabel(archive),
    actor: archive.actor || viewer.actorName,
    type: "Order",
    reference: reportOrderNumber(order, viewer),
    direction: `${order.broker || ""} -> ${order.agent || ""}`,
    details: [
      order.senderName ? `Sender: ${order.senderName}` : "",
      order.receiverName ? `Receiver: ${order.receiverName}` : "",
      order.receiverCity ? `Receiver City: ${order.receiverCity}` : "",
      order.remarks ? `Remarks: ${order.remarks}` : "",
      order.paidAt ? `Paid ${formatDateTime(order.paidAt)}` : "",
      voided ? "Excluded from all calculations" : "",
    ].filter(Boolean).join(" - "),
    amount: moneyLabel(amount.currency, amount.amountMinor),
    paidOut,
    currencyAmounts: { [amount.currency]: formattedMinor(amount.currency, amount.amountMinor) },
    status: voided ? "Voided - Excluded" : "Locked",
    voided,
  };
}

function transferRow(
  archive: ArchiveRecord,
  transfer: ArchivedTransfer,
  actors: ActorRecord[],
  viewer: UserSession
): ReportPdfRow {
  const sourceCurrency = transfer.sourceCurrency || transfer.currency || "USD";
  const payoutCurrency = transfer.currency || sourceCurrency;
  const sourceAmountMinor = Number(transfer.sourceAmountMinor || transfer.amountMinor || 0);
  const payoutAmountMinor = Number(transfer.amountMinor || 0);
  const baseCurrency = archiveBaseCurrency(archive, actors);
  const baseAmountMinor = specialAgentTransferBaseAmountMinor(archive, transfer, actors);
  const currencyAmounts: Partial<Record<Currency, string>> = {
    [payoutCurrency]: formattedMinor(payoutCurrency, payoutAmountMinor),
  };
  if (baseAmountMinor !== null) {
    currencyAmounts[baseCurrency] = formattedMinor(baseCurrency, baseAmountMinor);
  }
  return {
    date: formatDate(transfer.sentAt || transfer.createdAt || archive.closedAt),
    statement: statementLabel(archive),
    actor: archive.actor || viewer.actorName,
    type: "Transfer",
    reference: transfer.id || transfer.journal || "",
    direction: `${transfer.from || ""} -> ${transfer.to || ""}`,
    details: [
      `Source: ${moneyLabel(sourceCurrency, sourceAmountMinor)}`,
      `Payout: ${moneyLabel(payoutCurrency, payoutAmountMinor)}`,
      transfer.rate ? `Rate: ${transfer.rate}` : "",
      transfer.remarks ? `Remarks: ${transfer.remarks}` : "",
    ].filter(Boolean).join(" - "),
    amount: moneyLabel(payoutCurrency, payoutAmountMinor),
    paidOut: "",
    currencyAmounts,
    status: "Locked",
    voided: false,
  };
}

function archiveRows(archive: ArchiveRecord, actors: ActorRecord[], viewer: UserSession): ReportPdfRow[] {
  const rows: ReportPdfRow[] = [];
  (archive.orders || []).forEach((order) => rows.push(orderRow(archive, order, actors, viewer)));
  (archive.receivables || []).forEach((receivable) => {
    const currency = receivable.currency || "USD";
    const linkedOrder = (archive.orders || []).find((order) =>
      order.id === receivable.orderId ||
      order.internalOrderId === receivable.orderId ||
      order.brokerOrderNumber === receivable.brokerOrderNumber
    );
    const voided = receivable.voided === true || Boolean(receivable.voidedAt) ||
      linkedOrder?.state === "Voided" ||
      Boolean(linkedOrder?.voidedAt || linkedOrder?.voidJournal || linkedOrder?.excludedFromCalculations);
    rows.push({
      date: formatDate(receivable.archivedAt || archive.closedAt),
      statement: statementLabel(archive),
      actor: archive.actor || viewer.actorName,
      type: "Receivable",
      reference: receivable.brokerOrderNumber || receivable.orderId || receivable.id,
      direction: receivable.borrower ? `Borrower: ${receivable.borrower}` : "",
      details: [
        receivable.receiverName ? `Receiver: ${receivable.receiverName}` : "",
        receivable.receiverCity ? `Receiver City: ${receivable.receiverCity}` : "",
        voided ? "Excluded from all calculations" : "",
      ].filter(Boolean).join(" - "),
      amount: moneyLabel(currency, Number(receivable.principalMinor || 0)),
      paidOut: "",
      currencyAmounts: { [currency]: formattedMinor(currency, Number(receivable.principalMinor || 0)) },
      status: voided ? "Voided - Excluded" : "Locked",
      voided,
    });
  });
  (archive.transfers || []).forEach((transfer) => rows.push(transferRow(archive, transfer, actors, viewer)));
  (archive.ledger || []).forEach((line) => {
    const currency = line.currency || "USD";
    const voided = line.voided === true || line.excludedFromCalculations === true;
    rows.push({
      date: formatDate(line.postedAt || archive.closedAt),
      statement: statementLabel(archive),
      actor: archive.actor || viewer.actorName,
      type: line.source === "JOURNAL" ? "Journal" : line.source === "WITHDRAWAL" ? "Withdrawal" : "Ledger",
      reference: String(line.actorLedgerNumber || line.entryId || line.transferId || line.orderId || line.journal || ""),
      direction: line.direction || "",
      details: [
        line.details || line.account || "",
        voided ? "Excluded from all calculations" : "",
      ].filter(Boolean).join(" - "),
      amount: moneyLabel(currency, Number(line.amountMinor || 0)),
      paidOut: "",
      currencyAmounts: { [currency]: formattedMinor(currency, Number(line.amountMinor || 0)) },
      status: voided ? "Voided - Excluded" : "Locked",
      voided,
    });
  });
  currencies.forEach((currency) => {
    const netMinor = Number(archive.balances?.[currency] || 0);
    if (!netMinor) return;
    rows.push({
      date: formatDate(archive.closedAt),
      statement: statementLabel(archive),
      actor: archive.actor || viewer.actorName,
      type: "Current Close",
      reference: archive.id || "Reported close",
      direction: netMinor > 0 ? "Owes Master" : "Master owes",
      details: netMinor > 0
        ? `${archive.actor || viewer.actorName} owes Master`
        : `Master owes ${archive.actor || viewer.actorName}`,
      amount: moneyLabel(currency, Math.abs(netMinor)),
      paidOut: "",
      currencyAmounts: { [currency]: formattedMinor(currency, netMinor) },
      status: "Locked",
      voided: false,
    });
  });
  return rows;
}

export function archiveReportPdfRows(
  archives: ArchiveRecord[],
  actors: ActorRecord[],
  viewer: UserSession
): ReportPdfRow[] {
  return archives.flatMap((archive) => archiveRows(archive, actors, viewer));
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function buildArchiveReportPdfHtml(
  title: string,
  archives: ArchiveRecord[],
  actors: ActorRecord[],
  viewer: UserSession,
  fontBase64 = ""
): string {
  const rows = archiveReportPdfRows(archives, actors, viewer);
  const presentCurrencies = currencies.filter((currency) =>
    rows.some((row) => row.currencyAmounts[currency] !== undefined)
  );
  const body = rows.map((row) => `
    <tr class="${row.voided ? "void-row" : ""}">
      <td>${escapeHtml(row.date)}</td>
      <td>${escapeHtml(row.statement)}</td>
      <td>${escapeHtml(row.actor)}</td>
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.reference)}</td>
      <td>${escapeHtml(row.direction)}</td>
      <td class="details">${escapeHtml(row.details)}</td>
      <td>${escapeHtml(row.amount)}</td>
      ${rows.some((item) => item.paidOut) ? `<td>${escapeHtml(row.paidOut)}</td>` : ""}
      ${presentCurrencies.map((currency) => `<td>${escapeHtml(row.voided ? "" : row.currencyAmounts[currency] || "")}</td>`).join("")}
      <td>${escapeHtml(row.status)}</td>
    </tr>
  `).join("");
  const paidOutHeader = rows.some((row) => row.paidOut) ? "<th>Paid Out</th>" : "";
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <style>
        @page { size: A4 landscape; margin: 8mm; }
        ${fontBase64 ? `@font-face { font-family: "HaderaReport"; src: url("data:font/truetype;base64,${fontBase64}") format("truetype"); font-weight: normal; font-style: normal; }` : ""}
        * { box-sizing: border-box; }
        body { margin: 0; color: #18241e; font-family: ${fontBase64 ? '"HaderaReport", ' : ""}sans-serif; font-size: 7px; }
        h1 { margin: 0 0 3px; color: #104c36; font-size: 15px; font-weight: 600; }
        .meta { margin: 0 0 8px; color: #526058; font-size: 8px; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        thead { display: table-header-group; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        th, td { border: 0.5px solid #94a09a; padding: 3px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
        th { background: #e8f2ed; font-size: 7px; font-weight: 700; }
        td { line-height: 1.28; }
        .details { width: 22%; }
        .void-row td { background: #fde8e8; color: #9f1f26; }
        .empty { padding: 18px; color: #526058; }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">Exported ${escapeHtml(formatDateTime(new Date()))} - ${rows.length} record${rows.length === 1 ? "" : "s"}</p>
      ${rows.length ? `
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Closed Statement</th>
              <th>Actor</th>
              <th>Type</th>
              <th>Reference</th>
              <th>Direction</th>
              <th class="details">Details</th>
              <th>Amount</th>
              ${paidOutHeader}
              ${presentCurrencies.map((currency) => `<th>${currency}</th>`).join("")}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      ` : '<div class="empty">No closed report records are available for this selection.</div>'}
    </body>
  </html>`;
}
