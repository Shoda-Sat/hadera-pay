DROP INDEX IF EXISTS hp_actors_legacy_id_idx;
CREATE INDEX hp_actors_legacy_id_idx
  ON hp_actors(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

DROP INDEX IF EXISTS hp_orders_legacy_id_idx;
CREATE INDEX hp_orders_legacy_id_idx
  ON hp_orders(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

DROP INDEX IF EXISTS hp_receivables_legacy_id_idx;
CREATE INDEX hp_receivables_legacy_id_idx
  ON hp_receivables(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

DROP INDEX IF EXISTS hp_transfers_legacy_id_idx;
CREATE INDEX hp_transfers_legacy_id_idx
  ON hp_transfers(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

DROP INDEX IF EXISTS hp_closed_reports_legacy_id_idx;
CREATE INDEX hp_closed_reports_legacy_id_idx
  ON hp_closed_reports(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

DROP INDEX IF EXISTS hp_saved_customers_legacy_id_idx;
CREATE INDEX hp_saved_customers_legacy_id_idx
  ON hp_saved_customers(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

DROP INDEX IF EXISTS hp_master_bank_entries_legacy_id_idx;
CREATE INDEX hp_master_bank_entries_legacy_id_idx
  ON hp_master_bank_entries(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;
