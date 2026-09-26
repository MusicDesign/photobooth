/**
 * Appareils que gphoto2 voit en USB mais ne sait pas piloter (ni déclenchement ni aperçu, lecture des photos
 * seulement) : téléphones, tablettes, lecteurs MTP. Un iPhone branché se présente « Apple iPhone (PTP mode) ».
 */
export const NOT_A_CAMERA = /\b(apple|iphone|ipad|ipod|android|galaxy|pixel|mtp)\b/i;

/** Lignes de « gphoto2 --auto-detect » : [{ model, port }] (port = usb:bus,appareil). */
export function parseAutoDetect(stdout) {
  return String(stdout).split('\n').map((l) => /^(.*?)\s+(usb:\S*)\s*$/i.exec(l)).filter(Boolean).map((m) => ({ model: displayName(m[1].trim()) || 'Boîtier', port: m[2] }));
}

// gphoto2 n'a qu'une fiche pour tous les iPhone, « Apple iPhone 5 (PTP mode) », quel que soit le modèle branché
const displayName = (model) => model.replace(/^Apple iPhone \d+[a-z]*\s*\(PTP mode\)$/i, 'iPhone (mode PTP)');
