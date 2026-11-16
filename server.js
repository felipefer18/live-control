import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { createTriggers } from './lib/triggers.js';
import { createScore } from './lib/score.js';
import { createMatches } from './lib/matches.js';
import { listMixer, setVolume, setMute, dbFromMag } from './lib/mixer.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, config, saveConfig, state, saveState, resetSession, readJson, writeJson } from './lib/store.js';
import { createTwitch } from './lib/twitch.js';
import { createLivepix } from './lib/livepix.js';
import { createChatbot } from './lib/chatbot.js';
import { cutClip, clipMeta, ffmpegAvailable, CLIPS_DIR, fmtTc } from './lib/clips.js';
import { computeLayout, brandOf, gameSceneOf } from './lib/layout.js';
import { createPhase, gsiConfigText, findCs2CfgDir } from './lib/phase.js';
import crypto from 'node:crypto';
import { buildScenes } from './lib/scenes.js';
import QRCode from 'qrcode';

const MARKERS_PATH = path.join(DATA, 'markers.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/overlays', express.static(path.join(ROOT, 'overlays')));
app.use('/vendor/phosphor', express.static(path.join(ROOT, 'node_modules', '@phosphor-icons', 'web', 'src'))); // ícones do painel (offline)
app.use('/sounds', express.static(path.join(ROOT, 'sounds')));
app.use('/clips', express.static(CLIPS_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
};

/* ================= OBS ================= */
const obs = new OBSWebSocket();
let obsConnected = false, obsTimer = null, pollTimer = null, lastHealth = null;
let prevSkipped = 0, prevTotal = 0;
let recSession = null; // identifica a gravação em andamento

async function connectObs() {
  const { host, port, password } = config.obs ?? {};
  try {
    await obs.connect(`ws://${host}:${port}`, password || undefined, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters, rpcVersion: 1 });
    obsConnected = true;
    console.log('[OBS] conectado');
    broadcast({ type: 'obs', connected: true });
    startPolling();
  } catch { obsConnected = false; scheduleReconnect(); }
}
function scheduleReconnect() { clearInterval(pollTimer); clearTimeout(obsTimer); obsTimer = setTimeout(connectObs, 4000); }
obs.on('ConnectionClosed', () => {
  if (!obsConnected) return;
  obsConnected = false;
  console.log('[OBS] desconectado, tentando de novo...');
  broadcast({ type: 'obs', connected: false });
  scheduleReconnect();
});
let currentScene = null;
obs.on('CurrentProgramSceneChanged', (e) => { currentScene = e.sceneName; broadcast({ type: 'scene', scene: e.sceneName }); });
obs.on('InputMuteStateChanged', (e) => broadcast({ type: 'mute', input: e.inputName, muted: e.inputMuted }));
obs.on('InputVolumeChanged', (e) => broadcast({ type: 'mixer', name: e.inputName, db: Math.round(e.inputVolumeDb * 10) / 10 }));
let lastMeters = 0;
obs.on('InputVolumeMeters', (e) => { // medidores: no máximo ~8 por segundo e só se há painel aberto
  const now = Date.now();
  if (now - lastMeters < 120 || !wss.clients.size) return;
  lastMeters = now;
  const levels = {};
  for (const i of e.inputs ?? []) { let peak = 0; for (const ch of i.inputLevelsMul ?? []) peak = Math.max(peak, ch[1] ?? 0); levels[i.inputName] = Math.round(dbFromMag(peak)); }
  broadcast({ type: 'meters', levels });
});
obs.on('RecordStateChanged', (e) => {
  if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') recSession = Date.now();
  if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED' && e.outputPath) {
    const list = markers();
    let n = 0;
    for (const m of list) if (m.recSession && m.recSession === recSession && !m.recordPath) { m.recordPath = e.outputPath; n++; }
    if (n) { writeJson(MARKERS_PATH, list); broadcast({ type: 'markers' }); }
    recSession = null;
  }
});

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!obsConnected) return;
    try {
      const [stats, stream, record, scene] = await Promise.all([
        obs.call('GetStats'), obs.call('GetStreamStatus'), obs.call('GetRecordStatus'), obs.call('GetCurrentProgramScene')
      ]);
      if (record.outputActive && !recSession) recSession = Date.now();
      const dSkipped = stats.outputSkippedFrames - prevSkipped;
      const dTotal = stats.outputTotalFrames - prevTotal;
      prevSkipped = stats.outputSkippedFrames; prevTotal = stats.outputTotalFrames;
      lastHealth = {
        cpu: +stats.cpuUsage.toFixed(1), fps: +stats.activeFps.toFixed(1),
        renderMs: +stats.averageFrameRenderTime.toFixed(1),
        dropRecentPct: dTotal > 0 ? +((dSkipped / dTotal) * 100).toFixed(2) : 0,
        streaming: stream.outputActive, reconnecting: stream.outputReconnecting,
        timecode: stream.outputTimecode, congestion: +(stream.outputCongestion ?? 0).toFixed(2),
        dropped: stream.outputSkippedFrames,
        recording: record.outputActive, recTimecode: record.outputActive ? record.outputTimecode : null,
        scene: scene.currentProgramSceneName
      };
      broadcast({ type: 'health', health: lastHealth });
    } catch { /* falha pontual */ }
  }, 2000);
}
const requireObs = () => { if (!obsConnected) throw new Error('OBS não está conectado'); };

