CREATE TABLE IF NOT EXISTS hp_schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum_sha256 char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hp_database_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  document jsonb NOT NULL,
  metadata_sha256 char(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hp_workspace_states (
  workspace_id text PRIMARY KEY,
  revision text NOT NULL DEFAULT '0',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  collection_presence jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_sha256 char(64) NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hp_actors (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  actor_name text,
  actor_role text,
  base_currency char(3),
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE UNIQUE INDEX hp_actors_legacy_id_idx
  ON hp_actors(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE TABLE hp_orders (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  journal text,
  order_state text,
  broker_actor_id text,
  agent_actor_id text,
  created_at_text text,
  updated_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE UNIQUE INDEX hp_orders_legacy_id_idx
  ON hp_orders(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;
CREATE INDEX hp_orders_workspace_state_idx ON hp_orders(workspace_id, order_state, updated_at_text);
CREATE INDEX hp_orders_workspace_journal_idx ON hp_orders(workspace_id, journal);
CREATE INDEX hp_orders_broker_idx ON hp_orders(workspace_id, broker_actor_id, updated_at_text);
CREATE INDEX hp_orders_agent_idx ON hp_orders(workspace_id, agent_actor_id, updated_at_text);

CREATE TABLE hp_receivables (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  order_id text,
  journal text,
  borrower_actor_id text,
  created_at_text text,
  updated_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE UNIQUE INDEX hp_receivables_legacy_id_idx
  ON hp_receivables(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;
CREATE INDEX hp_receivables_order_idx ON hp_receivables(workspace_id, order_id);
CREATE INDEX hp_receivables_actor_idx ON hp_receivables(workspace_id, borrower_actor_id, updated_at_text);

CREATE TABLE hp_transfers (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  journal text,
  transfer_state text,
  from_actor_id text,
  to_actor_id text,
  created_at_text text,
  updated_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE UNIQUE INDEX hp_transfers_legacy_id_idx
  ON hp_transfers(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;
CREATE INDEX hp_transfers_journal_idx ON hp_transfers(workspace_id, journal);
CREATE INDEX hp_transfers_from_actor_idx ON hp_transfers(workspace_id, from_actor_id, updated_at_text);
CREATE INDEX hp_transfers_to_actor_idx ON hp_transfers(workspace_id, to_actor_id, updated_at_text);

CREATE TABLE hp_journal_entries (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  journal_entry_key text NOT NULL,
  journal text,
  source text,
  order_id text,
  transfer_id text,
  first_ordinal integer NOT NULL CHECK (first_ordinal >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, journal_entry_key)
);

CREATE INDEX hp_journal_entries_journal_idx ON hp_journal_entries(workspace_id, journal);
CREATE INDEX hp_journal_entries_order_idx ON hp_journal_entries(workspace_id, order_id);

CREATE TABLE hp_ledger_lines (
  workspace_id text NOT NULL,
  journal_entry_key text NOT NULL,
  record_key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  journal text,
  source text,
  order_id text,
  transfer_id text,
  actor_id text,
  account text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('Debit', 'Credit')),
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  posted_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal),
  FOREIGN KEY (workspace_id, journal_entry_key)
    REFERENCES hp_journal_entries(workspace_id, journal_entry_key)
    ON DELETE RESTRICT
);

CREATE INDEX hp_ledger_lines_actor_idx ON hp_ledger_lines(workspace_id, actor_id, posted_at_text);
CREATE INDEX hp_ledger_lines_account_idx ON hp_ledger_lines(workspace_id, account, currency, posted_at_text);
CREATE INDEX hp_ledger_lines_journal_idx ON hp_ledger_lines(workspace_id, journal, currency);
CREATE INDEX hp_ledger_lines_order_idx ON hp_ledger_lines(workspace_id, order_id);

CREATE TABLE hp_closed_reports (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  actor_id text,
  actor_name text,
  closed_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE UNIQUE INDEX hp_closed_reports_legacy_id_idx
  ON hp_closed_reports(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;
CREATE INDEX hp_closed_reports_actor_idx ON hp_closed_reports(workspace_id, actor_id, closed_at_text);
CREATE INDEX hp_closed_reports_actor_name_idx ON hp_closed_reports(workspace_id, actor_name, closed_at_text);

CREATE TABLE hp_saved_customers (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  actor_id text,
  updated_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE UNIQUE INDEX hp_saved_customers_legacy_id_idx
  ON hp_saved_customers(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE TABLE hp_master_bank_entries (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  reference text,
  currency char(3),
  posted_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE UNIQUE INDEX hp_master_bank_entries_legacy_id_idx
  ON hp_master_bank_entries(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE TABLE hp_settlements (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  actor_name text,
  currency char(3),
  net_minor bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE INDEX hp_settlements_actor_idx ON hp_settlements(workspace_id, actor_name, currency);

CREATE TABLE hp_workspace_manifests (
  workspace_id text PRIMARY KEY REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  migration_id text NOT NULL,
  manifest jsonb NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hp_migration_imports (
  migration_id text PRIMARY KEY,
  source_file_sha256 char(64) NOT NULL,
  database_sha256 char(64) NOT NULL,
  manifest jsonb NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW hp_journal_balances AS
SELECT
  workspace_id,
  journal_entry_key,
  journal,
  currency,
  sum(CASE direction WHEN 'Debit' THEN amount_minor ELSE -amount_minor END)::bigint AS difference_minor
FROM hp_ledger_lines
GROUP BY workspace_id, journal_entry_key, journal, currency;

CREATE OR REPLACE FUNCTION hp_prevent_closed_report_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'closed reports are immutable; create a separately reviewed correction record instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hp_closed_reports_no_update_delete
BEFORE UPDATE OR DELETE ON hp_closed_reports
FOR EACH ROW EXECUTE FUNCTION hp_prevent_closed_report_mutation();
