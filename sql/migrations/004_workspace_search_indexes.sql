CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS hp_orders_payload_search_idx
  ON hp_orders USING gin ((lower(payload::text)) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS hp_receivables_payload_search_idx
  ON hp_receivables USING gin ((lower(payload::text)) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS hp_transfers_payload_search_idx
  ON hp_transfers USING gin ((lower(payload::text)) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS hp_ledger_lines_payload_search_idx
  ON hp_ledger_lines USING gin ((lower(payload::text)) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS hp_closed_reports_payload_search_idx
  ON hp_closed_reports USING gin ((lower(payload::text)) gin_trgm_ops);
