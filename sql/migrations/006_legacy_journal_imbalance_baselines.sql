CREATE TABLE hp_legacy_journal_imbalance_baselines (
  workspace_id text NOT NULL,
  journal_entry_key text NOT NULL,
  journal text,
  currency char(3) NOT NULL,
  difference_minor bigint NOT NULL CHECK (difference_minor <> 0),
  migration_id text NOT NULL REFERENCES hp_migration_imports(migration_id) ON DELETE RESTRICT,
  source_file_sha256 char(64) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, journal_entry_key, currency),
  FOREIGN KEY (workspace_id, journal_entry_key)
    REFERENCES hp_journal_entries(workspace_id, journal_entry_key)
    ON DELETE RESTRICT
);

CREATE INDEX hp_legacy_journal_imbalance_journal_idx
  ON hp_legacy_journal_imbalance_baselines(workspace_id, journal, currency);

CREATE OR REPLACE FUNCTION hp_prevent_legacy_journal_baseline_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legacy journal imbalance baselines are immutable audit evidence';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hp_legacy_journal_baselines_no_update_delete
BEFORE UPDATE OR DELETE ON hp_legacy_journal_imbalance_baselines
FOR EACH ROW EXECUTE FUNCTION hp_prevent_legacy_journal_baseline_mutation();

CREATE VIEW hp_journal_balance_violations AS
WITH current_imbalances AS (
  SELECT
    workspace_id,
    journal_entry_key,
    journal,
    currency,
    difference_minor
  FROM hp_journal_balances
  WHERE difference_minor <> 0
)
SELECT
  COALESCE(current.workspace_id, baseline.workspace_id) AS workspace_id,
  COALESCE(current.journal_entry_key, baseline.journal_entry_key) AS journal_entry_key,
  COALESCE(current.journal, baseline.journal) AS journal,
  COALESCE(current.currency, baseline.currency) AS currency,
  baseline.difference_minor AS expected_difference_minor,
  current.difference_minor AS actual_difference_minor,
  CASE
    WHEN baseline.journal_entry_key IS NULL THEN 'new-unbalanced-journal'
    WHEN current.journal_entry_key IS NULL THEN 'legacy-journal-missing-or-rebalanced'
    ELSE 'legacy-journal-balance-changed'
  END AS violation_reason
FROM current_imbalances AS current
FULL OUTER JOIN hp_legacy_journal_imbalance_baselines AS baseline
  ON baseline.workspace_id = current.workspace_id
 AND baseline.journal_entry_key = current.journal_entry_key
 AND baseline.currency = current.currency
WHERE baseline.journal_entry_key IS NULL
   OR current.journal_entry_key IS NULL
   OR baseline.difference_minor <> current.difference_minor
   OR baseline.journal IS DISTINCT FROM current.journal;
