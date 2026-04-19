-- System Status Tables (Idempotent Script)

-- Create Types if they don't exist
DO $$ BEGIN
    CREATE TYPE system_status_type AS ENUM ('operational', 'degraded_performance', 'partial_outage', 'major_outage');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE incident_impact_type AS ENUM ('critical', 'warning', 'info');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE incident_status_type AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE subscription_type AS ENUM ('email', 'discord_dm', 'webhook', 'discord_channel');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Tables IF NOT EXISTS
CREATE TABLE IF NOT EXISTS system_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    status system_status_type NOT NULL DEFAULT 'operational',
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure UNIQUE constraint exists for ON CONFLICT to work
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'system_components_name_key'
    ) THEN
        ALTER TABLE system_components ADD CONSTRAINT system_components_name_key UNIQUE (name);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS system_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component_id UUID REFERENCES system_components(id) ON DELETE CASCADE,
    status system_status_type NOT NULL,
    recorded_at DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(component_id, recorded_at)
);

CREATE TABLE IF NOT EXISTS system_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    impact incident_impact_type NOT NULL DEFAULT 'info',
    status incident_status_type NOT NULL DEFAULT 'investigating',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_incident_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID REFERENCES system_incidents(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    status incident_status_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_status_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type subscription_type NOT NULL,
    target TEXT NOT NULL, -- email, discord user id, webhook url, or channel id
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS Enablement
ALTER TABLE system_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_incident_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_status_subscriptions ENABLE ROW LEVEL SECURITY;

-- Policies (using DO blocks to avoid "already exists" errors)
DO $$ BEGIN
    CREATE POLICY "Public can view system components" ON system_components FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Public can view system status history" ON system_status_history FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Public can view system incidents" ON system_incidents FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Public can view system incident updates" ON system_incident_updates FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Insert initial components (ON CONFLICT DO NOTHING requires the UNIQUE constraint added above)
INSERT INTO system_components (name, description, display_order) VALUES
('Flow AI', 'Status do sistema de IA tanto do sistema quanto do ETC', 1),
('API', 'API principal do sistemas', 2),
('Tarefas agendadas', 'Tarefas agendadas pelos clientes como pagamentos, Datas, Mudanças de plano, Downgrades etc.', 3),
('DISCORD BOT', 'Sistema do DISCORD BOT', 4),
('Notificações', 'Notificações de Segurança, Notificações de Atualizações, Logs ETC.', 5),
('Painel de controle', 'Dashboard fdesk.flwdesk.com e areas internas vinculadas ao painel principal', 6),
('DNS', 'DNS do sistema', 7),
('CDN', 'CDN, imagens do sistema, carregamento ETC', 8),
('Registro de domínio', 'Registro de domínios, clientes, subdomínios dos transcripts dos clientes, nossos domínios e subdomínios oficiais tbm', 9),
('Rede', 'Redes, Otimizações, Ethernet do sistema, Velocidade de carregamento, Velocidade do banco de dados', 10),
('Firewall DNS', 'Firewall, segurança etc.', 11),
('Geolocalização de IP', 'Geolocalização, Puxar IP, Localização de tudo etc', 12),
('Otimização', 'Otimizações do sistema, Otimizações de rede, Otimizações de imagem, Otimizações do carregamento, Otimizações de DB', 13),
('Registros de auditoria', 'Logs, Históricos de pagamento, Históricos da conta, Histórico de mensagens com IA, Histórico de transcripts, paginas de transcripts entre outros.', 14),
('Pagamentos e transações', 'Pagamentos, Criações de pagamentos, Validações, Recusados, Pendentes, Pagamentos dos sistemas dos clientes, Recorrências, PIX, CARTAO, *, *. Entre outros', 15),
('Cache', 'Cache do sistema de salvamento, Cache de imagens, Cache interno, Cache geral', 16),
('Velocidade do sistema', 'Velocidade de carregamento do sistema, Velocidade de resposta, Velocidade da IA, Velocidade de Renderização, Velocidade de abertura e fechamento, Velocidade de criação de pagamentos, Logs, Registros e funcionamentos', 17),
('Certificado SSL', 'Certificado SSL do sistema Oficial, Subdomínios, Paginas de clientes e Subdomínios Clientes', 18),
('Armazenamento DB', 'Armazenamento de informações, Armazenamento local, Armazenamento temporário, Armazenamento DB, Armazenamento de cache etc', 19),
('Analises da Web', 'Analise de comportamento, Analise de logs, velocidades, renderização, funções, padrões, bots, ataques, etc', 20)
ON CONFLICT (name) DO NOTHING;

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_system_status_history_component_date ON system_status_history (component_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_system_status_history_recorded_at ON system_status_history (recorded_at);
CREATE INDEX IF NOT EXISTS idx_system_incidents_created_at ON system_incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_incident_updates_incident_id ON system_incident_updates (incident_id);
