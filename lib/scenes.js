import { computeLayout, gameSceneOf, W, H } from './layout.js';

// Monta as cenas no OBS via obs-websocket. Para cada jogo, duas cenas:
//  - lobby (profile.scene):      moldura completa com painel, chat, QR e metas;
//  - partida (profile.sceneGame): jogo em tela cheia, só a webcam e o QR.
// Mais as telas Começando, Já volto e Encerrando.
// Regras de segurança:
//  - só cria ou atualiza fontes com nome começando por "LC " (e a webcam, se ainda não existir);
//  - nunca apaga nada;
//  - cena que já existe e tem itens seus (que não são "LC ") é pulada, para não bagunçar o que você montou.
const PREFIX = 'LC ';
const ALIGN_TOP_LEFT = 5;

export async function buildScenes({ obs, connected, config, port, dry = false }) {
  const steps = [];
  const log = (name, ok, detail = '') => steps.push({ name, ok, detail });
  const base = `http://localhost:${port}`;
  const camSource = config.camera?.source || 'LC Webcam';
  const sceneNames = {
    starting: config.scenes?.starting || 'Começando',
    brb: config.brb?.scene || 'Já volto',
    ending: config.scenes?.ending || 'Encerrando'
  };

  // estado atual do OBS (se estiver conectado)
  const have = { scenes: new Set(), inputs: new Set() };
  let canvas = { w: W, h: H };
  if (connected) {
    const [v, s, i] = await Promise.all([obs.call('GetVideoSettings'), obs.call('GetSceneList'), obs.call('GetInputList')]);
    canvas = { w: v.baseWidth, h: v.baseHeight };
    s.scenes.forEach((x) => have.scenes.add(x.sceneName));
    i.inputs.forEach((x) => have.inputs.add(x.inputName));
  } else if (!dry) throw new Error('OBS não está conectado');
  const kx = canvas.w / W, ky = canvas.h / H;
  if (!dry) log('Canvas do OBS', true, `${canvas.w}x${canvas.h}`);

  const tf = (r, boundsType = 'OBS_BOUNDS_SCALE_INNER') => ({
    positionX: r.x * kx, positionY: r.y * ky, alignment: ALIGN_TOP_LEFT,
    boundsType, boundsWidth: r.w * kx, boundsHeight: r.h * ky, boundsAlignment: 0
  });
  const full = { x: 0, y: 0, w: W, h: H };
  const browser = (url) => ({ url, width: W, height: H, fps: 30, shutdown: false, restart_when_active: false });

  const run = async (name, simulated, fn) => {
    if (dry) return log(name, true, simulated);
    try { log(name, true, (await fn()) || ''); } catch (e) { log(name, false, e.message); }
  };

  async function sceneIsSafe(scene) {
    if (!connected || !have.scenes.has(scene)) return true;
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
    const foreign = sceneItems.filter((it) => !it.sourceName.startsWith(PREFIX) && it.sourceName !== camSource);
    return foreign.length === 0;
  }

  async function ensureScene(scene) {
    if (have.scenes.has(scene)) return;
    await obs.call('CreateScene', { sceneName: scene });
    have.scenes.add(scene);
  }

  // coloca (ou atualiza) uma fonte numa cena e ajusta a posição
  async function ensureItem(scene, inputName, inputKind, settings, transform, { updateSettings = true } = {}) {
    let itemId = null;
    try { itemId = (await obs.call('GetSceneItemId', { sceneName: scene, sourceName: inputName })).sceneItemId; } catch { /* não está na cena */ }
    let created = false;
    if (itemId == null) {
      if (have.inputs.has(inputName)) {
        itemId = (await obs.call('CreateSceneItem', { sceneName: scene, sourceName: inputName })).sceneItemId;
      } else {
        itemId = (await obs.call('CreateInput', { sceneName: scene, inputName, inputKind, inputSettings: settings })).sceneItemId;
        have.inputs.add(inputName);
      }
      created = true;
    } else if (updateSettings && inputName.startsWith(PREFIX) && settings) {
      await obs.call('SetInputSettings', { inputName, inputSettings: settings, overlay: true });
    }
    await obs.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: itemId, sceneItemTransform: transform });
    return created ? 'criado' : 'atualizado';
  }

  async function pickCamera() {
    try {
      const r = await obs.call('GetInputPropertiesListPropertyItems', { inputName: camSource, propertyName: 'video_device_id' });
      const items = (r.propertyItems ?? []).filter((x) => x.itemValue);
      if (!items.length) return 'nenhuma câmera encontrada, escolha em Propriedades da fonte';
      const want = (config.camera?.device || '').toLowerCase();
      // prefere o nome que você informou; senão a primeira câmera que não seja virtual (OBS, Snap, ManyCam...)
      const real = items.filter((x) => !/virtual|obs|snap camera|manycam|droidcam|iriun/i.test(String(x.itemName)));
      const hit = (want && items.find((x) => String(x.itemName).toLowerCase().includes(want))) || real[0] || items[0];
      await obs.call('SetInputSettings', { inputName: camSource, inputSettings: { video_device_id: hit.itemValue }, overlay: true });
      return `câmera: ${hit.itemName}`;
    } catch { return 'escolha a câmera em Propriedades da fonte'; }
  }

  /* ---------- cenas de jogo: lobby e partida ---------- */
  for (const p of config.profiles ?? []) {
    if (!p.scene) continue;
    for (const phase of ['lobby', 'game']) {
      const L = computeLayout(config, p.id, phase);
      const scene = phase === 'game' ? gameSceneOf(p) : p.scene;
      const tag = `${p.label} · ${phase === 'game' ? 'partida' : 'lobby'} (${scene})`;
      if (!(await sceneIsSafe(scene))) { log(`Cena ${tag}`, true, 'já existe com itens seus, não mexi (apague a cena no OBS para o app recriar)'); continue; }
      const existed = have.scenes.has(scene);
      await run(`Cena ${tag}`, existed ? 'já existe, será completada' : 'será criada', async () => { await ensureScene(scene); return existed ? 'já existia, completada' : 'criada'; });
      await run(`  Jogo (${phase === 'game' ? 'tela cheia' : 'moldura lateral'})`, 'captura de jogo', () =>
        ensureItem(scene, `${PREFIX}Jogo ${p.label}`, 'game_capture', { capture_mode: 'any_fullscreen' }, tf(L.rects.game), { updateSettings: false }));
      await run('  Webcam', have.inputs.has(camSource) ? `usa "${camSource}"` : `criaria "${camSource}"`, async () => {
        const existedCam = have.inputs.has(camSource);
        const r = await ensureItem(scene, camSource, 'dshow_input', {}, tf(L.rects.cam), { updateSettings: false });
        return existedCam ? r : `${r}; ${await pickCamera()}`;
      });
      const frameName = phase === 'game' ? `${PREFIX}Moldura ${p.label} Jogo` : `${PREFIX}Moldura ${p.label}`;
      await run('  Moldura', phase === 'game' ? 'só a borda da webcam e o QR' : 'camada com borda, painel, QR e metas', () =>
        ensureItem(scene, frameName, 'browser_source', browser(`${base}/overlays/frame.html?game=${p.id}&phase=${phase}`), tf(full, 'OBS_BOUNDS_STRETCH')));
      // reroute_audio: o som dos efeitos (sirene, buzina...) entra no mixer do OBS e vai para a live
      await run('  Alertas', 'camada de alertas e efeitos sonoros no topo', () =>
        ensureItem(scene, `${PREFIX}Alertas`, 'browser_source', { ...browser(`${base}/overlays/alerts.html`), reroute_audio: true }, tf(full, 'OBS_BOUNDS_STRETCH')));
    }
  }

  /* ---------- telas de começo, pausa e fim ---------- */
  for (const [type, label] of [['starting', 'Começando'], ['brb', 'Já volto'], ['ending', 'Encerrando']]) {
    const scene = sceneNames[type];
    if (connected && have.scenes.has(scene) && !(await sceneIsSafe(scene))) { log(`Tela ${label} (${scene})`, true, 'já existe com itens seus, não mexi'); continue; }
    await run(`Tela ${label} (${scene})`, have.scenes.has(scene) ? 'já existe, será completada' : 'será criada', async () => {
      await ensureScene(scene);
      const url = `${base}/overlays/screen.html?type=${type}${type === 'starting' ? '&min=5' : ''}`;
      return ensureItem(scene, `${PREFIX}Tela ${label}`, 'browser_source', browser(url), tf(full, 'OBS_BOUNDS_STRETCH'));
    });
  }

  return { steps, canvas, dry };
}
