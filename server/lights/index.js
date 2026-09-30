import { EventEmitter } from 'node:events';
import { GoveeLan, MockGovee } from './govee.js';

/**
 * Appareils connectés (admin → Appareils connectés) : les lumières Govee du réseau local, pour deux usages.
 *   - Accueil : ambiance (couleur fixe, cycle de couleurs, respiration), ou lumières laissées telles quelles,
 *     ou éteintes (lights.idle.mode). « On la garde ? » compris : le résultat se regarde dans l'ambiance.
 *   - Prise de vue : blanc neutre à pleine puissance, du choix du template à la fin des photos, et pendant le
 *     calibrage, allumé avant la première mesure : l'exposition trouvée (flash compris) est celle des vraies photos.
 * La borne allume toutes les lumières à son démarrage et les éteint à son arrêt. Entre les deux, chaque lumière
 * est lue avant que la borne n'y touche : en mode « laisser telles quelles » elle retrouve cet état (allumée), et
 * quand l'option est coupée dans l'admin, exactement son état d'avant.
 * Rien n'est bloquant : une lumière éteinte au mur ou hors réseau est simplement ignorée.
 */
export const SHOOTING_SCREENS = ['template', 'capture'];
export const EFFECTS = ['fixed', 'cycle', 'breathe'];
export const IDLE_MODES = ['ambiance', 'keep', 'off'];
const TYPES = { H6008: 'ampoule', H6009: 'ampoule', H6006: 'ampoule', H6076: 'tube' };
export const lightType = (sku) => TYPES[sku] || (/^H60[0-9]{2}$/.test(sku) ? 'ampoule' : 'lumière');

const RESCAN_MS = 60000;
const ONLINE_MS = 3 * RESCAN_MS; // plus vue depuis 3 recherches : hors ligne
const SETTLE_MS = 1000;          // le temps que les lumières atteignent leur niveau (calibrage)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xff7a1a;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function hueToRgb(h) {
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return { r: f(0), g: f(8), b: f(4) };
}

export class Lights extends EventEmitter {
  constructor({ config, driver = process.env.BOOTH_LIGHTS || 'govee' }) {
    super();
    this.config = config;
    this.driverName = driver;
    this.driver = null;
    this.seen = new Map();     // id → { id, sku, ip, firmware, at } (réponses aux recherches)
    this.state = new Map();    // id → dernier état lu
    this.saved = new Map();    // id → état d'avant la borne (lu avant la première commande)
    this.screen = null;        // écran de la borne
    this.holds = new Set();    // raisons d'imposer la prise de vue (calibrage, essai depuis l'admin)
    this.scene = null;         // scène appliquée : idle | shooting
    this.effect = null;        // { timer, ... } ambiance en cours
    this.queue = Promise.resolve();
    this.rescanTimer = null;
    this.running = false;
  }

  cfg() { return this.config.get().lights || {}; }
  enabled() { return this.driverName !== 'off' && !!this.cfg().enabled; }

  async start() {
    // Seuls les réglages des lumières comptent (pas l'adresse d'une lumière, ni le reste de la config)
    const sig = () => { const c = this.cfg(); return JSON.stringify([this.enabled(), c.idle, c.shooting, Object.entries(c.devices || {}).map(([id, d]) => [id, d.ambiance, d.shooting])]); };
    let last = sig();
    this.config.on('change', () => { const now = sig(); if (now !== last) { last = now; this.sync(); } });
    await this.sync();
  }

  /** Option activée ou coupée, réglages changés : démarre, arrête ou réapplique la scène. */
  sync() {
    return this.enqueue(async () => {
      if (!this.enabled()) { if (this.running) await this.shutdown(); return; }
      if (!this.running) await this.boot();
      this.scene = null; // réglages changés : tout est réappliqué
      await this.applyWanted();
    });
  }

  async boot() {
    this.driver = this.driverName === 'mock' ? new MockGovee() : new GoveeLan();
    this.driver.onScan = (d) => this.found(d);
    await this.driver.start();
    this.running = true;
    await this.driver.scan();
    // Borne allumée : lumières allumées (réglages d'avant gardés, c'est l'état « hors prise de vue » à rendre)
    for (const d of this.targets('any')) {
      await this.remember(d);
      const st = this.saved.get(d.id);
      if (st) st.onOff = 1;
      this.driver.command(d.ip, 'turn', { value: 1 });
    }
    this.rescanTimer = setInterval(() => this.rescan().catch(() => {}), RESCAN_MS);
    this.rescanTimer.unref?.();
  }

  /**
   * Option coupée : ambiance stoppée, chaque lumière remise comme avant la borne.
   * Arrêt de la borne (off) : toutes les lumières éteintes (envoi doublé, l'UDP ne garantit rien).
   */
  async shutdown({ off = false } = {}) {
    this.stopEffect();
    clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    if (off) {
      const all = this.targets('any');
      for (let i = 0; i < 2; i++) { for (const d of all) this.driver.command(d.ip, 'turn', { value: 0 }); await wait(150); }
      this.saved.clear();
    }
    for (const id of [...this.saved.keys()]) await this.restore(id);
    await wait(150); // derniers paquets partis avant de fermer le socket
    await this.driver?.stop();
    this.driver = null;
    this.running = false;
    this.scene = null;
  }

