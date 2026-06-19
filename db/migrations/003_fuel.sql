-- ---------------------------------------------------------------------
-- 003_fuel.sql  |  Fuel + completion fields for the hire jobsheet
-- ---------------------------------------------------------------------
-- Promotes fuel from free-text in engine_hour_records.notes to real,
-- reportable columns, and adds tank capacity to assets so fuel % can be
-- expressed in litres. Additive + idempotent: safe to run on production.
--
-- Run once against Neon:  psql "$DATABASE_URL" -f db/migrations/003_fuel.sql
-- ---------------------------------------------------------------------

-- Fuel readings captured per engine-hour record (out at dispatch, return at
-- completion) plus the derived litres used over the hire.
ALTER TABLE engine_hour_records
  ADD COLUMN IF NOT EXISTS fuel_level_out_pct    NUMERIC
    CHECK (fuel_level_out_pct    IS NULL OR (fuel_level_out_pct    BETWEEN 0 AND 100)),
  ADD COLUMN IF NOT EXISTS fuel_level_return_pct NUMERIC
    CHECK (fuel_level_return_pct IS NULL OR (fuel_level_return_pct BETWEEN 0 AND 100)),
  ADD COLUMN IF NOT EXISTS fuel_used_litres      NUMERIC;

-- Tank capacity lets the app convert a fuel % delta into litres used.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS fuel_tank_litres NUMERIC;

-- Helpful when reporting fuel burn per deal.
CREATE INDEX IF NOT EXISTS idx_engine_deal ON engine_hour_records (pipedrive_deal_id);