/* ================= Metas, sessão e doações ================= */
const sessionMsg = () => ({ type: 'session', session: state.session, goals: state.goals });
function bumpGoals(type, amount) {
  let changed = false;
  for (const g of state.goals) if (g.type === type) { g.current = +(g.current + amount).toFixed(2); changed = true; }
  return changed;
}

function handleDonation({ name = 'Anônimo', amount = 0, message = '', source = 'manual', test = false }) {
  amount = Number(amount) || 0;
  const rule = [...(config.donationRules ?? [])].sort((a, b) => b.min - a.min).find((r) => amount >= r.min) ?? { effect: 'small', sound: '' };
  if (!test) {
    state.session.donationTotal = +(state.session.donationTotal + amount).toFixed(2);
    state.session.donationCount++;
    bumpGoals('donation', amount);
    pushFeed({ kind: 'donation', text: `${name} doou R$${amount.toFixed(2).replace('.', ',')}${message ? ' — ' + message : ''}` });
    saveState();
    broadcast(sessionMsg());
    triggers.fire('donation', { user: name, amount, input: message });
    const ac = config.autoClips ?? {};
    if (ac.enabled !== false && Number(ac.donationMin) > 0 && amount >= Number(ac.donationMin)) createMarker(`Doação de R$${amount.toFixed(2).replace('.', ',')} (${name})`, { auto: true, reason: 'doacao' });
    if (source === 'livepix' && config.livepix?.thanksInChat !== false) {
      bot.send(`Obrigado, ${name}, pela doação de R$${amount.toFixed(2).replace('.', ',')}! 💜`);
    }
  }
  const event = { type: 'donation', name, amount, message, effect: rule.effect, sound: rule.sound, test };
  broadcast(event);
  return event;
}

const EVENT_TEXT = {
  follow: (e) => `${e.user} seguiu o canal!`,
  sub: (e) => `${e.user} se inscreveu!`,
  resub: (e) => `${e.user} renovou a inscrição${e.amount ? ` (${e.amount} meses)` : ''}!`,
  gift: (e) => `${e.user} presenteou ${e.amount ?? ''} sub(s)!`,
  raid: (e) => `${e.user} chegou em raid com ${e.amount ?? '?'} viewers!`,
  bits: (e) => `${e.user} mandou ${e.amount} bits!`,
  redeem: (e) => `${e.user} resgatou "${e.title}"`
};
function handleTwitchEvent(e, test = false) {
  const text = (EVENT_TEXT[e.kind] ?? (() => e.kind))(e);
  if (!test) {
    const s = state.session;
    if (e.kind === 'follow') { s.follows++; bumpGoals('follow', 1); }
    if (e.kind === 'sub' || e.kind === 'resub') { s.subs++; bumpGoals('sub', 1); }
    if (e.kind === 'gift') { s.subs += e.amount || 1; bumpGoals('sub', e.amount || 1); }
    if (e.kind === 'raid') s.raids++;
    if (e.kind === 'bits') s.bits += e.amount || 0;
    pushFeed({ kind: e.kind, text });
    saveState(); broadcast(sessionMsg());
    triggers.fire(e.kind, { user: e.user, amount: e.amount, title: e.title, input: e.input });
    if (e.kind === 'raid' && config.autoClips?.enabled !== false && config.autoClips?.raid !== false) createMarker(`Raid de ${e.user} (${e.amount ?? '?'} viewers)`, { auto: true, reason: 'raid' });
  }
  if (e.kind !== 'redeem') broadcast({ type: 'twitchEvent', kind: e.kind, user: e.user, amount: e.amount, text, extra: e.text, test });
}

/* ================= Twitch, LivePix e bot ================= */
/* feed de eventos e estatísticas do chat (ficam só na memória) */
const feed = [];
const chatStats = { users: new Map(), times: [] };
function pushFeed(item) {
  const it = { t: Date.now(), ...item };
  feed.unshift(it); if (feed.length > 60) feed.pop();
  broadcast({ type: 'feed', item: it });
}
function chatNote(user) {
  chatStats.users.set(user, (chatStats.users.get(user) ?? 0) + 1);
  const now = Date.now(); chatStats.times.push(now);
  while (chatStats.times.length && now - chatStats.times[0] > 300000) chatStats.times.shift();
}
const chatSummary = () => ({
  perMin: chatStats.times.filter((t) => Date.now() - t < 60000).length,
  total: [...chatStats.users.values()].reduce((a, b) => a + b, 0),
  top: [...chatStats.users].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([user, n]) => ({ user, n }))
});
let lastOverview = null;
async function refreshOverview() {
  if (!twitch.isAuthed()) return;
  try { lastOverview = await twitch.overview(); broadcast({ type: 'overview', overview: lastOverview }); } catch { /* sem dados agora */ }
}
setInterval(refreshOverview, 30000);