  /** Arrêt de la borne : lumières éteintes. */
  stop() { return this.enqueue(() => (this.running ? this.shutdown({ off: true }) : null)); }

  enqueue(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch((e) => console.warn(`[lights] ${e.message}`));
    return p;
  }

  found(d) {
    const prev = this.seen.get(d.id);
    this.seen.set(d.id, { ...d, at: Date.now() });
    const known = this.cfg().devices?.[d.id];
    // Appareil nouveau ou adresse changée (DHCP) : retenu dans la config, même éteint il reste listé
    if (!known || known.ip !== d.ip || known.sku !== d.sku) {
      this.config.update({ lights: { devices: { [d.id]: { name: known?.name || '', ambiance: known?.ambiance ?? true, shooting: known?.shooting ?? true, ...known, ip: d.ip, sku: d.sku } } } });
    }
    if (!prev) this.emit('change');
  }

  async rescan() {
    if (!this.running) return;
    const before = new Set(this.onlineIds());
    await this.driver.scan();
    // Lumière revenue (rallumée au mur) : elle reprend la scène en cours
    if (this.onlineIds().some((id) => !before.has(id))) this.enqueue(() => { this.scene = null; return this.applyWanted(); });
  }

  onlineIds() {
    const now = Date.now();
    return [...this.seen.values()].filter((d) => now - d.at < ONLINE_MS).map((d) => d.id);
  }

  /** Lumières à piloter : connues, en ligne, avec ce rôle (any : toutes). */
  targets(role) {
    const devices = this.cfg().devices || {};
    return this.onlineIds().filter((id) => role === 'any' || (devices[id]?.[role] ?? true)).map((id) => ({ id, ip: this.seen.get(id).ip }));
  }

  // ---------- Écran de la borne, calibrage ----------

  /** Écran affiché sur la borne : prise de vue du choix du template à la dernière photo. */
  setScreen(screen) {
    // Code opérateur par-dessus un écran (« pin ») : la scène de cet écran continue
    if (screen == null || screen === 'pin' || screen === this.screen) return;
    this.screen = screen;
    if (this.running) this.enqueue(() => this.applyWanted());
  }

  /**
   * Impose la prise de vue (calibrage, essai) jusqu'à release(). Résolu une fois les lumières à leur niveau :
   * sans lumière, tout de suite.
   */
  async hold(reason) {
    this.holds.add(reason);
    if (!this.running) return false;
    const lit = await this.enqueue(() => this.applyWanted());
    if (lit) await wait(SETTLE_MS);
    return !!lit;
  }

  release(reason) {
    if (!this.holds.delete(reason) || !this.running) return;
    this.enqueue(() => this.applyWanted());
  }

  wanted() {
    return this.holds.size || SHOOTING_SCREENS.includes(this.screen) ? 'shooting' : 'idle';
  }

  /** Applique la scène voulue si elle a changé. Renvoie vrai si des lumières viennent de passer en prise de vue. */
  async applyWanted() {
    const scene = this.wanted();
    if (scene === this.scene) return false;
    this.scene = scene;
    const shooting = scene === 'shooting' ? this.targets('shooting') : [];
    const busy = new Set(shooting.map((d) => d.id));
    for (const d of shooting) await this.shoot(d);
    const idle = this.cfg().idle || {};
    const mode = IDLE_MODES.includes(idle.mode) ? idle.mode : 'ambiance';
    const ambiance = mode === 'keep' ? [] : this.targets('ambiance').filter((d) => !busy.has(d.id));
    const amb = new Set(ambiance.map((d) => d.id));
    // Les autres lumières que la borne avait touchées retrouvent leur état d'avant
    for (const id of [...this.saved.keys()]) if (!busy.has(id) && !amb.has(id)) await this.restore(id);
    this.stopEffect();
    if (mode === 'off') for (const d of ambiance) { await this.remember(d); this.driver.command(d.ip, 'turn', { value: 0 }); }
    else if (ambiance.length) await this.startEffect(ambiance, idle);
    this.emit('change');
    return shooting.length > 0;
  }

