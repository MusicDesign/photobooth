import { EventEmitter } from 'node:events';
import { GoveeLan, MockGovee } from './govee.js';
import { ElgatoLan, MockElgato } from './elgato.js';
import { HueLan, MockHue } from './hue.js';

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
export const lightType = (sku = '') => TYPES[sku] || (/ring light/i.test(sku) ? 'ring light' : /^Hue /i.test(sku) ? (/color light/i.test(sku) ? 'ampoule Hue' : 'ampoule Hue blanche') : /key light/i.test(sku) ? 'panneau'
  : /^H60[0-9]{2}$/.test(sku) ? 'ampoule' : 'lumière');

const RESCAN_MS = 10000;
const ONLINE_MS = 3 * RESCAN_MS; // plus vue depuis 3 recherches (30 s) : hors ligne
const SETTLE_MS = 1000;          // le temps que les lumières atteignent leur niveau (calibrage)
const WHITE_MIN_K = 2900, WHITE_MAX_K = 7000; // plage par défaut du cycle des lumières blanches (Elgato : 2900-7000 K)
const TICK_MS = 100, WHITE_TICK_MS = 40; // cadence de l'ambiance ; les lumières blanches (Elgato) : valeur recalculée très souvent, un seul envoi à la fois
const RAMP_STEP_MS = 120;        // pas de la montée de lumière pendant le décompte
/** Lumière blanche seulement (Elgato, ampoule Hue blanche) : elle a ses propres réglages, distincts des lumières RGB. */
const isWhite = (d) => !!d.drv.whiteOnly?.(d.sku);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xff7a1a;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
/** Couleur de la palette à la phase p (0 à 1), en fondu d'une couleur à la suivante puis retour à la première. */
function paletteColor(palette, p) {
  const x = (((p % 1) + 1) % 1) * palette.length;
  const i = Math.floor(x), f = x - i;
  const a = palette[i % palette.length], b = palette[(i + 1) % palette.length];
  return { r: Math.round(a.r + (b.r - a.r) * f), g: Math.round(a.g + (b.g - a.g) * f), b: Math.round(a.b + (b.b - a.b) * f) };
}
function hueToRgb(h) {
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return { r: f(0), g: f(8), b: f(4) };
}

export class Lights extends EventEmitter {
  constructor({ config, driver = process.env.BOOTH_LIGHTS || 'govee', themeColor = () => null }) {
    super();
    this.config = config;
    this.themeColor = themeColor; // (clé) → couleur du thème actif : accent, titre ou fond (option « couleur du thème » de l'ambiance)
    this.driverName = driver;
    this.drivers = [];         // Govee (UDP) et Elgato (HTTP), même interface
    this.seen = new Map();     // id → { id, sku, ip, firmware, drv, at } (réponses aux recherches)
    this.state = new Map();    // id → dernier état lu
    this.saved = new Map();    // id → état d'avant la borne (lu avant la première commande)
    this.ringOverride = null;  // luminosité des ring lights imposée par le calibrage en cours
    this.boost = 'wait';       // prise de vue : wait (lumière douce), ramp (montée du décompte), full (photo)
    this.ramp = null;          // { timer, start, dur, sent } montée en cours
    this.screen = null;        // écran de la borne
    this.holds = new Set();    // raisons d'imposer la prise de vue (calibrage, essai depuis l'admin)
    this.scene = null;         // scène appliquée : idle | shooting
    this.effects = new Map();  // famille (rgb | white) → { timer, ... } ambiance en cours
    this.lastEffects = new Map();
    this.queue = Promise.resolve();
    this.rescanTimer = null;
    this.running = false;
  }

  cfg() { return this.config.get().lights || {}; }
  /** Réglages d'une lumière (idle, shooting ou shutdown) : ceux de sa famille, RGB ou blanche. */
  famCfg(d, key) { const c = this.cfg(); return (isWhite(d) ? c.whiteLights?.[key] : c[key]) || {}; }

  /** Couleur du thème choisie pour l'ambiance RGB (colorSource : primary, secondary ou background), ou null si la couleur est personnalisée. */
  themedColor(idle = {}) {
    const key = ({ theme: 'primary', primary: 'primary', secondary: 'secondary', background: 'background' })[idle.colorSource];
    return key ? this.themeColor(key) || null : null;
  }

