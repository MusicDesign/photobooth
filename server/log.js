import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { DATA_DIR } from './paths.js';

export const LOG_FILE = process.env.BOOTH_LOG_FILE || path.join(DATA_DIR, 'logs', 'booth.log');
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Copie tout ce que le serveur écrit dans le terminal (console.log / warn / error) dans data/logs/booth.log,
 * horodaté, pour diagnostiquer après coup (le terminal n'est pas toujours visible sur la borne).
 * Au-delà de 5 Mo, le fichier devient booth.log.1 (un seul ancien fichier gardé).
 */
export function installFileLog(file = LOG_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${util.format(...args)}\n`;
    try {
      if (size + line.length > MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch { /* disque plein, droits : le terminal reste la référence */ }
  };
  for (const [method, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => { orig(...args); write(level, args); };
  }
  console.log(`[log] journal : ${file}`);
}
