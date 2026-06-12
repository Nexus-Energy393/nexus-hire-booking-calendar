-- =====================================================================
-- 001_init.sql  |  Nexus fleet-resourcing schema (Neon / Postgres)
-- =====================================================================
-- Operational records for generator hire resourcing. This is the SOURCE OF
-- TRUTH for fleet allocation, engine hours and service history. Pipedrive
-- stays the read-only source of truth for the bookings/deals themselves; the
-- link is the pipedrive_deal_id stored on allocations.
--
-- Run this once against your Neon database (see README "Database setup").
-- Safe to re-run: uses IF NOT EXISTS / idempotent guards where practical.
-- =====================================================================

-- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- ASSETS: serialised items (generators) tracked by fleet number.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  asset_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_number              TEXT NOT NULL UNIQUE,
  asset_name                TEXT NOT NULL,
  category                  TEXT NOT NULL DEFAULT 'Generator',
  generator_size_kva        NUMERIC,
  make                      TEXT,
  model                     TEXT,
  serial_number             TEXT,
  registration_number       TEXT,
  asset_type                TEXT NOT NULL DEFAULT 'serialised'
                              CHECK (asset_type = 'serialised'),
  status                    TEXT NOT NULL DEFAULT 'available'
                              CHECK (status IN ('available','allocated','on_hire',
                                'service_due','in_service','unavailable','retired')),
  current_engine_hours      NUMERIC NOT NULL DEFAULT 0,
  service_interval_hours    NUMERIC NOT NULL DEFAULT 300,
  last_service_hours        NUMERIC NOT NULL DEFAULT 0,
  next_service_due_hours    NUMERIC,
  service_due_warning_hours NUMERIC NOT NULL DEFAULT 50,
  location                  TEXT,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assets_size   ON assets (generator_size_kva);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);

-- next_service_due_hours defaults to last_service_hours + interval when not set.
-- (Kept as a stored column so it can be overridden per asset if needed.)

-- ---------------------------------------------------------------------
-- STOCK ITEMS: non-serialised items (cable sets, ramps) tracked by qty.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_items (
  stock_item_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_name      TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'Cable',
  description    TEXT,
  asset_type     TEXT NOT NULL DEFAULT 'non_serialised'
                   CHECK (asset_type = 'non_serialised'),
  total_quantity NUMERIC NOT NULL DEFAULT 0,
  unit           TEXT NOT NULL DEFAULT 'set',
  location       TEXT,
  status         TEXT NOT NULL DEFAULT 'available',
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_name, category)
);

-- ---------------------------------------------------------------------
-- ALLOCATIONS: links a Pipedrive booking to an asset OR a stock item.
-- Exactly one of asset_id / stock_item_id is set per row.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allocations (
  allocation_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipedrive_deal_id  BIGINT NOT NULL,
  booking_title      TEXT,
  asset_id           UUID REFERENCES assets (asset_id) ON DELETE SET NULL,
  stock_item_id      UUID REFERENCES stock_items (stock_item_id) ON DELETE SET NULL,
  quantity_required  NUMERIC NOT NULL DEFAULT 1,
  quantity_allocated NUMERIC NOT NULL DEFAULT 0,
  allocation_status  TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (allocation_status IN ('proposed','allocated',
                         'conflict','cross_hire_required','released','cancelled')),
  hire_start         DATE,
  hire_end           DATE,
  dispatch_status    TEXT,
  return_status      TEXT,
  cross_hire_qty     NUMERIC NOT NULL DEFAULT 0,
  override_note      TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (asset_id IS NOT NULL OR stock_item_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_alloc_deal   ON allocations (pipedrive_deal_id);
CREATE INDEX IF NOT EXISTS idx_alloc_asset  ON allocations (asset_id);
CREATE INDEX IF NOT EXISTS idx_alloc_stock  ON allocations (stock_item_id);
CREATE INDEX IF NOT EXISTS idx_alloc_dates  ON allocations (hire_start, hire_end);

-- ---------------------------------------------------------------------
-- ENGINE HOUR RECORDS: hours out / in per generator per hire.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS engine_hour_records (
  engine_hour_record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id              UUID NOT NULL REFERENCES assets (asset_id) ON DELETE CASCADE,
  pipedrive_deal_id     BIGINT,
  hours_out             NUMERIC,
  hours_in              NUMERIC,
  runtime_hours         NUMERIC,
  recorded_by           TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                 TEXT,
  CHECK (hours_in IS NULL OR hours_out IS NULL OR hours_in >= hours_out)
);

CREATE INDEX IF NOT EXISTS idx_engine_asset ON engine_hour_records (asset_id);
CREATE INDEX IF NOT EXISTS idx_engine_deal  ON engine_hour_records (pipedrive_deal_id);

-- ---------------------------------------------------------------------
-- SERVICE RECORDS: completed services against a generator.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_records (
  service_record_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id               UUID NOT NULL REFERENCES assets (asset_id) ON DELETE CASCADE,
  service_type           TEXT,
  service_due_hours      NUMERIC,
  service_completed_hours NUMERIC,
  service_completed_date DATE,
  completed_by           TEXT,
  service_form_url       TEXT,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_asset ON service_records (asset_id);

-- ---------------------------------------------------------------------
-- ALERTS: persisted operational alerts (also computable on the fly).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  alert_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID REFERENCES assets (asset_id) ON DELETE CASCADE,
  alert_type      TEXT NOT NULL
                    CHECK (alert_type IN ('service_due','service_overdue','conflict',
                      'cross_hire_required','stock_shortage','missing_hours_out',
                      'missing_hours_in')),
  severity        TEXT NOT NULL DEFAULT 'warning'
                    CHECK (severity IN ('warning','critical')),
  message         TEXT,
  related_deal_id BIGINT,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','acknowledged','resolved')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);
CREATE INDEX IF NOT EXISTS idx_alerts_asset  ON alerts (asset_id);

-- ---------------------------------------------------------------------
-- IMPORT LOG: one row per fleet-import run for traceability.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_log (
  import_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT,
  rows_total    INTEGER NOT NULL DEFAULT 0,
  rows_created  INTEGER NOT NULL DEFAULT 0,
  rows_updated  INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  errors        JSONB,
  imported_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- updated_at touch trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assets_touch ON assets;
CREATE TRIGGER trg_assets_touch BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_stock_touch ON stock_items;
CREATE TRIGGER trg_stock_touch BEFORE UPDATE ON stock_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_alloc_touch ON allocations;
CREATE TRIGGER trg_alloc_touch BEFORE UPDATE ON allocations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_service_touch ON service_records;
CREATE TRIGGER trg_service_touch BEFORE UPDATE ON service_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
