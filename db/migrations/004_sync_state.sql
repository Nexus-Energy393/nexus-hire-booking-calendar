-- =====================================================================
-- 004_sync_state.sql  |  Incremental Pipedrive sync cursor
-- =====================================================================
-- Single-row table holding the timestamp of the last successful hourly sync.
-- syncAll() reads it to skip deals whose update_time has not advanced, which
-- avoids re-processing (and re-enriching) unchanged won deals every hour.
--
-- Safe to re-run.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sync_state (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  last_sync_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sync_state_singleton CHECK (id = 1)
);

INSERT INTO sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
