import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("closed Report repair is guarded, backed up, and Master-only", async () => {
  const [server, index, preview] = await Promise.all([
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
  ]);

  assert.equal(index, preview, "Production and preview clients must remain identical.");
  assert.match(server, /backfillClosedParticipantOrderSnapshots/);
  assert.match(server, /Only Master can repair closed Actor reports/);
  assert.match(server, /expectedRevision[\s\S]*planDigest[\s\S]*expectedCount !== plan\.candidateCount/);
  assert.match(server, /orderArchiveRepairInvariantState\(beforeState\)/);
  assert.match(server, /afterPlan\.repairedCount !== 0 \|\| afterPlan\.skippedCount !== 0/);

  const backupPosition = server.indexOf("await createOrderArchiveRepairBackup(rawDatabase");
  const writePosition = server.indexOf("await writePersistedDbAtomic(latestDb)", backupPosition);
  assert.ok(backupPosition > 0 && writePosition > backupPosition, "A verified backup must finish before repaired data is written.");
  assert.match(server, /crypto\.scryptSync\(ownerPassword, salt, 32\)/);
  assert.match(server, /crypto\.createCipheriv\("aes-256-gcm"/);
  assert.match(server, /private-backups\/database/);
  assert.match(server, /GetObjectCommand\(\{ Bucket: r2BucketName, Key: objectKey \}\)/);
  assert.match(server, /storedPayload\.equals\(Buffer\.from\(payload\)\)/);
  assert.match(server, /Private backup storage is unavailable, so no report data was changed/);
  assert.match(server, /filePath === protectedDataPath[\s\S]*filePath\.startsWith/);
  assert.match(server, /filePath === protectedSourcePath/);
  assert.match(server, /protectedRelativePath/);
  assert.match(server, /rootRelativePath\.startsWith\(`\.\.\$\{path\.sep\}`\)/);

  assert.match(index, /id="orderArchiveRepairActor"/);
  assert.match(index, /id="orderArchiveRepairButton"/);
  assert.match(index, /This changes Report details only—not ledger balances or closed totals/);
  assert.match(index, /expectedCount: plan\.candidateCount/);
  assert.match(index, /expectedRevision: plan\.revision/);
  assert.match(index, /planDigest: plan\.planDigest/);
  assert.match(server, /const scope = body\.scope === "wipe" \? "wipe" : "data";[\s\S]*?workspaceStateSaveOptions\(db, session\.workspace\.id, expectedRevision\)/);
});

test("an unreadable existing database is never treated as an empty database", async () => {
  const server = await readFile(path.join(repositoryRoot, "server.mjs"), "utf8");
  assert.match(server, /if \(error\?\.code === "ENOENT"\) return null/);
  assert.match(server, /database could not be read safely/);
});
