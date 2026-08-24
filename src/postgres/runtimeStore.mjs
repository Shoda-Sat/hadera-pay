import crypto from "node:crypto";
import {
  insertPreparedWorkspace,
  reconstructDatabaseFromPostgres,
} from "./importer.mjs";
import {
  prepareDatabaseImport,
  sha256Json,
} from "./migrationModel.mjs";
import { postgresPool, withPostgresTransaction } from "./pool.mjs";

const mutableWorkspaceTables = [
  "hp_ledger_lines",
  "hp_journal_entries",
  "hp_actors",
  "hp_orders",
  "hp_receivables",
  "hp_transfers",
  "hp_saved_customers",
  "hp_master_bank_entries",
  "hp_settlements",
];

function cleanText(value) {
  return String(value || "").trim();
}

function reportCount(report, field) {
  const value = report?.[field];
  return Array.isArray(value) ? value.length : Number(report?.[`${field.slice(0, -1)}Count`] || 0);
}

function closedOrderReferences(orders = []) {
  return (Array.isArray(orders) ? orders : []).map((order) => ({
    id: cleanText(order?.id),
    internalOrderId: cleanText(order?.internalOrderId),
    collisionSourceOrderId: cleanText(order?.collisionSourceOrderId),
    journal: cleanText(order?.journal),
  }));
}

export function closedReportSummary(report, reportKey = "") {
  const source = report && typeof report === "object" ? report : {};
  const { orders, receivables, transfers, ledger, ...summary } = source;
  return {
    ...summary,
    _orderRefs: Array.isArray(source._orderRefs) ? source._orderRefs : closedOrderReferences(orders),
    _reportKey: cleanText(reportKey || source._reportKey),
    _reportDetailLoaded: false,
    orderCount: reportCount(source, "orders"),
    receivableCount: reportCount(source, "receivables"),
    transferCount: reportCount(source, "transfers"),
    ledgerLineCount: Array.isArray(ledger) ? ledger.length : Number(source.ledgerLineCount || 0),
  };
}

export function closedReportDetail(report, reportKey = "") {
  return {
    ...(report && typeof report === "object" ? report : {}),
    _reportKey: cleanText(reportKey || report?._reportKey),
    _reportDetailLoaded: true,
  };
}

export function jsonClosedReportKey(report, ordinal) {
  return `json:${String(ordinal).padStart(8, "0")}:${sha256Json(report).slice(0, 24)}`;
}

export function jsonClosedReportSummaries(reports = []) {
  return (Array.isArray(reports) ? reports : []).map((report, ordinal) =>
    closedReportSummary(report, jsonClosedReportKey(report, ordinal))
  );
}

export function findJsonClosedReport(reports = [], reportKey = "") {
  const source = Array.isArray(reports) ? reports : [];
  const index = source.findIndex((report, ordinal) => jsonClosedReportKey(report, ordinal) === reportKey);
  return index < 0 ? null : closedReportDetail(source[index], reportKey);
}

export async function loadRuntimePostgresDatabase(options = {}) {
  const client = await postgresPool().connect();
  try {
    return await reconstructDatabaseFromPostgres(client, options);
  } finally {
    client.release();
  }
}

function reportHashCounts(rows) {
  const counts = new Map();
  rows.forEach((row) => counts.set(row.payloadSha256, (counts.get(row.payloadSha256) || 0) + 1));
  return counts;
}

export function identifyNewImmutableReports(existingRows, incomingRows) {
  const remaining = reportHashCounts(existingRows || []);
  const additions = [];
  for (const row of incomingRows || []) {
    const count = remaining.get(row.payloadSha256) || 0;
    if (count > 0) remaining.set(row.payloadSha256, count - 1);
    else additions.push(row);
  }
  if (Array.from(remaining.values()).some((count) => count !== 0)) {
    throw new Error("A closed report was removed or changed. Closed reports are immutable.");
  }
  return additions;
}

async function persistDatabaseMetadata(client, db) {
  const metadata = Object.fromEntries(Object.entries(db || {}).filter(([key]) => key !== "appStates"));
  await client.query(
    `INSERT INTO hp_database_metadata(singleton, document, metadata_sha256, updated_at)
     VALUES (true, $1::jsonb, $2, now())
     ON CONFLICT (singleton) DO UPDATE
     SET document = EXCLUDED.document, metadata_sha256 = EXCLUDED.metadata_sha256, updated_at = now()`,
    [JSON.stringify(metadata), sha256Json(metadata)]
  );
}

