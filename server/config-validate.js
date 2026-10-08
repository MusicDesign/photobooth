import { coerceNumbers } from './config.js';
import { CAMERA_DRIVERS, CAMERA_FALLBACKS } from './camera/index.js';
import { PRINTER_DRIVERS, PRINTER_FALLBACKS } from './printer/index.js';
import { FORMATS } from './templates.js';
import { HttpError, isPlainObject } from './util.js';

/**
 * Vérification des réglages reçus, la même pour l'admin (PUT /config) et pour l'import d'un fichier de configuration
 * (config-bundle.js) : nombres dans leurs bornes, valeurs à choix, codes, adresses des images envoyées, cadres.
 */

/** Sections modifiables depuis l'admin et par import. */
export const EDITABLE_SECTIONS = ['booth', 'camera', 'printer', 'limits', 'templates', 'theme', 'texts', 'admin', 'share', 'gallery', 'lights', 'screen', 'usb'];

/** Bornes des réglages numériques : chemin → [min, max]. Valeurs entières. */
const LIGHT_RANGES = (p) => ({
  [`${p}.idle.kelvin`]: [1000, 10000],
  [`${p}.idle.brightness`]: [0, 100],
  [`${p}.idle.periodSec`]: [1, 3600],
  [`${p}.shooting.kelvin`]: [1000, 10000],
  [`${p}.shooting.brightness`]: [0, 100],
  [`${p}.shooting.waitBrightness`]: [0, 100],
  [`${p}.shutdown.kelvin`]: [1000, 10000],
  [`${p}.shutdown.brightness`]: [0, 100]
});
export const NUMBER_RANGES = {
  'booth.idleReturnSec': [5, 3600],
  'booth.menuIdleSec': [0, 3600],
  'booth.streamDeck.brightness': [0, 100],
  'camera.gphoto2.flashAutoThreshold': [0, 255],
  'camera.gphoto2.settleMs': [0, 10000],
  'camera.gphoto2.liveIdleMs': [0, 3600000],
  'printer.mockDelayMs': [0, 60000],
  'limits.maxCopiesPerSession': [1, 50],
  'limits.eventQuota': [0, 100000],
  'limits.maxRetakesPerSession': [-1, 50],
  'limits.reviewTimeoutSec': [0, 600],
  'limits.copiesTimeoutSec': [0, 600],
  'limits.captureTimeoutSec': [0, 600],
  'limits.countdownSec': [1, 10],
  'limits.lowPaperThreshold': [0, 100000],
  'limits.operatorMaxCopies': [1, 100],
  ...LIGHT_RANGES('lights'),
  ...LIGHT_RANGES('lights.whiteLights'),
  'lights.whiteLights.idle.kelvinMin': [1000, 10000],
  'lights.whiteLights.idle.kelvinMax': [1000, 10000]
};

/** Code opérateur : saisi sur le pavé de la borne (8 chiffres au plus). Vide ou trop court, n'importe qui lèverait les limites. */
export const OPERATOR_PIN = /^\d{4,8}$/; // le pavé de la borne : chiffres seulement, 8 au plus
export const ADMIN_PIN = /^(\d{4,8})?$/; // vide = admin ouvert (tests)
/** Logo et image de fond : fichiers envoyés depuis l'admin (POST /logo, /background), rien d'autre. */
const UPLOAD_URL = /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Réglages de l'écran (DDC/CI) : luminosité et volume de 0 à 100, ou null = la borne n'y touche pas. */
export function screenPatch(body = {}) {
  const out = {};
  for (const k of ['brightness', 'volume']) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 100)) throw new HttpError(400, 'SCREEN_VALUE', `${k === 'volume' ? 'Volume' : 'Luminosité'} de l'écran : nombre entier de 0 à 100, ou vide`);
    out[k] = v;
  }
  if ('display' in body) out.display = String(body.display || '').slice(0, 120);
  return out;
}

const parentOf = (o, keys) => keys.reduce((x, k) => (isPlainObject(x) ? x[k] : undefined), o);
const has = (o, k) => isPlainObject(o) && Object.hasOwn(o, k);

/**
 * Vérifie et normalise patch sur place (sections de la config). Erreur HTTP 400 au premier réglage refusé.
 * clamp : nombre hors bornes ramené dans ses bornes (import d'un fichier d'une version précédente) au lieu d'être refusé.
 * templateIds : cadres présents (Set) ; templates.enabled / default qui n'en font pas partie sont refusés.
 */
