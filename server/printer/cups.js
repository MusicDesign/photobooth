import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BasePrinter } from './base.js';

const execFileP = promisify(execFile);
const LPSTAT_MAX_FAILURES = 5;

/** Le tirage est-il dans la sortie de lpstat -o ? Ligne type : "DNP-42   lucas   1024   …" (DNP-4 ne trouve pas DNP-42). */
export function jobListed(stdout, jobId) {
  return stdout.split('\n').some((l) => l.split(/\s/)[0] === jobId);
}

/**
 * Impression via CUPS (commande lp). Fonctionne sous Linux avec le pilote
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

  /** Tirage lancé avant un redémarrage : la file CUPS dit s'il est sorti ou pas encore. */
  resume(jobId) {
    this.watch(jobId);
  }

  watch(jobId) {
    const started = Date.now();
    let stalled = false;
    let failures = 0; // lpstat en échec d'affilée
    const tick = async () => {
      try {
        const { stdout } = await execFileP('lpstat', ['-W', 'not-completed', '-o'], { timeout: 10000 });
        failures = 0;
        const pending = jobListed(stdout, jobId);
        if (!pending) {
          this.watchers.delete(jobId);
          this.emit('job', { jobId, status: 'done' });
          return;
        }
        if (!stalled) this.emit('job', { jobId, status: 'printing' });
        if (!stalled && Date.now() - started > 5 * 60 * 1000) {
          // Le tirage reste dans la file CUPS et sortira une fois le papier remis : on continue de le
          // surveiller (plus lentement) pour signaler 'done' s'il finit par sortir.
          stalled = true;
          this.emit('job', { jobId, status: 'error', message: 'Impression bloquée depuis 5 min (papier ? bourrage ?)' });
        }
      } catch (e) {
        // Échec passager (CUPS qui redémarre) : on réessaie ; au-delà, fin du suivi (final : la borne l'oublie)
        if (++failures >= LPSTAT_MAX_FAILURES) {
          this.watchers.delete(jobId);
          this.emit('job', { jobId, status: 'error', final: true, message: `Suivi de l'impression impossible : ${e.message}` });
          return;
        }
      }
      this.watchers.set(jobId, setTimeout(tick, stalled ? 10000 : 2000));
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
