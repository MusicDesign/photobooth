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

/** Identifiant de session lisible : AAMMJJ-HHMMSS-xxxxxx */
export function newId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
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

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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
