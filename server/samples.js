import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, SAMPLES_DIR } from './paths.js';

/**
 * Photos d'exemple : aperçus des templates (admin, choix du cadre sur la borne) et caméra simulée.
 * Ce sont public/assets/template-photo.jpg, puis -2 et -3 si elles existent (la photo N d'un template
 * prend l'exemple N, en boucle). Sans elles : les images de démonstration de data/samples.
 * BOOTH_SAMPLES_DIR (tests automatiques) force data/samples.
 * template-photo(-2, -3).png, s'ils existent : la même photo détourée (fond transparent), utilisée dans les
 * aperçus pour les calques photo dont le détourage est activé.
 */
const FILES = ['template-photo.jpg', 'template-photo-2.jpg', 'template-photo-3.jpg'];

export function samplePhotos() {
  if (!process.env.BOOTH_SAMPLES_DIR) {
    // Version détourée (même nom en .png, fond transparent) : aperçu des calques photo avec « Détourage »
    const own = FILES.map((f) => {
      const png = f.replace(/\.jpe?g$/i, '.png');
      return { file: path.join(PUBLIC_DIR, 'assets', f), url: `/assets/${f}`, cutoutUrl: fs.existsSync(path.join(PUBLIC_DIR, 'assets', png)) ? `/assets/${png}` : null };
    }).filter((s) => fs.existsSync(s.file));
    if (own.length) return own;
  }
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  return fs.readdirSync(SAMPLES_DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()
    .map((f) => ({ file: path.join(SAMPLES_DIR, f), url: `/samples/${f}` }));
}
