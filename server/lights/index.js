import { EventEmitter } from 'node:events';
import { GoveeLan, MockGovee } from './govee.js';
import { ElgatoLan, MockElgato } from './elgato.js';

/**
 * Appareils connectés (admin → Appareils connectés) : les lumières Govee et Elgato du réseau local, pour deux usages.
 *   - Accueil : ambiance (couleur fixe, cycle de couleurs, respiration), ou lumières laissées telles quelles,
 *     ou éteintes (lights.idle.mode). « On la garde ? » compris : le résultat se regarde dans l'ambiance.
 *   - Prise de vue : blanc neutre à pleine puissance, du choix du template à la fin des photos, et pendant le
 *     calibrage, allumé avant la première mesure : l'exposition trouvée (flash compris) est celle des vraies photos.
 * La borne allume toutes les lumières à son démarrage ; à son arrêt elles passent en blanc chaud doux, s'éteignent ou
 * retrouvent leur état d'avant (lights.shutdown). Entre les deux, chaque lumière
 * est lue avant que la borne n'y touche : en mode « laisser telles quelles » elle retrouve cet état (allumée), et
 * quand l'option est coupée dans l'admin, exactement son état d'avant.
 * Rien n'est bloquant : une lumière éteinte au mur ou hors réseau est simplement ignorée.
 */
