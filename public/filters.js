/**
 * Filtres que l'invité peut appliquer à ses photos sur l'écran « On la garde ? » (option de l'admin :
 * booth.filters). Partagé par le serveur, qui les applique pour de bon à tout le montage (photos, cadre, textes
 * et logo), et par la borne, qui s'en sert pour les vignettes.
 *
 *   matrix   : mélange des couleurs, 3×3 (rouge, vert, bleu de sortie en fonction de ceux d'entrée)
 *   contrast : contraste autour du gris moyen (1 = inchangé)
 *   lift     : éclaircissement des noirs, 0-255 (effet délavé)
 *   grain    : grain argentique, écart type en fraction de 255, sur les photos seulement (pas le cadre ni les textes)
 *   css      : équivalent approché pour les vignettes de la borne (CSS filter ; url(#grain) : index.html)
 */
const L = [0.299, 0.587, 0.114];
const sat = (s) => [
  0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
  0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
  0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s
];
const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
const mixM = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const FILTERS = [
  { id: 'none', name: 'Couleur', matrix: ID, css: 'none' },
  { id: 'bw', name: 'Noir & blanc', matrix: [...L, ...L, ...L], css: 'grayscale(1)' },
  { id: 'noir', name: 'N&B contrasté', matrix: [...L, ...L, ...L], contrast: 1.35, css: 'grayscale(1) contrast(1.35)' },
  { id: 'sepia', name: 'Sépia', matrix: SEPIA, css: 'sepia(1)' },
  { id: 'vintage', name: 'Vintage', matrix: mixM(ID, SEPIA, 0.45), contrast: 0.92, lift: 18, css: 'sepia(0.45) contrast(0.92) brightness(1.05)' },
  { id: 'warm', name: 'Chaud', matrix: [1.1, 0.05, 0, 0, 1.02, 0, 0, 0, 0.85], css: 'sepia(0.2) saturate(1.15)' },
  { id: 'cool', name: 'Froid', matrix: [0.88, 0, 0, 0, 1, 0.04, 0, 0.04, 1.12], css: 'hue-rotate(12deg) saturate(0.9) brightness(1.03)' },
  { id: 'vivid', name: 'Éclatant', matrix: sat(1.4), contrast: 1.08, css: 'saturate(1.4) contrast(1.08)' },
  { id: 'film', name: 'Argentique', matrix: mixM(sat(0.85), SEPIA, 0.2), contrast: 1.06, lift: 10, grain: 0.04, css: 'url(#grain) sepia(0.2) saturate(0.85) contrast(1.06)' },
  { id: 'filmbw', name: 'N&B argentique', matrix: [...L, ...L, ...L], contrast: 1.2, lift: 6, grain: 0.055, css: 'url(#grain) grayscale(1) contrast(1.2)' }
];
export const FILTER_IDS = FILTERS.map((f) => f.id);
export const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

/** Applique un filtre à des pixels RGBA (modifiés en place ; l'alpha, détourage compris, est gardé). */
export function applyFilter(px, id) {
  const f = filterById(id);
  if (f.id === 'none') return px;
  const m = f.matrix, c = f.contrast ?? 1, lift = f.lift ?? 0;
  const k = (255 - lift) / 255;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    for (let ch = 0; ch < 3; ch++) {
      let v = m[ch * 3] * r + m[ch * 3 + 1] * g + m[ch * 3 + 2] * b;
      if (c !== 1) v = (v - 128) * c + 128;
      if (lift) v = lift + v * k;
      px[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return px;
}

/** Générateur pseudo-aléatoire à graine (mulberry32) : même grain d'une image à l'autre d'un GIF. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grain du filtre sur une photo, pixels RGBA (modifiés en place, alpha gardé). Bruit monochrome, plus fort dans
 * les gris moyens que dans les noirs et les blancs comme sur un film, en grains d'environ un millième de la photo
 * (lissés) pour rester visible à l'impression.
 */
export function applyGrain(px, w, h, id, seed = 1) {
  const amount = filterById(id).grain;
  if (!amount) return px;
  const cell = Math.max(1, Math.max(w, h) / 1000);
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const rand = rng(seed);
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = (rand() + rand() + rand() - 1.5) * 2; // écart type 1
  const a = amount * 255;
  for (let y = 0; y < h; y++) {
    const fy = y / cell, y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x / cell, x0 = fx | 0, tx = fx - x0, o = y0 * gw + x0;
      const n = (g[o] * (1 - tx) + g[o + 1] * tx) * (1 - ty) + (g[o + gw] * (1 - tx) + g[o + gw + 1] * tx) * ty;
      const i = (y * w + x) * 4;
      const l = (L[0] * px[i] + L[1] * px[i + 1] + L[2] * px[i + 2]) / 255;
      const d = n * a * (0.35 + 2.6 * l * (1 - l));
      for (let ch = 0; ch < 3; ch++) { const v = px[i + ch] + d; px[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v; }
    }
  }
  return px;
}
