/**
 * Filtres que l'invité peut appliquer à ses photos sur l'écran « On la garde ? » (option de l'admin :
 * booth.filters). Partagé par le serveur, qui les applique pour de bon à tout le montage (photos, cadre, textes
 * et logo), et par la borne, qui s'en sert pour les vignettes.
 *
 *   matrix   : mélange des couleurs, 3×3 (rouge, vert, bleu de sortie en fonction de ceux d'entrée)
 *   contrast : contraste autour du gris moyen (1 = inchangé)
 *   lift     : éclaircissement des noirs, 0-255 (effet délavé)
 *   css      : équivalent approché pour les vignettes de la borne (CSS filter)
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
  { id: 'vivid', name: 'Éclatant', matrix: sat(1.4), contrast: 1.08, css: 'saturate(1.4) contrast(1.08)' }
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
