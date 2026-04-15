-- Scheduled Tasks and Plans System Tables

-- Create Types if they don't exist
DO $$ BEGIN
    CREATE TYPE task_status_type AS ENUM ('pending', 'processing', 'completed', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE task_type AS ENUM ('plan_downgrade', 'plan_upgrade', 'plan_expiry', 'payment_retry', 'account_cleanup', 'data_backup', 'notification_send');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE plan_status_type AS ENUM ('active', 'expired', 'cancelled', 'suspended');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE plan_type AS ENUM ('free', 'basic', 'premium', 'enterprise');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Tables IF NOT EXISTS
CREATE TABLE IF NOT EXISTS user_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    plan_type plan_type NOT NULL DEFAULT 'free',
    status plan_status_type NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type task_type NOT NULL,
    status task_status_type NOT NULL DEFAULT 'pending',
    user_id UUID,
    plan_id UUID REFERENCES user_plans(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    error_message TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    priority INT NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS Enablement
ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;

-- Policies
DO $$ BEGIN
    CREATE POLICY "Users can view their own plans" ON user_plans FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can manage all plans" ON user_plans FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Users can view their own tasks" ON scheduled_tasks FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can manage all tasks" ON scheduled_tasks FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_plans_user_id ON user_plans (user_id);
CREATE INDEX IF NOT EXISTS idx_user_plans_status ON user_plans (status);
CREATE INDEX IF NOT EXISTS idx_user_plans_expires_at ON user_plans (expires_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks (status);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_scheduled_at ON scheduled_tasks (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_id ON scheduled_tasks (user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks (task_type);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_priority ON scheduled_tasks (priority DESC);

-- Composite indexes for status + date queries (critical for health checks)
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_scheduled_at ON scheduled_tasks (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_completed_at ON scheduled_tasks (status, completed_at);
CREATE INDEX IF NOT EXISTS idx_user_plans_status_expires_at ON user_plans (status, expires_at);

-- Function to automatically create expiry tasks for plans
CREATE OR REPLACE FUNCTION create_plan_expiry_task()
RETURNS TRIGGER AS $$
BEGIN
    -- Only create task if plan has an expiry date and is active
    IF NEW.expires_at IS NOT NULL AND NEW.status = 'active' THEN
        INSERT INTO scheduled_tasks (task_type, user_id, plan_id, scheduled_at, priority, metadata)
        VALUES ('plan_expiry', NEW.user_id, NEW.id, NEW.expires_at, 10,
                jsonb_build_object('plan_type', NEW.plan_type, 'expires_at', NEW.expires_at))
        ON CONFLICT DO NOTHING;
    END IF;

    -- Clean up old expiry tasks if expiry changed
    IF OLD.expires_at IS NOT NULL AND (OLD.expires_at != NEW.expires_at OR NEW.status != 'active') THEN
        DELETE FROM scheduled_tasks
        WHERE plan_id = NEW.id AND task_type = 'plan_expiry' AND status = 'pending';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to handle plan status changes
CREATE OR REPLACE FUNCTION handle_plan_status_change()
RETURNS TRIGGER AS $$
BEGIN
    -- If plan expired, create cleanup task
    IF NEW.status = 'expired' AND OLD.status = 'active' THEN
        INSERT INTO scheduled_tasks (task_type, user_id, plan_id, scheduled_at, priority, metadata)
        VALUES ('account_cleanup', NEW.user_id, NEW.id, now() + interval '30 days', 5,
                jsonb_build_object('reason', 'plan_expired', 'plan_type', NEW.plan_type))
        ON CONFLICT DO NOTHING;
    END IF;

    -- If plan was cancelled, cancel related tasks
    IF NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
        UPDATE scheduled_tasks
        SET status = 'cancelled', updated_at = now()
        WHERE plan_id = NEW.id AND status IN ('pending', 'processing');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers (drop first to avoid conflicts)
DROP TRIGGER IF EXISTS trigger_create_plan_expiry_task ON user_plans;
DROP TRIGGER IF EXISTS trigger_plan_status_change ON user_plans;

CREATE TRIGGER trigger_create_plan_expiry_task
    AFTER INSERT OR UPDATE ON user_plans
    FOR EACH ROW EXECUTE FUNCTION create_plan_expiry_task();

CREATE TRIGGER trigger_plan_status_change
    AFTER UPDATE ON user_plans
    FOR EACH ROW EXECUTE FUNCTION handle_plan_status_change();