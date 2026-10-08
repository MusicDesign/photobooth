import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { DATA_DIR } from './paths.js';

export const LOG_FILE = process.env.BOOTH_LOG_FILE || path.join(DATA_DIR, 'logs', 'booth.log');
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3000; // lignes gardées en mémoire pour le journal en direct de l'admin

/** Modules du journal en direct (filtres de l'admin), dans l'ordre d'affichage. */
export const LOG_CATEGORIES = [
  ['camera', 'Appareil photo'], ['printer', 'Imprimante'], ['screen', 'Écran'], ['lights', 'Lumières'],
  ['deck', 'Stream Deck'], ['sessions', 'Séances'], ['network', 'Réseau'], ['data', 'Données & USB'],
  ['system', 'Système'], ['api', 'Appels de la borne'], ['apiAdmin', 'Appels de l\'admin']
];

const BY_MODULE = {
  gphoto2: 'camera', camera: 'camera', calibrage: 'camera',
  cups: 'printer', printer: 'printer',
  screen: 'screen',
  lights: 'lights', govee: 'lights', elgato: 'lights', hue: 'lights',
  streamdeck: 'deck',
  booth: 'sessions', video: 'sessions', cutout: 'sessions',
  remote: 'network',
  usb: 'data', export: 'data', 'données': 'data', uploads: 'data', templates: 'data', config: 'data', logs: 'data'
};

/** Module d'une ligne : le préfixe [module] ; [devices] parle de tout le matériel, on regarde de quoi. */
export function categorize(module, msg = '') {
  if (module === 'devices') {
    if (/caméra|boîtier|appareil photo/i.test(msg)) return 'camera';
    if (/imprimante/i.test(msg)) return 'printer';
    if (/réseau|wi-?fi/i.test(msg)) return 'network';
    if (/stream deck/i.test(msg)) return 'deck';
    if (/lumière/i.test(msg)) return 'lights';
    if (/écran/i.test(msg)) return 'screen';
  }
  return BY_MODULE[module] || 'system';
}

const entries = [];
const listeners = new Set();
let seq = 0;

/**
 * Une ligne du journal : gardée en mémoire (journal en direct de l'admin) et passée aux abonnés (fichier).
 * opts.module / opts.cat : déjà connus (appels HTTP) ; sinon tirés du préfixe [module] du texte.
 * opts.file = false : pas dans booth.log (appels HTTP, trop nombreux pour le fichier).
 */
export function recordLog(level, text, opts = {}) {
  const m = opts.module ? null : text.match(/^\[([^\]]+)\]\s*/);
  const module = opts.module || m?.[1] || '';
  const msg = m ? text.slice(m[0].length) : text;
  const e = { id: ++seq, t: Date.now(), level, module, cat: opts.cat || categorize(module, msg), msg, text, file: opts.file !== false };
  entries.push(e);
  if (entries.length > KEEP) entries.shift();
  for (const fn of listeners) { try { fn(e); } catch { /* un abonné en panne ne bloque pas les autres */ } }
  return e;
}

/** Dernières lignes (les n plus récentes), sans le champ interne file. */
export const recentLogs = (n = KEEP) => entries.slice(-n).map(publicEntry);
export const publicEntry = ({ file, text, ...e }) => e;
/** Abonnement aux nouvelles lignes ; renvoie la fonction de désabonnement. */
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Tout ce que le serveur écrit dans le terminal (console.log / warn / error) passe aussi par recordLog. Une seule fois. */
let captured = false;
export function installLogCapture() {
  if (captured) return;
  captured = true;
  for (const [method, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => { orig(...args); recordLog(level, util.format(...args)); };
  }
}

/**
 * Copie le journal du terminal dans data/logs/booth.log, horodaté, pour diagnostiquer après coup (le terminal
 * n'est pas toujours visible sur la borne). Au-delà de 5 Mo, le fichier devient booth.log.1 (un seul ancien gardé).
 */
export function installFileLog(file = LOG_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  installLogCapture();
  onLog((e) => {
    if (!e.file) return;
    const line = `${new Date(e.t).toISOString()} ${e.level} ${e.text}\n`;
    try {
      if (size + line.length > MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch { /* disque plein, droits : le terminal reste la référence */ }
  });
  console.log(`[log] journal : ${file}`);
}