async function insertNewClosedReports(client, workspace, existingRows) {
  const additions = identifyNewImmutableReports(existingRows, workspace.closedReports);
  if (!additions.length) return;
  const existingMinimum = existingRows.length
    ? Math.min(...existingRows.map((row) => Number(row.ordinal)))
    : 0;
  const firstOrdinal = existingMinimum - additions.length;
  for (let index = 0; index < additions.length; index += 1) {
    const row = additions[index];
    const recordKey = `runtime:${crypto.randomUUID()}:${row.payloadSha256.slice(0, 16)}`;
    await client.query(
      `INSERT INTO hp_closed_reports(
         workspace_id, record_key, legacy_id, ordinal, actor_id, actor_name, closed_at_text, payload, payload_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        workspace.workspaceId,
        recordKey,
        row.legacyId,
        firstOrdinal + index,
        row.actorId,
        row.actorName,
        row.closedAtText,
        JSON.stringify(row.payload),
        row.payloadSha256,
      ]
    );
  }
}

async function persistWorkspace(client, workspace, expectedRevision) {
  const locked = await client.query(
    "SELECT revision FROM hp_workspace_states WHERE workspace_id = $1 FOR UPDATE",
    [workspace.workspaceId]
  );
  const actualRevision = locked.rowCount ? String(locked.rows[0].revision || "0") : "0";
  if (expectedRevision !== undefined && actualRevision !== String(expectedRevision || "0")) {
    const error = new Error("The workspace changed before this action finished. Refresh and try again.");
    error.statusCode = 409;
    throw error;
  }
  const existingReportsResult = await client.query(
    "SELECT record_key, ordinal, payload_sha256 FROM hp_closed_reports WHERE workspace_id = $1 ORDER BY ordinal",
    [workspace.workspaceId]
  );
  const existingRows = existingReportsResult.rows.map((row) => ({
    recordKey: String(row.record_key),
    ordinal: Number(row.ordinal),
    payloadSha256: String(row.payload_sha256),
  }));
  identifyNewImmutableReports(existingRows, workspace.closedReports);

  await client.query(
    `INSERT INTO hp_workspace_states(workspace_id, revision, settings, collection_presence, source_sha256)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
     ON CONFLICT (workspace_id) DO UPDATE
     SET revision = EXCLUDED.revision,
         settings = EXCLUDED.settings,
         collection_presence = EXCLUDED.collection_presence,
         source_sha256 = EXCLUDED.source_sha256`,
    [
      workspace.workspaceId,
      workspace.revision,
      JSON.stringify(workspace.settings),
      JSON.stringify(workspace.collectionPresence),
      workspace.sourceSha256,
    ]
  );
  for (const table of mutableWorkspaceTables) {
    await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspace.workspaceId]);
  }
  await insertPreparedWorkspace(client, workspace, { includeClosedReports: false });
  await insertNewClosedReports(client, workspace, existingRows);

  const unbalanced = await client.query(
    `SELECT journal, currency, difference_minor
       FROM hp_journal_balances
      WHERE workspace_id = $1 AND difference_minor <> 0
      ORDER BY journal, currency`,
    [workspace.workspaceId]
  );
  if (unbalanced.rowCount) {
    throw new Error(`Workspace ${workspace.workspaceId} contains ${unbalanced.rowCount} unbalanced journal/currency group(s).`);
  }
}

export async function saveRuntimePostgresDatabase(db, options = {}) {
  const requestedWorkspaceIds = Array.from(new Set((options.workspaceIds || []).map(String).filter(Boolean)));
  const expectedRevisions = options.expectedAppStateRevisions || {};
  const prepared = prepareDatabaseImport(db);
  const preparedById = new Map(prepared.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  return withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('haderapay-runtime-write'))");
    await persistDatabaseMetadata(client, db);
    for (const workspaceId of requestedWorkspaceIds) {
      const workspace = preparedById.get(workspaceId);
      if (!workspace) {
        // Removing a Master revokes the workspace through top-level auth metadata.
        // Keep its normalized rows as inaccessible audit evidence; imported manifests
        // and immutable reports intentionally prevent destructive cascades.
        continue;
      }
      await persistWorkspace(client, workspace, expectedRevisions[workspaceId]);
    }
  });
}

export async function listPostgresClosedReportSummaries(workspaceId) {
  const result = await postgresPool().query(
    `SELECT
       record_key,
       payload - ARRAY['orders', 'receivables', 'transfers', 'ledger']::text[] AS summary,
       CASE WHEN jsonb_typeof(payload -> 'orders') = 'array' THEN jsonb_array_length(payload -> 'orders') ELSE 0 END AS order_count,
       CASE WHEN jsonb_typeof(payload -> 'receivables') = 'array' THEN jsonb_array_length(payload -> 'receivables') ELSE 0 END AS receivable_count,
       CASE WHEN jsonb_typeof(payload -> 'transfers') = 'array' THEN jsonb_array_length(payload -> 'transfers') ELSE 0 END AS transfer_count,
       CASE WHEN jsonb_typeof(payload -> 'ledger') = 'array' THEN jsonb_array_length(payload -> 'ledger') ELSE 0 END AS ledger_line_count,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', item ->> 'id',
           'internalOrderId', item ->> 'internalOrderId',
           'collisionSourceOrderId', item ->> 'collisionSourceOrderId',
           'journal', item ->> 'journal'
         ))
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(payload -> 'orders') = 'array' THEN payload -> 'orders' ELSE '[]'::jsonb END
         ) AS item
       ), '[]'::jsonb) AS order_refs
       FROM hp_closed_reports
      WHERE workspace_id = $1
      ORDER BY ordinal`,
    [workspaceId]
  );
  return result.rows.map((row) => closedReportSummary({
    ...(row.summary || {}),
    orderCount: Number(row.order_count || 0),
    receivableCount: Number(row.receivable_count || 0),
    transferCount: Number(row.transfer_count || 0),
    ledgerLineCount: Number(row.ledger_line_count || 0),
    _orderRefs: row.order_refs || [],
  }, row.record_key));
}

export async function getPostgresClosedReport(workspaceId, reportKey) {
  const result = await postgresPool().query(
    `SELECT record_key, payload
       FROM hp_closed_reports
      WHERE workspace_id = $1 AND record_key = $2`,
    [workspaceId, reportKey]
  );
  if (result.rowCount !== 1) return null;
  return closedReportDetail(result.rows[0].payload, result.rows[0].record_key);
}
