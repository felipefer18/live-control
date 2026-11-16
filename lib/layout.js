// Geometria das cenas, sempre em unidades de um canvas 1920x1080.
// O montador de cenas converte para o tamanho real do canvas do OBS.
//
// Cada jogo tem duas fases:
//  - "lobby": moldura completa (jogo a 80%, painel com webcam, chat, QR, metas e redes);
//  - "game":  partida em andamento, jogo em tela cheia com só a webcam e o QR.
export const W = 1920, H = 1080;

const LOBBY = {
  game: { x: 0, y: 0, w: 1536, h: 864 },
  cam: { x: 1536, y: 0, w: 384, h: 216 },
  chat: { x: 1536, y: 216, w: 384, h: 648 },
  bar: { x: 0, y: 864, w: 1920, h: 216 }
};
const FULL_CAM = { x: 24, y: 24, w: 360, h: 203 };
// Onde a webcam fica durante a partida. No CS2 o radar ocupa o canto de cima à esquerda,
// por isso a webcam fica na lateral esquerda, mais abaixo. No LoL o canto de cima à esquerda é livre.
export const DEFAULT_GAME_CAM = {
  cs2: { x: 24, y: 400, w: 360, h: 203 },
  lol: { x: 24, y: 24, w: 360, h: 203 },
  ronrun: { x: 24, y: 24, w: 360, h: 203 }
};

// nome da cena da partida (a cena do lobby é profile.scene)
export const gameSceneOf = (p) => p.sceneGame || (p.scene ? `${p.scene} Jogo` : '');
// como detectar que a partida começou
export const detectOf = (p) => p.detect?.type ?? (p.id === 'cs2' ? 'cs2' : p.id === 'lol' ? 'lol' : 'manual');

export function brandOf(config) {
  const ch = config.twitch?.channel;
  return {
    name: config.brand?.name || (ch && ch !== 'seucanal' ? ch : 'Seu Canal'),
    tagline: config.brand?.tagline ?? '',
    livepixUrl: config.brand?.livepixUrl ?? '',
    socials: (config.brand?.socials ?? []).filter((s) => s && (s.label || s.text)),
    qrEverySec: Number(config.brand?.qrEverySec) || 300,
    qrAlways: config.brand?.qrAlways !== false, // por padrão o QR fica fixo na tela
    showScore: config.brand?.showScore ?? 'lobby' // placar: 'lobby' (só na moldura completa), 'always' ou 'off'
  };
}

const num = (v, d) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));

export function gameCamOf(p) {
  const c = p.layout?.game?.cam ?? p.layout?.cam ?? {};
  const d = DEFAULT_GAME_CAM[p.id] ?? FULL_CAM;
  return { x: num(c.x, d.x), y: num(c.y, d.y), w: num(c.w, d.w), h: num(c.h, d.h) };
}

export function computeLayout(config, id, phase = 'lobby') {
  const p = (config.profiles ?? []).find((x) => x.id === id);
  if (!p) throw new Error('Perfil não encontrado');
  const inGame = phase === 'game';
  let rects, panels, outlines;
  if (!inGame) {
    rects = structuredClone(LOBBY);
    panels = [rects.chat, rects.bar];
    outlines = [rects.game, rects.cam];
  } else {
    const cam = gameCamOf(p);
    rects = { game: { x: 0, y: 0, w: W, h: H }, cam };
    panels = [];
    outlines = [cam];
  }
  const accent = p.accent || '#8b5cf6';
  return {
    id: p.id, label: p.label, scene: p.scene, sceneGame: gameSceneOf(p),
    phase: inGame ? 'game' : 'lobby', mode: inGame ? 'full' : 'side',
    accent, accent2: p.accent2 || accent,
    canvas: { w: W, h: H }, rects, panels, outlines, brand: brandOf(config)
  };
}