const twitch = createTwitch({
  config, publish: broadcast,
  onChat: (m) => {
    chatNote(m.user); broadcast({ type: 'chat', ...m }); bot.onChat(m);
    const w = (m.text || '').trim().split(/\s+/);
    if (w[0]?.startsWith('!')) triggers.fire('command', { user: m.user, command: w[0], input: w.slice(1).join(' '), badges: m.badges });
  },
  onEvent: (e) => handleTwitchEvent(e),
  onLogin: (login) => {
    // se o canal ainda é o padrão, usa o da conta que acabou de conectar
    if (!config.twitch?.channel || config.twitch.channel === 'seucanal') { config.twitch = { ...config.twitch, channel: login }; saveConfig(); twitch.startChat(); broadcast({ type: 'config' }); }
    refreshOverview();
  }
});

async function adRun(length) {
  const r = await twitch.runAd(length);
  pushFeed({ kind: 'ad', text: `Anúncio de ${r.length}s iniciado` });
  if (config.ads?.warnChat !== false) bot.send(`Anúncio de ${r.length}s começando. Já já a gente volta! 💜`);
  setTimeout(refreshOverview, 3000);
  return { ad: r };
}
const bot = createChatbot({
  config, publish: broadcast,
  say: (t) => twitch.sendChat(t),
  isLive: () => !!lastHealth?.streaming
});
const livepix = createLivepix({ config, publish: broadcast, onDonation: (d) => handleDonation(d) });

/* ================= Fase da partida: lobby ou partida ================= */
if (!config.integrations?.cs2Token) { config.integrations = { ...config.integrations, cs2Token: crypto.randomBytes(12).toString('hex') }; saveConfig(); }
const phase = createPhase({
  getProfile: () => (config.profiles ?? []).find((p) => p.id === state.activeProfile),
  getScene: () => currentScene ?? lastHealth?.scene ?? null,
  setScene: async (name) => { if (obsConnected) await obs.call('SetCurrentProgramScene', { sceneName: name }); },
  onChange: (st, changed) => {
    broadcast({ type: 'phase', phase: st });
    if (changed) pushFeed({ kind: 'phase', text: st.current === 'game' ? 'Partida em andamento: tela cheia com webcam e QR' : 'Lobby: moldura completa' });
  }
});

/* ================= Marcadores e cortes ================= */
const markers = () => readJson(MARKERS_PATH, []);
const saveMarkers = (l) => writeJson(MARKERS_PATH, l);
function createMarker(label = '', opts = {}) {
  const list = markers();
  const m = {
    id: Date.now() + Math.floor(Math.random() * 1000), at: new Date().toISOString(), label: String(label).slice(0, 80),
    profile: state.activeProfile, scene: lastHealth?.scene ?? null,
    timecode: lastHealth?.timecode ?? null, recTimecode: lastHealth?.recTimecode ?? null,
    recSession: lastHealth?.recording ? recSession : null, recordPath: null, replayPath: null, clips: [],
    auto: !!opts.auto, reason: opts.reason ?? null
  };
  list.push(m); saveMarkers(list);
  broadcast({ type: 'markers' });
  if (opts.auto) pushFeed({ kind: 'clip', text: `Clipe marcado: ${m.label}` });
  captureReplay(m).catch(() => {});
  if (opts.auto && config.autoClips?.twitchClip) autoTwitchClip(m).catch(() => {});
  return m;
}
async function captureReplay(m) {
  if (!obsConnected) return;
  try {
    await obs.call('SaveReplayBuffer');
    setTimeout(async () => {
      try {
        const r = await obs.call('GetLastReplayBufferReplay');
        const l2 = markers(); const mm = l2.find((x) => x.id === m.id);
        if (mm) { mm.replayPath = r.savedReplayPath; saveMarkers(l2); broadcast({ type: 'markers' }); }
      } catch { /* sem buffer de replay */ }
    }, 1500);
  } catch { /* buffer de replay desligado */ }
}
async function addMarker(label = '', opts = {}) { return createMarker(label, opts); }
function renameMarker(id, label) {
  const l = markers(); const m = l.find((x) => x.id === id);
  if (m) { m.label = String(label).slice(0, 80); saveMarkers(l); broadcast({ type: 'markers' }); }
}
async function autoTwitchClip(m) { // clipe oficial na Twitch (só com a opção ligada e live no ar)
  const c = await twitch.createClip();
  const l = markers(); const mm = l.find((x) => x.id === m.id);
  if (mm) { mm.twitchClip = c; saveMarkers(l); broadcast({ type: 'markers' }); }
}

