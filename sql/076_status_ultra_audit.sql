-- 076_status_ultra_audit.sql
-- StatusPage Enterprise Upgrade: Audit Logs, Failure Correlation & Detailed Metrics

-- 1. Create Status Audit Table
CREATE TABLE IF NOT EXISTS system_status_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component_id UUID REFERENCES system_components(id),
    old_status system_status_type,
    new_status system_status_type,
    reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create index for fast audit lookups
CREATE INDEX IF NOT EXISTS idx_status_audit_component ON system_status_audit(component_id, created_at DESC);

-- 3. Ensure new components exist
INSERT INTO system_components (name, description, status, is_core, display_order)
VALUES 
    ('Discord CDN', 'Entrega de icones e assets', 'operational', false, 100),
    ('Auditoria Interna', 'Integridade de logs e sinais', 'operational', true, 101)
ON CONFLICT (name) DO UPDATE SET is_core = EXCLUDED.is_core;

-- 4. Add last_failure_at to components
DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN last_failure_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- 4. Create trigger to automatically log status changes
CREATE OR REPLACE FUNCTION log_system_status_change()
RETURNS TRIGGER AS $$
BEGIN
    if (OLD.status IS DISTINCT FROM NEW.status) THEN
        INSERT INTO system_status_audit (component_id, old_status, new_status, reason, metadata)
        VALUES (
            NEW.id, 
            OLD.status, 
            NEW.status, 
            'Mudanca automatica detectada pelo monitor',
            jsonb_build_object(
                'updated_at', NEW.updated_at,
                'latency_ms', NEW.latency_ms
            )
        );
        
        if (NEW.status = 'major_outage' OR NEW.status = 'partial_outage') THEN
            NEW.last_failure_at = now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_log_status_change ON system_components;
CREATE TRIGGER trg_log_status_change
    BEFORE UPDATE ON system_components
    FOR EACH ROW
    EXECUTE FUNCTION log_system_status_change();

-- 5. Add failure count column for today's reliability score
DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN today_failure_count INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- 6. Create Discord CDN Cache Table
CREATE TABLE IF NOT EXISTS discord_cdn_cache (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_url TEXT NOT NULL,
    last_updated_at TIMESTAMPTZ DEFAULT now(),
    is_featured BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_discord_cdn_featured ON discord_cdn_cache(is_featured);
