// Mini-mixer de áudio: lê e ajusta o volume e o mudo das fontes de áudio do OBS.
const round1 = (n) => Math.round(n * 10) / 10;
export const clampDb = (db) => Math.max(-100, Math.min(26, Number(db)));
export const dbFromMag = (m) => (m > 0.000001 ? 20 * Math.log10(m) : -100);

// lista só as fontes que têm volume (as de áudio), respeitando ocultas e ordem
export async function listMixer(obs, cfg = {}) {
  const { inputs } = await obs.call('GetInputList');
  const out = [];
  for (const i of inputs) {
    try {
      const v = await obs.call('GetInputVolume', { inputName: i.inputName });
      const m = await obs.call('GetInputMute', { inputName: i.inputName });
      out.push({ name: i.inputName, kind: i.inputKind, db: round1(v.inputVolumeDb), muted: !!m.inputMuted });
    } catch { /* fonte sem áudio (imagem, texto...) */ }
  }
  const hidden = new Set(cfg.hidden ?? []);
  const order = cfg.order ?? [];
  const rank = (n) => { const i = order.indexOf(n); return i < 0 ? 999 : i; };
  return {
    inputs: out.filter((x) => !hidden.has(x.name)).sort((a, b) => rank(a.name) - rank(b.name)),
    all: out.map((x) => x.name),
    hidden: [...hidden]
  };
}

export async function setVolume(obs, name, db) {
  await obs.call('SetInputVolume', { inputName: name, inputVolumeDb: clampDb(db) });
}
export async function setMute(obs, name, muted) {
  if (muted === undefined) await obs.call('ToggleInputMute', { inputName: name });
  else await obs.call('SetInputMute', { inputName: name, inputMuted: !!muted });
}
