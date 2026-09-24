import fs from 'node:fs';
import { BaseCamera } from './base.js';
import { MjpegBroadcaster } from './mjpeg.js';
import { samplePhotos } from '../samples.js';

/** Caméra simulée : boucle sur les photos d'exemple (voir samples.js). Sert aux tests automatiques. */
export class MockCamera extends BaseCamera {
  name = 'mock';

  constructor() {
    super();
    this.mjpeg = new MjpegBroadcaster();
    this.frames = [];
    this.i = 0;
  }

  async init() {
    const files = samplePhotos();
    if (!files.length) throw new Error('Aucune photo d\'exemple (public/assets/template-photo.jpg, ou lancer : npm run demo-assets)');
    this.frames = files.map((s) => fs.readFileSync(s.file));
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
