import crypto from "node:crypto";
import {
  preparedWorkspaceTableSpecs,
  reconstructDatabaseFromPostgres,
  upsertRows,
} from "./importer.mjs";
import {
  prepareRuntimeWorkspace,
  sha256Json,
} from "./migrationModel.mjs";
import { postgresPool, withPostgresTransaction } from "./pool.mjs";

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

function closedReportMatchesActor(report, actorId = "", actorName = "") {
  const reportActorId = cleanText(report?.actorId);
  if (reportActorId) return Boolean(actorId && reportActorId === cleanText(actorId));
  return Boolean(actorName && cleanText(report?.actor) === cleanText(actorName));
}

export function jsonClosedReportSummaries(reports = [], { actorId = "", actorName = "" } = {}) {
  const actorScoped = Boolean(cleanText(actorId) || cleanText(actorName));
  return (Array.isArray(reports) ? reports : []).flatMap((report, ordinal) =>
    actorScoped && !closedReportMatchesActor(report, actorId, actorName)
      ? []
      : [closedReportSummary(report, jsonClosedReportKey(report, ordinal))]
  );
}

export function findJsonClosedReport(reports = [], reportKey = "") {
  const source = Array.isArray(reports) ? reports : [];
  const directKey = cleanText(reportKey).match(/^json:(\d{8}):([a-f0-9]{24})$/i);
  if (directKey) {
    const ordinal = Number(directKey[1]);
    const report = source[ordinal];
    return report && jsonClosedReportKey(report, ordinal) === reportKey
      ? closedReportDetail(report, reportKey)
      : null;
  }
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

function payloadRowIdentity(table, row) {
  if (cleanText(row?.legacyId)) return `legacy:${cleanText(row.legacyId)}`;
  if (table === "hp_ledger_lines") {
    return `ledger:${sha256Json([
      cleanText(row?.journalEntryKey), cleanText(row?.journal), cleanText(row?.source), cleanText(row?.orderId),
      cleanText(row?.transferId), cleanText(row?.actorId), cleanText(row?.account), cleanText(row?.direction),
      cleanText(row?.currency), cleanText(row?.payload?.entryId),
    ])}`;
  }
  if (table === "hp_settlements") {
    return `settlement:${sha256Json([cleanText(row?.actorName), cleanText(row?.currency)])}`;
  }
  return "";
}

function existingPayloadRowIdentity(table, row) {
  if (cleanText(row?.legacy_id)) return `legacy:${cleanText(row.legacy_id)}`;
  if (table === "hp_ledger_lines") {
    return `ledger:${sha256Json([
      cleanText(row?.journal_entry_key), cleanText(row?.journal), cleanText(row?.source), cleanText(row?.order_id),
      cleanText(row?.transfer_id), cleanText(row?.actor_id), cleanText(row?.account), cleanText(row?.direction),
      cleanText(row?.currency), cleanText(row?.entry_id),
    ])}`;
  }
  if (table === "hp_settlements") {
    return `settlement:${sha256Json([cleanText(row?.actor_name), cleanText(row?.currency)])}`;
  }
  return "";
}

function allocateStableOrdinals(plannedRows) {
  const anchors = plannedRows
    .map((item, index) => ({ index, ordinal: item.existingOrdinal }))
    .filter((item) => Number.isSafeInteger(item.ordinal));
  let mustRebalance = anchors.some((anchor, index) => index > 0 && anchor.ordinal <= anchors[index - 1].ordinal);
  if (!mustRebalance) {
    for (let index = 1; index < anchors.length; index += 1) {
      const openSlots = anchors[index].ordinal - anchors[index - 1].ordinal - 1;
      const neededSlots = anchors[index].index - anchors[index - 1].index - 1;
      if (openSlots < neededSlots) {
        mustRebalance = true;
        break;
      }
    }
  }
  if (mustRebalance || anchors.length === 0) {
    return {
      rebalanced: mustRebalance,
      rows: plannedRows.map((item, ordinal) => ({ ...item, row: { ...item.row, ordinal: ordinal * 1024 } })),
    };
  }

  const assigned = plannedRows.map((item) => ({ ...item, row: { ...item.row } }));
  const firstAnchor = anchors[0];
  for (let index = firstAnchor.index - 1; index >= 0; index -= 1) {
    assigned[index].row.ordinal = firstAnchor.ordinal - (firstAnchor.index - index);
  }
  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const anchor = anchors[anchorIndex];
    assigned[anchor.index].row.ordinal = anchor.ordinal;
    const nextAnchor = anchors[anchorIndex + 1];
    const segmentEnd = nextAnchor ? nextAnchor.index : assigned.length;
    for (let index = anchor.index + 1; index < segmentEnd; index += 1) {
      assigned[index].row.ordinal = anchor.ordinal + (index - anchor.index);
    }
  }
  return { rebalanced: false, rows: assigned };
}

