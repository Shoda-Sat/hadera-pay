import crypto from "node:crypto";

export const normalizedWorkspaceCollections = Object.freeze([
  "actors",
  "orders",
  "receivables",
  "transfers",
  "ledger",
  "archives",
  "savedCustomers",
  "masterBankEntries",
  "settlements",
]);

export function canonicalJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
  };
  return JSON.stringify(normalize(value));
}

export function sha256Json(value) {
  const hash = crypto.createHash("sha256");
  const update = (input, inArray = false) => {
    if (input === null || input === undefined) {
      if (input === undefined && !inArray) throw new Error("Cannot hash an undefined JSON object value.");
      hash.update("null");
      return;
    }
    if (typeof input === "string" || typeof input === "boolean") {
      hash.update(JSON.stringify(input));
      return;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("Cannot hash a non-finite JSON number.");
      hash.update(JSON.stringify(input));
      return;
    }
    if (Array.isArray(input)) {
      hash.update("[");
      input.forEach((item, index) => {
        if (index) hash.update(",");
        update(item, true);
      });
      hash.update("]");
      return;
    }
    if (typeof input === "object") {
      hash.update("{");
      const keys = Object.keys(input).filter((key) => input[key] !== undefined).sort();
      keys.forEach((key, index) => {
        if (index) hash.update(",");
        hash.update(JSON.stringify(key));
        hash.update(":");
        update(input[key]);
      });
      hash.update("}");
      return;
    }
    throw new Error(`Cannot hash unsupported JSON value type ${typeof input}.`);
  };
  update(value);
  return hash.digest("hex");
}

