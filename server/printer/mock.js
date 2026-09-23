import fs from 'node:fs';
import path from 'node:path';
import { BasePrinter } from './base.js';
import { PRINTS_DIR } from '../paths.js';

/** Imprimante simulée : copie le fichier final dans output/prints et simule le délai. */
export class MockPrinter extends BasePrinter {
  name = 'mock';

  constructor(opts = {}) {
    super();
    this.delayMs = opts.mockDelayMs ?? 3000;
    this.seq = 0;
  }

  async init() {
    fs.mkdirSync(PRINTS_DIR, { recursive: true });
  }

  async print(file, copies, meta = {}) {
    const jobId = `mock-${Date.now()}-${++this.seq}`;
    const out = path.join(PRINTS_DIR, `${path.basename(file, path.extname(file))}-${meta.sessionId || 'x'}-x${copies}.jpg`);
    fs.copyFileSync(file, out);
    this.emit('job', { jobId, status: 'queued' });
    setTimeout(() => this.emit('job', { jobId, status: 'printing' }), 200);
    setTimeout(() => this.emit('job', { jobId, status: 'done', message: `Fichier écrit : ${out}` }), this.delayMs);
    return { jobId, file: out };
  }

  async status() {
    return { driver: this.name, ok: true, message: `Simulation, fichiers dans ${PRINTS_DIR}` };
  }
}
