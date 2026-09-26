/**
 * Détourage des calques photo (option « Détourage » d'un calque, dans l'éditeur de templates).
 * Partagé par la borne (aperçu en direct) et le serveur (photo finale) : même calcul, même résultat.
 *
 *   none  : photo telle quelle
 *   ai    : sujet détouré par un modèle (MediaPipe dans l'aperçu ; BiRefNet ou MODNet sur la photo finale)
 *   green : fond vert retiré
 *   blue  : fond bleu retiré
 *
 * Les calques placés sous la photo apparaissent à travers les parties retirées.
 */
export const CUTOUT_MODES = ['none', 'ai', 'green', 'blue'];
export const DEFAULT_TOLERANCE = 50;

/**
 * Curseurs du détourage IA (calque photo) :
 *   aiThreshold 0-100 : plus haut, on retire plus de fond ; plus bas, on garde plus de la personne
 *   aiSoftness  0-100 : bord net (0) ou fondu (100)
 *   aiContour  -10…10 : rétrécit (négatif) ou élargit (positif) la découpe, en pixels de la photo finale
 *   aiPrecision       : modèle de la photo finale, 'precise' (BiRefNet : tout sujet, bords propres, quelques
 *                       secondes) ou 'fast' (MODNet : personnes seulement, instantané)
 */
export const AI_DEFAULTS = { aiThreshold: 50, aiSoftness: 50, aiContour: 0, aiPrecision: 'precise' };
export const AI_MODELS = ['precise', 'fast'];

/** Seuils [lo, hi] (fraction du masque, 0-1) entre lesquels le bord est progressif, d'après les curseurs. */
export function aiMatteRange(layer = {}, { contourShift = 0 } = {}) {
  const t = Math.max(0, Math.min(100, layer.aiThreshold ?? AI_DEFAULTS.aiThreshold)) / 100;
  const soft = Math.max(0, Math.min(100, layer.aiSoftness ?? AI_DEFAULTS.aiSoftness)) / 100;
  const center = 0.2 + 0.6 * t - contourShift;  // seuil 50 → 0,5
  const width = 0.04 + 0.66 * soft;             // douceur 50 → 0,37
  return [Math.max(0, center - width / 2), Math.min(1, center + width / 2)];
}

/**
 * Fond vert ou bleu, sur des pixels RGBA (modifiés en place). Un pixel est du fond quand la couleur du
 * fond domine les deux autres canaux ; le bord est progressif. Le reflet du fond sur le sujet
 * (liseré vert autour des cheveux) est ramené au niveau des autres canaux.
 * tolerance 0-100 : plus haut = retire aussi les nuances plus sombres ou moins saturées du fond.
 */
export function chromaKey(px, color, tolerance = DEFAULT_TOLERANCE) {
  const k = color === 'blue' ? 2 : 1;          // canal du fond
  const [a, b] = k === 1 ? [0, 2] : [0, 1];    // les deux autres
  const t = Math.max(0, Math.min(100, Number(tolerance) || 0));
  const hi = 110 - t;                          // dominance à partir de laquelle le pixel est entièrement du fond
  const lo = hi * 0.4;                         // en dessous : sujet, opaque
  for (let i = 0; i < px.length; i += 4) {
    const other = Math.max(px[i + a], px[i + b]);
    const d = px[i + k] - other;
    if (d <= 0) continue;
    px[i + k] = other; // reflet du fond
    if (d <= lo) continue;
    if (d >= hi) { px[i + 3] = 0; continue; }
    const s = (d - lo) / (hi - lo);
    px[i + 3] = Math.round(px[i + 3] * (1 - s * s * (3 - 2 * s)));
  }
  return px;
}

/**
 * Applique un masque de personne (une valeur par pixel, 0 = fond, max = personne) à l'alpha de pixels RGBA.
 * max : valeur d'une personne sûre (1 pour un masque flottant, 255 pour des octets).
 * lo / hi : seuils (fraction de max) entre lesquels le bord est progressif.
 */
export function applyMatte(px, matte, max = 1, lo = 0, hi = 1) {
  const n = Math.min(matte.length, px.length / 4);
  for (let i = 0; i < n; i++) {
    let m = matte[i] / max;
    m = m <= lo ? 0 : m >= hi ? 1 : (m - lo) / (hi - lo);
    px[i * 4 + 3] = Math.round(px[i * 4 + 3] * m);
  }
  return px;
}

/**
 * Fond uni d'une image importée (logo sur blanc…), sur des pixels RGBA w×h (modifiés en place).
 * color '#rrggbb' ; tolerance 0-100 : écart de couleur accepté ; contiguous : ne retire que le fond relié
 * aux bords de l'image (garde le blanc à l'intérieur d'un logo, des yeux, des lettres).
 */
export function removeColor(px, w, h, { color = '#ffffff', tolerance = 30, contiguous = true } = {}) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color) || [0, 'ffffff'];
  const [cr, cg, cb] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const hi = 0.02 + (Math.max(0, Math.min(100, tolerance)) / 100) * 0.5; // écart (0-1) sous lequel c'est du fond
  const lo = hi * 0.5;
  const n = w * h;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4] - cr, g = px[i * 4 + 1] - cg, b = px[i * 4 + 2] - cb;
    dist[i] = Math.sqrt(r * r + g * g + b * b) / 441.7;
  }
  let bg = null; // pixels de fond reliés aux bords (parcours en largeur)
  if (contiguous) {
    bg = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    const push = (i) => { if (!bg[i] && dist[i] < hi) { bg[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (head < tail) {
      const i = queue[head++], x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < n - w) push(i + w);
    }
  }
  for (let i = 0; i < n; i++) {
    if (bg && !bg[i]) continue;
    const d = dist[i];
    if (d >= hi) continue;
    const a = d <= lo ? 0 : (d - lo) / (hi - lo);
    px[i * 4 + 3] = Math.round(px[i * 4 + 3] * a);
  }
  return px;
}
