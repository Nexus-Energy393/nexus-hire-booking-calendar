-- ---------------------------------------------------------------------
-- 010_cross_hire_details.sql | A cross-hire says who, what and what it costs
--
-- Justin, 18 Nov 2026: "fix the cross hire allocation, should update the
-- 'Kennards 60kVA' or what ever the detail is on the fly. make it cool and
-- offer to include the cost price".
--
-- Until now a cross-hire row kept everything in override_note as typed into
-- a browser prompt ("Kennards 60kVA"). These columns hold the parts on their
-- own so the jobsheet can show them, the slot can be seated by size, and the
-- cost can reach the deal in Nexy (CrossHire, which already has supplier,
-- rate, unit and PO) without anyone re-typing it.
--
--   xhire_supplier    who it comes from            "Kennards Hire"
--   xhire_item        what is coming               "60 kVA generator"
--   xhire_kva         the slot size it covers      60
--   xhire_cost        cost price, ex GST           180.00
--   xhire_cost_unit   day | week | total
--   xhire_ref         supplier booking ref or PO   "KH-55123"
--   crm_crosshire_id  the CrossHire row in Nexy this row keeps up to date
--
-- override_note keeps the one-line summary it always held, so every reader
-- written before this (print, alerts, status) carries on unchanged.
--
-- Additive and safe to re-run. lib/store-fleet.js ensureCrossHireColumns()
-- applies the same statements at runtime the first time they are needed.
--
-- Reversal (loses the details, keeps the rows and their summary note):
--   ALTER TABLE allocations DROP COLUMN IF EXISTS xhire_supplier,
--     DROP COLUMN IF EXISTS xhire_item, DROP COLUMN IF EXISTS xhire_kva,
--     DROP COLUMN IF EXISTS xhire_cost, DROP COLUMN IF EXISTS xhire_cost_unit,
--     DROP COLUMN IF EXISTS xhire_ref, DROP COLUMN IF EXISTS crm_crosshire_id;
-- ---------------------------------------------------------------------
ALTER TABLE allocations ADD COLUMN IF NOT EXISTS xhire_supplier   TEXT;
ALTER TABLE allocations ADD COLUMN IF NOT EXISTS xhire_item       TEXT;
ALTER TABLE allocations ADD COLUMN IF NOT EXISTS xhire_kva        NUMERIC;
ALTER TABLE allocations ADD COLUMN IF NOT EXISTS xhire_cost       NUMERIC;
ALTER TABLE allocations ADD COLUMN IF NOT EXISTS xhire_cost_unit  TEXT;
ALTER TABLE allocations ADD COLUMN IF NOT EXISTS xhire_ref        TEXT;
ALTER TABLE allocations ADD COLUMN IF NOT EXISTS crm_crosshire_id TEXT;
