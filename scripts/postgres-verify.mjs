import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyPostgresMigrations } from "../src/postgres/migrations.mjs";
import { verifyImportedDatabase } from "../src/postgres/importer.mjs";
import { buildMigrationManifest } from "../src/postgres/migrationModel.mjs";
import { closePostgresPool, postgresPool } from "../src/postgres/pool.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const sourcePath = argument("--source");
let expectedManifest = null;
let sourceFileSha256 = "";
if (sourcePath) {
  const raw = await readFile(path.resolve(sourcePath), "utf8");
  sourceFileSha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const source = JSON.parse(raw);
  expectedManifest = buildMigrationManifest(source);
}

try {
  await applyPostgresMigrations();
  const client = await postgresPool().connect();
  try {
    const result = await verifyImportedDatabase(client, expectedManifest, { sourceFileSha256 });
    console.log(JSON.stringify({
      ok: true,
      migrationId: result.migrationId,
      sourceFileSha256: result.sourceFileSha256,
      databaseSha256: result.databaseSha256,
      manifestSha256: result.manifestSha256,
      sourceCompared: Boolean(sourcePath),
      workspaceCount: result.manifest.workspaceCount,
    }, null, 2));
  } finally {
    client.release();
  }
} finally {
  await closePostgresPool();
}
