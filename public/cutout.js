/**
 * Détourage des calques photo (option « Détourage » d'un calque, dans l'éditeur de templates).
 * Partagé par la borne (aperçu en direct) et le serveur (photo finale) : même calcul, même résultat.
 *
 *   none  : photo telle quelle
 *   ai    : personnes détourées par un modèle (MediaPipe dans l'aperçu, MODNet sur la photo finale)
 *   green : fond vert retiré
 *   blue  : fond bleu retiré
 *
 * Les calques placés sous la photo apparaissent à travers les parties retirées.
 */
export const CUTOUT_MODES = ['none', 'ai', 'green', 'blue'];
export const DEFAULT_TOLERANCE = 50;

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
