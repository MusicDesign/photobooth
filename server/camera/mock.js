import fs from 'node:fs';
import path from 'node:path';
import { BaseCamera } from './base.js';
import { MjpegBroadcaster } from './mjpeg.js';
import { SAMPLES_DIR } from '../paths.js';

/** Caméra simulée : boucle sur data/samples/*.jpg. Sert aux tests automatiques. */
export class MockCamera extends BaseCamera {
  name = 'mock';

  constructor() {
    super();
    this.mjpeg = new MjpegBroadcaster();
    this.frames = [];
    this.i = 0;
  }

  async init() {
    const files = fs.existsSync(SAMPLES_DIR)
      ? fs.readdirSync(SAMPLES_DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()
      : [];
    if (!files.length) throw new Error(`Aucune image d'exemple dans ${SAMPLES_DIR} (lancer: npm run demo-assets)`);
    this.frames = files.map((f) => fs.readFileSync(path.join(SAMPLES_DIR, f)));
    let k = 0;
    this.timer = setInterval(() => this.mjpeg.push(this.frames[k++ % this.frames.length]), 700);
  }

  async capture(destFile) {
    fs.writeFileSync(destFile, this.frames[this.i++ % this.frames.length]);
    return destFile;
  }

  attachLiveClient(res) {
    this.mjpeg.attach(res);
  }

  async shutdown() {
    clearInterval(this.timer);
    this.mjpeg.close();
  }
}
