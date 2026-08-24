# HaderaPay transactional data migration to PostgreSQL

This is the recommended production migration plan from `data/auth-db.json` to PostgreSQL. Do not point the live service at PostgreSQL until the rehearsal, accounting reconciliation, and rollback checks in this guide pass.

## Important starting point

`sql/schema.sql` is an architectural prototype, not a complete schema for the current application. It currently lacks workspace scoping and several live concepts, including Special Agents, returned and void-requested order states, receivables and their payments, manual journals, withdrawals, closed reports, saved customers, chats, attachment metadata, and the current authentication/session model.

Running that file unchanged against production data would omit or reject valid records. Expand it through versioned migrations first.

## Recommended target model

Every financial row must include `workspace_id`, and legacy JSON identifiers should be preserved in a `legacy_id` column with a unique constraint scoped to the workspace.

Create these transactional tables first:

- `workspaces`
- `actors` and `workspace_memberships`
- `orders`
- `receivables` and `receivable_payments`
- `transfers`
- `journal_entries`
- `ledger_lines`
- `closed_reports`
- `workspace_counters`
- `migration_imports`

Add non-financial tables in the same migration or a later phase:

- `users`, credentials and sessions
- `saved_customers`
- `chat_conversations` and `chat_messages`
- `stored_files`
- workspace settings, permissions and tombstones

Required database rules:

- Store all money as `bigint` minor units.
- Store exchange rates as numerator and denominator integers, not floating-point values.
- Keep journal entries and ledger lines append-only. Corrections must create reversal entries.
- Require every journal to balance independently by currency in a deferred constraint.
- Use unique idempotency keys for Broker submission, Master forwarding, payments, transfers and reversals.
- Scope order numbers, journal numbers and legacy identifiers by workspace and the correct numbering cycle.
- Keep closed reports immutable. Preserve their exact historical snapshot in `jsonb`, with separately indexed actor, cycle and closing timestamps.
- Add indexes for workspace plus state/date, actor/date, journal/date and order participant lookups.

## Application changes before importing data

1. Add the `pg` Node.js driver and create one process-wide connection pool. For the current one-CPU web service, start with a maximum of four database connections.
2. Add `DATABASE_URL` and `PERSISTENCE_BACKEND=json|postgres`. Never commit a connection URL.
3. Put persistence behind repository functions instead of reading or writing the database directly from request handlers.
4. Implement each financial action as one PostgreSQL transaction with row locking where sequencing is required.
5. Keep the existing atomic Broker-send and Master-forward idempotency tokens as database unique keys.
6. Add versioned SQL migrations and a `schema_migrations` table. Schema migrations must run as a Render pre-deploy step, not concurrently in every web-service process.
7. Make `/api/app-state/version` a small indexed query. Paginate orders, ledger lines, messages and reports instead of returning every historical record.

## Build an idempotent importer

The importer should accept an explicit JSON backup path and a migration ID. It must refuse to import the same migration twice.

For each workspace, in one database transaction:

1. Insert the workspace and actors, recording the mapping from every legacy Actor ID to its PostgreSQL ID.
2. Insert active orders while preserving original IDs, journal names, participant identities, state and timestamps.
3. Insert receivables and payment rows linked to their canonical orders.
4. Insert transfers.
5. Group existing ledger lines into journal entries using their journal/source/order identity, then insert the original ledger lines without recalculating them.
6. Insert closed reports as immutable snapshots. Do not re-open or merge them into active orders.
7. Insert counters and numbering cycles.
8. Insert customers, chats and stored-file metadata if they are included in this phase.
9. Record counts and SHA-256 evidence for the imported workspace in `migration_imports`.

Do not “repair” data inside the importer. If an invariant fails, roll back that workspace and produce a report for review.

## Mandatory reconciliation

Generate a manifest from the JSON source before importing and compare it with PostgreSQL afterward. The cutover must stop if any comparison differs.

Compare at minimum:

- Counts by workspace and order state.
- Counts of active and closed orders, receivables, payments, transfers, journal entries and ledger lines.
- Debit-minus-credit balance by workspace, Actor and currency.
- Journal balance by journal and currency.
- Closed-report count and hash for every Actor and closing cycle.
- Order-to-receivable and order-to-journal links.
- Highest counter and numbering cycle per workspace.
- Duplicate legacy IDs or idempotency keys.

The PostgreSQL journal validation query should return no rows:

```sql
SELECT
  workspace_id,
  journal_entry_id,
  currency,
  SUM(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) AS difference_minor
FROM ledger_lines
GROUP BY workspace_id, journal_entry_id, currency
HAVING SUM(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0;
```

## Render setup

1. Create a paid Render PostgreSQL database in the same region as the web service.
2. Use its internal connection URL for the Render web service and store it as the secret `DATABASE_URL`. Use the external URL only for migration tools running outside Render.
3. Keep external database access restricted when it is not needed.
4. Confirm point-in-time recovery is available and create a logical backup after the rehearsal and after the final import.
5. A single Node pool is enough initially. Render's integrated PgBouncer can be enabled later if connection metrics show pressure; it uses transaction-level pooling, so avoid session-scoped database features when using its URL.

Current Render references:

- [Create and connect to Render Postgres](https://render.com/docs/postgresql-creating-connecting)
- [Render Postgres recovery and backups](https://render.com/docs/postgresql-backups)
- [Render Postgres connection pooling](https://render.com/docs/postgresql-connection-pooling)

## Rehearsal and cutover

Use a maintenance-window cutover for the first migration. It is safer for accounting data than implementing temporary dual writes.

1. Make a recoverable copy of the Render persistent disk's `auth-db.json`; record its size and SHA-256 hash.
2. Run the importer against a staging PostgreSQL database.
3. Run the full reconciliation and application test suite against staging.
4. Test login, Broker submission, Master forwarding, payment, void, transfer, withdrawal, manual journal, balance closure and closed-report export.
5. Measure the staging import duration and prepare the exact production maintenance window.
6. Put production into read-only maintenance mode.
7. Wait for all current JSON writes to finish, then create and hash the final JSON backup.
8. Import that exact backup into an empty production PostgreSQL database.
9. Run reconciliation. Do not continue if even one balance, count or closed-report hash differs.
10. Set `PERSISTENCE_BACKEND=postgres`, deploy, and run smoke tests before reopening writes.
11. Keep the final JSON backup immutable and private. Do not let the PostgreSQL application continue writing to it.

## Rollback rule

Before PostgreSQL accepts new production writes, rollback can switch the application back to the final JSON backup.

After PostgreSQL accepts any new financial write, do not switch back to the now-stale JSON file. Restore PostgreSQL using point-in-time recovery or export the new PostgreSQL records through a separately tested reverse-migration process.

## Completion criteria

The migration is complete only when:

- All reconciliation checks match exactly.
- Closed reports remain byte-for-byte or hash-equivalent immutable snapshots.
- The application no longer loads or serializes the full transaction history for polling or ordinary actions.
- Render memory remains stable during a multi-user load test.
- PostgreSQL backups and a recovery rehearsal have been verified.