/* ================= Placar, ações do chat e eventos dos jogos ================= */
const score = createScore({ state, saveState, onChange: (st) => broadcast({ type: 'score', score: st }) });
function addResult(result, game, source = 'manual') {
  if (source !== 'manual' && state.score.auto === false) return null;
  const e = score.add(result, game, source);
  pushFeed({ kind: result, text: result === 'win' ? 'Vitória registrada' : 'Derrota registrada' });
  triggers.fire(result, { game: (config.profiles ?? []).find((p) => p.id === game)?.label ?? game });
  return e;
}
async function runTriggerAction(a, ctx) {
  switch (a.type) {
    case 'sound': broadcast({ type: 'sound', file: a.file, volume: Number(a.volume ?? config.soundVolume ?? 80) }); break;
    case 'effect': broadcast({ type: 'effect', effect: 'text', text: a.text, sound: '' }); break;
    case 'alert': broadcast({ type: 'twitchEvent', kind: 'custom', user: ctx.user, text: a.text }); break;
    case 'scene': {
      requireObs();
      const prev = currentScene;
      await obs.call('SetCurrentProgramScene', { sceneName: a.scene });
      const secs = Number(a.seconds) || 0;
      if (secs > 0 && prev && prev !== a.scene) setTimeout(async () => { if (currentScene === a.scene) { try { await obs.call('SetCurrentProgramScene', { sceneName: prev }); } catch { /* ok */ } } }, secs * 1000);
      break;
    }
    case 'say': if (!ctx.test) await twitch.sendChat(a.text); break;           // no teste não escreve no chat de verdade
    case 'announce': if (!ctx.test) await twitch.announce(a.text, a.color || 'primary'); break;
    case 'marker': createMarker(a.text || a.label || 'Momento (ação do chat)', { auto: true, reason: 'acao' }); break;
    default: throw new Error('tipo de ação desconhecido: ' + a.type);
  }
}
const triggers = createTriggers({
  config, run: runTriggerAction,
  onFire: (t, ctx, r) => {
    if (r.error) pushFeed({ kind: 'trigger', text: `Ação "${t.label}" falhou: ${r.error}` });
    else if (!ctx.test) pushFeed({ kind: 'trigger', text: `Ação disparada: ${t.label}${ctx.user ? ' (' + ctx.user + ')' : ''}` });
  }
});
const matches = createMatches({
  config, getProfile: () => (config.profiles ?? []).find((p) => p.id === state.activeProfile),
  mark: (label, o) => createMarker(label, o), rename: (id, label) => renameMarker(id, label), result: (r, g, src) => addResult(r, g, src)
});
let lastSpike = 0;
setInterval(() => { // chat bombando: marca o momento
  const ac = config.autoClips ?? {};
  if (ac.enabled === false || !(Number(ac.chatPerMin) > 0) || !lastHealth?.streaming) return;
  if (chatSummary().perMin >= Number(ac.chatPerMin) && Date.now() - lastSpike > 120000) { lastSpike = Date.now(); createMarker(`Chat bombando (${chatSummary().perMin} msgs/min)`, { auto: true, reason: 'chat' }); }
}, 10000);

/* ================= Perfis de jogo ================= */
async function applyProfile(id) {
  const p = (config.profiles ?? []).find((x) => x.id === id);
  if (!p) throw new Error('Perfil não encontrado');
  const steps = [];
  const step = async (name, fn) => {
    try { steps.push({ name, ok: true, detail: (await fn()) || '' }); }
    catch (e) { steps.push({ name, ok: false, detail: e.message }); }
  };
  const forcedGame = phase.status().mode === 'game';
  if (p.scene) await step('Cena', async () => { requireObs(); const sc = forcedGame ? gameSceneOf(p) : p.scene; await obs.call('SetCurrentProgramScene', { sceneName: sc }); return forcedGame ? 'partida' : 'lobby'; });
  for (const [input, db] of Object.entries(p.volumes ?? {})) {
    await step(`Volume ${input}`, async () => { requireObs(); await obs.call('SetInputVolume', { inputName: input, inputVolumeDb: Number(db) }); return `${db} dB`; });
  }
  for (const s of p.sources ?? []) {
    await step(`Fonte ${s.source}`, async () => {
      requireObs();
      const sceneName = s.scene || p.scene;
      const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName: s.source });
      await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !!s.enabled });
      return s.enabled ? 'ligada' : 'desligada';
    });
  }
  if (p.accent) { state.theme = { accent: p.accent, accent2: p.accent2 || p.accent }; broadcast({ type: 'theme', theme: state.theme }); }
  if (p.twitchTitle || p.twitchCategory) await step('Twitch', () => twitch.setChannelInfo({ title: p.twitchTitle, category: p.twitchCategory }));
  state.activeProfile = id; saveState();
  await phase.reset(); // vê se já há partida em andamento neste jogo
  { const st = phase.status(); steps.push({ name: 'Fase da partida', ok: true, detail: `${st.current === 'game' ? 'em partida' : 'lobby'} · ${st.mode === 'auto' ? (st.source === 'manual' ? 'detecção só manual' : 'detecção automática') : 'forçado por você'}` }); }
  broadcast({ type: 'profile', id });
  return { steps };
}

async function toggleBrb() {
  requireObs();
  const b = state.brb;
  const mic = config.audio?.mic;
  if (!b.active) {
    b.prevScene = lastHealth?.scene ?? null;
    b.active = true;
    if (config.brb?.muteMic !== false && mic) await obs.call('SetInputMute', { inputName: mic, inputMuted: true });
    if (config.brb?.scene) await obs.call('SetCurrentProgramScene', { sceneName: config.brb.scene });
    if (config.brb?.sound) broadcast({ type: 'sound', file: config.brb.sound });
  } else {
    b.active = false;
    if (config.brb?.muteMic !== false && mic) await obs.call('SetInputMute', { inputName: mic, inputMuted: false });
    if (b.prevScene) await obs.call('SetCurrentProgramScene', { sceneName: b.prevScene });
  }
  saveState();
  broadcast({ type: 'brb', active: b.active });
  return { active: b.active };
}