function stringValue(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function nullableString(value) {
  return stringValue(value) || null;
}

function currencyValue(value) {
  const currency = stringValue(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function recordKey(collection, item, ordinal, idField = "id", useLegacyIdInKey = true) {
  const legacyId = nullableString(item?.[idField]);
  return {
    legacyId,
    recordKey: legacyId && useLegacyIdInKey
      ? `id:${legacyId}`
      : `${collection}:${String(ordinal).padStart(8, "0")}:${sha256Json(item).slice(0, 20)}`,
  };
}

function assertUniqueLegacyIds(workspaceId, collection, rows) {
  const seen = new Set();
  rows.forEach((row) => {
    if (!row.legacyId) return;
    if (seen.has(row.legacyId)) {
      throw new Error(`Workspace ${workspaceId} has duplicate ${collection} legacy ID ${row.legacyId}.`);
    }
    seen.add(row.legacyId);
  });
}

function baseRows(workspaceId, collection, items, extract = () => ({}), options = {}) {
  const source = Array.isArray(items) ? items : [];
  const rows = source.map((item, ordinal) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Workspace ${workspaceId} ${collection}[${ordinal}] is not an object.`);
    }
    const identity = recordKey(
      collection,
      item,
      ordinal,
      options.idField || "id",
      options.uniqueLegacyIds !== false
    );
    return {
      workspaceId,
      ...identity,
      ordinal,
      ...extract(item),
      payload: item,
      payloadSha256: sha256Json(item),
    };
  });
  if (options.uniqueLegacyIds !== false) assertUniqueLegacyIds(workspaceId, collection, rows);
  return rows;
}

function ledgerJournalIdentity(line, ordinal) {
  const journal = stringValue(line?.journal);
  if (journal) return ["journal", journal];
  const entryId = stringValue(line?.entryId);
  if (entryId) return ["entry", entryId];
  const sourceIdentity = [stringValue(line?.source), stringValue(line?.orderId), stringValue(line?.transferId)];
  if (sourceIdentity.some(Boolean)) return ["source", ...sourceIdentity];
  return ["line", ordinal];
}

function prepareLedger(workspaceId, items) {
  const source = Array.isArray(items) ? items : [];
  const journalByKey = new Map();
  const rows = source.map((line, ordinal) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw new Error(`Workspace ${workspaceId} ledger[${ordinal}] is not an object.`);
    }
    const direction = stringValue(line.direction);
    const currency = currencyValue(line.currency);
    const amountMinor = Number(line.amountMinor);
    const account = stringValue(line.account);
    if (!["Debit", "Credit"].includes(direction)) {
      throw new Error(`Workspace ${workspaceId} ledger[${ordinal}] has an invalid direction.`);
    }
    if (!currency || !account || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new Error(`Workspace ${workspaceId} ledger[${ordinal}] has invalid accounting fields.`);
    }
    const identity = ledgerJournalIdentity(line, ordinal);
    const journalEntryKey = `journal:${sha256Json(identity)}`;
    if (!journalByKey.has(journalEntryKey)) {
      journalByKey.set(journalEntryKey, {
        workspaceId,
        journalEntryKey,
        journal: nullableString(line.journal),
        source: nullableString(line.source),
        orderId: nullableString(line.orderId),
        transferId: nullableString(line.transferId),
        firstOrdinal: ordinal,
        metadata: { identity },
      });
    }
    return {
      workspaceId,
      journalEntryKey,
      recordKey: `ledger:${String(ordinal).padStart(8, "0")}:${sha256Json(line).slice(0, 20)}`,
      ordinal,
      journal: nullableString(line.journal),
      source: nullableString(line.source),
      orderId: nullableString(line.orderId),
      transferId: nullableString(line.transferId),
      actorId: nullableString(line.actorId),
      account,
      direction,
      currency,
      amountMinor: String(amountMinor),
      postedAtText: nullableString(line.postedAt),
      payload: line,
      payloadSha256: sha256Json(line),
    };
  });
  return { journalEntries: Array.from(journalByKey.values()), ledgerLines: rows };
}

function sortedBalanceRows(map, fieldNames) {
  return Array.from(map.entries())
    .map(([encoded, differenceMinor]) => {
      const values = JSON.parse(encoded);
      return Object.fromEntries([
        ...fieldNames.map((field, index) => [field, values[index]]),
        ["differenceMinor", differenceMinor],
      ]);
    })
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function accountingManifest(state) {
  const actorBalances = new Map();
  const journalBalances = new Map();
  (Array.isArray(state?.ledger) ? state.ledger : []).forEach((line, ordinal) => {
    const amount = Number(line?.amountMinor || 0);
    if (!Number.isSafeInteger(amount)) return;
    const signed = line?.direction === "Debit" ? amount : line?.direction === "Credit" ? -amount : 0;
    const currency = stringValue(line?.currency);
    const actorKey = stringValue(line?.actorId) || stringValue(line?.account) || "UNKNOWN";
    const actorBalanceKey = JSON.stringify([actorKey, currency]);
    actorBalances.set(actorBalanceKey, (actorBalances.get(actorBalanceKey) || 0) + signed);
    const journalKey = JSON.stringify([sha256Json(ledgerJournalIdentity(line, ordinal)), stringValue(line?.journal), currency]);
    journalBalances.set(journalKey, (journalBalances.get(journalKey) || 0) + signed);
  });
  return {
    actorBalances: sortedBalanceRows(actorBalances, ["actor", "currency"]),
    journalBalances: sortedBalanceRows(journalBalances, ["journalEntryKey", "journal", "currency"]),
  };
}

function workspaceManifest(workspaceId, state) {
  const collectionCounts = Object.fromEntries(normalizedWorkspaceCollections.map((collection) => [
    collection,
    Array.isArray(state?.[collection]) ? state[collection].length : 0,
  ]));
  const collectionHashes = Object.fromEntries(normalizedWorkspaceCollections.map((collection) => [
    collection,
    sha256Json(Array.isArray(state?.[collection]) ? state[collection] : []),
  ]));
  const closedReports = (Array.isArray(state?.archives) ? state.archives : []).map((archive, ordinal) => ({
    ordinal,
    id: stringValue(archive?.id),
    actorId: stringValue(archive?.actorId),
    actor: stringValue(archive?.actor),
    closedAt: stringValue(archive?.closedAt),
    sha256: sha256Json(archive),
  }));
  const counters = Object.fromEntries(Object.entries(state || {})
    .filter(([key, value]) => /Counter$|Cycle$/.test(key) && Number.isFinite(Number(value)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Number(value)]));
  return {
    workspaceId,
    stateSha256: sha256Json(state || {}),
    collectionCounts,
    collectionHashes,
    closedReports,
    counters,
    ...accountingManifest(state),
  };
}

export function buildMigrationManifest(db) {
  const source = db && typeof db === "object" && !Array.isArray(db) ? db : {};
  const metadata = { ...source };
  delete metadata.appStates;
  const workspaces = Object.entries(source.appStates || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([workspaceId, state]) => workspaceManifest(workspaceId, state || {}));
  return {
    version: 1,
    sourceSha256: sha256Json(source),
    metadataSha256: sha256Json(metadata),
    workspaceCount: workspaces.length,
    workspaces,
  };
}

export function prepareDatabaseImport(db) {
  if (!db || typeof db !== "object" || Array.isArray(db)) throw new Error("The JSON backup must contain one database object.");
  const metadata = Object.fromEntries(Object.entries(db)
    .filter(([key]) => key !== "appStates")
    .map(([key, value]) => [key, structuredClone(value)]));
  const workspaces = Object.entries(db.appStates || {}).map(([workspaceId, rawState]) => {
    if (!workspaceId || !rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
      throw new Error(`Workspace ${workspaceId || "<blank>"} has an invalid state object.`);
    }
    const state = rawState;
    const settings = {};
    const collectionPresence = Object.fromEntries(normalizedWorkspaceCollections.map((collection) => {
      const present = Object.prototype.hasOwnProperty.call(state, collection);
      if (present && !Array.isArray(state[collection])) {
        throw new Error(`Workspace ${workspaceId} collection ${collection} is not an array.`);
      }
      return [collection, present];
    }));
    Object.entries(state).forEach(([key, value]) => {
      if (!normalizedWorkspaceCollections.includes(key)) settings[key] = structuredClone(value);
    });
    const ledger = prepareLedger(workspaceId, state.ledger);
    const manifest = workspaceManifest(workspaceId, state);
    return {
      workspaceId,
      revision: stringValue(state._syncRevision) || "0",
      settings,
      collectionPresence,
      sourceSha256: sha256Json(state),
      actors: baseRows(workspaceId, "actors", state.actors, (item) => ({
        actorName: nullableString(item.name),
        actorRole: nullableString(item.role),
        baseCurrency: currencyValue(item.currency),
      })),
      orders: baseRows(workspaceId, "orders", state.orders, (item) => ({
        journal: nullableString(item.journal),
        orderState: nullableString(item.state),
        brokerActorId: nullableString(item.brokerActorId),
        agentActorId: nullableString(item.agentActorId),
        createdAtText: nullableString(item.createdAt),
        updatedAtText: nullableString(item.updatedAt),
      })),
      receivables: baseRows(workspaceId, "receivables", state.receivables, (item) => ({
        orderId: nullableString(item.orderId),
        journal: nullableString(item.journal),
        borrowerActorId: nullableString(item.borrowerActorId),
        createdAtText: nullableString(item.createdAt),
        updatedAtText: nullableString(item.updatedAt),
      })),
      transfers: baseRows(workspaceId, "transfers", state.transfers, (item) => ({
        journal: nullableString(item.journal),
        transferState: nullableString(item.state),
        fromActorId: nullableString(item.fromActorId),
        toActorId: nullableString(item.toActorId),
        createdAtText: nullableString(item.createdAt),
        updatedAtText: nullableString(item.updatedAt),
      })),
      journalEntries: ledger.journalEntries,
      ledgerLines: ledger.ledgerLines,
      closedReports: baseRows(workspaceId, "archives", state.archives, (item) => ({
        actorId: nullableString(item.actorId),
        actorName: nullableString(item.actor),
        closedAtText: nullableString(item.closedAt),
      })),
      savedCustomers: baseRows(workspaceId, "savedCustomers", state.savedCustomers, (item) => ({
        actorId: nullableString(item.actorId),
        updatedAtText: nullableString(item.updatedAt),
      })),
      masterBankEntries: baseRows(workspaceId, "masterBankEntries", state.masterBankEntries, (item) => ({
        reference: nullableString(item.reference),
        currency: currencyValue(item.currency),
        postedAtText: nullableString(item.postedAt),
      })),
      settlements: baseRows(workspaceId, "settlements", state.settlements, (item) => ({
        actorName: nullableString(item.actor),
        currency: currencyValue(item.currency),
        netMinor: Number.isSafeInteger(Number(item.netMinor)) ? String(Number(item.netMinor)) : "0",
      }), { uniqueLegacyIds: false }),
      manifest,
      manifestSha256: sha256Json(manifest),
    };
  });
  const manifest = buildMigrationManifest(db);
  return {
    sourceSha256: manifest.sourceSha256,
    metadata,
    metadataSha256: manifest.metadataSha256,
    workspaces,
    manifest,
    manifestSha256: sha256Json(manifest),
  };
}

export function reconstructPreparedDatabase(prepared, options = {}) {
  const clone = options.clone !== false;
  const copy = (value) => clone ? structuredClone(value) : value;
  const db = { ...copy(prepared.metadata || {}) };
  db.appStates = {};
  for (const workspace of prepared.workspaces || []) {
    const state = { ...copy(workspace.settings || {}) };
    const presence = workspace.collectionPresence || {};
    if (presence.actors) state.actors = workspace.actors.map((row) => copy(row.payload));
    if (presence.orders) state.orders = workspace.orders.map((row) => copy(row.payload));
    if (presence.receivables) state.receivables = workspace.receivables.map((row) => copy(row.payload));
    if (presence.transfers) state.transfers = workspace.transfers.map((row) => copy(row.payload));
    if (presence.ledger) state.ledger = workspace.ledgerLines.map((row) => copy(row.payload));
    if (presence.archives) state.archives = workspace.closedReports.map((row) => copy(row.payload));
    if (presence.savedCustomers) state.savedCustomers = workspace.savedCustomers.map((row) => copy(row.payload));
    if (presence.masterBankEntries) state.masterBankEntries = workspace.masterBankEntries.map((row) => copy(row.payload));
    if (presence.settlements) state.settlements = workspace.settlements.map((row) => copy(row.payload));
    db.appStates[workspace.workspaceId] = state;
  }
  return db;
}

export function unbalancedJournals(manifest) {
  return (manifest?.workspaces || []).flatMap((workspace) => (workspace.journalBalances || [])
    .filter((row) => Number(row.differenceMinor || 0) !== 0)
    .map((row) => ({ workspaceId: workspace.workspaceId, ...row })));
}

export function assertMatchingMigrationManifests(expected, actual) {
  if (sha256Json(expected) === sha256Json(actual)) return;
  throw new Error("PostgreSQL reconciliation does not match the source JSON manifest.");
}
