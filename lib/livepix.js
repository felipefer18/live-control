// Integração com a API oficial da LivePix (https://docs.livepix.gg/api).
// Usa OAuth2 "client credentials" e consulta GET /v2/messages periodicamente (polling),
// então funciona direto no seu PC, sem endereço público nem webhook.
export function createLivepix({ config, onDonation, publish }) {
  let token = null, exp = 0, timer = null, running = false;
  let seen = new Set(), first = true;
  let st = { status: 'off', lastPoll: null, error: null, received: 0 };

  const cfg = () => config.livepix ?? {};
  const configured = () => !!(cfg().clientId && cfg().clientSecret);
  const status = () => ({ configured: configured(), ...st });
  const emit = () => publish({ type: 'livepixStatus', livepix: status() });

  async function getToken() {
    if (token && Date.now() < exp - 30000) return token;
    const r = await fetch('https://oauth.livepix.gg/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: cfg().clientId,
        client_secret: cfg().clientSecret, scope: 'messages:read'
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || `Login da LivePix falhou (${r.status})`);
    token = j.access_token; exp = Date.now() + (j.expires_in || 3600) * 1000;
    return token;
  }

  async function pollOnce() {
    const t = await getToken();
    const r = await fetch('https://api.livepix.gg/v2/messages', { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 401) { token = null; throw new Error('A LivePix recusou o token. Confira o Client ID e o Secret.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `LivePix respondeu ${r.status}`);
    const list = (j.data ?? []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (first || m.flagged) continue; // na primeira consulta só memoriza o que já existia
      if (m.currency && m.currency !== 'BRL') continue;
      st.received++;
      onDonation({ name: m.username || 'Anônimo', amount: (m.amount ?? 0) / 100, message: m.message ?? '', source: 'livepix' });
    }
    first = false;
    if (seen.size > 500) seen = new Set([...seen].slice(-200));
  }

  async function loop() {
    if (!running) return;
    try { await pollOnce(); st = { ...st, status: 'ok', lastPoll: Date.now(), error: null }; }
    catch (e) { st = { ...st, status: 'error', error: e.message }; }
    emit();
    timer = setTimeout(loop, Math.max(3, cfg().pollSeconds ?? 6) * 1000);
  }

  function start() {
    stop();
    if (!configured()) { st = { status: 'off', lastPoll: null, error: null, received: 0 }; emit(); return; }
    token = null; first = true; seen = new Set(); running = true; st = { status: 'connecting', lastPoll: null, error: null, received: 0 };
    loop();
  }
  function stop() { running = false; clearTimeout(timer); }

  return { start, stop, status };
}