export function reconcilePreparedPayloadRows(table, existingRows = [], incomingRows = []) {
  const existing = existingRows.map((row) => ({
    key: cleanText(row.key ?? row.record_key),
    legacyId: cleanText(row.legacy_id),
    ordinal: Number(row.ordinal),
    payloadSha256: cleanText(row.payload_sha256),
    logicalIdentity: existingPayloadRowIdentity(table, row),
  }));
  const unused = new Set(existing.map((row) => row.key));
  const usedKeys = new Set(existing.map((row) => row.key));
  const take = (predicate) => {
    const match = existing.find((row) => unused.has(row.key) && predicate(row));
    if (match) unused.delete(match.key);
    return match || null;
  };
  const planned = incomingRows.map((sourceRow) => {
    const row = { ...sourceRow };
    const sourceRecordKey = cleanText(row.recordKey);
    const legacyId = cleanText(row.legacyId);
    const logicalIdentity = payloadRowIdentity(table, row);
    const match = take((candidate) =>
      candidate.payloadSha256 === row.payloadSha256 && (!legacyId || candidate.legacyId === legacyId)
    ) || take((candidate) => candidate.payloadSha256 === row.payloadSha256)
      || (logicalIdentity ? take((candidate) => candidate.logicalIdentity === logicalIdentity) : null)
      || (legacyId ? take((candidate) => candidate.legacyId === legacyId) : null)
      || take((candidate) => candidate.key === cleanText(row.recordKey));
    if (match) row.recordKey = match.key;
    else if (!cleanText(row.recordKey) || usedKeys.has(cleanText(row.recordKey))) {
      row.recordKey = `runtime:${table}:${crypto.randomUUID()}`;
    }
    usedKeys.add(row.recordKey);
    return {
      row,
      sourceRecordKey,
      existingKey: match?.key || "",
      existingOrdinal: match?.ordinal,
      existingPayloadSha256: match?.payloadSha256 || "",
    };
  });
  const allocated = table === "hp_chat_messages"
    ? (() => {
        let nextOrdinal = Math.max(-1, ...existing.map((row) => row.ordinal)) + 1;
        return {
          rebalanced: false,
          rows: planned.map((item) => ({
            ...item,
            row: {
              ...item.row,
              ordinal: Number.isSafeInteger(item.existingOrdinal) ? item.existingOrdinal : nextOrdinal++,
            },
          })),
        };
      })()
    : allocateStableOrdinals(planned);
  return {
    rebalanced: allocated.rebalanced,
    rows: allocated.rows.map((item) => item.row),
    changedRows: allocated.rows
      .filter((item) => !item.existingKey
        || item.existingPayloadSha256 !== item.row.payloadSha256
        || item.existingOrdinal !== item.row.ordinal)
      .map((item) => item.row),
    deletedKeys: Array.from(unused),
    keyMappings: new Map(allocated.rows.map((item) => [item.sourceRecordKey, item.row.recordKey])),
  };
}

function payloadIdentitySelect(table) {
  if (table === "hp_ledger_lines") {
    return ", journal_entry_key, journal, source, order_id, transfer_id, actor_id, account, direction, currency, payload ->> 'entryId' AS entry_id";
  }
  if (table === "hp_settlements") return ", actor_name, currency";
  return "";
}

async function planPayloadTableSync(client, spec, workspaceId) {
  const legacyColumn = spec.columns.includes("legacy_id") ? "legacy_id" : "NULL::text AS legacy_id";
  const result = await client.query(
    `SELECT ${spec.keyColumn} AS key, ${legacyColumn}, ordinal, payload_sha256${payloadIdentitySelect(spec.table)}
       FROM ${spec.table}
      WHERE workspace_id = $1
      ORDER BY ordinal`,
    [workspaceId]
  );
  return reconcilePreparedPayloadRows(spec.table, result.rows, spec.rows);
}

