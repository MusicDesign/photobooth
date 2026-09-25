/**
 * Détourage dans l'aperçu de la borne (calques photo avec l'option « Détourage »).
 * Fond vert / bleu : même calcul que la photo finale (cutout.js). IA : MediaPipe (selfie segmenter),
 * servi en local, qui tourne sur la carte graphique ; la photo finale utilise un modèle plus fin (serveur).
 *
 * Le détourage se fait sur une copie réduite (640 px de large au plus) de la zone du calque :
 * assez pour l'écran, et léger à 30 images/s.
 */
import { drawCover } from './template-render.js';
import { chromaKey, applyMatte, aiMatteRange } from './cutout.js';

const MAX_W = 640;
const MEDIAPIPE = '/vendor/mediapipe';
const MODEL = '/models/selfie_segmenter_landscape.tflite';

let segmenter = null;
let segLoading = null;
let lastTs = 0;

/** Charge le modèle IA en arrière-plan (au choix d'un cadre qui l'utilise). Sans lui, l'aperçu n'est pas détouré. */
export function preloadAi() {
  segLoading ||= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
    try {
      segmenter = await ImageSegmenter.createFromOptions(fileset, opts('GPU'));
    } catch {
      segmenter = await ImageSegmenter.createFromOptions(fileset, opts('CPU')); // pas de WebGL : plus lent, mais marche
    }
  })().catch((e) => {
    console.warn(`détourage IA indisponible : ${e.message}`);
    segLoading = null;
  });
  return segLoading;
}

/** Masque de personne (0-1) de l'image du canvas, ou null tant que le modèle charge. */
function personMask(canvas) {
  if (!segmenter) { preloadAi(); return null; }
  const ts = Math.max(performance.now(), lastTs + 1); // horodatage strictement croissant exigé en mode vidéo
  lastTs = ts;
  let mask = null;
  segmenter.segmentForVideo(canvas, ts, (r) => {
    const m = r.confidenceMasks?.[r.confidenceMasks.length - 1]; // dernière catégorie : la personne
    if (m) mask = m.getAsFloat32Array().slice(); // copie : le masque n'est valable que pendant l'appel
    r.close?.();
  });
  return mask;
}

/**
 * Cutter pour renderTemplate : rend un canvas détouré de la zone du calque, ou null (dessin normal).
 * Photos déjà prises : détourées une fois puis gardées. Live : recalculé à chaque image.
 */
export function createCutter(getScale) {
  const live = new Map();       // id du calque → canvas de travail
  const stills = new WeakMap(); // image prise → Map(clé → canvas détouré)

  const work = (canvas, src, sw, sh, l, d, mirror) => {
    const w = Math.max(1, Math.min(MAX_W, Math.round(d.w * getScale())));
    const h = Math.max(1, Math.round((w * d.h) / d.w));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    drawCover(ctx, src, sw, sh, { x: 0, y: 0, w, h }, mirror);
    const px = ctx.getImageData(0, 0, w, h);
    if (l.cutout === 'ai') {
      const mask = personMask(canvas);
      if (!mask) return false;
      // Mêmes curseurs que la photo finale ; le contour (±px) est approché en décalant le seuil
      const [lo, hi] = aiMatteRange(l, { contourShift: (l.aiContour || 0) * 0.015 });
      applyMatte(px.data, mask, 1, lo, hi);
    } else {
      chromaKey(px.data, l.cutout, l.keyTolerance);
    }
    ctx.putImageData(px, 0, 0);
    return true;
  };

  return (src, sw, sh, l, d, mirror, isLive) => {
    if (isLive) {
      let c = live.get(l.id);
      if (!c) { c = document.createElement('canvas'); live.set(l.id, c); }
      return work(c, src, sw, sh, l, d, mirror) ? c : null;
    }
    const key = `${l.id}|${l.cutout}|${l.keyTolerance}|${l.aiThreshold}|${l.aiSoftness}|${l.aiContour}|${mirror}|${Math.round(d.w * getScale())}`;
    let byKey = stills.get(src);
    if (!byKey) { byKey = new Map(); stills.set(src, byKey); }
    if (byKey.has(key)) return byKey.get(key);
    const c = document.createElement('canvas');
    if (!work(c, src, sw, sh, l, d, mirror)) return null; // modèle pas encore prêt : on réessaie à l'image suivante
    byKey.set(key, c);
    return c;
  };
}
