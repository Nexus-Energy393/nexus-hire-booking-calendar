-- =====================================================================
-- 003_off_hire.sql  |  Nexus Off Hire (return hire equipment) schema
-- =====================================================================
-- Adds first-class support for the "Off Hire" return workflow:
--   * fuel consumed during a hire, recorded in LITRES (not regex-in-notes)
--   * a refuel-event log so ongoing top-ups during a hire are auditable
--   * an off_hired_at stamp on the allocation for "returned" reporting
--   * an 'off_hire_due' alert type for hires past their end date
--
-- Fuel can be captured two ways (both supported):
--   1. Refuel log  -> one refuel_events row per top-up; total = SUM(litres)
--   2. Single total -> engine_hour_records.fuel_used_litres set directly
--
-- Safe to re-run: uses IF NOT EXISTS / idempotent guards throughout.
-- =====================================================================

ALTER TABLE engine_hour_records
  ADD COLUMN IF NOT EXISTS fuel_used_litres      NUMERIC,
  ADD COLUMN IF NOT EXISTS fuel_level_return_pct NUMERIC;

ALTER TABLE allocations
  ADD COLUMN IF NOT EXISTS off_hired_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS refuel_events (
  refuel_event_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id          UUID NOT NULL REFERENCES assets (asset_id) ON DELETE CASCADE,
  pipedrive_deal_id BIGINT,
  litres            NUMERIC NOT NULL CHECK (litres >= 0),
  refuelled_at      DATE,
  recorded_by       TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refuel_asset ON refuel_events (asset_id);
CREATE INDEX IF NOT EXISTS idx_refuel_deal  ON refuel_events (pipedrive_deal_id);

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_alert_type_check
  CHECK (alert_type IN ('service_due','service_overdue','conflict',
    'cross_hire_required','stock_shortage','missing_hours_out',
    'missing_hours_in','off_hire_due'));
