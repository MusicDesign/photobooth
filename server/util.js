import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ouvre le serveur sur port, ou le suivant libre si une autre application l'occupe (3000, 3001… tries ports).
 * Retourne le port ouvert. BOOTH_PORT_FILE : il y est écrit, pour le lanceur Chromium (scripts/kiosk/photobooth.sh).
 */
export async function listenFree(server, port, { tries = 10 } = {}) {
  for (let p = port; ; p++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, () => { server.off('error', reject); resolve(); });
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || !port || p >= port + tries - 1) throw e.code === 'EADDRINUSE' ? new Error(`ports ${port} à ${p} déjà utilisés par d'autres applications`) : e;
      console.warn(`[server] port ${p} déjà utilisé, essai sur ${p + 1}`);
    }
  }
  const open = server.address().port;
  if (process.env.BOOTH_PORT_FILE) fs.writeFileSync(process.env.BOOTH_PORT_FILE, String(open));
  return open;
}

/**
 * Identifiant de session court, pour l'adresse du QR code : 6 lettres et chiffres sans caractères ambigus (ni 0/o, ni 1/l/i),
 * par exemple k7m2qx. exists(id) : déjà pris (le tirage est refait). Les anciens identifiants AAMMJJ-HHMMSS-xxxxxx restent valables.
 */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newId(exists = () => false) {
  for (;;) {
    const id = Array.from(crypto.randomBytes(6), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
    if (!exists(id)) return id;
  }
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fusion profonde : les objets sont fusionnés, tout le reste (tableaux inclus) est remplacé. */
export function deepMerge(target, patch) {
  if (!isPlainObject(patch)) return target;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = isPlainObject(v) ? deepMerge({}, v) : v;
  }
  return target;
}

export const clone = (o) => structuredClone(o);

const pad2 = (n) => String(n).padStart(2, '0');
/** Date du jour à l'heure de la borne (AAAA-MM-JJ), pas celle de Greenwich : après minuit UTC, c'est encore « aujourd'hui ». */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Horodatage local triable pour les noms de fichiers : 2026-10-08_20h34m05. */
export const localStamp = (d = new Date()) => `${localDate(d)}_${pad2(d.getHours())}h${pad2(d.getMinutes())}m${pad2(d.getSeconds())}`;

/**
 * Nom de fichier ou de dossier valable partout, clés FAT/exFAT et Windows compris : ni caractères interdits ni
 * caractères de contrôle, pas de point ni d'espace final, longueur bornée.
 */
export function safeName(s, max = 120) {
  let out = String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  out = [...out].slice(0, max).join('').replace(/[. ]+$/, '');
  return out || 'sans nom';
}

/**
 * Écriture sûre : fichier temporaire forcé sur le disque (fsync), puis renommé d'un coup. Une coupure de
 * courant laisse l'ancienne version ou la nouvelle, jamais un fichier vide ou à moitié écrit.
 */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* jamais créé */ } // disque plein : pas de .tmp abandonné qui l'encombre
    throw e;
  }
  try { const dir = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dir); fs.closeSync(dir); } catch { /* dossier : pas partout (Windows) */ }
}

const backupDir = (file) => path.join(path.dirname(file), 'backups');
const backupPrefix = (file) => `${path.basename(file, '.json')}-`;

/** Copie datée dans backups/ (à côté du fichier), en gardant les `keep` plus récentes. */
export function backupJson(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const dir = backupDir(file);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(dir, `${backupPrefix(file)}${stamp}.json`);
  fs.copyFileSync(file, dest);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(backupPrefix(file)) && f.endsWith('.json')).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return dest;
}

/**
 * Lecture protégée d'un fichier de données. Absent : null. Illisible (disque, coupure) : mis de côté sous un
 * nom daté (jamais écrasé ensuite), puis dernière sauvegarde lisible de backups/. Rend { data, warning }.
 */
export function loadJsonSafe(file, label) {
  if (!fs.existsSync(file)) return { data: null, warning: null };
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), warning: null };
  } catch (e) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // au millième : deux incidents ne s'écrasent pas
    const aside = `${file}.illisible-${stamp}`;
    try { fs.renameSync(file, aside); } catch { /* laissé en place */ }
    const dir = backupDir(file);
    const backups = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(backupPrefix(file)) && f.endsWith('.json')).sort().reverse() : [];
    for (const b of backups) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, b), 'utf8'));
        const warning = `${label} illisible (${e.message.split('\n')[0]}) : reprise de la sauvegarde ${b}. Fichier abîmé gardé : ${path.basename(aside)}.`;
        console.error(`[données] ${warning}`);
        return { data, warning };
      } catch { /* sauvegarde abîmée aussi : la suivante */ }
    }
    const warning = `${label} illisible et aucune sauvegarde lisible : départ à neuf. Fichier abîmé gardé : ${path.basename(aside)}.`;
    console.error(`[données] ${warning}`);
    return { data: null, warning };
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Première IPv4 non locale : sert à fabriquer l'URL de partage affichée dans le QR code. */
export function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

/** Requête venue de la machine elle-même : l'écran de la borne (les téléphones arrivent par le réseau). */
export function isLocalRequest(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
