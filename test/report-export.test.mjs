import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Could not find ${name}`);
  const tail = source.slice(start);
  const sourceFile = ts.createSourceFile("report-export.js", tail, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  assert.ok(declaration, `Could not parse ${name}`);
  return tail.slice(declaration.getStart(sourceFile), declaration.end);
}

function evaluateFunction(source, name, dependencies = {}) {
  const dependencyNames = Object.keys(dependencies);
  const dependencyValues = Object.values(dependencies);
  return new Function(
    ...dependencyNames,
    `${extractFunction(source, name)}; return ${name};`
  )(...dependencyValues);
}

function formatMinor(amountMinor, currency) {
  const decimals = { USD: 2, ETB: 0, EUR: 2, ERN: 0, SSP: 2, SDG: 2, LYD: 3 }[currency] ?? 0;
  return (Number(amountMinor || 0) / (10 ** decimals)).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

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

test("Special Agent report PDFs place converted base amounts in the base-currency column", async () => {
  const [index, preview] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
  ]);
  assert.equal(index, preview);

  const specialAgentTransferBaseAmountMinor = evaluateFunction(
    index,
    "specialAgentTransferBaseAmountMinor",
    {
      state: { actors: [] },
      archiveStatementBaseCurrency: (archive) => archive.actorCurrency || "USD",
    }
  );
  assert.equal(
    specialAgentTransferBaseAmountMinor(
      { actorRole: "Special Agent", actorCurrency: "USD" },
      { sourceCurrency: "USD", sourceAmountMinor: 272777, currency: "ETB", amountMinor: 500000 }
    ),
    272777
  );
  assert.equal(
    specialAgentTransferBaseAmountMinor(
      { actorRole: "Special Agent", actorCurrency: "EUR" },
      { sourceCurrency: "EUR", sourceAmountMinor: 12345, currency: "ERN", amountMinor: 2222 }
    ),
    12345
  );
  assert.equal(
    specialAgentTransferBaseAmountMinor(
      { actorRole: "Agent", actorCurrency: "USD" },
      { sourceCurrency: "USD", sourceAmountMinor: 272777, currency: "ETB", amountMinor: 500000 }
    ),
    null
  );

  const archiveExportRows = evaluateFunction(index, "archiveExportRows", {
    orderedArchiveExportRecords: (records) => records,
    supportedCurrencies: ["USD", "ETB", "EUR", "ERN", "SSP", "SDG", "LYD"],
    archiveMonthLabel: (month) => month,
    archiveMonthKey: () => "2026-07",
    displayDateOnly: () => "30/07/2026",
    displayDate: () => "30/07/2026",
    displayTimeOnly: () => "12:00",
    formatMinor,
  });
  const commonRecord = {
    actor: "Nahommm",
    closedAt: "2026-07-25T00:00:00.000Z",
    date: "2026-07-24T00:00:00.000Z",
    archiveId: "ARC-1",
    type: "Transfer",
    reference: "TRF-22",
    journal: "JRN-1136",
    direction: "Nahommm -> Walta",
    status: "Locked",
  };
  const pdfOptions = {
    pdfMode: true,
    includeDirection: true,
    includeJournal: true,
    includeEur: true,
    includeActor: true,
    includeTime: false,
  };
  const [usdBaseRow] = archiveExportRows([{
    ...commonRecord,
    baseCurrency: "USD",
    details: "Source: USD 2,727.77 - Payout: ETB 500,000",
    currency: "ETB",
    amountMinor: 500000,
    convertedBaseAmountMinor: 272777,
  }], pdfOptions);
  assert.equal(usdBaseRow.USD, "2,727.77");
  assert.equal(usdBaseRow.ETB, "500,000");

  const [eurBaseRow] = archiveExportRows([{
    ...commonRecord,
    baseCurrency: "EUR",
    details: "Source: EUR 123.45 - Payout: ERN 2,222",
    currency: "ERN",
    amountMinor: 2222,
    convertedBaseAmountMinor: 12345,
  }], pdfOptions);
  assert.equal(eurBaseRow.EUR, "123.45");
  assert.equal(eurBaseRow.ERN, "2,222");

  const privilegeViews = evaluateFunction(index, "privilegeViews", { selectedActor: () => null });
  ["Broker", "Agent", "Special Broker", "Special Agent"].forEach((role) => {
    assert.equal(privilegeViews(role, { role, transferEnabled: true }).includes("archive"), true);
  });
});

test("Android report PDF export is available to every Actor and preserves base-currency amounts", async () => {
  const [reportSource, dateSource, moneySource, appSource, packageSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/src/domain/reportPdf.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/date.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/package.json"), "utf8"),
  ]);
  const dateModule = evaluateCommonJs(dateSource, "date.ts");
  const moneyModule = evaluateCommonJs(moneySource, "money.ts");
  const reportModule = evaluateCommonJs(reportSource, "reportPdf.ts", {
    "../utils/date": dateModule,
    "../utils/money": moneyModule,
  });
  const packageJson = JSON.parse(packageSource);
  assert.equal(typeof packageJson.dependencies["expo-print"], "string");
  assert.match(appSource, /label="Export report PDF"/);
  assert.match(appSource, /Print\.printToFileAsync/);
  const exportButtonAt = appSource.indexOf('label="Export report PDF"');
  assert.doesNotMatch(appSource.slice(exportButtonAt - 180, exportButtonAt + 360), /actorRole|isMasterView/);

  const baseArchive = {
    id: "ARC-1",
    actor: "Actor One",
    actorId: "ACT-1",
    actorCurrency: "USD",
    closedAt: "2026-07-25T00:00:00.000Z",
    balances: {},
    transfers: [{
      id: "TRF-22",
      from: "Actor One",
      to: "Actor Two",
      sourceCurrency: "USD",
      sourceAmountMinor: 272777,
      currency: "ETB",
      amountMinor: 500000,
      rate: 183.3,
      sentAt: "2026-07-24T00:00:00.000Z",
    }],
  };
  ["Broker", "Agent", "Special Broker", "Special Agent"].forEach((actorRole) => {
    const viewer = {
      actorId: "ACT-1",
      actorName: "Actor One",
      actorRole,
      currency: "USD",
    };
    const rows = reportModule.archiveReportPdfRows([{ ...baseArchive, actorRole }], [], viewer);
    assert.equal(rows.length, 1, `${actorRole} should be able to build report rows`);
  });

  const specialAgentViewer = {
    actorId: "ACT-1",
    actorName: "Actor One",
    actorRole: "Special Agent",
    currency: "USD",
  };
  const [usdBaseRow] = reportModule.archiveReportPdfRows(
    [{ ...baseArchive, actorRole: "Special Agent" }],
    [],
    specialAgentViewer
  );
  assert.equal(usdBaseRow.currencyAmounts.USD, "2,727.77");
  assert.equal(usdBaseRow.currencyAmounts.ETB, "500,000");

  const [eurBaseRow] = reportModule.archiveReportPdfRows([{
    ...baseArchive,
    actorCurrency: "EUR",
    actorRole: "Special Agent",
    transfers: [{
      ...baseArchive.transfers[0],
      sourceCurrency: "EUR",
      sourceAmountMinor: 12345,
      currency: "ERN",
      amountMinor: 2222,
    }],
  }], [], { ...specialAgentViewer, currency: "EUR" });
  assert.equal(eurBaseRow.currencyAmounts.EUR, "123.45");
  assert.equal(eurBaseRow.currencyAmounts.ERN, "2,222");
});
