import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Vidéo MP4 (H.264) du boomerang, via ffmpeg : livré avec l'app (paquet ffmpeg-static), sinon celui du
 * système. Sans ffmpeg, le boomerang retombe sur un GIF (voir compositor.js).
 */
let cached;
export function ffmpegPath() {
  if (cached !== undefined) return cached;
  const candidates = [];
  try {
    // App empaquetée : le binaire est hors de l'archive asar (asarUnpack), là où il peut s'exécuter
    const p = createRequire(import.meta.url)('ffmpeg-static');
    if (p) candidates.push(p.replace('app.asar', 'app.asar.unpacked'), p);
  } catch { /* paquet absent */ }
  candidates.push('ffmpeg');
  cached = candidates.find((c) => {
    try { return spawnSync(c, ['-hide_banner', '-version'], { timeout: 5000 }).status === 0; } catch { return false; }
  }) || null;
  if (!cached) console.warn('[video] ffmpeg introuvable : boomerangs en GIF');
  return cached;
}

/** Images JPEG → MP4 H.264 lisible partout (téléphones compris), qui démarre avant la fin du téléchargement. */
export async function encodeMp4(frames, outFile, { fps }) {
  const bin = ffmpegPath();
  if (!bin) throw new Error('ffmpeg introuvable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boomerang-'));
  try {
    frames.forEach((buf, i) => fs.writeFileSync(path.join(dir, `f-${String(i + 1).padStart(4, '0')}.jpg`), buf));
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, 'f-%04d.jpg'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', // dimensions paires, couleurs lisibles partout
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-movflags', '+faststart', '-an', outFile];
    await new Promise((resolve, reject) => {
      const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg : ${err.trim().split('\n').pop() || `code ${code}`}`))));
    });
    return outFile;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
