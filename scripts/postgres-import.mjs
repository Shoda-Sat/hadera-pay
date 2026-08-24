import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyPostgresMigrations } from "../src/postgres/migrations.mjs";
import { importPreparedDatabase, verifyImportedDatabase } from "../src/postgres/importer.mjs";
import {
  assertMatchingMigrationManifests,
  buildMigrationManifest,
  prepareDatabaseImport,
  reconstructPreparedDatabase,
  unbalancedJournals,
} from "../src/postgres/migrationModel.mjs";
import { closePostgresPool, withPostgresTransaction } from "../src/postgres/pool.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const sourcePath = argument("--source");
const migrationId = argument("--migration-id");
const dryRun = process.argv.includes("--dry-run");
const confirmedEmptyTarget = process.argv.includes("--confirm-empty-target");

if (!sourcePath) throw new Error("Use --source with the explicit auth-db.json backup path.");
if (!migrationId) throw new Error("Use --migration-id with a unique rehearsal or production migration ID.");
if (!dryRun && !confirmedEmptyTarget) {
  throw new Error("Actual import requires --confirm-empty-target and still refuses any occupied target database.");
}

const absoluteSourcePath = path.resolve(sourcePath);
const raw = await readFile(absoluteSourcePath, "utf8");
const sourceFileSha256 = crypto.createHash("sha256").update(raw).digest("hex");
const database = JSON.parse(raw);
const prepared = prepareDatabaseImport(database);
const reconstructed = reconstructPreparedDatabase(prepared, { clone: false });
assertMatchingMigrationManifests(prepared.manifest, buildMigrationManifest(reconstructed));
const badJournals = unbalancedJournals(prepared.manifest);
if (badJournals.length) {
  throw new Error(`Source backup contains ${badJournals.length} unbalanced journal/currency group(s); import was blocked.`);
}

const counts = prepared.workspaces.reduce((summary, workspace) => {
  summary.actors += workspace.actors.length;
  summary.orders += workspace.orders.length;
  summary.receivables += workspace.receivables.length;
  summary.transfers += workspace.transfers.length;
  summary.ledgerLines += workspace.ledgerLines.length;
  summary.closedReports += workspace.closedReports.length;
  return summary;
}, { actors: 0, orders: 0, receivables: 0, transfers: 0, ledgerLines: 0, closedReports: 0 });

console.log(JSON.stringify({
  mode: dryRun ? "dry-run" : "import",
  source: absoluteSourcePath,
  migrationId,
  sourceFileSha256,
  databaseSha256: prepared.sourceSha256,
  workspaceCount: prepared.workspaces.length,
  counts,
}, null, 2));

if (!dryRun) {
  try {
    await applyPostgresMigrations();
    const result = await withPostgresTransaction(async (client) => {
      await importPreparedDatabase(client, prepared, migrationId, { sourceFileSha256 });
      return verifyImportedDatabase(client, prepared.manifest, { sourceFileSha256 });
    });
    console.log(`Import and reconciliation passed: ${result.manifestSha256}`);
  } finally {
    await closePostgresPool();
  }
}
