import { WebSocket } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import { DATA, readJson, writeJson } from './store.js';

const TOKEN_PATH = path.join(DATA, 'twitch.json');
const SCOPES = 'channel:manage:broadcast user:write:chat moderator:read:followers channel:read:subscriptions bits:read moderator:manage:announcements channel:edit:commercial channel:read:ads channel:read:redemptions channel:manage:redemptions clips:edit';
const ANN_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'];

export function createTwitch({ config, publish, onChat, onEvent, onLogin }) {
  let tokens = readJson(TOKEN_PATH, null);
  let auth = tokens ? { status: 'connected', login: tokens.login } : { status: 'off' };
  let authPoll = null;
  let es = null, esGen = 0, esInfo = { connected: false, errors: [] };
  let irc = null, ircGen = 0;

  const clientId = () => config.twitch?.clientId;
  const status = () => ({
    clientIdSet: !!clientId(), channel: config.twitch?.channel ?? '',
    ...auth, eventsub: esInfo
  });
  const emitStatus = () => publish({ type: 'twitchStatus', twitch: status() });

  async function form(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }

  /* ---------- login (Device Code Grant, sem precisar de servidor público) ---------- */
  async function startAuth() {
    if (!clientId()) throw new Error('Preencha o Client ID da Twitch primeiro');
    const { ok, j } = await form('https://id.twitch.tv/oauth2/device', { client_id: clientId(), scopes: SCOPES });
    if (!ok) throw new Error(j.message || 'Não foi possível iniciar o login na Twitch');
    auth = { status: 'pending', userCode: j.user_code, uri: j.verification_uri, expiresAt: Date.now() + j.expires_in * 1000 };
    emitStatus();
    clearInterval(authPoll);
    authPoll = setInterval(async () => {
      if (Date.now() > auth.expiresAt) { clearInterval(authPoll); auth = { status: 'error', error: 'O código expirou. Tente conectar de novo.' }; emitStatus(); return; }
      const r = await form('https://id.twitch.tv/oauth2/token', {
        client_id: clientId(), scopes: SCOPES, device_code: j.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      });
      if (r.ok) { clearInterval(authPoll); await saveTokens(r.j); }
      else if (!/pending|slow_down/i.test(r.j.message || '')) { clearInterval(authPoll); auth = { status: 'error', error: r.j.message || 'Login recusado' }; emitStatus(); }
    }, (j.interval || 5) * 1000);
    return status();
  }

  async function saveTokens(j) {
    tokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 14000) * 1000 };
    const v = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + tokens.access_token } }).then((r) => r.json());
    tokens.user_id = v.user_id; tokens.login = v.login;
    writeJson(TOKEN_PATH, tokens);
    auth = { status: 'connected', login: tokens.login };
    emitStatus();
    startEventSub();
    try { onLogin?.(tokens.login); } catch { /* ok */ }
  }

  // Renova o acesso. A Twitch troca a chave de renovação a cada uso, então só pode haver UMA renovação por vez:
  // se duas partes do app pedissem ao mesmo tempo, a segunda usaria a chave antiga e faria o app "perder" o login.
  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        if (!tokens?.refresh_token) throw new Error('Twitch não conectada');
        const used = tokens.refresh_token;
        let r;
        try { r = await form('https://id.twitch.tv/oauth2/token', { client_id: clientId(), grant_type: 'refresh_token', refresh_token: used }); }
        catch { throw new Error('Sem conexão com a Twitch agora. Tente de novo em instantes.'); } // falha de rede não derruba o login
        if (!r.ok) {
          // só apaga o login se a Twitch recusou de verdade (chave inválida) e ela ainda era a que estava salva
          if ((r.status === 400 || r.status === 401) && tokens?.refresh_token === used) {
            tokens = null; try { fs.rmSync(TOKEN_PATH); } catch { /* ok */ }
            auth = { status: 'error', error: 'A Twitch recusou a renovação do login. Conecte de novo.' }; emitStatus();
            throw new Error('A Twitch recusou a renovação do login. Conecte de novo.');
          }
          throw new Error(r.j?.message || `Não foi possível renovar o login da Twitch (${r.status}). Tente de novo.`);
        }
        tokens = { ...tokens, access_token: r.j.access_token, refresh_token: r.j.refresh_token ?? tokens.refresh_token, expires_at: Date.now() + (r.j.expires_in || 14000) * 1000 };
        writeJson(TOKEN_PATH, tokens);
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  function logout() {
    clearInterval(authPoll);
    tokens = null; try { fs.rmSync(TOKEN_PATH); } catch { /* ok */ }
    esGen++; try { es?.close(); } catch { /* ok */ }
    esInfo = { connected: false, errors: [] };
    auth = { status: 'off' }; emitStatus();
  }

  async function helix(p, { method = 'GET', body } = {}, retried = false) {
    if (!tokens) throw new Error('Twitch não conectada');
    if (Date.now() > tokens.expires_at - 60000) await refresh();
    const r = await fetch('https://api.twitch.tv/helix' + p, {
      method,
      headers: { Authorization: 'Bearer ' + tokens.access_token, 'Client-Id': clientId(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401 && !retried) { await refresh(); return helix(p, { method, body }, true); }
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `Twitch respondeu ${r.status}`);
    return j;
  }

  /* ---------- título e categoria ---------- */
  async function setChannelInfo({ title, category }) {
    const body = {};
    let found = null;
    if (title) body.title = title;
    if (category) {
      const r = await helix('/search/categories?first=10&query=' + encodeURIComponent(category));
      const list = r.data ?? [];
      found = list.find((c) => c.name.toLowerCase() === category.toLowerCase()) ?? list[0];
      if (!found) throw new Error(`Categoria "${category}" não encontrada na Twitch`);
      body.game_id = found.id;
    }
    if (!Object.keys(body).length) return 'nada a alterar';
    await helix('/channels?broadcaster_id=' + tokens.user_id, { method: 'PATCH', body });
    return [title && 'título', found && `categoria ${found.name}`].filter(Boolean).join(' + ');
  }

  async function sendChat(message) {
    const r = await helix('/chat/messages', { method: 'POST', body: { broadcaster_id: tokens?.user_id, sender_id: tokens?.user_id, message: String(message).slice(0, 480) } });
    if (r.data?.[0] && r.data[0].is_sent === false) throw new Error(r.data[0].drop_reason?.message || 'Mensagem não enviada');
  }

  /* ---------- anúncios no chat e intervalos comerciais ---------- */
  async function announce(message, color = 'primary') {
    const msg = String(message ?? '').trim().slice(0, 500);
    if (!msg) throw new Error('Escreva o texto do anúncio');
    const c = ANN_COLORS.includes(color) ? color : 'primary';
    await helix(`/chat/announcements?broadcaster_id=${tokens?.user_id}&moderator_id=${tokens?.user_id}`, { method: 'POST', body: { message: msg, color: c } });
  }
  async function runAd(length) {
    const len = [30, 60, 90, 120, 150, 180].includes(Number(length)) ? Number(length) : 30;
    const r = await helix('/channels/commercial', { method: 'POST', body: { broadcaster_id: tokens?.user_id, length: len } });
    const d = r.data?.[0] ?? {};
    return { length: d.length ?? len, message: d.message || '', retryAfter: d.retry_after };
  }
  async function adSchedule() {
    const r = await helix('/channels/ads?broadcaster_id=' + tokens?.user_id);
    const d = r.data?.[0];
    if (!d) return null;
    return { nextAt: d.next_ad_at ? d.next_ad_at * 1000 : null, lastAt: d.last_ad_at ? d.last_ad_at * 1000 : null, duration: d.duration, prerollFree: d.preroll_free_time, snoozes: d.snooze_count, snoozeRefreshAt: d.snooze_refresh_at ? d.snooze_refresh_at * 1000 : null };
  }
  async function snoozeAd() {
    const r = await helix('/channels/ads/schedule/snooze?broadcaster_id=' + tokens?.user_id, { method: 'POST' });
    const d = r.data?.[0] ?? {};
    return { snoozes: d.snooze_count, nextAt: d.next_ad_at ? d.next_ad_at * 1000 : null };
  }

  /* ---------- recompensas de pontos do canal e clipes ---------- */
  async function listRewards() {
    const r = await helix('/channel_points/custom_rewards?broadcaster_id=' + tokens?.user_id);
    return (r.data ?? []).map((x) => ({ id: x.id, title: x.title, cost: x.cost, enabled: x.is_enabled }));
  }
  // recompensas criadas pelo app já nascem "sem fila": o resgate conclui sozinho e o app não precisa limpar nada
  async function createReward({ title, cost, prompt, inputRequired }) {
    const t = String(title ?? '').trim().slice(0, 45);
    if (!t) throw new Error('Dê um nome à recompensa');
    const c = Math.max(1, Math.round(Number(cost) || 0));
    const r = await helix('/channel_points/custom_rewards?broadcaster_id=' + tokens?.user_id, {
      method: 'POST',
      body: { title: t, cost: c, prompt: String(prompt ?? '').slice(0, 200), is_user_input_required: !!inputRequired, should_redemptions_skip_request_queue: true }
    });
    const d = r.data?.[0] ?? {};
    return { id: d.id, title: d.title ?? t, cost: d.cost ?? c };
  }
  async function createClip() {
    const r = await helix('/clips?broadcaster_id=' + tokens?.user_id, { method: 'POST' });
    const d = r.data?.[0];
    if (!d) throw new Error('A Twitch não criou o clipe (a live precisa estar no ar)');
    return { id: d.id, editUrl: d.edit_url, url: `https://clips.twitch.tv/${d.id}` };
  }

  // visão geral do canal: espectadores, seguidores, subs, título, categoria e próximo anúncio
  async function overview() {
    if (!tokens) throw new Error('Twitch não conectada');
    const uid = tokens.user_id;
    const safe = (p) => p.catch(() => null);
    const [stream, chan, fol, subs, ads] = await Promise.all([
      safe(helix('/streams?user_id=' + uid)),
      safe(helix('/channels?broadcaster_id=' + uid)),
      safe(helix(`/channels/followers?broadcaster_id=${uid}&first=1`)),
      safe(helix(`/subscriptions?broadcaster_id=${uid}&first=1`)),
      safe(adSchedule())
    ]);
    const s = stream?.data?.[0];
    const c = chan?.data?.[0];
    return {
      live: !!s, viewers: s?.viewer_count ?? 0, startedAt: s ? Date.parse(s.started_at) : null,
      title: s?.title ?? c?.title ?? '', game: s?.game_name ?? c?.game_name ?? '',
      followers: fol?.total ?? null, subs: subs?.total != null ? Math.max(0, subs.total - 1) : null,
      ads, at: Date.now()
    };
  }

  /* ---------- EventSub: follow, sub, raid, bits ---------- */
  async function subscribeAll(sessionId) {
    const uid = tokens.user_id;
    const list = [
      ['channel.follow', '2', { broadcaster_user_id: uid, moderator_user_id: uid }],
      ['channel.subscribe', '1', { broadcaster_user_id: uid }],
      ['channel.subscription.message', '1', { broadcaster_user_id: uid }],
      ['channel.subscription.gift', '1', { broadcaster_user_id: uid }],
      ['channel.raid', '1', { to_broadcaster_user_id: uid }],
      ['channel.cheer', '1', { broadcaster_user_id: uid }],
      ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: uid }]
    ];
    const errors = [];
    for (const [type, version, condition] of list) {
      try { await helix('/eventsub/subscriptions', { method: 'POST', body: { type, version, condition, transport: { method: 'websocket', session_id: sessionId } } }); }
      catch (e) { errors.push(`${type}: ${e.message}`); }
    }
    esInfo = { connected: true, errors }; emitStatus();
  }

  function handleEvent(type, e) {
    switch (type) {
      case 'channel.follow': return onEvent({ kind: 'follow', user: e.user_name });
      case 'channel.subscribe': return onEvent({ kind: 'sub', user: e.user_name });
      case 'channel.subscription.message': return onEvent({ kind: 'resub', user: e.user_name, amount: e.cumulative_months, text: e.message?.text });
      case 'channel.subscription.gift': return onEvent({ kind: 'gift', user: e.is_anonymous ? 'Anônimo' : e.user_name, amount: e.total });
      case 'channel.raid': return onEvent({ kind: 'raid', user: e.from_broadcaster_user_name, amount: e.viewers });
      case 'channel.cheer': return onEvent({ kind: 'bits', user: e.is_anonymous ? 'Anônimo' : e.user_name, amount: e.bits, text: e.message });
      case 'channel.channel_points_custom_reward_redemption.add':
        return onEvent({ kind: 'redeem', user: e.user_name, title: e.reward?.title, amount: e.reward?.cost, input: e.user_input, id: e.id, rewardId: e.reward?.id });
    }
  }

  function startEventSub(url = 'wss://eventsub.wss.twitch.tv/ws') {
    if (!tokens) return;
    const gen = ++esGen;
    try { es?.close(); } catch { /* ok */ }
    es = new WebSocket(url);
    es.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const t = m.metadata?.message_type;
      if (t === 'session_welcome' && url.includes('eventsub.wss.twitch.tv/ws') && !url.includes('?')) await subscribeAll(m.payload.session.id);
      else if (t === 'session_reconnect') startEventSub(m.payload.session.reconnect_url);
      else if (t === 'notification') handleEvent(m.metadata.subscription_type, m.payload.event);
    });
    es.on('close', () => { if (gen !== esGen) return; esInfo = { connected: false, errors: esInfo.errors }; emitStatus(); if (tokens) setTimeout(() => gen === esGen && startEventSub(), 5000); });
    es.on('error', () => {});
  }

  /* ---------- leitura do chat (anônima, sem login) ---------- */
  const parseTags = (raw) => {
    const tags = {};
    for (const kv of raw.slice(1).split(';')) { const i = kv.indexOf('='); tags[kv.slice(0, i)] = kv.slice(i + 1); }
    return tags;
  };
  function startChat() {
    const gen = ++ircGen;
    try { irc?.close(); } catch { /* ok */ }
    const channel = (config.twitch?.channel ?? '').toLowerCase().replace(/^#/, '');
    if (!channel || channel === 'seucanal') { console.log('[Twitch] defina o canal em Twitch > Canal para ler o chat'); return; }
    irc = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    irc.on('open', () => {
      irc.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      irc.send('PASS SCHMOOPIIE');
      irc.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`);
      irc.send(`JOIN #${channel}`);
      console.log(`[Twitch] lendo o chat de #${channel}`);
    });
    irc.on('message', (buf) => {
      for (const line of buf.toString().split('\r\n').filter(Boolean)) {
        if (line.startsWith('PING')) { irc.send('PONG :tmi.twitch.tv'); continue; }
        const m = line.match(/^(@\S+) :(\w+)!\S+ (PRIVMSG|USERNOTICE) #\S+(?: :(.*))?$/);
        if (!m) continue;
        const tags = parseTags(m[1]);
        if (m[3] === 'PRIVMSG') {
          onChat({ user: tags['display-name'] || m[2], login: m[2], color: tags.color || '#a78bfa', text: m[4] ?? '', badges: tags.badges || '', firstMsg: tags['first-msg'] === '1' });
        } else if (auth.status !== 'connected') {
          // sem login, aproveita os avisos do chat para sub e raid
          const map = { sub: 'sub', resub: 'resub', subgift: 'gift', raid: 'raid' };
          const kind = map[tags['msg-id']];
          if (kind) onEvent({ kind, user: tags['display-name'] || m[2], amount: Number(tags['msg-param-viewerCount'] || tags['msg-param-cumulative-months'] || 0) || undefined });
        }
      }
    });
    irc.on('close', () => { if (gen === ircGen) setTimeout(() => gen === ircGen && startChat(), 5000); });
    irc.on('error', () => {});
  }

  function resume() { if (tokens) startEventSub(); }

  return { status, startAuth, logout, setChannelInfo, sendChat, announce, runAd, adSchedule, snoozeAd, overview, listRewards, createReward, createClip, startChat, resume, isAuthed: () => auth.status === 'connected' };
}
