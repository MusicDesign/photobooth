import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BasePrinter } from './base.js';

const execFileP = promisify(execFile);

/**
 * Impression via CUPS (commande lp). Fonctionne sur Raspberry Pi avec le pilote
 * Gutenprint (DNP, HiTi, Canon Selphy…) et sur macOS.
 *
 * ÉTAPE 3 : À VALIDER avec l'imprimante réelle (nom de file, option media, marges).
 */
export class CupsPrinter extends BasePrinter {
  name = 'cups';

  constructor(opts = {}) {
    super();
    this.printerName = opts.name || '';
    this.options = opts.options || [];
    this.watchers = new Map();
  }

  async init() {
    try {
      const { stdout } = await execFileP('lpstat', ['-p']);
      console.log(`[cups] ${stdout.trim().split('\n')[0] || 'aucune imprimante'}`);
    } catch (e) {
      console.warn(`[cups] lpstat indisponible : ${e.message}`);
    }
  }

  async print(file, copies, meta = {}) {
    const args = [];
    if (this.printerName) args.push('-d', this.printerName);
    args.push('-n', String(copies));
    for (const o of this.options) args.push('-o', o);
    if (meta.sessionId) args.push('-t', `booth-${meta.sessionId}`);
    args.push(file);
    const { stdout } = await execFileP('lp', args);
    // Réponse type : "request id is DNP-42 (1 file(s))"
    const m = stdout.match(/request id is (\S+)/i);
    const jobId = m ? m[1] : `lp-${Date.now()}`;
    this.emit('job', { jobId, status: 'queued' });
    this.watch(jobId);
    return { jobId };
  }

  watch(jobId) {
    const started = Date.now();
    const tick = async () => {
      try {
        const { stdout } = await execFileP('lpstat', ['-W', 'not-completed', '-o']);
        const pending = stdout.split('\n').some((l) => l.startsWith(jobId));
        if (!pending) {
          this.emit('job', { jobId, status: 'done' });
          return;
        }
        this.emit('job', { jobId, status: 'printing' });
        if (Date.now() - started > 5 * 60 * 1000) {
          this.emit('job', { jobId, status: 'error', message: 'Impression bloquée depuis 5 min (papier ? bourrage ?)' });
          return;
        }
      } catch (e) {
        this.emit('job', { jobId, status: 'error', message: e.message });
        return;
      }
      this.watchers.set(jobId, setTimeout(tick, 2000));
    };
    this.watchers.set(jobId, setTimeout(tick, 1500));
  }

  async status() {
    try {
      const args = this.printerName ? ['-p', this.printerName] : ['-p'];
      const { stdout } = await execFileP('lpstat', args);
      const line = stdout.trim().split('\n')[0] || '';
      return { driver: this.name, ok: !/disabled|hors ligne|désactiv/i.test(line), message: line };
    } catch (e) {
      return { driver: this.name, ok: false, message: e.message };
    }
  }

  async shutdown() {
    for (const t of this.watchers.values()) clearTimeout(t);
  }
}