async function deleteRowKeys(client, spec, workspaceId, keys) {
  if (!keys.length) return;
  await client.query(
    `DELETE FROM ${spec.table} WHERE workspace_id = $1 AND ${spec.keyColumn} = ANY($2::text[])`,
    [workspaceId, keys]
  );
}

async function applyPayloadTablePlan(client, spec, workspaceId, plan, options = {}) {
  let rowsToUpsert = plan.changedRows;
  if (plan.rebalanced) {
    const existingMaximum = await client.query(
      `SELECT COALESCE(max(abs(ordinal)), 0)::bigint AS maximum FROM ${spec.table} WHERE workspace_id = $1`,
      [workspaceId]
    );
    const shift = Number(existingMaximum.rows[0]?.maximum || 0) + (plan.rows.length + 1) * 2048;
    await client.query(`UPDATE ${spec.table} SET ordinal = ordinal + $2 WHERE workspace_id = $1`, [workspaceId, shift]);
    rowsToUpsert = plan.rows;
  }
  if (options.deleteMissing !== false) await deleteRowKeys(client, spec, workspaceId, plan.deletedKeys);
  await upsertRows(client, spec, rowsToUpsert);
}

function journalEntrySignature(row) {
  return sha256Json([
    cleanText(row?.journal), cleanText(row?.source), cleanText(row?.orderId ?? row?.order_id),
    cleanText(row?.transferId ?? row?.transfer_id), Number(row?.firstOrdinal ?? row?.first_ordinal),
    row?.metadata || {},
  ]);
}

async function upsertJournalEntries(client, spec, workspaceId) {
  const existingResult = await client.query(
    `SELECT journal_entry_key, journal, source, order_id, transfer_id, first_ordinal, metadata
       FROM hp_journal_entries WHERE workspace_id = $1`,
    [workspaceId]
  );
  const existing = new Map(existingResult.rows.map((row) => [String(row.journal_entry_key), row]));
  const desiredKeys = new Set(spec.rows.map((row) => row.journalEntryKey));
  const changedRows = spec.rows.filter((row) => {
    const previous = existing.get(row.journalEntryKey);
    return !previous || journalEntrySignature(previous) !== journalEntrySignature(row);
  });
  await upsertRows(client, spec, changedRows);
  return Array.from(existing.keys()).filter((key) => !desiredKeys.has(key));
}

async function syncPreparedWorkspaceRows(client, workspace, collections = null) {
  const selected = Array.isArray(collections) && collections.length ? new Set(collections) : null;
  const includes = (collection) => !selected || selected.has(collection);
  const specs = preparedWorkspaceTableSpecs(workspace, { includeClosedReports: false });
  const byTable = new Map(specs.map((spec) => [spec.table, spec]));
  const ledgerSpec = byTable.get("hp_ledger_lines");
  const journalSpec = byTable.get("hp_journal_entries");
  if (includes("ledger")) {
    const ledgerPlan = await planPayloadTableSync(client, ledgerSpec, workspace.workspaceId);
    const firstOrdinalByJournal = new Map();
    ledgerPlan.rows.forEach((row) => {
      const current = firstOrdinalByJournal.get(row.journalEntryKey);
      if (current === undefined || row.ordinal < current) firstOrdinalByJournal.set(row.journalEntryKey, row.ordinal);
    });
    journalSpec.rows = journalSpec.rows.map((row) => ({
      ...row,
      firstOrdinal: firstOrdinalByJournal.get(row.journalEntryKey) ?? row.firstOrdinal,
    }));
    const deletedJournalKeys = await upsertJournalEntries(client, journalSpec, workspace.workspaceId);
    await applyPayloadTablePlan(client, ledgerSpec, workspace.workspaceId, ledgerPlan);
    await deleteRowKeys(client, journalSpec, workspace.workspaceId, deletedJournalKeys);
  }

  const conversationSpec = byTable.get("hp_chat_conversations");
  const messageSpec = byTable.get("hp_chat_messages");
  if (includes("chatConversations")) {
    const conversationPlan = await planPayloadTableSync(client, conversationSpec, workspace.workspaceId);
    await applyPayloadTablePlan(client, conversationSpec, workspace.workspaceId, conversationPlan, { deleteMissing: false });
    messageSpec.rows = messageSpec.rows.map((row) => ({
      ...row,
      conversationRecordKey: conversationPlan.keyMappings.get(row.conversationRecordKey) || row.conversationRecordKey,
    }));
    const messagePlan = await planPayloadTableSync(client, messageSpec, workspace.workspaceId);
    await applyPayloadTablePlan(client, messageSpec, workspace.workspaceId, messagePlan);
    await deleteRowKeys(client, conversationSpec, workspace.workspaceId, conversationPlan.deletedKeys);
  }

  for (const spec of specs) {
    if ([ledgerSpec, journalSpec, conversationSpec, messageSpec].includes(spec)) continue;
    const collection = ({
      hp_actors: "actors",
      hp_orders: "orders",
      hp_receivables: "receivables",
      hp_transfers: "transfers",
      hp_saved_customers: "savedCustomers",
      hp_master_bank_entries: "masterBankEntries",
      hp_settlements: "settlements",
    })[spec.table];
    if (!includes(collection)) continue;
    const plan = await planPayloadTableSync(client, spec, workspace.workspaceId);
    await applyPayloadTablePlan(client, spec, workspace.workspaceId, plan);
  }
}