/* ================= Ações ================= */
async function runAction(a) {
  switch (a.type) {
    case 'scene': requireObs(); await obs.call('SetCurrentProgramScene', { sceneName: a.scene }); return {};
    case 'toggleMute': requireObs(); await obs.call('ToggleInputMute', { inputName: a.input }); return {};
    case 'toggleStream': requireObs(); await obs.call('ToggleStream'); return {};
    case 'toggleRecord': requireObs(); await obs.call('ToggleRecord'); return {};
    case 'replay': requireObs(); await obs.call('SaveReplayBuffer'); return {};
    case 'marker': return { marker: await addMarker(a.label) };
    case 'sound': broadcast({ type: 'sound', file: a.file, volume: Number(a.volume ?? config.soundVolume ?? 80) }); return {};
    case 'stopSounds': broadcast({ type: 'stopSounds' }); return {};
    case 'effect': broadcast({ type: 'effect', effect: a.effect ?? 'text', text: a.text ?? '', sound: a.sound ?? '' }); return {};
    case 'profile': return applyProfile(a.id);
    case 'brb': return toggleBrb();
    case 'alertControl': broadcast({ type: 'alertControl', action: a.action }); return {};
    case 'phase': await phase.setMode(a.mode); return { phase: phase.status() };
    case 'qr': broadcast({ type: 'showQr' }); return {};
    case 'announce': {
      const key = String(a.id ?? '').toLowerCase();
      const an = (config.announcements ?? []).find((x) => x.id === a.id || String(x.label).toLowerCase() === key);
      if (!an) throw new Error('Anúncio não encontrado');
      await twitch.announce(an.text, an.color); pushFeed({ kind: 'announce', text: `Anúncio enviado: ${an.label}` }); return {};
    }
    case 'ad': return adRun(a.length);
    case 'say': await twitch.sendChat(a.text); return {};
    case 'score': {
      if (a.result === 'undo') score.undo();
      else if (a.result === 'reset') score.reset();
      else if (a.result === 'win' || a.result === 'loss') addResult(a.result, a.game || state.activeProfile || 'geral', 'manual');
      else throw new Error('Resultado inválido');
      return { score: score.status() };
    }
    case 'clipTwitch': { const c = await twitch.createClip(); pushFeed({ kind: 'clip', text: 'Clipe criado na Twitch' }); return { clip: c }; }
    default: throw new Error(`Ação desconhecida: ${a.type}`);
  }
}

/* ================= API ================= */
const wrap = (fn) => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
};
const publicConfig = () => ({
  buttons: config.buttons, profiles: config.profiles, donationRules: config.donationRules,
  commands: config.commands, timers: config.timers, audio: config.audio, brb: config.brb, clips: config.clips,
  announcements: config.announcements ?? [], ads: config.ads ?? {}, soundVolume: config.soundVolume ?? 80,
  triggers: config.triggers ?? [], autoClips: config.autoClips ?? {}, mixer: config.mixer ?? {},
  brand: { ...brandOf(config), name: config.brand?.name ?? '' }, camera: config.camera ?? {}, scenes: config.scenes ?? {},
  twitch: { channel: config.twitch?.channel ?? '', clientId: config.twitch?.clientId ?? '' },
  livepix: { clientId: config.livepix?.clientId ?? '', hasSecret: !!config.livepix?.clientSecret, pollSeconds: config.livepix?.pollSeconds ?? 6, thanksInChat: config.livepix?.thanksInChat !== false }
});

app.get('/api/state', wrap(async () => ({
  obsConnected, health: lastHealth, config: publicConfig(), phase: phase.status(),
  activeProfile: state.activeProfile, brb: state.brb.active, theme: state.theme,
  session: state.session, goals: state.goals, score: score.status(),
  twitch: twitch.status(), livepix: livepix.status(), ffmpeg: ffmpegAvailable(config)
})));
app.post('/api/action', wrap((req) => runAction(req.body)));
app.get('/api/scenes', wrap(async () => { requireObs(); const r = await obs.call('GetSceneList'); return { scenes: r.scenes.map((s) => s.sceneName).reverse() }; }));
app.get('/api/inputs', wrap(async () => { requireObs(); const r = await obs.call('GetInputList'); return { inputs: r.inputs.map((i) => i.inputName) }; }));
app.get('/api/sounds', wrap(async () => ({ sounds: fs.readdirSync(path.join(ROOT, 'sounds')).filter((f) => /\.(mp3|wav|ogg)$/i.test(f)).sort() })));
// biblioteca de sons: subir e apagar arquivos (só .mp3, .wav e .ogg, só dentro da pasta sounds)
const SOUNDS_DIR = path.join(ROOT, 'sounds');
const safeSound = (n) => { const b = path.basename(String(n ?? '')).replace(/[^\w.\- ()À-ÿ]/g, '_'); return /\.(mp3|wav|ogg)$/i.test(b) ? b : null; };
app.post('/api/sounds/upload', express.raw({ type: () => true, limit: '15mb' }), wrap(async (req) => {
  const name = safeSound(req.query.name);
  if (!name) throw new Error('Use um arquivo .mp3, .wav ou .ogg');
  if (!req.body?.length) throw new Error('Arquivo vazio');
  fs.writeFileSync(path.join(SOUNDS_DIR, name), req.body);
  return { file: name };
}));
app.delete('/api/sounds/:file', wrap(async (req) => {
  const name = safeSound(req.params.file);
  const p = name && path.join(SOUNDS_DIR, name);
  if (!p || !fs.existsSync(p)) throw new Error('Arquivo não encontrado');
  fs.rmSync(p);
  return {};
}));

