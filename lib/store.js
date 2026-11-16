import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

export const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
export const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2));

const CONFIG_PATH = path.join(ROOT, 'config.json');
// Primeira execução: cria o config.json local (ignorado pelo Git) a partir do exemplo.
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_PATH)) fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
const STATE_PATH = path.join(DATA, 'state.json');

export const config = readJson(CONFIG_PATH, {});
export const saveConfig = () => writeJson(CONFIG_PATH, config);

const defaults = () => ({
  activeProfile: null,
  brb: { active: false, prevScene: null },
  theme: { accent: '#8b5cf6', accent2: '#db2777' },
  goals: [],
  score: { wins: 0, losses: 0, streak: { type: null, n: 0 }, byGame: {}, history: [], auto: true },
  session: { startedAt: Date.now(), donationTotal: 0, donationCount: 0, follows: 0, subs: 0, raids: 0, bits: 0 }
});
export const state = Object.assign(defaults(), readJson(STATE_PATH, {}));
if (!state.goals.length && Array.isArray(config.goals)) state.goals = structuredClone(config.goals);
export const saveState = () => writeJson(STATE_PATH, state);
export const resetSession = () => { state.session = defaults().session; saveState(); };
