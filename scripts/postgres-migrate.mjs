import { applyPostgresMigrations } from "../src/postgres/migrations.mjs";
import { closePostgresPool } from "../src/postgres/pool.mjs";

try {
  const result = await applyPostgresMigrations();
  if (result.installed.length) {
    console.log(`Applied ${result.installed.length} PostgreSQL migration(s): ${result.installed.join(", ")}`);
  } else {
    console.log(`PostgreSQL schema is current (${result.total} migration(s)).`);
  }
} finally {
  await closePostgresPool();
}
