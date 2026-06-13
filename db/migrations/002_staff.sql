-- =====================================================================
-- 002_staff.sql  |  Nexus staff resourcing + utilisation schema
-- =====================================================================
-- Adds three tables: staff, staff_allocations, staff_unavailability.
-- Safe to re-run: all statements use IF NOT EXISTS or DO blocks.
-- =====================================================================

-- ---------------------------------------------------------------------
-- STAFF: team members and contractors tracked for resourcing.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  staff_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT,
  staff_type TEXT NOT NULL DEFAULT 'employee'
               CHECK (staff_type IN ('employee','contractor')),
  status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','inactive')),
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_type   ON staff (staff_type);
CREATE INDEX IF NOT EXISTS idx_staff_status ON staff (status);

-- ---------------------------------------------------------------------
-- STAFF ALLOCATIONS: hours allocated to a staff member on a hire job.
-- duration_hours = total allocated hours for the block.
-- billable_hours defaults to duration_hours when billable = true.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_allocations (
  staff_allocation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id            UUID NOT NULL REFERENCES staff (staff_id) ON DELETE CASCADE,
  pipedrive_deal_id   BIGINT,
  booking_title       TEXT,
  allocation_start    TIMESTAMPTZ NOT NULL,
  allocation_end      TIMESTAMPTZ NOT NULL,
  duration_hours      NUMERIC NOT NULL DEFAULT 0
                        CHECK (duration_hours >= 0),
  billable            BOOLEAN NOT NULL DEFAULT true,
  billable_hours      NUMERIC NOT NULL DEFAULT 0
                        CHECK (billable_hours >= 0),
  status              TEXT NOT NULL DEFAULT 'allocated'
                        CHECK (status IN ('proposed','allocated','conflict',
                                          'completed','cancelled')),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (allocation_end >= allocation_start)
);

CREATE INDEX IF NOT EXISTS idx_sa_staff ON staff_allocations (staff_id);
CREATE INDEX IF NOT EXISTS idx_sa_deal  ON staff_allocations (pipedrive_deal_id);
CREATE INDEX IF NOT EXISTS idx_sa_dates ON staff_allocations (allocation_start, allocation_end);

-- ---------------------------------------------------------------------
-- STAFF UNAVAILABILITY: leave and unavailable blocks.
-- These reduce the available hours for utilisation calculations.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_unavailability (
  unavailability_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id          UUID NOT NULL REFERENCES staff (staff_id) ON DELETE CASCADE,
  start_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  reason            TEXT NOT NULL DEFAULT 'annual_leave'
                      CHECK (reason IN ('annual_leave','sick_leave','other')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time >= start_time)
);

CREATE INDEX IF NOT EXISTS idx_unavail_staff ON staff_unavailability (staff_id);
CREATE INDEX IF NOT EXISTS idx_unavail_dates ON staff_unavailability (start_time, end_time);

-- ---------------------------------------------------------------------
-- Touch triggers for staff + staff_allocations
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_staff_touch ON staff;
CREATE TRIGGER trg_staff_touch BEFORE UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_sa_touch ON staff_allocations;
CREATE TRIGGER trg_sa_touch BEFORE UPDATE ON staff_allocations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
