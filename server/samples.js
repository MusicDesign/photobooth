import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, SAMPLES_DIR } from './paths.js';

/**
 * Photos d'exemple : aperçus des templates (admin, choix du cadre sur la borne) et caméra simulée.
 * Ce sont public/assets/template-photo.jpg, puis -2 et -3 si elles existent (la photo N d'un template
 * prend l'exemple N, en boucle). Sans elles : les images de démonstration de data/samples.
 * BOOTH_SAMPLES_DIR (tests automatiques) force data/samples.
 */
const FILES = ['template-photo.jpg', 'template-photo-2.jpg', 'template-photo-3.jpg'];

export function samplePhotos() {
  if (!process.env.BOOTH_SAMPLES_DIR) {
    const own = FILES.map((f) => ({ file: path.join(PUBLIC_DIR, 'assets', f), url: `/assets/${f}` })).filter((s) => fs.existsSync(s.file));
    if (own.length) return own;
  }
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  return fs.readdirSync(SAMPLES_DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()
    .map((f) => ({ file: path.join(SAMPLES_DIR, f), url: `/samples/${f}` }));
}
