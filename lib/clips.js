import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './store.js';

export const CLIPS_DIR = path.join(DATA, 'clips');
fs.mkdirSync(CLIPS_DIR, { recursive: true });

export const tcToSeconds = (tc) => {
  if (!tc) return null;
  const [h, m, s] = tc.split(':');
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
};
export const fmtTc = (tc) => (tc ?? '—').split('.')[0];

export function ffmpegBin(config) { return config.clips?.ffmpegPath || 'ffmpeg'; }
export function ffmpegAvailable(config) {
  try { return spawnSync(ffmpegBin(config), ['-version'], { windowsHide: true }).status === 0; } catch { return false; }
}

const slug = (s) => String(s || 'clipe').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'clipe';

// Corta um momento marcado. Usa a gravação inteira (se houver) ou o replay salvo.
export function cutClip(config, marker, { before, after, vertical }) {
  return new Promise((resolve, reject) => {
    if (!ffmpegAvailable(config)) return reject(new Error('ffmpeg não encontrado. Instale com: winget install Gyan.FFmpeg (e reinicie o app).'));
    const dur = before + after;
    let input, start;
    const recSecs = tcToSeconds(marker.recTimecode);
    if (marker.recordPath && recSecs != null && fs.existsSync(marker.recordPath)) {
      input = marker.recordPath; start = Math.max(0, recSecs - before);
    } else if (marker.replayPath && fs.existsSync(marker.replayPath)) {
      input = marker.replayPath; start = 0; // o replay já termina no momento marcado
    } else {
      return reject(new Error('Sem arquivo para cortar. Ligue a gravação ou o buffer de replay no OBS antes da live.'));
    }
    const out = path.join(CLIPS_DIR, `${slug(marker.label)}-${marker.id}${vertical ? '-vertical' : ''}.mp4`);
    const args = ['-y', '-ss', String(start), '-i', input];
    if (input === marker.recordPath) args.push('-t', String(dur));
    if (vertical) {
      args.push('-filter_complex',
        '[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v]',
        '-map', '[v]', '-map', '0:a?');
    }
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', out);
    const p = spawn(ffmpegBin(config), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => code === 0 ? resolve(path.basename(out)) : reject(new Error('ffmpeg falhou: ' + err.split('\n').slice(-3).join(' ').trim())));
  });
}

const GAME_TAGS = {
  cs2: ['#cs2', '#counterstrike2', '#cs2clips'],
  lol: ['#lol', '#leagueoflegends', '#lolclips'],
  ronrun: ['#ronrun']
};
// Sugestão de título, descrição e hashtags para o corte
export function clipMeta(config, marker, profiles) {
  const prof = (profiles ?? []).find((p) => p.id === marker.profile);
  const game = prof?.label ?? '';
  const label = marker.label?.trim() || 'Momento da live';
  const tags = [...(GAME_TAGS[marker.profile] ?? []), '#twitch', '#gameplay', '#shorts', '#fyp'];
  const channel = config.twitch?.channel && config.twitch.channel !== 'seucanal' ? config.twitch.channel : null;
  return {
    title: [label, game].filter(Boolean).join(' | '),
    description: `${label}${game ? ` em ${game}` : ''}.${channel ? ` Ao vivo em twitch.tv/${channel}` : ''}`,
    hashtags: tags.join(' ')
  };
}
