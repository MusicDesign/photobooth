import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compose, scaleTemplate } from './compositor.js';
import { samplePhotos } from './samples.js';
import { isAnimatedKind, PREVIEW_META } from './templates.js';

/**
 * Miniatures des templates (choix du cadre sur la borne, liste de l'admin), calculées à l'enregistrement
 * plutôt qu'à chaque affichage : le template monté en petit avec les photos d'exemple, comme l'aperçu de
 * l'éditeur. Calques détourés : la photo d'exemple déjà détourée (.png), sans IA.
 * Une miniature par photo d'exemple pour les GIF et boomerangs (la carte les fait défiler), une sinon.
 * Rangées dans le dossier du template : preview-<signature>-<n>.jpg + preview.json.
 */
const SIDE = 720; // plus grand côté, net même sur une carte affichée en grand

/** Signature du contenu : template et photos d'exemple. Inchangée, rien n'est recalculé. */
function signature(t, samples) {
  const { dir, previews, ...def } = t;
  const files = samples.map((s) => [s.file, s.cutoutFile].filter(Boolean).map((f) => `${f}:${fs.statSync(f).mtimeMs}`));
  return crypto.createHash('sha1').update(JSON.stringify([def, files, SIDE])).digest('hex').slice(0, 10);
}

/**
 * Un calcul à la fois par template : deux calculs en parallèle (enregistrement pendant celui du démarrage)
 * supprimaient chacun les fichiers de l'autre. Le second attend le premier, puis repart du template à jour :
 * fresh() le relit à ce moment-là (null : supprimé entre-temps).
 */
const running = new Map(); // dossier du template → dernier calcul lancé
export function buildPreviews(t, { fresh = null, force = false } = {}) {
  const prev = running.get(t.dir) || Promise.resolve();
  const job = prev.catch(() => {}).then(() => {
    const cur = fresh ? fresh() : t;
    return cur && fs.existsSync(cur.dir) ? build(cur, { force }) : [];
  });
  running.set(t.dir, job);
  job.catch(() => {}).finally(() => { if (running.get(t.dir) === job) running.delete(t.dir); });
  return job;
}

async function build(t, { force = false } = {}) {
  const samples = samplePhotos();
  if (!samples.length) return [];
  const sig = signature(t, samples);
  const metaFile = path.join(t.dir, PREVIEW_META);
  if (!force) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.sig === sig && meta.files.every((f) => fs.existsSync(path.join(t.dir, f)))) return meta.files;
    } catch { /* pas encore de miniature */ }
  }
  const small = scaleTemplate(t, Math.min(1, SIDE / Math.max(t.width, t.height)));
  const count = isAnimatedKind(t.kind) ? samples.length : 1;
  const files = [];
  for (let i = 0; i < count; i++) {
    // Photo N du template → exemple N (en boucle) ; GIF / boomerang : l'exemple i dans tous les calques
    const pick = (shot) => samples[(isAnimatedKind(t.kind) ? i : shot) % samples.length];
    const shotFiles = [];
    const layers = small.layers.map((l) => {
      if (l.type !== 'photo') return l;
      const s = pick(l.shot);
      const cut = l.cutout && l.cutout !== 'none' && s.cutoutFile;
      shotFiles.push(cut ? s.cutoutFile : s.file);
      return { ...l, shot: shotFiles.length - 1, ...(cut ? { cutout: 'none' } : {}) };
    });
    const name = `preview-${sig}-${i + 1}.jpg`;
    await compose({ ...small, layers }, shotFiles, path.join(t.dir, name));
    files.push(name);
  }
  // Anciennes miniatures : supprimées
  for (const f of fs.readdirSync(t.dir)) if (/^preview-[0-9a-f]{10}-\d+\.jpg$/.test(f) && !files.includes(f)) fs.rmSync(path.join(t.dir, f), { force: true });
  fs.writeFileSync(metaFile, JSON.stringify({ sig, files }));
  return files;
}

/** Au démarrage : les miniatures manquantes ou périmées (templates copiés à la main, nouvelle version). */
export async function buildAllPreviews(templates) {
  let n = 0;
  for (const t of templates.all()) {
    try {
      const before = fs.existsSync(path.join(t.dir, PREVIEW_META)) ? fs.readFileSync(path.join(t.dir, PREVIEW_META), 'utf8') : '';
      await buildPreviews(t, { fresh: () => templates.items.get(t.id) });
      if (fs.readFileSync(path.join(t.dir, PREVIEW_META), 'utf8') !== before) n++;
    } catch (e) { if (fs.existsSync(t.dir)) console.warn(`[templates] miniature de ${t.id} : ${e.message}`); } // supprimé pendant le calcul : rien à dire
  }
  if (n) console.log(`[templates] ${n} miniature(s) calculée(s)`);
  return n;
}
