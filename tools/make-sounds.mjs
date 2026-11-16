// Gera efeitos sonoros sintéticos (sem direitos autorais) na pasta sounds/.
// Uso: node tools/make-sounds.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'sounds');
fs.mkdirSync(OUT, { recursive: true });
const SR = 44100, TAU = Math.PI * 2;
const buf = (sec) => new Float32Array(Math.floor(sec * SR));
const fade = (i, n, a, r) => Math.max(0, Math.min(1, i / (a * SR), (n - i) / (r * SR)));
const saw = (ph) => 2 * ((ph / TAU) % 1) - 1;
let seed = 1234567;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };

function write(name, x) {
  // normaliza pelo pico e também limita o volume médio, para nenhum efeito sair muito mais alto que os outros
  let peak = 0, sum = 0;
  for (const s of x) { peak = Math.max(peak, Math.abs(s)); sum += s * s; }
  const rms = Math.sqrt(sum / x.length);
  const g = peak > 0 ? Math.min(0.85 / peak, 0.22 / Math.max(rms, 1e-6)) : 1;
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i] * g)) * 32767), 44 + i * 2);
  fs.writeFileSync(path.join(OUT, name), b);
}

// filtro passa-banda (biquad) para as vogais
function bandpass(x, f0, q) {
  const w = TAU * f0 / SR, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const o = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = o; y[i] = o;
  }
  return y;
}
const lowpass1 = (x, fc) => { const a = 1 - Math.exp(-TAU * fc / SR); const y = new Float32Array(x.length); let p = 0; for (let i = 0; i < x.length; i++) { p += a * (x[i] - p); y[i] = p; } return y; };

// 1) sirene de polícia (wail): varre devagar entre grave e agudo
function sirene(sec, cycle, lo, hi) {
  const x = buf(sec); let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR, m = 0.5 - 0.5 * Math.cos(TAU * t / cycle);
    const f = lo + (hi - lo) * m; ph += TAU * f / SR;
    x[i] = (Math.sin(ph) + 0.4 * Math.sin(3 * ph) + 0.2 * Math.sin(5 * ph)) * fade(i, x.length, 0.05, 0.4);
  }
  return x;
}
write('sirene-policia.wav', sirene(5, 1.7, 650, 1450));
write('sirene-rapida.wav', sirene(3.5, 0.32, 700, 1500));

// 2) buzina de ar: dois toques curtos e um longo, notas empilhadas
{
  const x = buf(1.9); const notes = [466, 587, 698];
  const blasts = [[0, 0.22], [0.3, 0.52], [0.6, 1.75]];
  for (const [s, e] of blasts) for (let i = Math.floor(s * SR); i < Math.floor(e * SR) && i < x.length; i++) {
    const t = i / SR, n = (e - s) * SR, j = i - s * SR; let v = 0;
    for (const f of notes) v += saw(TAU * f * (1 + 0.006 * Math.sin(TAU * 6 * t)) * t);
    x[i] += (v / 3 + 0.08 * rnd()) * Math.min(1, j / (0.015 * SR), (n - j) / (0.12 * SR));
  }
  write('buzina-ar.wav', x);
}

// 3) erro: buzina de resposta errada
{
  const x = buf(0.75);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = ((Math.sin(TAU * 110 * t) > 0 ? 1 : -1) + (Math.sin(TAU * 117 * t) > 0 ? 1 : -1)) * 0.5 * fade(i, x.length, 0.01, 0.12);
  }
  write('erro.wav', lowpass1(x, 2500));
}

// 4) trombone triste: wah wah wah waaah
{
  const seq = [[233, 0.5], [220, 0.5], [208, 0.5], [196, 1.5]];
  const x = buf(3.1); let pos = 0;
  seq.forEach(([f, d], k) => {
    const n = Math.floor(d * SR), last = k === seq.length - 1;
    for (let i = 0; i < n && pos + i < x.length; i++) {
      const t = i / SR, vib = last ? 1 + 0.025 * Math.sin(TAU * 5.5 * t) * Math.min(1, t / 0.5) : 1;
      const bend = last ? 1 - 0.045 * Math.min(1, t / 1.5) : 1;
      x[pos + i] = saw(TAU * f * vib * bend * t) * Math.min(1, i / (0.03 * SR), (n - i) / ((last ? 0.35 : 0.08) * SR));
    }
    pos += Math.floor((d + 0.04) * SR);
  });
  write('trombone-triste.wav', lowpass1(lowpass1(x, 1100), 1500));
}

