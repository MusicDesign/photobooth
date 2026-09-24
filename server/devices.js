import { EventEmitter } from 'node:events';
import { createCamera, detectGphoto2 } from './camera/index.js';
import { createPrinter, detectCupsPrinter } from './printer/index.js';
import { wifiStatus } from './network.js';

/**
 * Gestion du matériel à chaud. Choisit le pilote caméra et imprimante d'après
 * la config, les instancie, et les remplace sans redémarrage quand la config
 * change ou, en mode « auto », quand un appareil apparaît ou disparaît.
 *
 *   camera.driver  = 'auto' → gphoto2 si un boîtier est détecté en USB, sinon camera.fallback
 *   printer.driver = 'auto' → cups si la file configurée existe et que l'imprimante
 *                             répond, sinon printer.fallback ('none' = impression désactivée)
 *
 * Émet 'camera' et 'printer' (nouveau pilote, ancien pilote) après chaque bascule,
 * et 'network' quand le Wi-Fi apparaît ou disparaît (les QR codes en dépendent).
 */
export class Devices extends EventEmitter {
  constructor({ config, pollMs = 10000, printerBusy = () => false }) {
    super();
    this.config = config;
    this.pollMs = pollMs;
    this.printerBusy = printerBusy;
    this.camera = null;
    this.printer = null;
    this.cameraKey = null;
    this.printerKey = null;
    this.state = { camera: null, printer: null, network: null };
    this.timer = null;
    this.pending = null;
    this.closed = false;
  }

  async start() {
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch((e) => console.warn(`[devices] ${e.message}`)), this.pollMs);
    this.timer.unref();
  }

  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.pending) await this.pending.catch(() => {});
    await this.camera?.shutdown().catch(() => {});
    await this.printer?.shutdown().catch(() => {});
  }

  status() {
    return this.state;
  }

  /** Re-détecte et bascule si besoin. Sérialisé : un seul passage à la fois. */
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this._refresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  async _refresh() {
    if (this.closed) return;
    const cfg = this.config.get();
    await this._refreshCamera(cfg.camera);
    await this._refreshPrinter(cfg.printer);
    this._refreshNetwork();
  }

  // ---------- Réseau ----------

  _refreshNetwork() {
    const prev = this.state.network;
    const w = wifiStatus();
    this.state.network = { wifi: w.connected, iface: w.iface, ip: w.ip, checkedAt: new Date().toISOString() };
    if (prev && prev.wifi === w.connected && prev.ip === w.ip) return;
    console.log(`[devices] réseau : ${w.connected ? `Wi-Fi ${w.iface} (${w.ip})` : 'pas de Wi-Fi → QR codes masqués'}`);
    if (prev) this.emit('network', this.state.network);
  }

  // ---------- Caméra ----------

  async resolveCamera(c) {
    if (c.driver !== 'auto') return { driver: c.driver, reason: 'pilote choisi dans l\'admin' };
    // Le boîtier diffuse déjà : inutile de sonder l'USB (et de le déranger).
    if (this.camera?.name === 'gphoto2' && this.camera.live) return { driver: 'gphoto2', reason: 'boîtier en cours de diffusion' };
    const d = await detectGphoto2(c.gphoto2);
    if (d.found) return { driver: 'gphoto2', reason: `${d.model} détecté en USB` };
    return { driver: c.fallback || 'browser', reason: `${d.reason} → repli ${c.fallback || 'browser'}` };
  }

  async _refreshCamera(c) {
    const r = await this.resolveCamera(c);
    const key = JSON.stringify({ driver: r.driver, gphoto2: r.driver === 'gphoto2' ? c.gphoto2 : null });
    this.state.camera = { requested: c.driver, driver: r.driver, reason: r.reason, checkedAt: new Date().toISOString() };
    if (this.camera && key === this.cameraKey) return;
    if (this.camera?.busy) return; // photo en cours : on rebasculera au prochain passage
    let next;
    try {
      next = createCamera({ ...c, driver: r.driver });
      await next.init();
    } catch (e) {
      // Pilote injoignable (ex. gphoto2 non installé) : la borne démarre quand même sur le repli.
      console.warn(`[devices] caméra ${r.driver} indisponible : ${e.message}`);
      this.state.camera.reason = `${r.driver} indisponible : ${e.message}`;
      if (this.camera) return;
      next = createCamera({ ...c, driver: c.fallback || 'browser' });
      await next.init();
      this.state.camera.driver = next.name;
    }
    const prev = this.camera;
    this.camera = next;
    this.cameraKey = key;
    if (prev) await prev.shutdown().catch(() => {});
    console.log(`[devices] caméra : ${next.name} (${this.state.camera.reason})`);
    this.emit('camera', next, prev);
  }

  // ---------- Imprimante ----------

  async resolvePrinter(p) {
    if (p.driver !== 'auto') return { driver: p.driver, reason: 'pilote choisi dans l\'admin' };
    const d = await detectCupsPrinter(p.cups);
    if (d.found) return { driver: 'cups', reason: d.reason };
    return { driver: p.fallback || 'none', reason: `${d.reason} → ${p.fallback === 'mock' ? 'simulation' : 'impression désactivée'}` };
  }

  async _refreshPrinter(p) {
    const r = await this.resolvePrinter(p);
    const key = JSON.stringify({ driver: r.driver, cups: r.driver === 'cups' ? p.cups : null, mockDelayMs: r.driver === 'mock' ? p.mockDelayMs : null });
    this.state.printer = { requested: p.driver, driver: r.driver, reason: r.reason, checkedAt: new Date().toISOString() };
    if (this.printer && key === this.printerKey) return;
    if (this.printer && this.printerBusy()) return; // tirage en cours : on attend qu'il sorte
    let next;
    try {
      next = createPrinter({ ...p, driver: r.driver });
      await next.init();
    } catch (e) {
      console.warn(`[devices] imprimante ${r.driver} indisponible : ${e.message}`);
      this.state.printer.reason = `${r.driver} indisponible : ${e.message}`;
      if (this.printer) return;
      next = createPrinter({ ...p, driver: p.fallback || 'none' });
      await next.init();
      this.state.printer.driver = next.name;
    }
    const prev = this.printer;
    this.printer = next;
    this.printerKey = key;
    if (prev) await prev.shutdown().catch(() => {});
    console.log(`[devices] imprimante : ${next.name} (${this.state.printer.reason})`);
    this.emit('printer', next, prev);
  }
}
