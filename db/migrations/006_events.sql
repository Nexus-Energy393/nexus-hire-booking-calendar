-- =====================================================================
-- 006_events.sql  |  Typed calendar events + staff assignment
-- =====================================================================
-- Until now the board could only show one kind of thing: a won HIRE deal
-- from the CRM feed. Everything else a crew actually does on a given day
-- lived as a boolean on that deal - deliveryRequired, refuellingRequired,
-- electricalConnectionRequired, electricalInspectionRequired - with no date
-- of its own and nobody assigned to it. You cannot roster an install that
-- has no date, so this table gives those jobs a real existence.
--
-- The CRM stays the source of truth for the HIRE DEAL. This table owns the
-- scheduling layer on top of it, in the board's own database, exactly as
-- allocations and staff already do.
--
-- Safe to re-run: every statement uses IF NOT EXISTS or a DO block.
-- =====================================================================

CREATE TABLE IF NOT EXISTS events (
  event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  event_type   TEXT NOT NULL
                 CHECK (event_type IN ('hire','outage','install','electrical',
                                       'refuel','delivery','collection',
                                       'service','other')),

  title        TEXT NOT NULL,
  customer     TEXT,
  site         TEXT,
  suburb       TEXT,

  -- Dates, not timestamps. This is a day-planning board: a hire runs "3 Aug
  -- to 2 Nov", not "3 Aug 00:00:00+10". Times are optional and only used
  -- when a job genuinely has a window, e.g. a 6am delivery before trading.
  start_date   DATE NOT NULL,
  end_date     DATE,
  start_time   TIME,
  end_time     TIME,
  all_day      BOOLEAN NOT NULL DEFAULT true,

  status       TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('tentative','scheduled','in_progress',
                                   'completed','cancelled')),

  -- ---------------------------------------------------------------
  -- PROVENANCE. The whole design turns on these three columns.
  --
  -- 'derived' rows are generated from a won deal on the CRM feed, so an
  -- install the office already recorded against a hire does not have to be
  -- typed in again. 'manual' rows are created on the board by clicking a
  -- date, for work that has no deal behind it.
  --
  -- source_key is the stable identity of a derived row, e.g.
  -- "deal:1042:delivery". Re-deriving UPSERTs on it, so running the sync
  -- twice cannot produce two delivery events for the same job.
  --
  -- pinned is the guard that makes this safe to automate. The moment a human
  -- moves, renames or re-crews a derived event, it is pinned, and the sync
  -- will never touch it again. Otherwise the next feed refresh would quietly
  -- drag a delivery someone deliberately shifted to Thursday back to Monday,
  -- which is precisely the kind of silent overwrite that makes people stop
  -- trusting a roster.
  -- ---------------------------------------------------------------
  source       TEXT NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual','derived')),
  source_deal_id TEXT,
  source_key   TEXT UNIQUE,
  pinned       BOOLEAN NOT NULL DEFAULT false,

  equipment    TEXT,
  notes        TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (end_time IS NULL OR start_time IS NULL OR end_time >= start_time)
);

-- The board almost always asks "what is on between these two dates", so the
-- range index carries both ends.
CREATE INDEX IF NOT EXISTS idx_events_dates  ON events (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_events_type   ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_deal   ON events (source_deal_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);

-- ---------------------------------------------------------------------
-- EVENT STAFF: who is on the job.
--
-- A join table rather than a column, because an install is routinely two
-- sparkies and a driver, and "assigned_to TEXT" would have us splitting
-- names on commas within a month. ON DELETE CASCADE on both sides: removing
-- a staff member should not leave a ghost crew member on a job.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_staff (
  event_id   UUID NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  staff_id   UUID NOT NULL REFERENCES staff  (staff_id) ON DELETE CASCADE,
  role       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_event_staff_staff ON event_staff (staff_id);

-- touch_updated_at() is defined in 001_init.sql
DROP TRIGGER IF EXISTS trg_events_touch ON events;
CREATE TRIGGER trg_events_touch BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
