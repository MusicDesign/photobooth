import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from './paths.js';

/**
 * Modèles d'IA trop lourds pour le dépôt git (limite de GitHub : 100 Mo par fichier) : téléchargés une fois,
 * borne connectée à internet (admin → Templates, ou `npm run models`), puis utilisés hors ligne.
 * Version figée et empreinte vérifiée : le fichier ne peut pas changer dans notre dos.
 */
export const MODELS = {
  // BiRefNet lite (MIT) : détoure le sujet principal de n'importe quelle image (personnes, objets, figurines)
  subject: {
    name: 'Détourage précis (BiRefNet)',
    file: 'birefnet-lite-fp16.onnx',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx',
    size: 114538221,
    sha256: 'd39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402'
  }
};
export const MODELS_DIR = path.join(DATA_DIR, 'models');

/** Chemin du modèle s'il est présent (livré avec l'app dans server/models, ou téléchargé dans data/models). */
export function modelPath(key) {
  const m = MODELS[key];
  if (!m) return null;
  for (const p of [path.join(ROOT, 'server', 'models', m.file), path.join(MODELS_DIR, m.file)]) if (fs.existsSync(p)) return p;
  return null;
}

const jobs = {}; // key → { promise, received, error }

export function modelStatus(key) {
  const m = MODELS[key];
  const j = jobs[key];
  return {
    key, name: m.name, size: m.size, installed: !!modelPath(key),
    downloading: !!j?.promise, received: j?.received || 0, error: j?.error || null
  };
}

/** Télécharge le modèle (un seul téléchargement à la fois), vérifie son empreinte, puis le range. */
export function downloadModel(key, { log = console.log } = {}) {
  const m = MODELS[key];
  if (!m) throw new Error(`Modèle inconnu : ${key}`);
  if (modelPath(key)) return Promise.resolve(modelPath(key));
  if (jobs[key]?.promise) return jobs[key].promise;
  const job = jobs[key] = { received: 0, error: null, promise: null };
  job.promise = (async () => {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    const dest = path.join(MODELS_DIR, m.file);
    const part = `${dest}.part`;
    const res = await fetch(m.url);
    if (!res.ok || !res.body) throw new Error(`téléchargement impossible (HTTP ${res.status})`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        job.received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (hash.digest('hex') !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error('fichier reçu corrompu, réessayez'); }
    fs.renameSync(part, dest);
    log(`[models] ${m.name} installé (${Math.round(m.size / 1e6)} Mo)`);
    return dest;
  })();
  job.promise.then(() => { job.promise = null; }, (e) => { job.promise = null; job.error = e.message; log(`[models] ${m.name} : ${e.message}`); });
  return job.promise;
}
