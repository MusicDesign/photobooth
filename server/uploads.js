import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from './paths.js';

/**
 * Dossier des envois de l'admin (logo, image de fond) : chaque envoi crée un nouveau fichier horodaté. Ceux que
 * la config ne référence plus (remplacés, « Logo par défaut », « Retirer ») sont supprimés, au démarrage et à
 * chaque changement de config. Seuls les fichiers logo-* et bg-* sont concernés : le reste du dossier est laissé.
 */
export function pruneUploads(cfg) {
  if (!fs.existsSync(UPLOADS_DIR)) return 0;
  const used = new Set([cfg.booth?.logo, cfg.booth?.backgroundImage, cfg.theme?.custom?.logo, cfg.theme?.custom?.backgroundImage]
    .filter((u) => typeof u === 'string' && u.startsWith('/uploads/')).map((u) => path.basename(u)));
  let n = 0;
  for (const f of fs.readdirSync(UPLOADS_DIR)) {
    if (!/^(logo|bg)-\d+\.[a-z0-9]+$/i.test(f) || used.has(f)) continue;
    try { fs.rmSync(path.join(UPLOADS_DIR, f), { force: true }); n++; } catch { /* fichier occupé : au prochain passage */ }
  }
  if (n) console.log(`[uploads] ${n} fichier(s) plus référencé(s) supprimé(s)`);
  return n;
}

/**
 * Logo ou image de fond de la config dont le fichier a disparu du dossier des envois (disque nettoyé à la main,
 * dossier recopié sans lui) : le réglage est rendu vide, le logo par défaut et l'absence de fond reprennent.
 * Rend le correctif de config à appliquer, ou null si tout est en place.
 */
export function missingUploadRefs(cfg) {
  const missing = (u) => typeof u === 'string' && u.startsWith('/uploads/') && !fs.existsSync(path.join(UPLOADS_DIR, path.basename(u)));
  const patch = {};
  if (missing(cfg.booth?.logo)) patch.booth = { ...patch.booth, logo: '' };
  if (missing(cfg.booth?.backgroundImage)) patch.booth = { ...patch.booth, backgroundImage: '' };
  if (missing(cfg.theme?.custom?.logo)) patch.theme = { custom: { ...patch.theme?.custom, logo: '' } };
  if (missing(cfg.theme?.custom?.backgroundImage)) patch.theme = { custom: { ...patch.theme?.custom, backgroundImage: '' } };
  return Object.keys(patch).length ? patch : null;
}
