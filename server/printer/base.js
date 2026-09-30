import { EventEmitter } from 'node:events';

/**
 * Un pilote d'impression émet des événements 'job' :
 * { jobId, status: 'queued' | 'printing' | 'done' | 'error', message? }
 */
export class BasePrinter extends EventEmitter {
  name = 'base';
  /** false : l'impression est désactivée, l'invité termine avec le QR code. */
  available = true;

  async init() {}

  /** Lance l'impression. Retourne { jobId }. */
  async print(file, copies, meta = {}) {
    throw new Error(`print() non disponible pour le pilote ${this.name}`);
  }

  /**
   * Tirage lancé avant un redémarrage de la borne : son suivi était en mémoire. Un pilote qui peut interroger
   * sa file (CUPS) le reprend ; les autres ne peuvent plus rien savoir et le considèrent comme sorti.
   */
  resume(jobId) {
    setImmediate(() => this.emit('job', { jobId, status: 'done', message: 'Suivi perdu au redémarrage : considéré comme sorti' }));
  }

  async status() {
    return { driver: this.name, ok: true, message: '' };
  }

  async shutdown() {}
}