async function persistWorkspace(client, workspace, expectedRevision, collections = null) {
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
  const syncClosedReports = !Array.isArray(collections) || !collections.length || collections.includes("archives");
  const existingRows = syncClosedReports
    ? (await client.query(
        "SELECT record_key, ordinal, payload_sha256 FROM hp_closed_reports WHERE workspace_id = $1 ORDER BY ordinal",
        [workspace.workspaceId]
      )).rows.map((row) => ({
        recordKey: String(row.record_key),
        ordinal: Number(row.ordinal),
        payloadSha256: String(row.payload_sha256),
      }))
    : [];
  if (syncClosedReports) identifyNewImmutableReports(existingRows, workspace.closedReports);

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
  await syncPreparedWorkspaceRows(client, workspace, collections);
  if (syncClosedReports) await insertNewClosedReports(client, workspace, existingRows);

  const validateLedger = !Array.isArray(collections) || !collections.length || collections.includes("ledger");
  const unbalanced = validateLedger ? await client.query(
    `SELECT journal, currency, difference_minor
       FROM hp_journal_balances
      WHERE workspace_id = $1 AND difference_minor <> 0
      ORDER BY journal, currency`,
    [workspace.workspaceId]
  ) : { rowCount: 0 };
  if (unbalanced.rowCount) {
    throw new Error(`Workspace ${workspace.workspaceId} contains ${unbalanced.rowCount} unbalanced journal/currency group(s).`);
  }
}

export async function saveRuntimePostgresDatabase(db, options = {}) {
  const requestedWorkspaceIds = Array.from(new Set((options.workspaceIds || []).map(String).filter(Boolean)));
  const expectedRevisions = options.expectedAppStateRevisions || {};
  const workspaceCollections = options.workspaceCollections || {};
  const preparedById = new Map(requestedWorkspaceIds.flatMap((workspaceId) => {
    const state = db?.appStates?.[workspaceId];
    return state
      ? [[workspaceId, prepareRuntimeWorkspace(workspaceId, state, {
          collections: workspaceCollections[workspaceId],
          cloneSettings: false,
        })]]
      : [];
  }));
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
      await persistWorkspace(client, workspace, expectedRevisions[workspaceId], workspaceCollections[workspaceId]);
    }
  });
}

