/**
 * Diffuseur MJPEG : reçoit des images JPEG et les pousse à tous les navigateurs
 * connectés sur /api/live.mjpeg (multipart/x-mixed-replace).
 */
export class MjpegBroadcaster {
  constructor() {
    this.clients = new Set();
    this.listeners = new Set(); // enregistrements en cours (boomerang), voir record()
    this.last = null;
  }

  attach(res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close'
    });
    this.clients.add(res);
    if (this.last) this.write(res, this.last);
    res.on('close', () => this.clients.delete(res));
  }

  write(res, jpeg) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write('\r\n');
  }

  push(jpeg) {
    this.last = jpeg;
    for (const fn of this.listeners) fn(jpeg);
    for (const res of this.clients) {
      if (res.writableEnded || res.destroyed) {
        this.clients.delete(res);
        continue;
      }
      this.write(res, jpeg);
    }
  }

  close() {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  /**
   * Enregistre le flux pendant durationMs, à fps images par seconde au plus (boomerang) : l'aperçu continue
   * pendant ce temps. Attend la première image au plus waitMs. Rend les JPEG dans l'ordre.
   */
  record({ durationMs, fps, waitMs = 4000 }) {
    return new Promise((resolve, reject) => {
      const frames = [];
      const step = 1000 / fps;
      let start = 0, next = 0;
      const done = (err) => { this.listeners.delete(onFrame); clearTimeout(wait); err ? reject(err) : resolve(frames); };
      const onFrame = (jpeg) => {
        const now = Date.now();
        if (!start) { start = now; next = now; clearTimeout(wait); setTimeout(() => done(), durationMs); }
        if (now >= next - step / 3) { frames.push(jpeg); next += step; if (next < now - step) next = now + step; }
      };
      const wait = setTimeout(() => done(new Error('l\'aperçu du boîtier n\'envoie pas d\'images')), waitMs);
      this.listeners.add(onFrame);
    });
  }
}

/**
 * Découpe un flux binaire en images JPEG complètes (marqueurs FFD8 … FFD9).
 * Utilisé pour la sortie de `gphoto2 --capture-movie --stdout`.
 */
export class JpegFrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        return;
      }
      const end = this.buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        return;
      }
      this.onFrame(this.buf.subarray(start, end + 2));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}