  /** Palette du cycle « couleurs du thème » : accent, titre, fond (sans doublon voisin), ou null s'il y a moins de deux couleurs. */
  themePalette(idle = {}) {
    if (idle.cyclePalette !== 'theme') return null;
    const hexes = ['primary', 'secondary', 'background'].map((k) => this.themeColor(k)).filter((c) => /^#?[0-9a-f]{6}$/i.test(c || '')).map((c) => c.toLowerCase());
    const distinct = hexes.filter((c, i) => c !== hexes[(i + hexes.length - 1) % hexes.length]);
    return distinct.length >= 2 ? distinct : null;
  }

  enabled() { return this.driverName !== 'off' && !!this.cfg().enabled; }

  async start() {
    // Seuls les réglages des lumières comptent (pas l'adresse d'une lumière, ni le reste de la config)
    const sig = () => { const c = this.cfg(); return JSON.stringify([this.enabled(), c.idle, c.shooting, c.whiteLights, this.themedColor(c.idle), this.themePalette(c.idle), Object.entries(c.devices || {}).map(([id, d]) => [id, d.ambiance, d.shooting])]); };
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
    const hueAuth = () => this.cfg().hue || null; // pont Hue associé (admin → Lumières)
    this.drivers = this.driverName === 'mock' ? [new MockGovee(), new MockElgato(), new MockHue({ auth: hueAuth })] : [new GoveeLan(), new ElgatoLan(), new HueLan({ auth: hueAuth })];
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
   * Arrêt de la borne (off) : selon lights.shutdown (RGB) ou lights.whiteLights.shutdown (blanches), blanc chaud doux (white), toutes éteintes (off) ou remises comme
   * avant la borne (keep). Envois doublés, l'UDP ne garantit rien.
   */
  async shutdown({ off = false } = {}) {
    this.stopEffect();
    clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    if (off) {
      const keep = new Set();
      const all = this.targets('any');
      for (let i = 0; i < 2; i++) {
        for (const d of all) {
          const sd = this.famCfg(d, 'shutdown');
          const mode = SHUTDOWN_MODES.includes(sd.mode) ? sd.mode : 'white';
          if (mode === 'keep') { keep.add(d.id); continue; }
          if (mode === 'off') { d.drv.command(d.ip, 'turn', { value: 0 }); continue; }
          d.drv.command(d.ip, 'turn', { value: 1 });
          d.drv.command(d.ip, 'brightness', { value: clamp(sd.brightness ?? 20, 1, 100) });
          d.drv.command(d.ip, 'colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(sd.kelvin ?? 2700, 2000, 9000) });
        }
        await wait(150);
      }
      for (const id of [...this.saved.keys()]) if (!keep.has(id)) this.saved.delete(id); // les autres : remises comme avant
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
      this.config.update({ lights: { devices: { [d.id]: { name: known?.name || d.name || '', ambiance: known?.ambiance ?? true, shooting: known?.shooting ?? true, ...known, ip: d.ip, sku: d.sku } } } });
    }
    if (!prev) this.emit('change');
  }

  async rescan() {
    if (!this.running || this.rescanning) return; // une recherche à la fois : celle des Elgato dure quelques secondes
    this.rescanning = true;
    try { await this.rescanOnce(); } finally { this.rescanning = false; }
  }

  async rescanOnce() {
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
    // Scène réappliquée même si elle ne change pas (prise de vue → prise de vue) : la lumière quitte la pleine
    // puissance du calibrage ou de l'essai pour son niveau du moment (lumière douce d'attente)
    this.enqueue(() => { this.scene = null; return this.applyWanted(); });
  }

  wanted() {
    return this.holds.size || SHOOTING_SCREENS.includes(this.screen) ? 'shooting' : 'idle';
  }

  /** Ring lights (Elgato) en ligne et utilisées pour la prise de vue : avec elles, plus jamais de flash. */
  ringLights() {
    return this.running ? this.targets('shooting').filter((d) => lightType(d.sku) === 'ring light') : [];
  }
  hasRingLight() { return this.ringLights().length > 0; }

  /** Réglage des ring lights en prise de vue : essai du calibrage, sinon celui qu'il a retenu, sinon rien. */
  ringProfile() {
    if (this.ringOverride) return this.ringOverride;
    const c = this.config.get().camera?.control;
    return c?.mode === 'auto' ? c.auto?.profile?.light || null : null;
  }
  ringBrightness() { return this.ringProfile()?.brightness ?? null; }

  /** Calibrage : ring lights à cette luminosité et cette couleur, le temps qu'elles s'y stabilisent ; null rend la main. */
  async setRingLight(brightness, kelvin = null) {
    this.ringOverride = brightness == null ? null : { brightness: clamp(brightness, 1, 100), kelvin: kelvin ? clamp(kelvin, 2000, 9000) : null };
    if (this.scene !== 'shooting') return;
    await this.enqueue(async () => { for (const d of this.ringLights()) await this.shoot(d); });
    await wait(SETTLE_MS);
  }

  /** Applique la scène voulue si elle a changé. Renvoie vrai si des lumières viennent de passer en prise de vue. */
  async applyWanted() {
    const scene = this.wanted();
    if (scene === this.scene) return false;
    this.scene = scene;
    if (scene !== 'shooting') { this.stopRamp(); this.boost = 'wait'; } // retour à l'accueil : la prochaine séance repart douce
    // Animation arrêtée d'abord : sinon, pendant la lecture d'état des lumières de prise de vue, le cycle ou la
    // respiration continue d'envoyer couleurs et luminosités par-dessus le blanc (clignotement)
    this.stopEffect();
    const shooting = scene === 'shooting' ? this.targets('shooting') : [];
    const busy = new Set(shooting.map((d) => d.id));
    for (const d of shooting) await this.shoot(d);
    // Ambiance : chaque famille (RGB, blanches) a son mode et son effet
    const amb = new Set();
    const families = [['rgb', (d) => !isWhite(d)], ['white', isWhite]];
    const plans = [];
    for (const [fam, member] of families) {
      const idle = (fam === 'white' ? this.cfg().whiteLights?.idle : this.cfg().idle) || {};
      const mode = IDLE_MODES.includes(idle.mode) ? idle.mode : 'ambiance';
      const devices = mode === 'keep' ? [] : this.targets('ambiance').filter((d) => member(d) && !busy.has(d.id));
      for (const d of devices) amb.add(d.id);
      plans.push({ fam, idle, mode, devices });
    }
    // Les autres lumières que la borne avait touchées retrouvent leur état d'avant
    for (const id of [...this.saved.keys()]) if (!busy.has(id) && !amb.has(id)) await this.restore(id);
    // Une lumière passée en prise de vue (ou rendue à son état d'avant) n'est plus dans l'animation : elle la reçoit
    // de nouveau en entier, au lieu de rester à la luminosité de la photo
    for (const e of this.lastEffects.values()) for (const id of [...e.ids]) if (busy.has(id) || !amb.has(id)) e.ids.delete(id);
    for (const { fam, idle, mode, devices } of plans) {
      if (mode === 'off') for (const d of devices) { await this.remember(d); d.drv.command(d.ip, 'turn', { value: 0 }); }
      else if (devices.length) await this.startEffect(devices, idle, fam);
    }
    this.emit('change');
    return shooting.length > 0;
  }

  /** Luminosité de prise de vue d'une lumière : celle du calibrage pour une ring light, sinon le réglage. */
  fullLevel(d) {
    const s = this.famCfg(d, 'shooting');
    const ring = lightType(d.sku) === 'ring light' ? this.ringBrightness() : null;
    return clamp(ring ?? s.brightness ?? 100, 1, 100);
  }
  /** Lumière douce d'avant la photo (choix du cadre, aperçu) : jamais plus que la pleine luminosité. */
  waitLevel(d) {
    const w = this.famCfg(d, 'shooting').waitBrightness;
    return Math.min(this.fullLevel(d), clamp(w ?? 30, 1, 100));
  }
  /** Niveau du moment : plein pendant un calibrage ou un essai, sinon selon l'étape (attente, montée, photo). */
  levelNow(d) {
    if (this.holds.size || this.boost === 'full') return this.fullLevel(d);
    if (this.boost === 'ramp' && this.ramp) {
      const p = Math.min(1, (Date.now() - this.ramp.start) / this.ramp.dur);
      const e = p * p * (3 - 2 * p); // départ et arrivée en douceur
      return Math.round(this.waitLevel(d) + (this.fullLevel(d) - this.waitLevel(d)) * e);
    }
    return this.waitLevel(d);
  }

  /**
   * Décompte affiché sur la borne (n secondes restantes, relayé par app.js) : la lumière monte progressivement de
   * l'attente à la pleine luminosité, atteinte un peu avant le « 0 ». Les yeux s'adaptent, sans réflexe de clignement.
   */
  setCountdown(n) {
    if (!Number.isFinite(n) || n <= 0 || this.boost !== 'wait' || this.scene !== 'shooting' || this.holds.size || !this.running) return;
    this.boost = 'ramp';
    console.log(`[lights] décompte ${n} s : montée vers la pleine luminosité`);
    this.ramp = { start: Date.now(), dur: Math.max(300, n * 1000 - 400), sent: new Map() };
    const step = () => {
      if (this.boost !== 'ramp' || !this.running) return this.stopRamp();
      const done = Date.now() - this.ramp.start >= this.ramp.dur;
      for (const d of this.targets('shooting')) {
        const v = done ? this.fullLevel(d) : this.levelNow(d);
        if (this.ramp.sent.get(d.id) !== v) { this.ramp.sent.set(d.id, v); d.drv.command(d.ip, 'brightness', { value: v }); }
      }
      if (done) { this.stopRamp(); this.boost = 'full'; }
    };
    this.ramp.timer = setInterval(step, RAMP_STEP_MS);
    this.ramp.timer.unref?.();
    step();
  }

  stopRamp() {
    if (this.ramp?.timer) clearInterval(this.ramp.timer);
    this.ramp = null;
  }

  /** Photo prise (ou film du boomerang terminé) : retour à la lumière douce jusqu'au prochain décompte. */
  shotDone() {
    if (this.boost === 'wait' || !this.running) return;
    this.stopRamp();
    this.boost = 'wait';
    console.log('[lights] photo prise : retour à la lumière douce');
    if (this.scene !== 'shooting' || this.holds.size) return;
    this.enqueue(async () => { for (const d of this.targets('shooting')) d.drv.command(d.ip, 'brightness', { value: this.waitLevel(d) }); });
  }

  async shoot(d) {
    const s = this.famCfg(d, 'shooting');
    await this.remember(d);
    d.drv.command(d.ip, 'turn', { value: 1 });
    const lvl = this.levelNow(d);
    d.drv.command(d.ip, 'brightness', { value: lvl });
    console.log(`[lights] prise de vue : ${this.cfg().devices?.[d.id]?.name || d.sku} ${lvl} % (${this.holds.size ? [...this.holds].join(', ') : this.boost}, écran ${this.screen})`);
    const ringK = lightType(d.sku) === 'ring light' ? this.ringProfile()?.kelvin : null; // couleur choisie au calibrage
    d.drv.command(d.ip, 'colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(ringK ?? s.kelvin ?? 5000, 2000, 9000) });
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

  async startEffect(devices, idle, fam = 'rgb') {
    const isW = fam === 'white';
    const effect = EFFECTS.includes(idle.effect) ? idle.effect : isW ? 'fixed' : 'cycle';
    const bright = clamp(idle.brightness ?? 60, 1, 100);
    // Couleur fixe et respiration : la couleur choisie, ou un blanc (température) si l'admin l'a demandé. Les lumières
    // blanches n'ont que le blanc.
    const tint = isW || idle.white ? { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(idle.kelvin ?? (isW ? 4000 : 2700), 2000, 9000) } : { color: hexToRgb(this.themedColor(idle) || idle.color), colorTemInKelvin: 0 };
    const period = clamp(idle.periodSec ?? (effect === 'breathe' ? 6 : 20), 2, 600) * 1000;
    const kMin = clamp(idle.kelvinMin ?? WHITE_MIN_K, 2000, 9000), kMax = Math.max(kMin, clamp(idle.kelvinMax ?? WHITE_MAX_K, 2000, 9000));
    // Même animation qu'avant l'interruption (changement de scène, lumière revenue) : elle reprend là où elle en
    // était, et les lumières qui y étaient déjà ne reçoivent rien : pas de saut de couleur ni de luminosité
    // Cycle « couleurs du thème » : palette accent, titre, fond ; sinon tout le tour de l'arc-en-ciel
    const palette = isW ? null : this.themePalette(idle)?.map(hexToRgb);
    const key = `${effect}|${period}|${idle.sync ? 1 : 0}|${bright}|${JSON.stringify(tint)}|${kMin}|${kMax}|${JSON.stringify(palette)}`;
    const lastEffect = this.lastEffects.get(fam);
    const resumed = lastEffect?.key === key ? lastEffect : null;
    const t0 = resumed ? resumed.t0 : Date.now();
    // Décalage entre lumières d'après leur rang parmi toutes les lumières d'ambiance de la famille : il ne bouge pas
    // quand l'une d'elles passe en prise de vue. Synchronisées : aucun décalage.
    const all = this.targets('ambiance').filter((d) => isWhite(d) === isW);
    const rank = new Map(all.map((d, i) => [d.id, i]));
    const offset = (d) => (idle.sync ? 0 : (rank.get(d.id) || 0) / Math.max(1, all.length));
    const phase = (d, now = Date.now()) => ((now - t0) / period + offset(d)) % 1;
    const low = Math.max(3, Math.round(bright * 0.15));
    const level = (d, now) => Math.round(low + (bright - low) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase(d, now))));
    const hue = (d, now) => (palette ? paletteColor(palette, phase(d, now)) : hueToRgb(phase(d, now) * 360));
    // Lumières blanches : le cycle passe du blanc chaud au blanc froid et revient
    const kelvin = (d, now) => Math.round(kMin + (kMax - kMin) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase(d, now))));
    for (const d of devices) {
      await this.remember(d);
      if (resumed?.ids?.has(d.id)) continue; // déjà dans l'animation : elle continue telle quelle
      d.drv.command(d.ip, 'turn', { value: 1 });
      d.drv.command(d.ip, 'brightness', { value: effect === 'breathe' ? level(d) : bright });
      d.drv.command(d.ip, 'colorwc', effect === 'cycle' ? (isW ? { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: kelvin(d) } : { color: hue(d), colorTemInKelvin: 0 }) : tint); // directement la valeur de la phase en cours
    }
    if (effect === 'fixed') return;
    const last = new Map();  // dernière luminosité envoyée (respiration)
    const sentAt = new Map(); // dernier envoi par lumière
    // Pas de chaque lumière : celles qui font un fondu d'elles-mêmes (ampoules H6008, Elgato) glissent vers la
    // valeur suivante, une par seconde suffit (cycle). Les autres (tube H6076) sautent : 5 petits pas par seconde.
    const stepOf = (d) => (isW ? 0 : d.drv.fades(d.sku) ? (effect === 'cycle' ? 1000 : 350) : 200);
    const lastK = new Map(); // dernière température envoyée (cycle des lumières blanches)
    const tick = () => {
      if (!this.running) return;
      const now = Date.now();
      for (const d of devices) {
        if (stepOf(d) && now - (sentAt.get(d.id) || 0) < stepOf(d) - 50) continue;
        sentAt.set(d.id, now);
        if (effect === 'cycle' && isW) {
          const k = kelvin(d, now);
          if (k !== lastK.get(d.id)) { lastK.set(d.id, k); d.drv.command(d.ip, 'colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: k }); }
        } else if (effect === 'cycle') d.drv.command(d.ip, 'colorwc', { color: hue(d, now), colorTemInKelvin: 0 });
        else { const v = level(d, now); if (last.get(d.id) !== v) { last.set(d.id, v); d.drv.command(d.ip, 'brightness', { value: v }); } }
      }
    };
    const timer = setInterval(tick, isW ? WHITE_TICK_MS : TICK_MS);
    timer.unref?.();
    this.effects.set(fam, { timer, key, t0, ids: new Set(devices.map((d) => d.id)) });
  }

  stopEffect() {
    for (const [fam, e] of this.effects) { clearInterval(e.timer); this.lastEffects.set(fam, { key: e.key, t0: e.t0, ids: e.ids }); }
    this.effects.clear();
  }

  // ---------- Philips Hue : recherche du pont et association ----------

  hueClass() { return this.driverName === 'mock' ? MockHue : HueLan; }

  /** Ponts Hue du réseau local. */
  discoverHue() { return this.hueClass().discover(); }

  /**
   * Association avec un pont : réessaie toutes les 2 s pendant maxMs, le temps qu'on appuie sur son bouton.
   * Réussie : enregistrée dans la config (lights.hue) puis ampoules recherchées. Rend true, ou false au bout du délai.
   */
  async pairHue({ ip, name = '' }, { maxMs = 30000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const username = await this.hueClass().pair(ip);
      if (username) {
        this.config.update({ lights: { hue: { ip, username, name } } });
        console.log(`[lights] pont Hue ${name || ip} associé`);
        if (this.running) await this.discover().catch(() => {});
        return true;
      }
      if (Date.now() - t0 > maxMs) return false;
      await wait(2000);
    }
  }

  /** Dissociation : le pont et ses ampoules sont oubliés. */
  forgetHue() {
    const ids = Object.entries(this.cfg().devices || {}).filter(([, d]) => /^Hue /i.test(d?.sku || '')).map(([id]) => id);
    for (const id of ids) { this.seen.delete(id); this.state.delete(id); this.saved.delete(id); this.config.remove(['lights', 'devices', id]); }
    this.config.update({ lights: { hue: { ip: '', username: '', name: '' } } });
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
      hue: this.cfg().hue?.username ? { ip: this.cfg().hue.ip, name: this.cfg().hue.name || '' } : null,
      ringLight: this.hasRingLight(), // flash interdit, calibrage à la ring light
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
