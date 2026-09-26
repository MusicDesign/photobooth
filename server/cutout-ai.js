import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from './paths.js';
import { modelPath } from './models.js';

/**
 * Détourage IA côté serveur (photo finale, images importées dans le concepteur), hors ligne via onnxruntime.
 * Deux modèles :
 *   precise : BiRefNet lite (MIT), détoure le sujet principal de n'importe quelle image : personnes, objets,
 *             figurines, gros plans. ~3 à 10 s par image selon la machine. Téléchargé une fois (voir models.js).
 *   fast    : MODNet (Apache-2.0), personnes seulement, ~0,5 s. Livré avec l'app ; sert aussi de secours
 *             tant que le modèle précis n'est pas installé.
 * Les modèles sont chargés au premier usage puis gardés en mémoire.
 */
const MODNET = path.join(ROOT, 'server', 'models', 'modnet.onnx');
const threads = Math.max(1, os.cpus().length - 1); // un cœur reste libre pour la borne (boîtier, aperçu)

const sessions = {};
function session(key, file) {
  sessions[key] ||= (async () => {
    const ort = (await import('onnxruntime-node')).default;
    // Lu en mémoire : dans l'app empaquetée, le modèle est dans l'archive asar que onnxruntime ne sait pas lire.
    // Sans la réserve mémoire d'onnxruntime (arena) : dans Electron, ses gros blocs font tuer le processus
    // de la borne (SIGTRAP) avec BiRefNet. Allocation au fil de l'eau, un peu plus lente, mais sûre.
    const s = await ort.InferenceSession.create(fs.readFileSync(file), { intraOpNumThreads: threads, logSeverityLevel: 3, enableCpuMemArena: false, enableMemPattern: false });
    return { ort, s };
  })();
  sessions[key].catch(() => { delete sessions[key]; }); // réessai au prochain appel
  return sessions[key];
}

/** Le modèle précis est-il installé ? Sinon « precise » retombe sur MODNet. */
export const preciseReady = () => !!modelPath('subject');

const toMatte = (bytes, W, H, w, h) => sharp(bytes, { raw: { width: W, height: H, channels: 1 } }).resize(w, h, { fit: 'fill' }).extractChannel(0).raw().toBuffer();

async function modnet(rgb, w, h) {
  const { ort, s } = await session('fast', MODNET);
  const k = 1024 / Math.max(w, h);
  const W = Math.max(32, Math.round((w * k) / 32) * 32);
  const H = Math.max(32, Math.round((h * k) / 32) * 32);
  const small = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(W, H, { fit: 'fill' }).raw().toBuffer();
  const n = W * H;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = small[i * 3 + c] / 127.5 - 1;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) });
  const m = out[s.outputNames[0]].data;
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(m[i] * 255)));
  return toMatte(bytes, W, H, w, h);
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
async function birefnet(rgb, w, h) {
  const { ort, s } = await session('precise', modelPath('subject'));
  const S = 1024; // taille fixe du modèle
  const small = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(S, S, { fit: 'fill' }).raw().toBuffer();
  const n = S * S;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = (small[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) });
  const m = out[s.outputNames[0]].data; // logits
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i++) bytes[i] = Math.round(255 / (1 + Math.exp(-m[i])));
  return toMatte(bytes, S, S, w, h);
}

let warned = false;
let queue = Promise.resolve(); // un calcul à la fois : mémoire bornée (GIF : trois photos arrivent coup sur coup)
/** Masque du sujet (octets 0-255, un par pixel) d'une image RGB brute w×h. model : 'precise' ou 'fast'. */
export function subjectMatte(rgb, w, h, { model = 'precise' } = {}) {
  const run = () => {
    if (model !== 'fast' && preciseReady()) return birefnet(rgb, w, h);
    if (model !== 'fast' && !warned) { warned = true; console.warn('[cutout] modèle précis absent : détourage MODNet (admin → Templates pour l\'installer)'); }
    return modnet(rgb, w, h);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** contour : ±px, élargit (positif) ou rétrécit (négatif) la découpe. */
export async function adjustContour(matte, w, h, contour = 0) {
  const px = Math.round(Math.abs(contour || 0));
  if (!px) return matte;
  // sharp opère sur les zones sombres : erode élargit le blanc (le sujet)
  return sharp(matte, { raw: { width: w, height: h, channels: 1 } })[contour > 0 ? 'erode' : 'dilate'](px).extractChannel(0).raw().toBuffer();
}

/** Ancien nom (détourage de personne) : même masque, contour appliqué. */
export async function personMatte(rgb, w, h, { precision = 'precise', contour = 0 } = {}) {
  return adjustContour(await subjectMatte(rgb, w, h, { model: precision }), w, h, contour);
}

/**
 * Masque d'une photo du boîtier, calculé une fois par fichier et gardé en mémoire : la borne le lance dès
 * l'arrivée de la photo (Booth.addShot), le montage le retrouve prêt. Le masque couvre la photo entière
 * (orientée) ; le montage le recadre comme la photo.
 */
const shotCache = new Map(); // `${model}:${file}` → Promise<{ data, w, h }>
export function shotMatte(file, model = 'precise') {
  const key = `${model}:${file}`;
  if (!shotCache.has(key)) {
    const p = (async () => {
      const { data, info } = await sharp(file).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: await subjectMatte(data, info.width, info.height, { model }), w: info.width, h: info.height };
    })();
    p.catch(() => shotCache.delete(key));
    shotCache.set(key, p);
    while (shotCache.size > 24) shotCache.delete(shotCache.keys().next().value); // les plus anciennes
  }
  return shotCache.get(key);
}

/**
 * Nettoyage des bords après détourage (pixels RGBA w×h, modifiés en place) : dans les zones semi-transparentes,
 * la couleur du fond d'origine (liseré clair ou coloré autour des cheveux) est remplacée par celle du sujet
 * tout proche. Le sujet opaque n'est pas touché.
 */
export async function cleanEdges(px, w, h) {
  const n = w * h;
  const weighted = Buffer.alloc(n * 3), weight = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3];
    const k = a >= 242 ? 1 : 0; // sujet sûr : source de la couleur
    weight[i] = k * 255;
    for (let c = 0; c < 3; c++) weighted[i * 3 + c] = k * px[i * 4 + c];
  }
  const sigma = Math.max(2, Math.min(12, Math.max(w, h) / 300));
  const [bw, bc] = await Promise.all([
    sharp(weight, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer(),
    sharp(weighted, { raw: { width: w, height: h, channels: 3 } }).blur(sigma).raw().toBuffer()
  ]);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3];
    if (a >= 242 || a === 0 || bw[i] < 8) continue;
    const t = (a / 255) ** 3; // presque opaque : on garde surtout la couleur d'origine
    for (let c = 0; c < 3; c++) {
      const f = Math.min(255, (bc[i * 3 + c] * 255) / bw[i]);
      px[i * 4 + c] = Math.round(px[i * 4 + c] * t + f * (1 - t));
    }
  }
  return px;
}
