import pg from "pg";

const { Pool } = pg;
let sharedPool = null;

export function configuredDatabaseUrl() {
  return String(process.env.DATABASE_URL || "").trim();
}

function postgresSslOptions(connectionString) {
  const sslMode = String(process.env.PGSSLMODE || "").trim().toLowerCase();
  if (sslMode === "disable") return false;
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return false;
  } catch {
    // Let pg report an invalid connection string with its normal error.
  }
  return { rejectUnauthorized: false };
}

export function postgresPool() {
  if (sharedPool) return sharedPool;
  const connectionString = configuredDatabaseUrl();
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL commands.");
  const requestedMax = Number(process.env.PG_POOL_MAX || 4);
  const max = Number.isInteger(requestedMax) ? Math.min(10, Math.max(1, requestedMax)) : 4;
  sharedPool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: postgresSslOptions(connectionString),
  });
  sharedPool.on("error", (error) => {
    console.error("Unexpected idle PostgreSQL client error:", error instanceof Error ? error.message : error);
  });
  return sharedPool;
}

export async function withPostgresTransaction(operation) {
  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePostgresPool() {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  await pool.end();
}
