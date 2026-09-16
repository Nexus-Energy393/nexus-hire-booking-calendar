-- =====================================================================
-- 008_staff_licence.sql  |  Licence number and location on staff
-- =====================================================================
-- The jobsheet's Inspector table has rendered Licence and Location columns
-- since it shipped (app.js, jsRenderStaffAllocations). The `staff` table has
-- never had either field, so both cells read "—" on every inspector, on every
-- sheet, forever. On an electrical job the licence number is the one detail
-- the sheet exists to carry: without it the crew has to ring the office to
-- find out who is actually accredited to sign the connection off.
--
-- Two nullable TEXT columns. Nothing existing changes, no row is rewritten,
-- and every current staff record keeps working with both as NULL.
--
-- Additive and safe to re-run.
--
-- To reverse:
--   ALTER TABLE staff DROP COLUMN license_number;
--   ALTER TABLE staff DROP COLUMN location;
-- =====================================================================

ALTER TABLE staff ADD COLUMN IF NOT EXISTS license_number TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS location       TEXT;

-- Inspectors are found by role ILIKE '%inspector%' in half a dozen places
-- (store-staff.js conflict detection, the jobsheet's section split). That is a
-- scan of a table with tens of rows and does not need an index; this one is
-- for the licence lookup, which is the question people actually ask of it -
-- "who holds licence 12345".
CREATE INDEX IF NOT EXISTS idx_staff_license ON staff (license_number);
