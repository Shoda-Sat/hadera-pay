import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("manual logout and file exports require confirmation", async () => {
  const [index, preview, mobileApp] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(index, /title: "Confirm logout", yes: "Log out", no: "Stay logged in"/);
  assert.match(index, /function confirmFileExport\(format, subject, exportAction\)/);
  assert.match(index, /downloaded file may contain sensitive financial information/);
  assert.match(index, /confirmFileExport\("Excel", "the current ledger", exportLedgerExcel\)/);
  assert.match(index, /confirmFileExport\("PDF", "the current ledger", exportLedgerPdf\)/);
  assert.match(index, /confirmFileExport\("Excel", "the selected report", exportArchiveExcel\)/);
  assert.match(index, /confirmFileExport\("PDF", "the selected report", exportArchivePdf\)/);

  assert.match(mobileApp, /Alert\.alert\("Log out\?"/);
  assert.match(mobileApp, /"Export PDF\?"/);
  assert.match(mobileApp, /onPress=\{confirmReportPdfExport\}/);
});