export async function listPostgresClosedReportSummaries(workspaceId, { actorId = "", actorName = "" } = {}) {
  const normalizedActorId = cleanText(actorId);
  const normalizedActorName = cleanText(actorName);
  const actorFilter = normalizedActorId
    ? "AND (actor_id = $2 OR (actor_id IS NULL AND actor_name = $3))"
    : normalizedActorName
      ? "AND actor_id IS NULL AND actor_name = $2"
      : "";
  const parameters = normalizedActorId
    ? [workspaceId, normalizedActorId, normalizedActorName]
    : normalizedActorName
      ? [workspaceId, normalizedActorName]
      : [workspaceId];
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
      ${actorFilter}
      ORDER BY ordinal`,
    parameters
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

function lightweightChatMessage(message) {
  if (!message || typeof message !== "object") return null;
  const { media, ...summary } = message;
  return summary;
}

function chatMessagePageItem(message) {
  return message?.attachmentId ? lightweightChatMessage(message) : message;
}

export async function listPostgresChatSummaries(workspaceId) {
  const result = await postgresPool().query(
    `SELECT
       conversation.payload,
       latest.payload AS last_message,
       COALESCE(message_stats.message_count, 0)::bigint AS message_count,
       COALESCE(unread_stats.unread_counts, '{}'::jsonb) AS unread_counts
       FROM hp_chat_conversations AS conversation
       LEFT JOIN LATERAL (
         SELECT message.payload
           FROM hp_chat_messages AS message
          WHERE message.workspace_id = conversation.workspace_id
            AND message.conversation_record_key = conversation.record_key
          ORDER BY message.ordinal DESC
          LIMIT 1
       ) AS latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::bigint AS message_count
           FROM hp_chat_messages AS message
          WHERE message.workspace_id = conversation.workspace_id
            AND message.conversation_record_key = conversation.record_key
       ) AS message_stats ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(member_counts.actor_name, member_counts.unread_count) AS unread_counts
           FROM (
             SELECT member.actor_name,
                    count(message.record_key) FILTER (
                      WHERE COALESCE(message.payload ->> 'from', '') <> member.actor_name
                        AND NOT (COALESCE(message.payload -> 'readBy', '[]'::jsonb) ? member.actor_name)
                        AND (
                          COALESCE(conversation.payload -> 'readThroughBy' ->> member.actor_name, '') = ''
                          OR COALESCE(message.created_at_text, message.payload ->> 'createdAt', '')
                            > COALESCE(conversation.payload -> 'readThroughBy' ->> member.actor_name, '')
                        )
                    )::bigint AS unread_count
               FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(conversation.payload -> 'members') = 'array'
                   THEN conversation.payload -> 'members'
                   ELSE '[]'::jsonb
                 END
               ) AS member(actor_name)
               LEFT JOIN hp_chat_messages AS message
                 ON message.workspace_id = conversation.workspace_id
                AND message.conversation_record_key = conversation.record_key
              GROUP BY member.actor_name
           ) AS member_counts
       ) AS unread_stats ON true
      WHERE conversation.workspace_id = $1
      ORDER BY conversation.ordinal`,
    [workspaceId]
  );
  return result.rows.map((row) => ({
    ...(row.payload || {}),
    messages: [],
    lastMessage: lightweightChatMessage(row.last_message),
    unreadCounts: row.unread_counts || {},
    messageCount: Number(row.message_count || 0),
    _messagesLoaded: false,
    _messagesLoading: false,
    _hasOlderMessages: Number(row.message_count || 0) > 0,
    _nextBefore: "",
  }));
}

export async function getPostgresChatMessagePage(workspaceId, chatId, { before = "", limit = 50 } = {}) {
  const conversationResult = await postgresPool().query(
    `SELECT record_key, payload
       FROM hp_chat_conversations
      WHERE workspace_id = $1
        AND (legacy_id = $2 OR payload ->> 'id' = $2)
      ORDER BY ordinal
      LIMIT 1`,
    [workspaceId, chatId]
  );
  if (conversationResult.rowCount !== 1) return null;
  const conversation = conversationResult.rows[0];
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 50));
  const cleanBefore = /^-?\d+$/.test(String(before || "")) ? String(before) : "";
  const parameters = [workspaceId, String(conversation.record_key)];
  const beforeClause = cleanBefore ? `AND ordinal < $${parameters.push(cleanBefore)}` : "";
  parameters.push(boundedLimit + 1);
  const pageResult = await postgresPool().query(
    `SELECT ordinal, payload
       FROM hp_chat_messages
      WHERE workspace_id = $1
        AND conversation_record_key = $2
        ${beforeClause}
      ORDER BY ordinal DESC
      LIMIT $${parameters.length}`,
    parameters
  );
  const hasOlder = pageResult.rows.length > boundedLimit;
  const newestFirst = pageResult.rows.slice(0, boundedLimit);
  const nextBefore = hasOlder && newestFirst.length
    ? String(newestFirst[newestFirst.length - 1].ordinal)
    : "";
  return {
    conversation: conversation.payload || {},
    messages: newestFirst.map((row) => chatMessagePageItem(row.payload || {})).reverse(),
    hasOlder,
    nextBefore,
  };
}

function boundedSearchTerms(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((term) => term.slice(0, 80));
}

function postgresLikePattern(value) {
  return `%${String(value || "").replace(/[\\%_]/g, "\\$&")}%`;
}

export async function searchPostgresWorkspaceRecords(workspaceId, {
  query = "",
  limit = 50,
  actorId = "",
  actorName = "",
  actorScoped = false,
} = {}) {
  const terms = boundedSearchTerms(query);
  if (!terms.length) return { results: [], hasMore: false };
  const resultLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const parameters = [workspaceId];
  const addParameter = (value) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const termPlaceholders = terms.map((term) => addParameter(postgresLikePattern(term)));
  const actorIdPlaceholder = actorScoped ? addParameter(cleanText(actorId)) : "";
  const actorNamePlaceholder = actorScoped ? addParameter(cleanText(actorName)) : "";
  const limitPlaceholder = addParameter(resultLimit + 1);
  const matchesJson = (expression) => termPlaceholders
    .map((placeholder) => `lower((${expression})::text) LIKE ${placeholder} ESCAPE '\\'`)
    .join(" AND ");
  const matchesPayload = (alias) => matchesJson(`${alias}.payload`);
  const orderActorScope = actorScoped
    ? `AND (
         o.broker_actor_id = ${actorIdPlaceholder} OR o.agent_actor_id = ${actorIdPlaceholder}
         OR (o.broker_actor_id IS NULL AND o.payload ->> 'broker' = ${actorNamePlaceholder})
         OR (o.agent_actor_id IS NULL AND o.payload ->> 'agent' = ${actorNamePlaceholder})
       )`
    : "";
  const receivableActorScope = actorScoped
    ? `AND (
         r.borrower_actor_id = ${actorIdPlaceholder}
         OR (r.borrower_actor_id IS NULL AND r.payload ->> 'borrower' = ${actorNamePlaceholder})
         OR EXISTS (
           SELECT 1 FROM hp_orders visible_order
            WHERE visible_order.workspace_id = r.workspace_id
              AND visible_order.legacy_id = r.order_id
              AND (
                visible_order.broker_actor_id = ${actorIdPlaceholder} OR visible_order.agent_actor_id = ${actorIdPlaceholder}
                OR (visible_order.broker_actor_id IS NULL AND visible_order.payload ->> 'broker' = ${actorNamePlaceholder})
                OR (visible_order.agent_actor_id IS NULL AND visible_order.payload ->> 'agent' = ${actorNamePlaceholder})
              )
         )
       )`
    : "";
  const transferActorScope = actorScoped
    ? `AND (
         t.from_actor_id = ${actorIdPlaceholder} OR t.to_actor_id = ${actorIdPlaceholder}
         OR (t.from_actor_id IS NULL AND t.payload ->> 'from' = ${actorNamePlaceholder})
         OR (t.to_actor_id IS NULL AND t.payload ->> 'to' = ${actorNamePlaceholder})
       )`
    : "";
  const ledgerActorScope = actorScoped
    ? `AND (
         l.actor_id = ${actorIdPlaceholder}
         OR (l.actor_id IS NULL AND l.account IN (${actorNamePlaceholder}, ${actorNamePlaceholder} || ' ACTOR_CLEARING'))
         OR EXISTS (
           SELECT 1 FROM hp_orders visible_order
            WHERE visible_order.workspace_id = l.workspace_id
              AND visible_order.legacy_id = l.order_id
              AND (
                visible_order.broker_actor_id = ${actorIdPlaceholder} OR visible_order.agent_actor_id = ${actorIdPlaceholder}
                OR (visible_order.broker_actor_id IS NULL AND visible_order.payload ->> 'broker' = ${actorNamePlaceholder})
                OR (visible_order.agent_actor_id IS NULL AND visible_order.payload ->> 'agent' = ${actorNamePlaceholder})
              )
         )
       )`
    : "";
  const reportActorScope = actorScoped
    ? `AND (
         c.actor_id = ${actorIdPlaceholder}
         OR (c.actor_id IS NULL AND c.actor_name = ${actorNamePlaceholder})
       )`
    : "";
  const result = await postgresPool().query(
    `SELECT kind, record_key, payload
       FROM (
         SELECT 'order'::text AS kind, o.record_key, COALESCE(o.updated_at_text, o.created_at_text, '') AS sort_text, o.payload
           FROM hp_orders o
          WHERE o.workspace_id = $1 AND ${matchesPayload("o")} ${orderActorScope}
         UNION ALL
         SELECT
                'archived_order'::text,
                c.record_key || ':order:' || archived_order.ordinality::text,
                COALESCE(c.closed_at_text, ''),
                archived_order.payload || jsonb_build_object(
                  'archivedAt', COALESCE(c.closed_at_text, archived_order.payload ->> 'archivedAt', ''),
                  'searchArchiveId', COALESCE(NULLIF(c.payload ->> 'id', ''), c.legacy_id, c.record_key),
                  'searchArchiveActor', COALESCE(c.actor_name, c.payload ->> 'actor', ''),
                  'searchArchiveClosedAt', COALESCE(c.closed_at_text, ''),
                  'searchReportKey', c.record_key,
                  'state', COALESCE(NULLIF(archived_order.payload ->> 'state', ''), 'Archived')
                )
           FROM hp_closed_reports c
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.payload -> 'orders') = 'array' THEN c.payload -> 'orders' ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS archived_order(payload, ordinality)
          WHERE c.workspace_id = $1
            AND ${matchesPayload("c")}
            AND ${matchesJson("archived_order.payload")}
            ${reportActorScope}
         UNION ALL
         SELECT 'receivable'::text, r.record_key, COALESCE(r.updated_at_text, r.created_at_text, ''), r.payload
           FROM hp_receivables r
          WHERE r.workspace_id = $1 AND ${matchesPayload("r")} ${receivableActorScope}
         UNION ALL
         SELECT 'transfer'::text, t.record_key, COALESCE(t.updated_at_text, t.created_at_text, ''), t.payload
           FROM hp_transfers t
          WHERE t.workspace_id = $1 AND ${matchesPayload("t")} ${transferActorScope}
         UNION ALL
         SELECT 'ledger'::text, l.record_key, COALESCE(l.posted_at_text, ''), l.payload
           FROM hp_ledger_lines l
          WHERE l.workspace_id = $1 AND ${matchesPayload("l")} ${ledgerActorScope}
         UNION ALL
         SELECT 'report'::text, c.record_key, COALESCE(c.closed_at_text, ''),
                jsonb_build_object(
                  'id', COALESCE(c.legacy_id, c.record_key),
                  'actorId', COALESCE(c.actor_id, ''),
                  'actor', COALESCE(c.actor_name, ''),
                  'closedAt', COALESCE(c.closed_at_text, ''),
                  'balances', COALESCE(c.payload -> 'balances', '{}'::jsonb),
                  '_reportKey', c.record_key,
                  '_reportDetailLoaded', false,
                  'orderCount', CASE WHEN jsonb_typeof(c.payload -> 'orders') = 'array' THEN jsonb_array_length(c.payload -> 'orders') ELSE 0 END,
                  'receivableCount', CASE WHEN jsonb_typeof(c.payload -> 'receivables') = 'array' THEN jsonb_array_length(c.payload -> 'receivables') ELSE 0 END,
                  'transferCount', CASE WHEN jsonb_typeof(c.payload -> 'transfers') = 'array' THEN jsonb_array_length(c.payload -> 'transfers') ELSE 0 END,
                  'ledgerLineCount', CASE WHEN jsonb_typeof(c.payload -> 'ledger') = 'array' THEN jsonb_array_length(c.payload -> 'ledger') ELSE 0 END
                )
           FROM hp_closed_reports c
          WHERE c.workspace_id = $1
            AND ${matchesJson("c.payload - ARRAY['orders', 'receivables', 'transfers', 'ledger']::text[]")}
            ${reportActorScope}
       ) matches
      ORDER BY sort_text DESC, kind, record_key
      LIMIT ${limitPlaceholder}`,
    parameters
  );
  const rows = result.rows.slice(0, resultLimit);
  return {
    results: rows.map((row) => ({ kind: String(row.kind), record: row.payload || {} })),
    hasMore: result.rows.length > resultLimit,
  };
}
