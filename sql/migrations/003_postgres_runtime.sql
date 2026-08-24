ALTER TABLE hp_closed_reports
  DROP CONSTRAINT IF EXISTS hp_closed_reports_ordinal_check;

COMMENT ON COLUMN hp_closed_reports.ordinal IS
  'Stable display order. Runtime inserts may use negative values so new immutable reports can be prepended without updating older rows.';
