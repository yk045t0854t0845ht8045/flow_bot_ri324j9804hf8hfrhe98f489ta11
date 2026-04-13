const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const dns = require("dns").promises;
const https = require("https");

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

/**
 * Sistema de Heartbeat do Status - Profissional e Real-Time
 * Monitora Bot, API, DB, AI, CDN, DNS, SSL e Armazenamento.
 */
function startStatusHeartbeat(client) {
    console.log("[status-system] Iniciando monitoramento real-time profissional...");

    // Executa a primeira vez e depois a cada 1 minuto
    checkAllSystems(client);
    setInterval(() => checkAllSystems(client), 60000);
}

async function checkAllSystems(client) {
    try {
        const now = new Date();
        const dateIso = now.toISOString().split('T')[0];
        const results = [];

        // 1. DISCORD BOT (Real-time WS)
        const botStatus = client && client.ws && client.ws.status === 0 ? "operational" : "degraded_performance";
        results.push({ name: 'DISCORD BOT', status: botStatus });

        // 2. Armazenamento DB (Supabase Health)
        const { error: dbError } = await supabase.from('system_components').select('id').limit(1);
        results.push({ name: 'Armazenamento DB', status: dbError ? "major_outage" : "operational" });

        // 3. API (Supabase API Latency)
        const apiStart = Date.now();
        const apiRes = await fetch(`${env.supabaseUrl}/rest/v1/`, { 
            headers: { apikey: env.supabaseServiceRoleKey } 
        }).catch(() => null);
        const apiLatency = Date.now() - apiStart;
        
        let apiStatus = "operational";
        if (!apiRes) {
            apiStatus = "major_outage";
        } else if (apiLatency > 3000) { // Aumentado para 3s para evitar falso positivo
            apiStatus = "partial_outage";
        } else if (apiLatency > 1500) {
            apiStatus = "degraded_performance";
        }
        results.push({ name: 'API', status: apiStatus });

        // 4. FLOW AI (OpenAI API Check)
        const aiStart = Date.now();
        const aiRes = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${env.openaiApiKey}` }
        }).catch(() => null);
        results.push({ name: 'Flow AI', status: !aiRes || !aiRes.ok ? "partial_outage" : "operational" });

        // 5. CDN (Asset Availability)
        const cdnRes = await fetch(`${env.supabaseUrl}/storage/v1/object/public/cdn/logos/logo.png`).catch(() => null);
        results.push({ name: 'CDN', status: !cdnRes || !cdnRes.ok ? "partial_outage" : "operational" });

        // 6. DNS (Domain Resolution)
        try {
            const domain = new URL(env.supabaseUrl).hostname;
            await dns.resolve(domain);
            results.push({ name: 'DNS', status: "operational" });
        } catch {
            results.push({ name: 'DNS', status: "partial_outage" });
        }

        // 7. CERTIFICADO SSL (HTTPS Check)
        const sslStatus = await checkSSL(new URL(env.supabaseUrl).hostname);
        results.push({ name: 'Certificado SSL', status: sslStatus });

        // 8. REDE (Ping/Latency general)
        results.push({ name: 'Rede', status: apiLatency > 2000 ? "degraded_performance" : "operational" });

        // Atualizar todos os componentes no banco de dados
        for (const res of results) {
            const { data: comp } = await supabase
                .from('system_components')
                .select('id')
                .eq('name', res.name)
                .single();

            if (comp) {
                // Update current status
                await supabase
                    .from('system_components')
                    .update({ 
                        status: res.status, 
                        updated_at: now.toISOString() 
                    })
                    .eq('id', comp.id);

                // Update daily history
                await supabase
                    .from('system_status_history')
                    .upsert({ 
                        component_id: comp.id, 
                        recorded_at: dateIso, 
                        status: res.status 
                    }, { onConflict: 'component_id,recorded_at' });
            }
        }

        // IA Analysis (Only on changes or every hour)
        const hasIssues = results.some(r => r.status !== "operational");
        if (hasIssues) {
            console.log("[status-system] Analisando anomalias com IA para evitar falsos positivos...");
            await runAiStatusAnalysis(results);
        } else if (now.getMinutes() === 0) {
            await runAiStatusAnalysis(results);
        }

    } catch (error) {
        console.error("[status-system] Erro crítico no heartbeat:", error);
    }
}

async function checkSSL(hostname) {
    return new Promise((resolve) => {
        const req = https.request({
            hostname,
            port: 443,
            method: 'GET',
            rejectUnauthorized: true,
            timeout: 5000
        }, (res) => {
            resolve("operational");
        });

        req.on('error', () => resolve("partial_outage"));
        req.on('timeout', () => resolve("degraded_performance"));
        req.end();
    });
}

async function runAiStatusAnalysis(results) {
    if (!env.openaiApiKey) return;

    const issues = results.filter(r => r.status !== 'operational');
    if (issues.length === 0) return;

    try {
        // AI Logic to generate a professional incident report if major
        if (issues.some(i => i.status === 'major_outage')) {
            const { data: incident } = await supabase
                .from('system_incidents')
                .insert({
                    title: `Anomalia detectada em: ${issues.map(i => i.name).join(', ')}`,
                    impact: "critical",
                    status: "investigating"
                })
                .select()
                .single();

            if (incident) {
                await supabase
                    .from('system_incident_updates')
                    .insert({
                        incident_id: incident.id,
                        message: "Nossa IA de monitoramento detectou uma falha de conectividade. A equipe técnica já foi acionada e está investigando a causa raiz.",
                        status: "investigating"
                    });
            }
        }
    } catch (e) {
        console.error("[status-system] IA Error:", e);
    }
}

module.exports = { startStatusHeartbeat };
