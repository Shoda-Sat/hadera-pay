import {
  assertMatchingMigrationManifests,
  buildMigrationManifest,
  reconstructPreparedDatabase,
  sha256Json,
} from "./migrationModel.mjs";

const batchSize = 200;

function jsonParameter(value) {
  return JSON.stringify(value ?? null);
}

function groupByWorkspace(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const workspaceId = String(row.workspace_id);
    if (!grouped.has(workspaceId)) grouped.set(workspaceId, []);
    grouped.get(workspaceId).push(row);
  });
  return grouped;
}

export async function insertRows(client, table, columns, rows, valuesForRow) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const tuples = batch.map((row) => {
      const rowValues = valuesForRow(row);
      if (rowValues.length !== columns.length) throw new Error(`Invalid ${table} importer column mapping.`);
      const placeholders = rowValues.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, values);
  }
}

export async function upsertRows(client, spec, rows) {
  const conflictColumns = ["workspace_id", spec.keyColumn];
  const updateColumns = spec.columns.filter((column) => !conflictColumns.includes(column));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const tuples = batch.map((row) => {
      const rowValues = spec.valuesForRow(row);
      if (rowValues.length !== spec.columns.length) throw new Error(`Invalid ${spec.table} runtime column mapping.`);
      const placeholders = rowValues.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const assignments = updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(", ");
    await client.query(
      `INSERT INTO ${spec.table} (${spec.columns.join(", ")}) VALUES ${tuples.join(", ")}
       ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${assignments}`,
      values
    );
  }
}

export function preparedWorkspaceTableSpecs(workspace, options = {}) {
  const includeClosedReports = options.includeClosedReports !== false;
  const specs = [
    {
      table: "hp_actors", keyColumn: "record_key", keyField: "recordKey", rows: workspace.actors,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "actor_name", "actor_role", "base_currency", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.actorName, row.actorRole, row.baseCurrency, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_orders", keyColumn: "record_key", keyField: "recordKey", rows: workspace.orders,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "journal", "order_state", "broker_actor_id", "agent_actor_id", "created_at_text", "updated_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.journal, row.orderState, row.brokerActorId, row.agentActorId, row.createdAtText, row.updatedAtText, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_receivables", keyColumn: "record_key", keyField: "recordKey", rows: workspace.receivables,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "order_id", "journal", "borrower_actor_id", "created_at_text", "updated_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.orderId, row.journal, row.borrowerActorId, row.createdAtText, row.updatedAtText, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_transfers", keyColumn: "record_key", keyField: "recordKey", rows: workspace.transfers,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "journal", "transfer_state", "from_actor_id", "to_actor_id", "created_at_text", "updated_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.journal, row.transferState, row.fromActorId, row.toActorId, row.createdAtText, row.updatedAtText, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_journal_entries", keyColumn: "journal_entry_key", keyField: "journalEntryKey", rows: workspace.journalEntries,
      columns: ["workspace_id", "journal_entry_key", "journal", "source", "order_id", "transfer_id", "first_ordinal", "metadata"],
      valuesForRow: (row) => [row.workspaceId, row.journalEntryKey, row.journal, row.source, row.orderId, row.transferId, row.firstOrdinal, jsonParameter(row.metadata)],
    },
    {
      table: "hp_ledger_lines", keyColumn: "record_key", keyField: "recordKey", rows: workspace.ledgerLines,
      columns: ["workspace_id", "journal_entry_key", "record_key", "ordinal", "journal", "source", "order_id", "transfer_id", "actor_id", "account", "direction", "currency", "amount_minor", "posted_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.journalEntryKey, row.recordKey, row.ordinal, row.journal, row.source, row.orderId, row.transferId, row.actorId, row.account, row.direction, row.currency, row.amountMinor, row.postedAtText, jsonParameter(row.payload), row.payloadSha256],
    },
    ...(includeClosedReports ? [{
      table: "hp_closed_reports", keyColumn: "record_key", keyField: "recordKey", rows: workspace.closedReports,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "actor_id", "actor_name", "closed_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.actorId, row.actorName, row.closedAtText, jsonParameter(row.payload), row.payloadSha256],
    }] : []),
    {
      table: "hp_saved_customers", keyColumn: "record_key", keyField: "recordKey", rows: workspace.savedCustomers,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "actor_id", "updated_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.actorId, row.updatedAtText, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_master_bank_entries", keyColumn: "record_key", keyField: "recordKey", rows: workspace.masterBankEntries,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "reference", "currency", "posted_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.reference, row.currency, row.postedAtText, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_settlements", keyColumn: "record_key", keyField: "recordKey", rows: workspace.settlements,
      columns: ["workspace_id", "record_key", "ordinal", "actor_name", "currency", "net_minor", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.ordinal, row.actorName, row.currency, row.netMinor, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_chat_conversations", keyColumn: "record_key", keyField: "recordKey", rows: workspace.chatConversations,
      columns: ["workspace_id", "record_key", "legacy_id", "ordinal", "chat_type", "updated_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.recordKey, row.legacyId, row.ordinal, row.chatType, row.updatedAtText, jsonParameter(row.payload), row.payloadSha256],
    },
    {
      table: "hp_chat_messages", keyColumn: "record_key", keyField: "recordKey", rows: workspace.chatMessages,
      columns: ["workspace_id", "conversation_record_key", "record_key", "legacy_id", "ordinal", "order_id", "created_at_text", "payload", "payload_sha256"],
      valuesForRow: (row) => [row.workspaceId, row.conversationRecordKey, row.recordKey, row.legacyId, row.ordinal, row.orderId, row.createdAtText, jsonParameter(row.payload), row.payloadSha256],
    },
  ];
  return specs;
}

export async function insertPreparedWorkspace(client, workspace, options = {}) {
  for (const spec of preparedWorkspaceTableSpecs(workspace, options)) {
    await insertRows(client, spec.table, spec.columns, spec.rows, spec.valuesForRow);
  }
}

async function assertEmptyImportTarget(client, migrationId) {
  const existingMigration = await client.query(
    "SELECT migration_id FROM hp_migration_imports WHERE migration_id = $1",
    [migrationId]
  );
  if (existingMigration.rowCount) throw new Error(`Migration ID ${migrationId} has already been imported.`);
  const counts = await client.query(`
    SELECT
      (SELECT count(*) FROM hp_migration_imports)::bigint AS imports,
      (SELECT count(*) FROM hp_workspace_states)::bigint AS workspaces,
      (SELECT count(*) FROM hp_database_metadata)::bigint AS metadata
  `);
  const occupied = Object.entries(counts.rows[0] || {}).filter(([, value]) => Number(value) > 0);
  if (occupied.length) {
    throw new Error("The PostgreSQL import target is not empty. Use a fresh rehearsal database or an explicitly reviewed recovery process.");
  }
}

export async function importPreparedDatabase(client, prepared, migrationId, options = {}) {
  const cleanMigrationId = String(migrationId || "").trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(cleanMigrationId)) {
    throw new Error("Provide a migration ID containing only letters, numbers, dot, underscore, colon, or dash.");
  }
  const sourceFileSha256 = String(options.sourceFileSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceFileSha256)) {
    throw new Error("The exact source backup file SHA-256 is required for import evidence.");
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtext('haderapay-json-import'))");
  await assertEmptyImportTarget(client, cleanMigrationId);
  await client.query(
    "INSERT INTO hp_database_metadata(singleton, document, metadata_sha256) VALUES (true, $1::jsonb, $2)",
    [jsonParameter(prepared.metadata), prepared.metadataSha256]
  );
  await insertRows(
    client,
    "hp_workspace_states",
    ["workspace_id", "revision", "settings", "collection_presence", "source_sha256"],
    prepared.workspaces,
    (workspace) => [
      workspace.workspaceId,
      workspace.revision,
      jsonParameter(workspace.settings),
      jsonParameter(workspace.collectionPresence),
      workspace.sourceSha256,
    ]
  );

  for (const workspace of prepared.workspaces) {
    await insertPreparedWorkspace(client, workspace);
    await client.query(
      `INSERT INTO hp_workspace_manifests(workspace_id, migration_id, manifest, manifest_sha256)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [workspace.workspaceId, cleanMigrationId, jsonParameter(workspace.manifest), workspace.manifestSha256]
    );
  }

  await client.query(
    `INSERT INTO hp_migration_imports(migration_id, source_file_sha256, database_sha256, manifest, manifest_sha256)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [cleanMigrationId, sourceFileSha256, prepared.sourceSha256, jsonParameter(prepared.manifest), prepared.manifestSha256]
  );
}

async function payloadRows(client, table, workspaceIds = []) {
  const cleanWorkspaceIds = (workspaceIds || []).map(String).filter(Boolean);
  const result = cleanWorkspaceIds.length
    ? await client.query(
        `SELECT workspace_id, payload FROM ${table} WHERE workspace_id = ANY($1::text[]) ORDER BY workspace_id, ordinal`,
        [cleanWorkspaceIds]
      )
    : await client.query(`SELECT workspace_id, payload FROM ${table} ORDER BY workspace_id, ordinal`);
  return groupByWorkspace(result.rows);
}

async function chatConversationRows(client, workspaceIds = []) {
  const cleanWorkspaceIds = (workspaceIds || []).map(String).filter(Boolean);
  const result = cleanWorkspaceIds.length
    ? await client.query(
        `SELECT workspace_id, record_key, payload FROM hp_chat_conversations
          WHERE workspace_id = ANY($1::text[]) ORDER BY workspace_id, ordinal`,
        [cleanWorkspaceIds]
      )
    : await client.query("SELECT workspace_id, record_key, payload FROM hp_chat_conversations ORDER BY workspace_id, ordinal");
  return groupByWorkspace(result.rows);
}

async function chatMessageRows(client, workspaceIds = []) {
  const cleanWorkspaceIds = (workspaceIds || []).map(String).filter(Boolean);
  const result = cleanWorkspaceIds.length
    ? await client.query(
        `SELECT workspace_id, conversation_record_key, payload FROM hp_chat_messages
          WHERE workspace_id = ANY($1::text[]) ORDER BY workspace_id, ordinal`,
        [cleanWorkspaceIds]
      )
    : await client.query("SELECT workspace_id, conversation_record_key, payload FROM hp_chat_messages ORDER BY workspace_id, ordinal");
  return groupByWorkspace(result.rows);
}

export async function reconstructDatabaseFromPostgres(client, options = {}) {
  const workspaceIds = (options.workspaceIds || []).map(String).filter(Boolean);
  const metadataOnly = options.metadataOnly === true;
  const includeClosedReports = options.includeClosedReports !== false;
  const metadataResult = await client.query("SELECT document FROM hp_database_metadata WHERE singleton = true");
  if (metadataResult.rowCount !== 1) throw new Error("PostgreSQL does not contain exactly one HaderaPay metadata record.");
  const workspaceResult = workspaceIds.length
    ? await client.query(
        "SELECT workspace_id, revision, settings, collection_presence, source_sha256 FROM hp_workspace_states WHERE workspace_id = ANY($1::text[]) ORDER BY workspace_id",
        [workspaceIds]
      )
    : await client.query(
        "SELECT workspace_id, revision, settings, collection_presence, source_sha256 FROM hp_workspace_states ORDER BY workspace_id"
      );
  if (metadataOnly) {
    return {
      ...(metadataResult.rows[0].document || {}),
      appStates: Object.fromEntries(workspaceResult.rows.map((row) => [
        String(row.workspace_id),
        { _syncRevision: String(row.revision || "0") },
      ])),
    };
  }
  const [actors, orders, receivables, transfers, ledger, archives, savedCustomers, masterBankEntries, settlements, chatConversations, chatMessages] = await Promise.all([
    payloadRows(client, "hp_actors", workspaceIds),
    payloadRows(client, "hp_orders", workspaceIds),
    payloadRows(client, "hp_receivables", workspaceIds),
    payloadRows(client, "hp_transfers", workspaceIds),
    payloadRows(client, "hp_ledger_lines", workspaceIds),
    includeClosedReports ? payloadRows(client, "hp_closed_reports", workspaceIds) : Promise.resolve(new Map()),
    payloadRows(client, "hp_saved_customers", workspaceIds),
    payloadRows(client, "hp_master_bank_entries", workspaceIds),
    payloadRows(client, "hp_settlements", workspaceIds),
    chatConversationRows(client, workspaceIds),
    chatMessageRows(client, workspaceIds),
  ]);
  const prepared = {
    metadata: metadataResult.rows[0].document,
    workspaces: workspaceResult.rows.map((row) => {
      const workspaceId = String(row.workspace_id);
      const wrap = (grouped) => (grouped.get(workspaceId) || []).map((item) => ({ payload: item.payload }));
      return {
        workspaceId,
        revision: String(row.revision || "0"),
        settings: row.settings || {},
        collectionPresence: includeClosedReports
          ? (row.collection_presence || {})
          : { ...(row.collection_presence || {}), archives: false },
        actors: wrap(actors),
        orders: wrap(orders),
        receivables: wrap(receivables),
        transfers: wrap(transfers),
        ledgerLines: wrap(ledger),
        closedReports: wrap(archives),
        savedCustomers: wrap(savedCustomers),
        masterBankEntries: wrap(masterBankEntries),
        settlements: wrap(settlements),
        chatConversations: (chatConversations.get(workspaceId) || []).map((item) => ({
          recordKey: String(item.record_key),
          payload: item.payload,
        })),
        chatMessages: (chatMessages.get(workspaceId) || []).map((item) => ({
          conversationRecordKey: String(item.conversation_record_key),
          payload: item.payload,
        })),
      };
    }),
  };
  return reconstructPreparedDatabase(prepared, { clone: false });
}

export async function verifyImportedDatabase(client, expectedManifest = null, options = {}) {
  const db = await reconstructDatabaseFromPostgres(client);
  const actualManifest = buildMigrationManifest(db);
  const storedResult = await client.query(
    "SELECT migration_id, source_file_sha256, database_sha256, manifest FROM hp_migration_imports ORDER BY imported_at DESC LIMIT 1"
  );
  if (storedResult.rowCount !== 1) throw new Error("PostgreSQL has no completed HaderaPay import manifest.");
  const storedManifest = storedResult.rows[0].manifest;
  assertMatchingMigrationManifests(storedManifest, actualManifest);
  if (expectedManifest) assertMatchingMigrationManifests(expectedManifest, actualManifest);
  const storedDatabaseSha256 = String(storedResult.rows[0].database_sha256 || "").trim();
  if (storedDatabaseSha256 !== actualManifest.sourceSha256) {
    throw new Error("PostgreSQL reconstructed database SHA-256 does not match its import evidence.");
  }
  const expectedSourceFileSha256 = String(options.sourceFileSha256 || "").trim().toLowerCase();
  if (expectedSourceFileSha256 && expectedSourceFileSha256 !== String(storedResult.rows[0].source_file_sha256 || "").trim()) {
    throw new Error("The supplied source backup file SHA-256 does not match the imported backup evidence.");
  }
  const badJournals = await client.query(
    "SELECT workspace_id, journal, currency, difference_minor FROM hp_journal_balances WHERE difference_minor <> 0 ORDER BY workspace_id, journal, currency"
  );
  if (badJournals.rowCount) {
    throw new Error(`PostgreSQL contains ${badJournals.rowCount} unbalanced journal/currency group(s).`);
  }
  return {
    migrationId: storedResult.rows[0].migration_id,
    sourceFileSha256: String(storedResult.rows[0].source_file_sha256 || "").trim(),
    databaseSha256: storedDatabaseSha256,
    manifest: actualManifest,
    manifestSha256: sha256Json(actualManifest),
  };
}