export function validateConfigPatch(patch, { clamp = false, templateIds = null } = {}) {
  const notNumber = coerceNumbers(patch);
  if (notNumber) throw new HttpError(400, 'NUMBER', `Nombre attendu pour « ${notNumber} »`);
  for (const [p, [min, max]] of Object.entries(NUMBER_RANGES)) {
    const keys = p.split('.');
    const parent = parentOf(patch, keys.slice(0, -1));
    const k = keys.at(-1);
    if (!has(parent, k) || typeof parent[k] !== 'number') continue;
    const v = Math.round(parent[k]);
    if (v < min || v > max) {
      if (!clamp) throw new HttpError(400, 'NUMBER', `« ${p} » : nombre de ${min} à ${max}`);
      parent[k] = Math.min(max, Math.max(min, v));
    } else parent[k] = v;
  }

  const oneOf = (section, key, list, code, message) => {
    const o = patch[section];
    if (has(o, key) && !list.includes(o[key])) throw new HttpError(400, code, message);
  };
  oneOf('booth', 'touch', ['auto', 'touch', 'buttons'], 'TOUCH', 'Mode d\'écran tactile inconnu');
  oneOf('booth', 'window', ['kiosk', 'fullscreen'], 'WINDOW', 'Mode de fenêtre inconnu');
  oneOf('usb', 'content', ['originals', 'finals', 'both'], 'USB_CONTENT', 'Contenu attendu : originals, finals ou both');
  oneOf('camera', 'driver', CAMERA_DRIVERS, 'DRIVER', 'Pilote caméra inconnu');
  oneOf('camera', 'fallback', CAMERA_FALLBACKS, 'DRIVER', 'Repli caméra inconnu');
  oneOf('printer', 'driver', PRINTER_DRIVERS, 'DRIVER', 'Pilote imprimante inconnu');
  oneOf('printer', 'fallback', PRINTER_FALLBACKS, 'DRIVER', 'Repli imprimante inconnu');
  oneOf('templates', 'defaultFormat', Object.keys(FORMATS), 'FORMAT', 'Format inconnu');
  if (isPlainObject(patch.screen)) patch.screen = screenPatch(patch.screen);

  if (has(patch.admin, 'pin')) {
    const pin = String(patch.admin.pin ?? '').trim();
    if (!ADMIN_PIN.test(pin)) throw new HttpError(400, 'ADMIN_PIN', 'Code admin : 4 à 8 chiffres, ou vide');
    patch.admin.pin = pin;
  }
  if (has(patch.limits, 'operatorPin')) {
    const pin = String(patch.limits.operatorPin ?? '').trim();
    if (!OPERATOR_PIN.test(pin)) throw new HttpError(400, 'OPERATOR_PIN', 'Code opérateur : 4 à 8 chiffres');
    patch.limits.operatorPin = pin;
  }

  for (const [section, sub] of [['booth'], ['theme', 'custom']]) {
    const o = sub ? parentOf(patch, [section, sub]) : patch[section];
    for (const k of ['logo', 'backgroundImage']) {
      if (!has(o, k)) continue;
      if (o[k] === '' || o[k] === null) { o[k] = ''; continue; }
      if (typeof o[k] !== 'string' || !UPLOAD_URL.test(o[k])) throw new HttpError(400, 'UPLOAD_URL', `${k === 'logo' ? 'Logo' : 'Image de fond'} : fichier envoyé depuis l'admin attendu`);
    }
  }

  const t = patch.templates;
  if (isPlainObject(t)) {
    for (const k of ['enabled', 'order']) {
      if (!has(t, k)) continue;
      if (!Array.isArray(t[k]) || !t[k].every((id) => typeof id === 'string')) throw new HttpError(400, 'TEMPLATES_LIST', `templates.${k} : liste d'identifiants de cadres attendue`);
      t[k] = [...new Set(t[k])];
    }
    if (has(t, 'default') && typeof t.default !== 'string') throw new HttpError(400, 'TEMPLATES_DEFAULT', 'Cadre par défaut invalide');
    if (templateIds) {
      const unknown = [...(t.enabled || []), ...(t.default ? [t.default] : [])].find((id) => !templateIds.has(id));
      if (unknown) throw new HttpError(400, 'TEMPLATE_NOT_FOUND', `Template inconnu : ${unknown}`);
    }
  }
  return patch;
}
