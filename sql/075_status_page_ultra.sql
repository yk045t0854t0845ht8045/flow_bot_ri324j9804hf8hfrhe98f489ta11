-- 075_status_page_ultra.sql
-- StatusPage Enterprise Upgrade: Immutable Daily Severity + AI Incident Backfill Support

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add missing columns to system_components (idempotent via DO blocks)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN is_core BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN latency_ms INT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN source_key TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- Mark key components as core and ensure Square Cloud exists
INSERT INTO system_components (name, description, status, is_core, display_order)
VALUES ('Square Cloud', 'Infraestrutura de Hospedagem', 'operational', true, 99)
ON CONFLICT (name) DO UPDATE SET is_core = true;

UPDATE system_components SET is_core = true WHERE name IN ('API', 'Flow AI', 'DISCORD BOT', 'Armazenamento DB', 'Tarefas agendadas', 'Square Cloud');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add missing columns to system_incidents (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE system_incidents ADD COLUMN public_summary TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_incidents ADD COLUMN ai_summary TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_incidents ADD COLUMN component_summary TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Create system_incident_components join table (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_incident_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES system_incidents(id) ON DELETE CASCADE,
    component_id UUID REFERENCES system_components(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(incident_id, component_id)
);

ALTER TABLE system_incident_components ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY "Public can view incident components" ON system_incident_components FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS idx_system_incident_components_incident_id ON system_incident_components (incident_id);
CREATE INDEX IF NOT EXISTS idx_system_incident_components_component_id ON system_incident_components (component_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Health pings table (raw per-minute signals for strike gate logic)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_health_pings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component_name TEXT NOT NULL,
    status system_status_type NOT NULL,
    latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_health_pings_created_at ON system_health_pings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_health_pings_component_created ON system_health_pings (component_name, created_at DESC);

-- Auto-purge pings older than 48h via policy (requires pg_cron or manual cleanup)
-- To keep the table lean, you can run: DELETE FROM system_health_pings WHERE created_at < now() - interval '48 hours';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Immutable daily severity: worst status of the day is never overwritten
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_status_severity_weight(system_status_type);

CREATE OR REPLACE FUNCTION get_status_severity_weight(s system_status_type)
RETURNS INT AS $$
BEGIN
    RETURN CASE s
        WHEN 'operational'         THEN 1
        WHEN 'degraded_performance' THEN 2
        WHEN 'partial_outage'      THEN 3
        WHEN 'major_outage'        THEN 4
        ELSE 0
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION maintain_worst_daily_status()
RETURNS TRIGGER AS $$
BEGIN
    -- Only allow updates that are equal-or-worse severity than what's stored
    IF get_status_severity_weight(NEW.status) < get_status_severity_weight(OLD.status) THEN
        NEW.status = OLD.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maintain_worst_daily_status ON system_status_history;
CREATE TRIGGER trg_maintain_worst_daily_status
BEFORE UPDATE ON system_status_history
FOR EACH ROW
EXECUTE FUNCTION maintain_worst_daily_status();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Add label column to subscriptions (already present in subscriptions.ts)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN label TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN verified_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN metadata JSONB;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN last_delivery_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN last_delivery_status INT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN last_delivery_error TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- Add UNIQUE constraint for on-conflict upserts
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'system_status_subscriptions_type_target_key') THEN
        ALTER TABLE system_status_subscriptions ADD CONSTRAINT system_status_subscriptions_type_target_key UNIQUE (type, target);
    END IF;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Extra indexes for fast queries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_system_components_status ON system_components (status);
CREATE INDEX IF NOT EXISTS idx_system_components_display_order ON system_components (display_order);
CREATE INDEX IF NOT EXISTS idx_system_incidents_status ON system_incidents (status);
CREATE INDEX IF NOT EXISTS idx_system_incidents_impact ON system_incidents (impact);
CREATE INDEX IF NOT EXISTS idx_system_incident_updates_created_at ON system_incident_updates (created_at DESC);