// 5) ding de acerto
{
  const x = buf(1.3);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = (Math.sin(TAU * 1318 * t) + 0.5 * Math.sin(TAU * 2637 * t) + 0.2 * Math.sin(TAU * 3951 * t)) * Math.exp(-3.2 * t) * Math.min(1, i / (0.002 * SR));
  }
  write('ding.wav', x);
}

// 6) boom de impacto (dramático)
{
  const x = buf(1.6); let ph = 0; const nz = [];
  for (let i = 0; i < x.length; i++) nz.push(rnd());
  const noise = lowpass1(Float32Array.from(nz), 400);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR, f = 35 + 120 * Math.exp(-9 * t); ph += TAU * f / SR;
    x[i] = Math.sin(ph) * Math.exp(-2.6 * t) + 2.5 * noise[i] * Math.exp(-9 * t);
  }
  write('boom.wav', x);
}

// 7) "fah" sintético (imitação: voz aberta caindo de tom, NÃO é o áudio original do meme)
{
  const n = Math.floor(1.15 * SR), src = new Float32Array(n), fr = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f0 = 150 + 130 * Math.exp(-3.2 * t) + 4 * Math.sin(TAU * 6 * t);
    ph += TAU * f0 / SR; src[i] = saw(ph);
    fr[i] = rnd() * (t < 0.14 ? 1 : 0);
  }
  const f1 = bandpass(src, 800, 6), f2 = bandpass(src, 1250, 8), f3 = bandpass(src, 2600, 10);
  const frHi = bandpass(fr, 5000, 1.2);
  const x = buf(1.15);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, Math.max(0, (t - 0.07) / 0.05)) * Math.exp(-1.1 * Math.max(0, t - 0.4)) * Math.min(1, (1.15 - t) / 0.2);
    x[i] = (1.0 * f1[i] + 0.8 * f2[i] + 0.35 * f3[i]) * 0.3 * env + frHi[i] * 0.9 * Math.min(1, (0.18 - t) / 0.05);
  }
  write('fah-sintetico.wav', x);
}

// 8) moeda / level up
{
  const notes = [659, 784, 988, 1319], x = buf(0.75);
  notes.forEach((f, k) => {
    const s = Math.floor(k * 0.09 * SR), n = Math.floor((k === 3 ? 0.4 : 0.12) * SR);
    for (let i = 0; i < n && s + i < x.length; i++) x[s + i] += (Math.sin(TAU * f * i / SR) > 0 ? 1 : -1) * 0.5 * Math.exp(-6 * i / SR) * Math.min(1, i / (0.003 * SR));
  });
  write('moeda.wav', x);
}

// 9) rimshot (ba-dum-tss)
{
  const x = buf(1.2); const nz = []; for (let i = 0; i < x.length; i++) nz.push(rnd());
  const hi = bandpass(Float32Array.from(nz), 7000, 0.8);
  const drum = (start, f) => { const s = Math.floor(start * SR); for (let i = 0; i < 0.18 * SR && s + i < x.length; i++) { const t = i / SR; x[s + i] += Math.sin(TAU * (f + 70 * Math.exp(-30 * t)) * t) * Math.exp(-20 * t) + 0.25 * rnd() * Math.exp(-40 * t); } };
  drum(0, 190); drum(0.17, 140);
  const s = Math.floor(0.42 * SR);
  for (let i = 0; s + i < x.length; i++) x[s + i] += hi[i] * 1.6 * Math.exp(-4.5 * i / SR);
  write('rimshot.wav', x);
}

console.log('sons gerados em', OUT);
