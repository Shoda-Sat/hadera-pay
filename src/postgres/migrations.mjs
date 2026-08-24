import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPostgresTransaction } from "./pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = path.join(root, "sql", "migrations");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function postgresMigrationFiles() {
  const names = (await readdir(migrationsDir))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    const version = name.split("_", 1)[0];
    return { version, name, sql, checksum: sha256(sql.replace(/\r\n/g, "\n")) };
  }));
}

export async function applyPostgresMigrations() {
  const files = await postgresMigrationFiles();
  return withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('haderapay-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS hp_schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum_sha256 char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query("SELECT version, name, checksum_sha256 FROM hp_schema_migrations ORDER BY version");
    const appliedByVersion = new Map(applied.rows.map((row) => [String(row.version), row]));
    const installed = [];
    for (const file of files) {
      const previous = appliedByVersion.get(file.version);
      if (previous) {
        if (String(previous.checksum_sha256).trim() !== file.checksum || previous.name !== file.name) {
          throw new Error(`Applied PostgreSQL migration ${file.version} no longer matches ${file.name}.`);
        }
        continue;
      }
      await client.query(file.sql);
      await client.query(
        "INSERT INTO hp_schema_migrations(version, name, checksum_sha256) VALUES ($1, $2, $3)",
        [file.version, file.name, file.checksum]
      );
      installed.push(file.name);
    }
    return { total: files.length, installed };
  });
}
