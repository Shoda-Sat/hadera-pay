import { reconstructDatabaseFromPostgres } from "./importer.mjs";
import { postgresPool } from "./pool.mjs";

export function selectedPersistenceBackend() {
  const backend = String(process.env.PERSISTENCE_BACKEND || "json").trim().toLowerCase();
  if (!["json", "postgres"].includes(backend)) {
    throw new Error("PERSISTENCE_BACKEND must be either json or postgres.");
  }
  return backend;
}

export function assertPostgresCutoverAuthorized() {
  if (selectedPersistenceBackend() !== "postgres") {
    throw new Error("PostgreSQL persistence is not selected.");
  }
  if (String(process.env.POSTGRES_CUTOVER_CONFIRMED || "") !== "reconciled-production-import") {
    throw new Error("PostgreSQL cutover is blocked until the reconciled production import is explicitly confirmed.");
  }
}

export async function loadImportedPostgresDatabase() {
  assertPostgresCutoverAuthorized();
  const client = await postgresPool().connect();
  try {
    return await reconstructDatabaseFromPostgres(client);
  } finally {
    client.release();
  }
}
