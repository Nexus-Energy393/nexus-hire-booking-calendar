-- =====================================================================
-- 007_fuel_columns.sql  |  Fuel readings become columns
-- =====================================================================
-- Fuel had no column. It was serialised into engine_hour_records.notes as
--
--     "Fuel out: 100% | Fuel return: 40% | Ongoing refuelling REQUIRED"
--
-- and four separate regexes, in three files and two repos, parsed it back out:
-- the jobsheet inputs, the readiness gate that decides whether a job can be
-- dispatched, and the CRM mirror. Change that wording anywhere and the fuel
-- check silently starts reporting "Fuel level not checked" on jobs that were
-- checked - a readiness gate failing open on a formatting change.
--
-- The columns already existed on the CRM side (HireEngineLog.fuelOutPct etc).
-- This gives the board the same, and backfills every row already written so no
-- history is lost and nothing has to be re-entered.
--
-- notes stays, and stays human-readable - it is what a person reads on the
-- sheet. It is simply no longer the place the data LIVES.
--
-- Additive and safe to re-run.
-- =====================================================================

ALTER TABLE engine_hour_records ADD COLUMN IF NOT EXISTS fuel_out_pct    NUMERIC;
ALTER TABLE engine_hour_records ADD COLUMN IF NOT EXISTS fuel_return_pct NUMERIC;
ALTER TABLE engine_hour_records ADD COLUMN IF NOT EXISTS ongoing_refuel  BOOLEAN;

-- A percentage is a percentage. Rows written before this migration are
-- backfilled below and cannot violate it; anything outside 0-100 afterwards is
-- a bug worth failing on rather than storing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engine_hour_fuel_pct_range') THEN
    ALTER TABLE engine_hour_records ADD CONSTRAINT engine_hour_fuel_pct_range CHECK (
      (fuel_out_pct    IS NULL OR (fuel_out_pct    >= 0 AND fuel_out_pct    <= 100)) AND
      (fuel_return_pct IS NULL OR (fuel_return_pct >= 0 AND fuel_return_pct <= 100))
    );
  END IF;
END $$;

-- ---- Backfill from the notes string -------------------------------------
-- Only where the column is still NULL, so a re-run cannot overwrite a real
-- reading with whatever the note happens to say.
UPDATE engine_hour_records
   SET fuel_out_pct = LEAST(100, GREATEST(0,
         (substring(notes from 'Fuel out:\s*([0-9]{1,3})'))::numeric))
 WHERE fuel_out_pct IS NULL
   AND notes ~* 'Fuel out:\s*[0-9]';

UPDATE engine_hour_records
   SET fuel_return_pct = LEAST(100, GREATEST(0,
         (substring(notes from 'Fuel return:\s*([0-9]{1,3})'))::numeric))
 WHERE fuel_return_pct IS NULL
   AND notes ~* 'Fuel return:\s*[0-9]';

-- The flag is three-valued on purpose. NULL means nobody said; false means
-- somebody said no. "No ongoing refuelling" was written on every save, so its
-- presence is what distinguishes the two.
UPDATE engine_hour_records
   SET ongoing_refuel = (notes ~* 'ongoing refuelling required')
 WHERE ongoing_refuel IS NULL
   AND notes ~* 'ongoing refuelling';

CREATE INDEX IF NOT EXISTS idx_engine_fuel_out ON engine_hour_records (fuel_out_pct);
