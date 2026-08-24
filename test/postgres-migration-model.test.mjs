import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertMatchingMigrationManifests,
  buildMigrationManifest,
  canonicalJson,
  prepareDatabaseImport,
  reconstructPreparedDatabase,
  sha256Json,
  unbalancedJournals,
} from "../src/postgres/migrationModel.mjs";
import {
  assertPostgresCutoverAuthorized,
  selectedPersistenceBackend,
} from "../src/postgres/databaseStore.mjs";

function balancedDatabase() {
  return {
    users: [{ id: "USR-1", name: "Master", passwordHash: "private-hash" }],
    workspaces: [{ id: "WS-1", name: "Galaxy Workspace" }],
    memberships: [],
    sessions: [],
    files: [],
    ownerPasswordHash: "owner-private-hash",
    appStates: {
      "WS-1": {
        _workspaceId: "WS-1",
        _syncRevision: "revision-7",
        journalCounter: 12,
        actors: [
          { id: "ACT-0", name: "Master", role: "Master", currency: "USD" },
          { id: "ACT-1", name: "Nahom", role: "Agent", currency: "USD" },
        ],
        orders: [{
          id: "ORD-1",
          journal: "JRN-12",
          state: "Paid",
          brokerActorId: "ACT-2",
          agentActorId: "ACT-1",
          createdAt: "2026-08-24T10:00:00.000Z",
        }],
        receivables: [{ id: "REC-1", orderId: "ORD-1", journal: "JRN-12", borrowerActorId: "ACT-2", payments: [] }],
        transfers: [],
        ledger: [
          { journal: "JRN-12", orderId: "ORD-1", source: "ORDER_PAYMENT", actorId: "ACT-1", account: "Nahom ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 10000 },
          { journal: "JRN-12", orderId: "ORD-1", source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "USD", amountMinor: 10000 },
        ],
        archives: [{ id: "ARC-1", actorId: "ACT-1", actor: "Nahom", closedAt: "2026-08-24T11:00:00.000Z", orders: [], ledger: [] }],
        savedCustomers: [],
        settlements: [{ actor: "Nahom", currency: "USD", netMinor: 0 }],
        chatConversations: [{ id: "CHAT-1", messages: [{ id: "MSG-1", text: "Preserve me" }] }],
      },
    },
  };
}

test("PostgreSQL import preparation is lossless and keeps closed reports unchanged", () => {
  const source = balancedDatabase();
  const prepared = prepareDatabaseImport(source);
  const reconstructed = reconstructPreparedDatabase(prepared);
  assert.deepEqual(reconstructed, source);
  assertMatchingMigrationManifests(buildMigrationManifest(source), buildMigrationManifest(reconstructed));
  assert.equal(prepared.workspaces[0].closedReports[0].payloadSha256, buildMigrationManifest(source).workspaces[0].closedReports[0].sha256);
  assert.equal(unbalancedJournals(prepared.manifest).length, 0);
});

test("streaming JSON evidence matches canonical JSON without allocating a normalized database copy", () => {
  const source = balancedDatabase();
  const expected = crypto.createHash("sha256").update(canonicalJson(source)).digest("hex");
  assert.equal(sha256Json(source), expected);
});

test("PostgreSQL import preparation preserves duplicate legacy record IDs losslessly", () => {
  const source = balancedDatabase();
  source.appStates["WS-1"].orders.push({ ...source.appStates["WS-1"].orders[0] });
  source.appStates["WS-1"].transfers.push(
    { id: "TFR-1", journal: "JRN-12", amountMinor: 5000 },
    { id: "TFR-1", journal: "JRN-13", amountMinor: 7000 },
  );

  const prepared = prepareDatabaseImport(source);
  const workspace = prepared.workspaces[0];

  assert.equal(new Set(workspace.orders.map((row) => row.recordKey)).size, 2);
  assert.equal(new Set(workspace.transfers.map((row) => row.recordKey)).size, 2);
  assert.deepEqual(reconstructPreparedDatabase(prepared), source);
});

test("PostgreSQL manifest identifies an unbalanced journal without changing its amount", () => {
  const source = balancedDatabase();
  source.appStates["WS-1"].ledger[1].amountMinor = 9999;
  const prepared = prepareDatabaseImport(source);
  assert.equal(unbalancedJournals(prepared.manifest).length, 1);
  assert.equal(unbalancedJournals(prepared.manifest)[0].differenceMinor, 1);
  assert.equal(reconstructPreparedDatabase(prepared).appStates["WS-1"].ledger[1].amountMinor, 9999);
});

test("PostgreSQL cutover requires both the backend choice and reconciliation confirmation", () => {
  const previousBackend = process.env.PERSISTENCE_BACKEND;
  const previousConfirmation = process.env.POSTGRES_CUTOVER_CONFIRMED;
  try {
    process.env.PERSISTENCE_BACKEND = "json";
    delete process.env.POSTGRES_CUTOVER_CONFIRMED;
    assert.equal(selectedPersistenceBackend(), "json");
    assert.throws(() => assertPostgresCutoverAuthorized(), /not selected/);
    process.env.PERSISTENCE_BACKEND = "postgres";
    assert.throws(() => assertPostgresCutoverAuthorized(), /blocked/);
    process.env.POSTGRES_CUTOVER_CONFIRMED = "reconciled-production-import";
    assert.doesNotThrow(() => assertPostgresCutoverAuthorized());
  } finally {
    if (previousBackend === undefined) delete process.env.PERSISTENCE_BACKEND;
    else process.env.PERSISTENCE_BACKEND = previousBackend;
    if (previousConfirmation === undefined) delete process.env.POSTGRES_CUTOVER_CONFIRMED;
    else process.env.POSTGRES_CUTOVER_CONFIRMED = previousConfirmation;
  }
});

test("PostgreSQL schema makes closed reports immutable and keeps transactional indexes", async () => {
  const sql = await readFile(new URL("../sql/migrations/001_lossless_import.sql", import.meta.url), "utf8");
  const collisionMigration = await readFile(new URL("../sql/migrations/002_allow_legacy_id_collisions.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE hp_closed_reports/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON hp_closed_reports/);
  assert.match(sql, /CREATE TABLE hp_ledger_lines/);
  assert.match(sql, /CREATE INDEX hp_orders_workspace_state_idx/);
  assert.match(sql, /CREATE VIEW hp_journal_balances/);
  assert.match(collisionMigration, /DROP INDEX IF EXISTS hp_transfers_legacy_id_idx/);
  assert.match(collisionMigration, /CREATE INDEX hp_transfers_legacy_id_idx/);
  assert.doesNotMatch(collisionMigration, /CREATE UNIQUE INDEX/);
});

test("the live server refuses an accidental PostgreSQL cutover before repository wiring", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /PostgreSQL cutover is not enabled in this release/);
  assert.match(server, /Keep PERSISTENCE_BACKEND=json/);
});
