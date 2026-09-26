import fs from 'node:fs';
import sharp from 'sharp';
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

  /** Vidéo simulée : la photo d'exemple qui se rapproche et glisse, pour voir l'aller-retour. */
  async recordClip({ durationMs, fps }) {
    const src = this.frames[0];
    const { width: w, height: h } = await sharp(src).metadata();
    const n = Math.max(2, Math.round((durationMs / 1000) * fps));
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = 1 - 0.25 * (i / (n - 1)); // zoom de 0 à 25 %
      const cw = Math.round(w * k), ch = Math.round(h * k);
      out.push(await sharp(src).extract({ left: Math.round((w - cw) * (i / (n - 1))), top: Math.round((h - ch) / 2), width: cw, height: ch }).resize(960, Math.round((960 * h) / w)).jpeg({ quality: 85 }).toBuffer());
    }
    await new Promise((r) => setTimeout(r, Math.min(durationMs, 400))); // le temps de filmer, raccourci
    return out;
  }

  attachLiveClient(res) {
    this.mjpeg.attach(res);
  }

  async shutdown() {
    clearInterval(this.timer);
    this.mjpeg.close();
  }
}
