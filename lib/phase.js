// Fase da partida: "lobby" (moldura completa) ou "game" (tela cheia com só webcam e QR).
// Detecção automática:
//  - CS2: integração oficial da Valve (Game State Integration). O jogo envia dados para o app.
//  - LoL: API local do próprio jogo (https://127.0.0.1:2999), que só responde durante a partida.
//  - Qualquer programa: considera "em partida" enquanto o programa (.exe) estiver aberto.
//  - Manual: só pelos botões do painel.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { gameSceneOf, detectOf } from './layout.js';

export function lolInGame() {
  return new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port: 2999, path: '/liveclientdata/gamestats', rejectUnauthorized: false, timeout: 1500 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

export function processRunning(name) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !/^[\w .\-()]+$/.test(name || '')) return resolve(false);
    execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 4000 },
      (err, out) => resolve(!err && String(out).toLowerCase().includes(name.toLowerCase())));
  });
}

/* ---------- integração do CS2 ---------- */
export function gsiConfigText(port, token) {
  return [
    '"Live Control"', '{',
    `  "uri" "http://127.0.0.1:${port}/gsi/cs2"`,
    '  "timeout" "5.0"', '  "buffer" "0.1"', '  "throttle" "0.5"', '  "heartbeat" "10.0"',
    '  "auth"', '  {', `    "token" "${token}"`, '  }',
    '  "data"', '  {', '    "provider" "1"', '    "map" "1"', '    "round" "1"', '    "player_id" "1"', '    "player_state" "1"', '  }',
    '}', ''
  ].join('\n');
}

// procura a pasta cfg do CS2 nas bibliotecas do Steam
export function findCs2CfgDir() {
  const rel = 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg';
  const roots = new Set(['C:/Program Files (x86)/Steam', 'C:/Program Files/Steam']);
  for (const l of 'CDEFG') for (const n of ['Steam', 'SteamLibrary', 'Games/Steam', 'Games/SteamLibrary']) roots.add(`${l}:/${n}`);
  const libs = new Set();
  for (const r of roots) {
    const vdf = path.join(r, 'steamapps/libraryfolders.vdf');
    if (fs.existsSync(vdf)) {
      libs.add(r);
      try { for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '/')); } catch { /* ok */ }
    } else if (fs.existsSync(path.join(r, 'steamapps'))) libs.add(r);
  }
  for (const l of libs) { const d = path.join(l, rel); if (fs.existsSync(d)) return d; }
  return null;
}

/* ---------- controlador ---------- */
export function createPhase({ getProfile, getScene, setScene, onChange }) {
  let mode = 'auto';      // 'auto' | 'lobby' | 'game'
  let detected = false;   // o detector diz que há partida
  let lastRaw = false, streak = 0;
  let current = 'lobby';
  const gsi = { at: 0, inGame: false };
  let lastJson = '';

  const status = () => {
    const p = getProfile();
    return { mode, current, detected, source: p ? detectOf(p) : 'manual', gsiActive: Date.now() - gsi.at < 30000, profile: p?.id ?? null };
  };
  const want = () => (mode === 'auto' ? (detected ? 'game' : 'lobby') : mode);
  const emit = (changed) => {
    const j = JSON.stringify(status());
    if (j !== lastJson || changed) { lastJson = j; onChange?.(status(), !!changed); }
  };

  async function switchScene(force) {
    const p = getProfile();
    if (!p?.scene) return;
    const lobby = p.scene, game = gameSceneOf(p), cur = getScene();
    // só troca se você está numa das cenas deste jogo (não atrapalha a pausa, por exemplo), a menos que tenha forçado
    if (!force && cur !== lobby && cur !== game) return;
    try { await setScene(current === 'game' ? game : lobby); } catch { /* OBS fora do ar */ }
  }
  async function sync(force) {
    const next = want();
    const changed = next !== current;
    current = next;
    emit(changed);
    if (changed || force) await switchScene(force);
  }

  async function poll(fast = false) {
    const p = getProfile();
    if (!p) return;
    const t = detectOf(p);
    let raw = false;
    if (t === 'cs2') raw = Date.now() - gsi.at < 25000 && gsi.inGame;
    else if (t === 'lol') raw = await lolInGame();
    else if (t === 'process') raw = await processRunning(p.detect?.process);
    if (raw === lastRaw) streak++; else { lastRaw = raw; streak = 1; }
    // exige 2 leituras iguais seguidas (~6 s) para não piscar por uma falha pontual
    if (raw !== detected && (streak >= 2 || fast)) { detected = raw; await sync(false); }
    else emit(false);
  }
  setInterval(() => poll(false).catch(() => {}), 3000);

  return {
    status,
    current: () => current,
    async setMode(m) { mode = ['auto', 'lobby', 'game'].includes(m) ? m : 'auto'; await sync(mode !== 'auto'); },
    // chamado ao trocar de perfil
    async reset() { detected = false; lastRaw = false; streak = 0; current = want(); emit(false); await poll(true).catch(() => {}); },
    // dados enviados pelo CS2
    gsi(body) { gsi.at = Date.now(); gsi.inGame = !!(body && body.map && body.map.name); poll(false).catch(() => {}); }
  };
}
