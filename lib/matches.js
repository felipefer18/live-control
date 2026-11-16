// Eventos dos jogos: marca clipes sozinho (multi-kills) e conta vitórias e derrotas.
//  - CS2: dados da integração oficial (Game State Integration).
//  - LoL: API local do jogo (https://127.0.0.1:2999/liveclientdata/...), que só responde durante a partida.
import https from 'node:https';

export function lolGet(path) {
  return new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port: 2999, path: '/liveclientdata/' + path, rejectUnauthorized: false, timeout: 1500 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(d) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

const CS_LABEL = { 2: 'Double kill (2K)', 3: 'Triple kill (3K)', 4: 'Quadra kill (4K)', 5: 'ACE (5K)' };
const LOL_LABEL = { 2: 'Double kill', 3: 'Triple kill', 4: 'Quadra kill', 5: 'PENTAKILL' };

export function createMatches({ config, getProfile, mark, rename, result, get = lolGet }) {
  const cs = { markerId: null, kills: 0, resultKey: null };
  const lol = { lastEvent: -1, me: null, over: false };
  const auto = () => config.autoClips ?? {};

  /* ---------- CS2 ---------- */
  function gsi(body) {
    if (!body) return;
    const own = body.player && body.provider && body.player.steamid && body.player.steamid === body.provider.steamid;
    const rk = Number(body.player?.state?.round_kills ?? 0);
    const phase = body.round?.phase;
    if (own) {
      if (phase === 'freezetime' || rk === 0) { cs.kills = 0; cs.markerId = null; }
      const min = Number(auto().cs2Kills ?? 3);
      if (auto().enabled !== false && min > 0 && rk >= min && rk > cs.kills) {
        const label = CS_LABEL[Math.min(rk, 5)] ?? `${rk}K`;
        if (cs.markerId) rename?.(cs.markerId, label);
        else cs.markerId = mark?.(label, { auto: true, reason: 'cs2-kills' })?.id ?? null;
      }
      cs.kills = Math.max(cs.kills, rk);
    }
    // fim de partida: compara o placar do meu time com o do outro
    const map = body.map;
    if (map?.phase && map.phase !== 'gameover') cs.resultKey = null;
    if (own && map?.phase === 'gameover') {
      const ct = Number(map.team_ct?.score ?? 0), t = Number(map.team_t?.score ?? 0);
      const mine = body.player.team === 'CT' ? ct : body.player.team === 'T' ? t : null;
      const key = `${map.name}:${ct}:${t}`;
      if (mine !== null && key !== cs.resultKey && ct !== t) {
        cs.resultKey = key;
        result?.(mine > (body.player.team === 'CT' ? t : ct) ? 'win' : 'loss', 'cs2', 'cs2-gsi');
      }
    }
  }

  /* ---------- LoL ---------- */
  async function pollLol() {
    const p = getProfile();
    if (!p || (p.detect?.type ?? (p.id === 'lol' ? 'lol' : 'manual')) !== 'lol') return;
    const data = await get('eventdata');
    if (!data) { lol.lastEvent = -1; lol.me = null; lol.over = false; return; } // sem partida
    if (!lol.me) { const n = await get('activeplayername'); lol.me = n ? String(n).split('#')[0].toLowerCase() : null; }
    const min = Number(auto().lolKills ?? 3);
    for (const ev of data.Events ?? []) {
      if (ev.EventID <= lol.lastEvent) continue;
      lol.lastEvent = ev.EventID;
      const mine = lol.me && String(ev.KillerName ?? '').toLowerCase().split('#')[0] === lol.me;
      if (ev.EventName === 'Multikill' && mine && auto().enabled !== false && min > 0 && ev.KillStreak >= min) {
        mark?.(LOL_LABEL[Math.min(ev.KillStreak, 5)] ?? `${ev.KillStreak}K`, { auto: true, reason: 'lol-multikill' });
      }
      if (ev.EventName === 'GameEnd' && !lol.over) {
        lol.over = true;
        if (ev.Result === 'Win') result?.('win', 'lol', 'lol-api');
        else if (ev.Result === 'Lose') result?.('loss', 'lol', 'lol-api');
      }
    }
  }
  const timer = setInterval(() => pollLol().catch(() => {}), 3000);
  timer.unref?.();

  return { gsi, pollLol };
}
