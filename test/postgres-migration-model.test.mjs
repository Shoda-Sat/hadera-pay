import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertMatchingMigrationManifests,
  buildMigrationManifest,
  canonicalJson,
  prepareDatabaseImport,
  prepareRuntimeWorkspace,
  reconstructPreparedDatabase,
  sha256Json,
  unbalancedJournals,
} from "../src/postgres/migrationModel.mjs";
import {
  assertPostgresCutoverAuthorized,
  selectedPersistenceBackend,
} from "../src/postgres/databaseStore.mjs";
import {
  closedReportSummary,
  findJsonClosedReport,
  identifyNewImmutableReports,
  jsonClosedReportKey,
  jsonClosedReportSummaries,
  reconcilePreparedPayloadRows,
} from "../src/postgres/runtimeStore.mjs";

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
  const runtimeMigration = await readFile(new URL("../sql/migrations/003_postgres_runtime.sql", import.meta.url), "utf8");
  const searchMigration = await readFile(new URL("../sql/migrations/004_workspace_search_indexes.sql", import.meta.url), "utf8");
  const rowPersistenceMigration = await readFile(new URL("../sql/migrations/005_stable_runtime_ordinals.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE hp_closed_reports/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON hp_closed_reports/);
  assert.match(sql, /CREATE TABLE hp_ledger_lines/);
  assert.match(sql, /CREATE INDEX hp_orders_workspace_state_idx/);
  assert.match(sql, /CREATE VIEW hp_journal_balances/);
  assert.match(collisionMigration, /DROP INDEX IF EXISTS hp_transfers_legacy_id_idx/);
  assert.match(collisionMigration, /CREATE INDEX hp_transfers_legacy_id_idx/);
  assert.doesNotMatch(collisionMigration, /CREATE UNIQUE INDEX/);
  assert.match(runtimeMigration, /DROP CONSTRAINT IF EXISTS hp_closed_reports_ordinal_check/);
  assert.match(searchMigration, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  for (const table of ["orders", "receivables", "transfers", "ledger_lines", "closed_reports"]) {
    assert.match(searchMigration, new RegExp(`hp_${table}_payload_search_idx`));
  }
  assert.match(rowPersistenceMigration, /CREATE TABLE hp_chat_conversations/);
  assert.match(rowPersistenceMigration, /CREATE TABLE hp_chat_messages/);
  assert.match(rowPersistenceMigration, /settings = settings - 'chatConversations'/);
  assert.match(rowPersistenceMigration, /DROP CONSTRAINT IF EXISTS hp_orders_ordinal_check/);
});

test("the live server wires PostgreSQL through the guarded runtime repository", async () => {
  const [server, runtimeStore] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/postgres/runtimeStore.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(server, /assertPostgresCutoverAuthorized\(\)/);
  assert.match(server, /await applyPostgresMigrations\(\)/);
  assert.match(server, /loadRuntimePostgresDatabase/);
  assert.match(server, /saveRuntimePostgresDatabase/);
  assert.match(server, /url\.searchParams\.get\("reports"\) === "summary"/);
  assert.match(server, /listPostgresClosedReportSummaries\(session\.workspace\.id, reportActorScope\)/);
  assert.match(server, /url\.pathname === "\/api\/search"/);
  assert.match(runtimeStore, /export async function searchPostgresWorkspaceRecords/);
  assert.match(runtimeStore, /ORDER BY sort_text DESC, kind, record_key/);
  assert.match(runtimeStore, /LIMIT \$\{limitPlaceholder\}/);
  assert.match(runtimeStore, /reconcilePreparedPayloadRows/);
  assert.match(runtimeStore, /workspaceCollections\[workspaceId\]/);
  assert.doesNotMatch(runtimeStore, /DELETE FROM \$\{table\} WHERE workspace_id = \$1/);
  assert.match(server, /collections: \["orders", "receivables", "savedCustomers"\]/);
  assert.match(server, /collections: \["orders", "receivables", "chatConversations"\]/);
});

test("closed report summaries omit transaction payloads and immutable rows can only be appended", () => {
  const report = {
    id: "ARC-1",
    actor: "Nahom",
    orders: [{ id: "ORD-1" }],
    receivables: [{ id: "REC-1" }],
    transfers: [{ id: "TFR-1" }],
    ledger: [{ journal: "JRN-1" }],
  };
  const key = jsonClosedReportKey(report, 0);
  const summary = closedReportSummary(report, key);
  assert.equal(summary._reportKey, key);
  assert.equal(summary._reportDetailLoaded, false);
  assert.equal(summary.orderCount, 1);
  assert.equal(summary.receivableCount, 1);
  assert.equal(summary.transferCount, 1);
  assert.equal(summary.ledgerLineCount, 1);
  assert.equal(Object.hasOwn(summary, "orders"), false);
  const otherReport = { ...report, id: "ARC-2", actorId: "ACT-2", actor: "Other Actor" };
  report.actorId = "ACT-1";
  const actorSummaries = jsonClosedReportSummaries([report, otherReport], {
    actorId: "ACT-1",
    actorName: "Nahom",
  });
  assert.deepEqual(actorSummaries.map((item) => item.id), ["ARC-1"]);
  assert.equal(actorSummaries[0]._reportKey, jsonClosedReportKey(report, 0), "Filtering must retain the immutable report key ordinal.");
  assert.deepEqual(findJsonClosedReport([report, otherReport], actorSummaries[0]._reportKey)?.orders, report.orders);
  const existing = [{ payloadSha256: sha256Json(report) }];
  const incoming = [{ payloadSha256: sha256Json(report) }, { payloadSha256: sha256Json({ id: "ARC-2" }) }];
  assert.deepEqual(identifyNewImmutableReports(existing, incoming), [incoming[1]]);
  assert.throws(() => identifyNewImmutableReports(existing, []), /immutable/);
});

test("runtime row reconciliation preserves old keys and writes only the changed order", () => {
  const existing = [
    { key: "imported-order-a", legacy_id: "ORD-1", ordinal: 0, payload_sha256: "hash-a" },
    { key: "imported-order-b", legacy_id: "ORD-2", ordinal: 1, payload_sha256: "hash-b" },
  ];
  const incoming = [
    { recordKey: "generated-new", legacyId: "ORD-3", ordinal: 0, payloadSha256: "hash-c", payload: { id: "ORD-3" } },
    { recordKey: "generated-a", legacyId: "ORD-1", ordinal: 1, payloadSha256: "hash-a", payload: { id: "ORD-1" } },
    { recordKey: "generated-b", legacyId: "ORD-2", ordinal: 2, payloadSha256: "hash-b-updated", payload: { id: "ORD-2" } },
  ];
  const plan = reconcilePreparedPayloadRows("hp_orders", existing, incoming);
  assert.equal(plan.rebalanced, false);
  assert.deepEqual(plan.deletedKeys, []);
  assert.equal(plan.rows[0].ordinal, -1, "A prepend must not renumber existing rows.");
  assert.equal(plan.rows[1].recordKey, "imported-order-a");
  assert.equal(plan.rows[2].recordKey, "imported-order-b");
  assert.deepEqual(plan.changedRows.map((row) => row.legacyId), ["ORD-3", "ORD-2"]);
});

test("runtime preparation normalizes only collections named by an atomic action", () => {
  const state = balancedDatabase().appStates["WS-1"];
  const prepared = prepareRuntimeWorkspace("WS-1", state, {
    collections: ["orders", "receivables"],
    cloneSettings: false,
  });
  assert.equal(prepared.orders.length, 1);
  assert.equal(prepared.receivables.length, 1);
  assert.equal(prepared.actors.length, 0);
  assert.equal(prepared.ledgerLines.length, 0);
  assert.equal(prepared.closedReports.length, 0);
  assert.equal(prepared.chatMessages.length, 0);
  assert.equal(Object.hasOwn(prepared.settings, "chatConversations"), false);
});

test("appending a chat message preserves every older message ordinal", () => {
  const existing = [
    { key: "message-a", legacy_id: "MSG-1", ordinal: 0, payload_sha256: "hash-a" },
    { key: "message-b", legacy_id: "MSG-2", ordinal: 1, payload_sha256: "hash-b" },
  ];
  const incoming = [
    { recordKey: "generated-a", legacyId: "MSG-1", ordinal: 0, payloadSha256: "hash-a", payload: { id: "MSG-1" } },
    { recordKey: "generated-new", legacyId: "MSG-3", ordinal: 1, payloadSha256: "hash-c", payload: { id: "MSG-3" } },
    { recordKey: "generated-b", legacyId: "MSG-2", ordinal: 2, payloadSha256: "hash-b", payload: { id: "MSG-2" } },
  ];
  const plan = reconcilePreparedPayloadRows("hp_chat_messages", existing, incoming);
  assert.equal(plan.rebalanced, false);
  assert.equal(plan.rows.find((row) => row.legacyId === "MSG-1").ordinal, 0);
  assert.equal(plan.rows.find((row) => row.legacyId === "MSG-2").ordinal, 1);
  assert.equal(plan.rows.find((row) => row.legacyId === "MSG-3").ordinal, 2);
  assert.deepEqual(plan.changedRows.map((row) => row.legacyId), ["MSG-3"]);
});

test("chat messages are normalized but reconstruct without changing the workspace", () => {
  const source = balancedDatabase();
  const prepared = prepareDatabaseImport(source);
  const workspace = prepared.workspaces[0];
  assert.equal(workspace.chatConversations.length, 1);
  assert.equal(workspace.chatMessages.length, 1);
  assert.equal(Object.hasOwn(workspace.settings, "chatConversations"), false);
  assert.deepEqual(reconstructPreparedDatabase(prepared), source);
});