export const SHOOTING_SCREENS = ['template', 'capture'];
export const EFFECTS = ['fixed', 'cycle', 'breathe'];
export const IDLE_MODES = ['ambiance', 'keep', 'off'];
export const SHUTDOWN_MODES = ['white', 'off', 'keep'];
const TYPES = { H6008: 'ampoule', H6009: 'ampoule', H6006: 'ampoule', H6076: 'tube' };
export const lightType = (sku = '') => TYPES[sku] || (/ring light/i.test(sku) ? 'ring light' : /key light/i.test(sku) ? 'panneau'
  : /^H60[0-9]{2}$/.test(sku) ? 'ampoule' : 'lumière');

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
    this.drivers = [];         // Govee (UDP) et Elgato (HTTP), même interface
    this.seen = new Map();     // id → { id, sku, ip, firmware, drv, at } (réponses aux recherches)
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
    this.drivers = this.driverName === 'mock' ? [new MockGovee(), new MockElgato()] : [new GoveeLan(), new ElgatoLan()];
    for (const drv of this.drivers) {
      drv.onScan = (d) => this.found(d, drv);
      await drv.start();
    }
    this.running = true;
    await this.scanAll();
    // Borne allumée : lumières allumées (réglages d'avant gardés, c'est l'état « hors prise de vue » à rendre)
    for (const d of this.targets('any')) {
      await this.remember(d);
      const st = this.saved.get(d.id);
      if (st) st.onOff = 1;
      d.drv.command(d.ip, 'turn', { value: 1 });
    }
    this.rescanTimer = setInterval(() => this.rescan().catch(() => {}), RESCAN_MS);
    this.rescanTimer.unref?.();
  }

  /**
   * Option coupée : ambiance stoppée, chaque lumière remise comme avant la borne.
   * Arrêt de la borne (off) : selon lights.shutdown, blanc chaud doux (white), toutes éteintes (off) ou remises comme
   * avant la borne (keep). Envois doublés, l'UDP ne garantit rien.
   */
  async shutdown({ off = false } = {}) {
    this.stopEffect();
    clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    if (off) {
      const sd = this.cfg().shutdown || {};
      const mode = SHUTDOWN_MODES.includes(sd.mode) ? sd.mode : 'white';
      if (mode !== 'keep') {
        const all = this.targets('any');
        for (let i = 0; i < 2; i++) {
          for (const d of all) {
            if (mode === 'off') { d.drv.command(d.ip, 'turn', { value: 0 }); continue; }
            d.drv.command(d.ip, 'turn', { value: 1 });
            d.drv.command(d.ip, 'brightness', { value: clamp(sd.brightness ?? 20, 1, 100) });
            d.drv.command(d.ip, 'colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(sd.kelvin ?? 2700, 2000, 9000) });
          }
          await wait(150);
        }
        this.saved.clear();
      }
    }
    for (const id of [...this.saved.keys()]) await this.restore(id);
    await wait(150); // derniers paquets partis avant de fermer le socket
    for (const drv of this.drivers) await drv.stop();
    this.drivers = [];
    this.running = false;
    this.scene = null;
  }

  /** Arrêt de la borne : lumières en blanc chaud doux, éteintes ou remises comme avant (lights.shutdown). */
  stop() { return this.enqueue(() => (this.running ? this.shutdown({ off: true }) : null)); }

  enqueue(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch((e) => console.warn(`[lights] ${e.message}`));
    return p;
  }

  scanAll() {
    return Promise.all(this.drivers.map((drv) => drv.scan()));
  }

  found(d, drv) {
    const prev = this.seen.get(d.id);
    this.seen.set(d.id, { ...d, drv, at: Date.now() });
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
    await this.scanAll();
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
    return this.onlineIds().filter((id) => role === 'any' || (devices[id]?.[role] ?? true)).map((id) => this.seen.get(id));
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
    // Animation arrêtée d'abord : sinon, pendant la lecture d'état des lumières de prise de vue, le cycle ou la
    // respiration continue d'envoyer couleurs et luminosités par-dessus le blanc (clignotement)
    this.stopEffect();
    const shooting = scene === 'shooting' ? this.targets('shooting') : [];
    const busy = new Set(shooting.map((d) => d.id));
    for (const d of shooting) await this.shoot(d);
    const idle = this.cfg().idle || {};
    const mode = IDLE_MODES.includes(idle.mode) ? idle.mode : 'ambiance';
    const ambiance = mode === 'keep' ? [] : this.targets('ambiance').filter((d) => !busy.has(d.id));
    const amb = new Set(ambiance.map((d) => d.id));
    // Les autres lumières que la borne avait touchées retrouvent leur état d'avant
    for (const id of [...this.saved.keys()]) if (!busy.has(id) && !amb.has(id)) await this.restore(id);
    if (mode === 'off') for (const d of ambiance) { await this.remember(d); d.drv.command(d.ip, 'turn', { value: 0 }); }
    else if (ambiance.length) await this.startEffect(ambiance, idle);
    this.emit('change');
    return shooting.length > 0;
  }

  async shoot(d) {
    const s = this.cfg().shooting || {};
    await this.remember(d);
    d.drv.command(d.ip, 'turn', { value: 1 });
    d.drv.command(d.ip, 'brightness', { value: clamp(s.brightness ?? 100, 1, 100) });
    d.drv.command(d.ip, 'colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(s.kelvin ?? 5000, 2000, 9000) });
  }

  /** État d'avant la borne, lu une seule fois : c'est lui qu'on remet ensuite. */
  async remember(d) {
    if (this.saved.has(d.id)) return;
    const st = await d.drv.status(d.ip);
    if (st) { this.saved.set(d.id, st); this.state.set(d.id, st); }
  }

  async restore(id) {
    const st = this.saved.get(id);
    this.saved.delete(id);
    const d = this.seen.get(id);
    if (!st || !d || !this.running) return;
    const { ip, drv } = d;
    if (!st.onOff) { drv.command(ip, 'turn', { value: 0 }); return; }
    drv.command(ip, 'turn', { value: 1 });
    drv.command(ip, 'brightness', { value: clamp(st.brightness || 1, 1, 100) });
    const k = st.colorTemInKelvin;
    drv.command(ip, 'colorwc', k > 0 ? { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: k } : { color: st.color || { r: 255, g: 255, b: 255 }, colorTemInKelvin: 0 });
  }

  // ---------- Ambiance de l'accueil ----------

  async startEffect(devices, idle) {
    const effect = EFFECTS.includes(idle.effect) ? idle.effect : 'cycle';
    const bright = clamp(idle.brightness ?? 60, 1, 100);
    // Couleur fixe et respiration : la couleur choisie, ou un blanc (température) si l'admin l'a demandé
    const tint = idle.white ? { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(idle.kelvin ?? 2700, 2000, 9000) } : { color: hexToRgb(idle.color), colorTemInKelvin: 0 };
    const period = clamp(idle.periodSec ?? (effect === 'breathe' ? 6 : 20), 2, 600) * 1000;
    // Même animation qu'avant l'interruption (changement de scène, lumière revenue) : elle reprend là où elle en
    // était, et les lumières qui y étaient déjà ne reçoivent rien : pas de saut de couleur ni de luminosité
    const key = `${effect}|${period}|${idle.sync ? 1 : 0}|${bright}|${JSON.stringify(tint)}`;
    const resumed = this.lastEffect?.key === key ? this.lastEffect : null;
    const t0 = resumed ? resumed.t0 : Date.now();
    // Décalage entre lumières d'après leur rang parmi toutes les lumières d'ambiance : il ne bouge pas quand l'une
    // d'elles passe en prise de vue. Synchronisées : aucun décalage.
    const all = this.targets('ambiance');
    const rank = new Map(all.map((d, i) => [d.id, i]));
    const offset = (d) => (idle.sync ? 0 : (rank.get(d.id) || 0) / Math.max(1, all.length));
    const phase = (d, now = Date.now()) => ((now - t0) / period + offset(d)) % 1;
    const low = Math.max(3, Math.round(bright * 0.15));
    const level = (d, now) => Math.round(low + (bright - low) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase(d, now))));
    const hue = (d, now) => hueToRgb(phase(d, now) * 360);
    for (const d of devices) {
      await this.remember(d);
      if (resumed?.ids?.has(d.id)) continue; // déjà dans l'animation : elle continue telle quelle
      d.drv.command(d.ip, 'turn', { value: 1 });
      d.drv.command(d.ip, 'brightness', { value: effect === 'breathe' ? level(d) : bright });
      d.drv.command(d.ip, 'colorwc', effect === 'cycle' ? { color: hue(d), colorTemInKelvin: 0 } : tint); // directement la valeur de la phase en cours
    }
    if (effect === 'fixed') return;
    const last = new Map();  // dernière luminosité envoyée (respiration)
    const sentAt = new Map(); // dernier envoi par lumière
    // Pas de chaque lumière : celles qui font un fondu d'elles-mêmes (ampoules H6008, Elgato) glissent vers la
    // valeur suivante, une par seconde suffit (cycle). Les autres (tube H6076) sautent : 5 petits pas par seconde.
    const stepOf = (d) => (d.drv.fades(d.sku) ? (effect === 'cycle' ? 1000 : 350) : 200);
    const tick = () => {
      if (!this.running) return;
      const now = Date.now();
      for (const d of devices) {
        if (now - (sentAt.get(d.id) || 0) < stepOf(d) - 50) continue;
        sentAt.set(d.id, now);
        if (effect === 'cycle') d.drv.command(d.ip, 'colorwc', { color: hue(d, now), colorTemInKelvin: 0 });
        else { const v = level(d, now); if (last.get(d.id) !== v) { last.set(d.id, v); d.drv.command(d.ip, 'brightness', { value: v }); } }
      }
    };
    this.effect = { timer: setInterval(tick, 100), key, t0, ids: new Set(devices.map((d) => d.id)) };
    this.effect.timer.unref?.();
  }

  stopEffect() {
    if (this.effect) { clearInterval(this.effect.timer); this.lastEffect = { key: this.effect.key, t0: this.effect.t0, ids: this.effect.ids }; }
    this.effect = null;
  }

  // ---------- Admin ----------

  /** Recherche immédiate puis lecture de l'état de chaque lumière (bouton « Rechercher »). */
  async discover() {
    if (!this.running) throw new Error('Activez d\'abord les appareils connectés');
    await this.scanAll();
    await Promise.all(this.onlineIds().map(async (id) => {
      const d = this.seen.get(id);
      const st = await d.drv.status(d.ip);
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
        d.drv.command(d.ip, 'turn', { value: 1 });
        d.drv.command(d.ip, 'brightness', { value: 100 });
        d.drv.command(d.ip, 'colorwc', { color: { r: 0, g: 120, b: 255 }, colorTemInKelvin: 0 });
        await wait(450);
        d.drv.command(d.ip, 'brightness', { value: 5 });
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
      error: this.drivers.map((drv) => drv.error).filter(Boolean).join(' · ') || null,
      network: this.drivers[0]?.local ? `${this.drivers[0].local.address} (${this.drivers[0].local.name})` : null,
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