// salvar configurações (só as chaves permitidas)
app.put('/api/settings', wrap(async (req) => {
  const b = req.body;
  for (const k of ['buttons', 'profiles', 'commands', 'timers', 'donationRules', 'announcements', 'triggers']) if (Array.isArray(b[k])) config[k] = b[k];
  for (const k of ['audio', 'brb', 'clips', 'camera', 'scenes', 'brand', 'ads', 'autoClips', 'mixer']) if (b[k] && typeof b[k] === 'object') config[k] = { ...config[k], ...b[k] };
  if (typeof b.soundVolume === 'number') config.soundVolume = Math.max(0, Math.min(100, Math.round(b.soundVolume)));
  if (b.twitch) config.twitch = { ...config.twitch, channel: b.twitch.channel ?? config.twitch?.channel, clientId: b.twitch.clientId ?? config.twitch?.clientId };
  if (b.livepix) {
    const lp = { ...config.livepix };
    for (const k of ['clientId', 'pollSeconds', 'thanksInChat']) if (b.livepix[k] !== undefined) lp[k] = b.livepix[k];
    if (b.livepix.clientSecret) lp.clientSecret = b.livepix.clientSecret;
    config.livepix = lp;
  }
  saveConfig(); bot.resetTimers();
  if (b.twitch?.channel !== undefined) twitch.startChat();
  if (b.livepix) livepix.start();
  broadcast({ type: 'config' });
  return {};
}));

app.post('/api/twitch/login', wrap(async () => ({ twitch: await twitch.startAuth() })));
app.post('/api/twitch/logout', wrap(async () => { twitch.logout(); return {}; }));
app.post('/api/twitch/channel', wrap(async (req) => ({ detail: await twitch.setChannelInfo({ title: req.body.title, category: req.body.category }) })));

// visual: layout de cada jogo, QR code da LivePix e montagem das cenas no OBS
app.get('/api/layout/:id', wrap(async (req) => ({ layout: computeLayout(config, req.params.id, req.query.phase === 'game' ? 'game' : 'lobby') })));
app.get('/api/phase', wrap(async () => ({ phase: phase.status() })));

