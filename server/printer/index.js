import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MockPrinter } from './mock.js';
import { CupsPrinter } from './cups.js';
import { NonePrinter } from './none.js';

const execFileP = promisify(execFile);

/** 'auto' : cups si la file configurée répond, sinon printer.fallback (voir devices.js). */
export const PRINTER_DRIVERS = ['auto', 'mock', 'cups', 'none'];
export const PRINTER_FALLBACKS = ['none', 'mock'];

export function createPrinter(printerConfig) {
  switch (printerConfig.driver) {
    case 'cups': return new CupsPrinter(printerConfig.cups);
    case 'none': return new NonePrinter();
    case 'auto': throw new Error('createPrinter : "auto" doit être résolu par Devices');
    case 'mock':
    default: return new MockPrinter({ mockDelayMs: printerConfig.mockDelayMs });
  }
}

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const norm = (s) => decode(s).toLowerCase().replace(/[_\-]+/g, ' ').trim();

/**
 * L'imprimante photo est-elle prête ? Il faut une file CUPS nommée (pour ne jamais
 * imprimer sur une autre imprimante), non désactivée, et si elle est en USB,
 * physiquement présente : lpinfo liste les imprimantes USB réellement branchées.
 */
export async function detectCupsPrinter(cups = {}) {
  const name = (cups.name || '').trim();
  if (!name) return { found: false, reason: 'nom de la file CUPS non renseigné' };
  let state;
  try {
    ({ stdout: state } = await execFileP('lpstat', ['-p', name], { timeout: 5000 }));
  } catch (e) {
    if (/ENOENT/.test(e.message)) return { found: false, reason: 'CUPS (lpstat) non installé' };
    return { found: false, reason: `file CUPS « ${name} » inconnue` };
  }
  if (/disabled|désactiv|hors ligne|offline|paused|en pause/i.test(state)) return { found: false, reason: `file CUPS « ${name} » désactivée` };

  let uri = '';
  try {
    const { stdout } = await execFileP('lpstat', ['-v', name], { timeout: 5000 });
    uri = (stdout.match(/:\s*(\S+)\s*$/m) || [])[1] || '';
  } catch { /* on se fie à l'état de la file */ }
  const usb = uri.match(/^usb:\/\/([^/?]+)\/([^?]+)/i);
  if (usb) {
    const wanted = `${norm(usb[1])} ${norm(usb[2])}`;
    const present = await usbPrinterPresent(wanted);
    if (present === false) return { found: false, reason: `« ${decode(usb[1])} ${decode(usb[2])} » absente de l'USB (éteinte ? câble ?)` };
  }
  return { found: true, reason: `file CUPS « ${name} » prête${usb ? ' (USB)' : ''}` };
}

/** true / false, ou null si on ne peut pas savoir (outil absent, droits). */
async function usbPrinterPresent(wanted) {
  try {
    const { stdout } = await execFileP('lpinfo', ['--include-schemes', 'usb', '-v'], { timeout: 8000 });
    const found = stdout.split('\n').map((l) => l.match(/usb:\/\/([^/?]+)\/([^?\s]+)/i)).filter(Boolean)
      .some((m) => `${norm(m[1])} ${norm(m[2])}` === wanted);
    return found;
  } catch { /* lpinfo indisponible ou refusé : on essaie le bus USB */ }
  try {
    const [bin, args] = process.platform === 'darwin' ? ['ioreg', ['-p', 'IOUSB', '-l', '-w0']] : ['lsusb', []];
    const { stdout } = await execFileP(bin, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    const hay = stdout.toLowerCase().replace(/[_\-]+/g, ' ');
    const model = wanted.split(' ').slice(1).join(' ');
    return model ? hay.includes(model) : null;
  } catch { return null; }
}
