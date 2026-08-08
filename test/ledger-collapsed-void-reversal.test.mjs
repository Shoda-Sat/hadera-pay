import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function evaluateCommonJs(source, fileName, dependencies = {}) {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    (request) => {
      if (Object.prototype.hasOwnProperty.call(dependencies, request)) return dependencies[request];
      throw new Error(`Unexpected dependency ${request} in ${fileName}`);
    }
  );
  return module.exports;
}

test("voided orders and reversed transfers collapse to one display row without changing ledger math", async () => {
  const source = await readFile(path.join(repositoryRoot, "mobile/src/domain/ledgerDisplay.ts"), "utf8");
  const { consolidatedLedgerDisplayLines } = evaluateCommonJs(source, "ledgerDisplay.ts");
  const state = {
    actors: [],
    orders: [{
      id: "ORD-1",
      brokerOrderNumber: "001_AAA001",
      broker: "Actor A",
      agent: "Actor B",
      senderName: "Sender",
      receiverName: "Receiver",
      sourceCurrency: "USD",
      sourceAmountMinor: 10000,
      payoutCurrency: "USD",
      payoutAmountMinor: 10000,
      state: "Voided",
      journal: "JRN-1",
      voidJournal: "JRN-2",
      voidedAt: "2026-08-08T11:00:00.000Z",
    }],
    transfers: [{
      id: "TRF-1",
      recordKey: "TRX:cycle-4:TRF-1",
      from: "Actor A",
      to: "Actor B",
      sourceCurrency: "USD",
      sourceAmountMinor: 5000,
      currency: "ETB",
      amountMinor: 10000,
      state: "Reversed",
      journal: "JRN-3",
      reversalJournal: "JRN-4",
      reversedAt: "2026-08-08T12:00:00.000Z",
    }],
    archives: [],
  };
  const lines = [
    { journal: "JRN-2", orderId: "ORD-1", source: "ORDER_VOID", account: "Actor A ACTOR_CLEARING", direction: "Credit", currency: "USD", amountMinor: 10000, postedAt: "2026-08-08T11:00:00.000Z", voided: true, excludedFromCalculations: true },
    { journal: "JRN-2", orderId: "ORD-1", source: "ORDER_VOID", account: "Actor A ACTOR_CLEARING", direction: "Credit", currency: "USD", amountMinor: 200, postedAt: "2026-08-08T11:00:00.000Z", voided: true, excludedFromCalculations: true },
    { journal: "JRN-1", orderId: "ORD-1", source: "ORDER_PAYMENT", account: "Actor A ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 10000, postedAt: "2026-08-08T10:00:00.000Z", voided: true, excludedFromCalculations: true },
    { journal: "JRN-1", orderId: "ORD-1", source: "ORDER_PAYMENT", account: "Actor A ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 200, postedAt: "2026-08-08T10:00:00.000Z", voided: true, excludedFromCalculations: true },
    { journal: "JRN-4", transferId: "TRF-1", transferRecordKey: "TRX:cycle-4:TRF-1", source: "TRANSFER_REVERSAL", account: "Actor A", direction: "Debit", currency: "USD", amountMinor: 5000, actorLedgerNumber: "005_TRF-01", postedAt: "2026-08-08T12:00:00.000Z" },
    { journal: "JRN-3", transferId: "TRF-1", transferRecordKey: "TRX:cycle-4:TRF-1", source: "TRANSFER", account: "Actor A", direction: "Credit", currency: "USD", amountMinor: 5000, actorLedgerNumber: "004_TRF-01", postedAt: "2026-08-08T09:00:00.000Z" },
    { journal: "JRN-5", entryId: "JNL-1", source: "JOURNAL", account: "Actor A", direction: "Debit", currency: "USD", amountMinor: 300, postedAt: "2026-08-08T08:00:00.000Z" },
  ];
  const snapshot = structuredClone(lines);
  const displayed = consolidatedLedgerDisplayLines(state, lines);

  assert.deepEqual(lines, snapshot, "display consolidation must not mutate accounting entries");
  assert.equal(displayed.length, 3);
  const voided = displayed.find((line) => line.displayState === "Voided");
  const reversed = displayed.find((line) => line.displayState === "Reversed");
  assert.deepEqual(voided.displayAmounts, [{ currency: "USD", signedMinor: 10200 }]);
  assert.equal(voided.journal, "JRN-1 / JRN-2");
  assert.match(voided.displayDetails, /Excluded from all calculations/);
  assert.deepEqual(reversed.displayAmounts, [{ currency: "USD", signedMinor: -5000 }]);
  assert.equal(reversed.actorLedgerNumber, "004_TRF-01", "the visible reversal keeps the original transaction number");
  assert.equal(reversed.journal, "JRN-3 / JRN-4");
  assert.match(reversed.displayDetails, /net to zero/);

  const voidCalculableLines = lines.filter((line) => line.orderId === "ORD-1" && line.excludedFromCalculations !== true);
  assert.equal(voidCalculableLines.length, 0);
  const reversalNet = lines
    .filter((line) => line.transferId === "TRF-1")
    .reduce((sum, line) => sum + (line.direction === "Debit" ? 1 : -1) * line.amountMinor, 0);
  assert.equal(reversalNet, 0);
});

test("web and Android render consolidated rows while keeping raw entries for balances", async () => {
  const [index, preview, screens, numbering] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/ledgerNumbering.ts"), "utf8"),
  ]);
  assert.equal(index, preview);
  assert.match(index, /function consolidatedLedgerDisplayLines\(lines = \[\]\)/);
  assert.match(index, /lines: visibleLines, displayLines/);
  assert.match(index, /ledgerBalanceRows\(visibleLines,/);
  assert.match(index, /line\.displayState \|\| ledgerLineIsForVoidedOrder\(line\) \? "void-row"/);
  assert.match(index, /ledgerDisplayCurrencyCells\(line\)/);
  assert.match(index, /displayLines: context\.displayLines/);
  assert.match(screens, /consolidatedLedgerDisplayLines\(state, lines\)/);
  assert.match(screens, /const balanceLines = useMemo\(\(\) => calculableLedgerLines\(state, lines\)/);
  assert.match(screens, /const highlighted = Boolean\(displayState\) \|\| voided/);
  assert.match(screens, /positions\.map\(\(item\) => item\.amount\)\.join\(" \/ "\)/);
  assert.match(numbering, /line\.source !== "TRANSFER_REVERSAL"/);
  assert.match(numbering, /line\.source === "TRANSFER" && line\.actorLedgerNumber/);
});

test("a hidden transfer reversal reuses the original Actor ledger number", async () => {
  const source = await readFile(path.join(repositoryRoot, "mobile/src/domain/ledgerNumbering.ts"), "utf8");
  const numbering = evaluateCommonJs(source, "ledgerNumbering.ts");
  const state = {
    actors: [{ id: "ACT-1", name: "Actor A", role: "Broker", active: true, numberingCycle: 0 }],
    orders: [],
    archives: [],
    ledger: [
      { journal: "JRN-1", transferId: "TRF-1", transferRecordKey: "TRX:1", source: "TRANSFER", account: "Actor A", direction: "Credit", currency: "USD", amountMinor: 5000, actorLedgerNumber: "004_TRF-01", postedAt: "2026-08-08T09:00:00.000Z" },
      { journal: "JRN-2", transferId: "TRF-1", transferRecordKey: "TRX:1", source: "TRANSFER_REVERSAL", account: "Actor A", direction: "Debit", currency: "USD", amountMinor: 5000, actorLedgerNumber: "005_TRF-01", postedAt: "2026-08-08T10:00:00.000Z" },
    ],
  };
  assert.equal(numbering.ensureActorLedgerNumbers(state), true);
  assert.equal(state.ledger[1].actorLedgerNumber, "004_TRF-01");
  assert.equal(numbering.nextActorLedgerNumber(state, "Actor A", "JNL-1"), "005_JNL-01");
});

test("Master Bank shows a reversed transfer once while retaining both sides of the amount", async () => {
  const source = await readFile(path.join(repositoryRoot, "mobile/src/domain/ledgerDisplay.ts"), "utf8");
  const { consolidatedMasterBankDisplayEntries } = evaluateCommonJs(source, "ledgerDisplay.ts");
  const entries = [
    { id: "BANK-TRANSFER-C4-TRF-1-OUT", type: "Transfer Out", reference: "TRF-1", direction: "Debit", currency: "USD", amountMinor: 5000, details: "Master to Actor", postedAt: "2026-08-08T09:00:00.000Z", runningMinor: -5000 },
    { id: "BANK-TRANSFER-C4-TRF-1-REVERSAL", type: "Transfer Reversal", reference: "JRN-2", direction: "Credit", currency: "USD", amountMinor: 5000, details: "Reversal of TRF-1", postedAt: "2026-08-08T10:00:00.000Z", runningMinor: 0 },
    { id: "BANK-FUND-1", type: "Funding", reference: "BANK-FUND-1", direction: "Credit", currency: "USD", amountMinor: 1000, details: "Funding", postedAt: "2026-08-08T11:00:00.000Z", runningMinor: 1000 },
  ];
  const snapshot = structuredClone(entries);
  const displayed = consolidatedMasterBankDisplayEntries(entries);
  assert.deepEqual(entries, snapshot);
  assert.equal(displayed.length, 2);
  assert.equal(displayed[0].displayReversed, true);
  assert.equal(displayed[0].moneyInMinor, 5000);
  assert.equal(displayed[0].moneyOutMinor, 5000);
  assert.equal(displayed[0].runningMinor, 0);
});

test("closed reports keep one red canonical row and show the voided or reversed amount", async () => {
  const [reportSource, dateSource, moneySource] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/src/domain/reportPdf.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/date.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8"),
  ]);
  const dateModule = evaluateCommonJs(dateSource, "date.ts");
  const moneyModule = evaluateCommonJs(moneySource, "money.ts");
  const reportModule = evaluateCommonJs(reportSource, "reportPdf.ts", {
    "../utils/date": dateModule,
    "../utils/money": moneyModule,
  });
  const viewer = { actorId: "ACT-1", actorName: "Actor A", actorRole: "Broker", currency: "USD" };
  const archive = {
    id: "ARC-1",
    actor: "Actor A",
    actorId: "ACT-1",
    actorRole: "Broker",
    actorCurrency: "USD",
    closedAt: "2026-08-08T13:00:00.000Z",
    balances: {},
    transfers: [{
      id: "TRF-1",
      from: "Actor A",
      to: "Actor B",
      sourceCurrency: "USD",
      sourceAmountMinor: 5000,
      currency: "ETB",
      amountMinor: 10000,
      state: "Reversed",
      journal: "JRN-3",
      reversalJournal: "JRN-4",
      reversedAt: "2026-08-08T12:00:00.000Z",
    }],
    ledger: [
      { journal: "JRN-3", transferId: "TRF-1", source: "TRANSFER", account: "Actor A", direction: "Credit", currency: "USD", amountMinor: 5000 },
      { journal: "JRN-4", transferId: "TRF-1", source: "TRANSFER_REVERSAL", account: "Actor A", direction: "Debit", currency: "USD", amountMinor: 5000 },
    ],
  };
  const rows = reportModule.archiveReportPdfRows([archive], [], viewer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reversed, true);
  assert.equal(rows[0].amount, "50.00 USD");
  assert.equal(rows[0].status, "Reversed - Netted to zero");
  const html = reportModule.buildArchiveReportPdfHtml("Reversed transfer", [archive], [], viewer);
  assert.match(html, /<tr class="void-row">/);
  assert.match(html, /50\.00 USD/);
  assert.match(html, /<td><\/td>\s*<td>Reversed - Netted to zero<\/td>/);

  const receiverArchive = {
    ...archive,
    actor: "Actor B",
    actorId: "ACT-2",
    ledger: archive.ledger.map((line) => ({ ...line, account: "Actor B" })),
  };
  const [receiverRow] = reportModule.archiveReportPdfRows(
    [receiverArchive],
    [],
    { ...viewer, actorId: "ACT-2", actorName: "Actor B" }
  );
  assert.equal(receiverRow.amount, "10,000 ETB");
});