  async shoot(d) {
    const s = this.cfg().shooting || {};
    await this.remember(d);
    this.driver.command(d.ip, 'turn', { value: 1 });
    this.driver.command(d.ip, 'brightness', { value: clamp(s.brightness ?? 100, 1, 100) });
    this.driver.command(d.ip, 'colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(s.kelvin ?? 5000, 2000, 9000) });
  }

  /** État d'avant la borne, lu une seule fois : c'est lui qu'on remet ensuite. */
  async remember(d) {
    if (this.saved.has(d.id)) return;
    const st = await this.driver.status(d.ip);
    if (st) { this.saved.set(d.id, st); this.state.set(d.id, st); }
  }

  async restore(id) {
    const st = this.saved.get(id);
    this.saved.delete(id);
    const ip = this.seen.get(id)?.ip;
    if (!st || !ip || !this.driver) return;
    if (!st.onOff) { this.driver.command(ip, 'turn', { value: 0 }); return; }
    this.driver.command(ip, 'turn', { value: 1 });
    this.driver.command(ip, 'brightness', { value: clamp(st.brightness || 1, 1, 100) });
    const k = st.colorTemInKelvin;
    this.driver.command(ip, 'colorwc', k > 0 ? { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: k } : { color: st.color || { r: 255, g: 255, b: 255 }, colorTemInKelvin: 0 });
  }

  // ---------- Ambiance de l'accueil ----------

  async startEffect(devices, idle) {
    const effect = EFFECTS.includes(idle.effect) ? idle.effect : 'cycle';
    const bright = clamp(idle.brightness ?? 60, 1, 100);
    const color = hexToRgb(idle.color);
    const period = clamp(idle.periodSec ?? (effect === 'breathe' ? 6 : 20), 2, 600) * 1000;
    for (const d of devices) {
      await this.remember(d);
      this.driver.command(d.ip, 'turn', { value: 1 });
      this.driver.command(d.ip, 'brightness', { value: bright });
      this.driver.command(d.ip, 'colorwc', { color, colorTemInKelvin: 0 });
    }
    if (effect === 'fixed') return;
    const t0 = Date.now();
    const last = new Map();
    // Synchronisées : toutes à la même couleur (ou au même souffle). Sinon décalées d'autant entre elles.
    const offset = (i) => (idle.sync ? 0 : i / devices.length);
    // Cycle : une couleur par seconde. Respiration : ~3 envois par seconde.
    const step = effect === 'cycle' ? 1000 : 350;
    const tick = () => {
      if (!this.driver) return;
      const t = (Date.now() - t0) / period;
      devices.forEach((d, i) => {
        if (effect === 'cycle') {
          const c = hueToRgb(((t + offset(i)) % 1) * 360);
          this.driver.command(d.ip, 'colorwc', { color: c, colorTemInKelvin: 0 });
        } else {
          const low = Math.max(3, Math.round(bright * 0.15));
          const v = Math.round(low + (bright - low) * (0.5 - 0.5 * Math.cos(2 * Math.PI * (t + offset(i)))));
          if (last.get(d.id) !== v) { last.set(d.id, v); this.driver.command(d.ip, 'brightness', { value: v }); }
        }
      });
    };
    this.effect = { timer: setInterval(tick, step) };
    this.effect.timer.unref?.();
  }

  stopEffect() {
    if (this.effect) clearInterval(this.effect.timer);
    this.effect = null;
  }

  // ---------- Admin ----------

  /** Recherche immédiate puis lecture de l'état de chaque lumière (bouton « Rechercher »). */
  async discover() {
    if (!this.running) throw new Error('Activez d\'abord les appareils connectés');
    await this.driver.scan();
    await Promise.all(this.onlineIds().map(async (id) => {
      const st = await this.driver.status(this.seen.get(id).ip);
      if (st) this.state.set(id, st);
    }));
    this.enqueue(() => { this.scene = null; return this.applyWanted(); }); // nouvelles lumières : dans la scène
    return this.status();
  }

  /** Fait clignoter une lumière pour la reconnaître, puis la remet dans la scène en cours. */
  identify(id) {
    const d = this.seen.get(id);
    if (!this.running || !d) throw new Error('Lumière introuvable sur le réseau');
    return this.enqueue(async () => {
      this.stopEffect();
      await this.remember(d);
      for (let i = 0; i < 3; i++) {
        this.driver.command(d.ip, 'turn', { value: 1 });
        this.driver.command(d.ip, 'brightness', { value: 100 });
        this.driver.command(d.ip, 'colorwc', { color: { r: 0, g: 120, b: 255 }, colorTemInKelvin: 0 });
        await wait(450);
        this.driver.command(d.ip, 'brightness', { value: 5 });
        await wait(450);
      }
      this.scene = null;
      await this.applyWanted();
    });
  }

  /** Essai de la scène « Prise de vue » depuis l'admin, quelques secondes. */
  async tryShooting(ms = 8000) {
    await this.hold('admin');
    setTimeout(() => this.release('admin'), ms).unref?.();
  }

  status() {
    const devices = this.cfg().devices || {};
    const online = new Set(this.onlineIds());
    return {
      available: this.driverName !== 'off',
      enabled: this.enabled(),
      running: this.running,
      error: this.driver?.error || null,
      network: this.driver?.local ? `${this.driver.local.address} (${this.driver.local.name})` : null,
      scene: this.scene,
      devices: Object.entries(devices).map(([id, d]) => ({
        id, name: d.name || '', sku: d.sku || '', type: lightType(d.sku), ip: this.seen.get(id)?.ip || d.ip || '',
        online: online.has(id), ambiance: d.ambiance ?? true, shooting: d.shooting ?? true, state: this.state.get(id) || null
      }))
    };
  }
}

function clamp(v, lo, hi) {
  const n = Number(v);
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.round(n) : lo));
}