// integração do CS2 (Game State Integration): o jogo avisa quando a partida começa e termina
app.post('/gsi/cs2', (req, res) => {
  if (req.body?.auth?.token === config.integrations?.cs2Token) { phase.gsi(req.body); matches.gsi(req.body); }
  res.sendStatus(200);
});
app.get('/api/cs2-gsi.cfg', (req, res) => {
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="gamestate_integration_livecontrol.cfg"' });
  res.send(gsiConfigText(PORT, config.integrations.cs2Token));
});
app.post('/api/cs2-gsi/install', wrap(async () => {
  const dir = findCs2CfgDir();
  if (!dir) throw new Error('Não achei a pasta do CS2. Baixe o arquivo e copie para a pasta game/csgo/cfg do CS2.');
  const file = path.join(dir, 'gamestate_integration_livecontrol.cfg');
  fs.writeFileSync(file, gsiConfigText(PORT, config.integrations.cs2Token));
  return { file };
}));
app.get('/api/qr.svg', async (req, res) => {
  const text = String(req.query.text || config.brand?.livepixUrl || '').trim();
  res.type('image/svg+xml');
  if (!text) return res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#fff"/><text x="50" y="54" font-size="9" text-anchor="middle" fill="#555" font-family="sans-serif">sem link</text></svg>');
  const url = /^https?:\/\//i.test(text) ? text : 'https://' + text;
  res.send(await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0c10', light: '#ffffff' } }));
});
app.get('/api/scenes/plan', wrap(async () => buildScenes({ obs, connected: obsConnected, config, port: PORT, dry: true })));
app.post('/api/scenes/build', wrap(async () => buildScenes({ obs, connected: obsConnected, config, port: PORT, dry: false })));

// anúncios no chat, intervalos comerciais e visão geral do canal
app.post('/api/twitch/announce', wrap(async (req) => { await twitch.announce(req.body.message, req.body.color); pushFeed({ kind: 'announce', text: 'Anúncio enviado no chat' }); return {}; }));
app.post('/api/twitch/ad', wrap((req) => adRun(req.body.length)));
app.get('/api/twitch/ads', wrap(async () => ({ ads: await twitch.adSchedule() })));
app.post('/api/twitch/ads/snooze', wrap(async () => { const r = await twitch.snoozeAd(); setTimeout(refreshOverview, 1500); return { snooze: r }; }));
app.get('/api/overview', wrap(async () => {
  if (twitch.isAuthed() && !lastOverview) await refreshOverview();
  return { twitch: lastOverview, connected: twitch.isAuthed(), feed, chat: chatSummary(), session: state.session, goals: state.goals, timecode: lastHealth?.timecode ?? null, streaming: !!lastHealth?.streaming };
}));

app.get('/api/goals', wrap(async () => ({ goals: state.goals })));
app.put('/api/goals', wrap(async (req) => { state.goals = req.body.goals; saveState(); broadcast(sessionMsg()); return {}; }));
app.post('/api/goals/:id/add', wrap(async (req) => {
  const g = state.goals.find((x) => x.id === req.params.id);
  if (!g) throw new Error('Meta não encontrada');
  g.current = +(g.current + Number(req.body.amount || 0)).toFixed(2); saveState(); broadcast(sessionMsg()); return {};
}));
app.post('/api/session/reset', wrap(async () => { resetSession(); for (const g of state.goals) g.current = 0; feed.length = 0; chatStats.users.clear(); chatStats.times.length = 0; score.reset(); saveState(); broadcast(sessionMsg()); return {}; }));

// doação manual, teste ou vinda de outro sistema (n8n etc.)
app.post('/api/donation', wrap(async (req) => ({ event: handleDonation(req.body) })));
app.post('/api/twitch/test-event', wrap(async (req) => { handleTwitchEvent({ kind: req.body.kind || 'follow', user: 'Teste', amount: req.body.amount }, true); return {}; }));

// marcadores e cortes
app.get('/api/markers', wrap(async () => ({ markers: markers(), ffmpeg: ffmpegAvailable(config), before: config.clips?.before ?? 25, after: config.clips?.after ?? 10 })));
app.delete('/api/markers', wrap(async () => { saveMarkers([]); broadcast({ type: 'markers' }); return {}; }));
app.put('/api/markers/:id', wrap(async (req) => {
  const l = markers(); const m = l.find((x) => String(x.id) === req.params.id);
  if (!m) throw new Error('Marcação não encontrada');
  if (req.body.label !== undefined) m.label = String(req.body.label).slice(0, 80);
  for (const k of ['before', 'after']) if (req.body[k] !== undefined) { const v = Number(req.body[k]); if (Number.isFinite(v) && v >= 0) m[k] = Math.min(300, v); else delete m[k]; }
  saveMarkers(l); return {};
}));
app.delete('/api/markers/:id', wrap(async (req) => {
  const l = markers().filter((x) => String(x.id) !== req.params.id);
  saveMarkers(l); broadcast({ type: 'markers' }); return {};
}));
app.get('/api/markers/:id/meta', wrap(async (req) => {
  const m = markers().find((x) => String(x.id) === req.params.id);
  if (!m) throw new Error('Marcação não encontrada');
  return { meta: clipMeta(config, m, config.profiles) };
}));
app.post('/api/clips/cut', wrap(async (req) => {
  const l = markers(); const m = l.find((x) => String(x.id) === String(req.body.id));
  if (!m) throw new Error('Marcação não encontrada');
  const before = Number(req.body.before ?? m.before ?? config.clips?.before ?? 25), after = Number(req.body.after ?? m.after ?? config.clips?.after ?? 10);
  const file = await cutClip(config, m, { before, after, vertical: !!req.body.vertical });
  m.clips = [...(m.clips ?? []).filter((c) => c.file !== file), { file, vertical: !!req.body.vertical }];
  saveMarkers(l); broadcast({ type: 'markers' });
  return { file };
}));
// fila de cortes em lote
let cutJob = { running: false, done: 0, total: 0, errors: [], current: null };
const cutMsg = () => ({ type: 'cutProgress', job: cutJob });
async function runCutQueue(jobs, before, after) {
  cutJob = { running: true, done: 0, total: jobs.length, errors: [], current: null };
  broadcast(cutMsg());
  for (const j of jobs) {
    cutJob.current = `${j.marker.label || fmtTc(j.marker.timecode)} (${j.vertical ? 'vertical' : '16:9'})`;
    broadcast(cutMsg());
    try {
      const b = Number(j.marker.before ?? before), a = Number(j.marker.after ?? after);
      const file = await cutClip(config, j.marker, { before: b, after: a, vertical: j.vertical });
      const l = markers(); const m = l.find((x) => x.id === j.marker.id);
      if (m) { m.clips = [...(m.clips ?? []).filter((c) => c.file !== file), { file, vertical: j.vertical }]; saveMarkers(l); }
    } catch (e) { cutJob.errors.push(`${j.marker.label || j.marker.id}: ${e.message}`); }
    cutJob.done++;
    broadcast({ type: 'markers' }); broadcast(cutMsg());
  }
  cutJob.running = false; cutJob.current = null;
  broadcast(cutMsg());
}
app.post('/api/clips/cut-all', wrap(async (req) => {
  if (cutJob.running) throw new Error('Já existe uma fila de cortes em andamento');
  if (!ffmpegAvailable(config)) throw new Error('ffmpeg não encontrado. Instale com: winget install Gyan.FFmpeg (e reinicie o app).');
  const formats = (req.body.formats?.length ? req.body.formats : ['wide']).map((f) => f === 'vertical');
  const onlyNew = req.body.onlyNew !== false;
  const hasSource = (m) => (m.recordPath && fs.existsSync(m.recordPath)) || (m.replayPath && fs.existsSync(m.replayPath));
  const jobs = []; let skipped = 0;
  for (const m of markers()) {
    if (!hasSource(m)) { skipped++; continue; }
    for (const vertical of formats) {
      if (onlyNew && (m.clips ?? []).some((c) => !!c.vertical === vertical)) continue;
      jobs.push({ marker: m, vertical });
    }
  }
  if (!jobs.length) return { queued: 0, skipped };
  runCutQueue(jobs, Number(req.body.before ?? config.clips?.before ?? 25), Number(req.body.after ?? config.clips?.after ?? 10)).catch(() => {});
  return { queued: jobs.length, skipped };
}));
app.get('/api/clips/job', wrap(async () => ({ job: cutJob })));
app.post('/api/clips/twitch', wrap(async (req) => {
  const c = await twitch.createClip();
  if (req.body?.id) { const l = markers(); const m = l.find((x) => String(x.id) === String(req.body.id)); if (m) { m.twitchClip = c; saveMarkers(l); broadcast({ type: 'markers' }); } }
  pushFeed({ kind: 'clip', text: 'Clipe criado na Twitch' });
  return { clip: c };
}));
app.post('/api/clips/open-folder', wrap(async () => {
  if (process.platform !== 'win32') throw new Error('Abrir a pasta só funciona no Windows. Os arquivos ficam em data/clips.');
  spawn('explorer.exe', [CLIPS_DIR], { detached: true, stdio: 'ignore' }).unref();
  return { folder: CLIPS_DIR };
}));

// placar
app.get('/api/score', wrap(async () => ({ score: score.status() })));
app.post('/api/score', wrap(async (req) => {
  if (req.body.auto !== undefined) score.setAuto(req.body.auto);
  else return runAction({ type: 'score', result: req.body.result, game: req.body.game });
  return { score: score.status() };
}));

// ações do chat
app.post('/api/triggers/:id/test', wrap(async (req) => { await triggers.test(req.params.id); return {}; }));
app.get('/api/twitch/rewards', wrap(async () => ({ rewards: await twitch.listRewards() })));
app.post('/api/twitch/rewards', wrap(async (req) => { const r = await twitch.createReward(req.body); pushFeed({ kind: 'trigger', text: `Recompensa criada na Twitch: ${r.title}` }); return { reward: r }; }));

// mixer de áudio
app.get('/api/mixer', wrap(async () => { requireObs(); return listMixer(obs, config.mixer ?? {}); }));
app.post('/api/mixer/volume', wrap(async (req) => { requireObs(); await setVolume(obs, req.body.name, req.body.db); return {}; }));
app.post('/api/mixer/mute', wrap(async (req) => { requireObs(); await setMute(obs, req.body.name, req.body.muted); return {}; }));
app.post('/api/mixer/save-profile', wrap(async (req) => {
  requireObs();
  const id = req.body.id || state.activeProfile;
  const p = (config.profiles ?? []).find((x) => x.id === id);
  if (!p) throw new Error('Escolha um jogo (clique em um perfil) antes de salvar os volumes nele');
  const mx = await listMixer(obs, {});
  const names = req.body.names?.length ? req.body.names : mx.inputs.map((i) => i.name);
  p.volumes = { ...(p.volumes ?? {}), ...Object.fromEntries(mx.inputs.filter((i) => names.includes(i.name)).map((i) => [i.name, i.db])) };
  saveConfig(); broadcast({ type: 'config' });
  return { profile: p.label, saved: Object.keys(p.volumes) };
}));

app.get('/api/markers/export', (req, res) => {
  const list = markers();
  const rows = list.map((m) => ({ tempo: fmtTc(m.timecode), nome: m.label || '', jogo: (config.profiles ?? []).find((p) => p.id === m.profile)?.label ?? '', cena: m.scene ?? '', hora: new Date(m.at).toLocaleTimeString('pt-BR') }));
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="marcacoes.csv"' });
    return res.send('﻿' + ['tempo,nome,jogo,cena,hora', ...rows.map((r) => Object.values(r).map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','))].join('\n'));
  }
  res.type('text/plain; charset=utf-8').send(rows.map((r) => `${r.tempo}  ${r.nome || '(sem nome)'}  [${r.jogo}]`).join('\n'));
});

/* ================= WebSocket (painel e overlays) ================= */
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'obs', connected: obsConnected }));
  ws.send(JSON.stringify({ type: 'theme', theme: state.theme }));
  ws.send(JSON.stringify({ type: 'phase', phase: phase.status() }));
  ws.send(JSON.stringify({ type: 'score', score: score.status() }));
  if (lastHealth) ws.send(JSON.stringify({ type: 'health', health: lastHealth }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'alertState') broadcast({ type: 'alertState', queued: m.queued, paused: m.paused });
  });
});

const PORT = config.port ?? 3000;
server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
  console.log('\n=== Live Control ===');
  console.log(`Painel (PC):      http://localhost:${PORT}`);
  if (lan) console.log(`Painel (celular): http://${lan}:${PORT}`);
  console.log(`Overlays no OBS:  /overlays/alerts.html  /overlays/chat.html  /overlays/goals.html\n`);
  connectObs();
  twitch.startChat();
  twitch.resume();
  refreshOverview();
  livepix.start();
});
