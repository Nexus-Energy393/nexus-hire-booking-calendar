-- ---------------------------------------------------------------------
-- 005_deal_ids_text.sql | Deal ids are CRM cuids now, not Pipedrive ints
--
-- The calendar reads bookings from the Nexy CRM Hire Operations feed.
-- New deals carry cuid ids (e.g. "cmr4jnd9500038mrb2elus20m"); the old
-- BIGINT columns made every jobsheet query for a CRM deal throw a cast
-- error, which surfaced as the picking list rendering "read-only".
--
-- BIGINT -> TEXT preserves all existing numeric values ("491" etc.), so
-- legacy Pipedrive deals keep matching. Idempotent: re-running the cast
-- on an already-TEXT column is a no-op.
-- ---------------------------------------------------------------------
ALTER TABLE allocations         ALTER COLUMN pipedrive_deal_id TYPE TEXT USING pipedrive_deal_id::TEXT;
ALTER TABLE engine_hour_records ALTER COLUMN pipedrive_deal_id TYPE TEXT USING pipedrive_deal_id::TEXT;
ALTER TABLE staff_allocations   ALTER COLUMN pipedrive_deal_id TYPE TEXT USING pipedrive_deal_id::TEXT;
ALTER TABLE refuel_events       ALTER COLUMN pipedrive_deal_id TYPE TEXT USING pipedrive_deal_id::TEXT;
