import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Écran de la borne piloté en DDC/CI, le canal de commande des moniteurs qui passe dans le câble vidéo (HDMI,
 * DisplayPort, USB-C) : luminosité, et volume des haut-parleurs quand l'écran en a. Deux outils selon la machine :
 * m1ddc sur Mac Apple Silicon, ddcutil sur Linux (module i2c-dev, utilisateur dans le groupe i2c). Le contrôleur
 * tactile USB de l'écran n'y est pour rien : il ne parle que toucher.
 * Rien n'est bloquant : sans outil ou sans écran qui répond, l'admin l'indique et la borne tourne normalement.
 * Les écrans sont relus au démarrage, toutes les RESCAN_MS (branché, débranché) et après chaque réglage. Les
 * réglages de la config (screen.brightness, screen.volume ; null = ne pas y toucher) sont renvoyés à l'écran à
 * chaque démarrage : certains écrans oublient les leurs en s'éteignant.
 */
const RESCAN_MS = 60000;
const TIMEOUT_MS = 10000; // ddcutil est lent (I2C) : plusieurs secondes par commande
const PROPS = ['brightness', 'volume'];

/** Premier chemin existant parmi des emplacements connus, sinon `which` : lancée depuis le bureau, l'app a un PATH réduit. */
async function findBinary(name, candidates) {
  for (const p of candidates) if (fs.existsSync(p)) return p;
  try { return (await execFileP('which', [name])).stdout.trim() || null; } catch { return null; }
}
const run = (bin, args) => execFileP(bin, args, { timeout: TIMEOUT_MS }).then((r) => r.stdout);
const firstLine = (e) => String(e.message || e).split('\n')[0];

/** m1ddc (Mac) : `display list` numérote les écrans, les commandes prennent ce numéro ; l'UUID sert d'identifiant stable. */
class M1ddc {
  name = 'm1ddc';
  constructor(bin) { this.bin = bin; this.nums = new Map(); }
  async list() {
    const displays = [];
    for (const line of (await run(this.bin, ['display', 'list'])).split('\n')) {
      const m = /^\[(\d+)\]\s+(.*?)\s+\(([0-9A-Fa-f-]{36})\)\s*$/.exec(line.trim());
      if (!m) continue;
      this.nums.set(m[3], m[1]);
      displays.push({ id: m[3], name: m[2] === '(null)' ? '' : m[2] }); // (null) : service sans nom, pas un écran externe
    }
    return displays;
  }
  num(id) { const n = this.nums.get(id); if (!n) throw new Error('écran débranché'); return n; }
  prop(p) { return p === 'volume' ? 'volume' : 'luminance'; }
  async get(id, prop) {
    const v = parseInt(await run(this.bin, ['display', this.num(id), 'get', this.prop(prop)]), 10);
    if (Number.isNaN(v)) throw new Error('pas de réponse DDC/CI');
    return v;
  }
  async set(id, prop, value) { await run(this.bin, ['display', this.num(id), 'set', this.prop(prop), String(value)]); }
}

/** ddcutil (Linux) : `detect` numérote les écrans ; codes VCP 0x10 luminosité, 0x62 volume, ramenés sur 0-100. */
class Ddcutil {
  name = 'ddcutil';
  constructor(bin) { this.bin = bin; this.nums = new Map(); this.max = new Map(); }
  async list() {
    const found = [];
    let cur = null;
    for (const line of (await run(this.bin, ['detect', '--brief'])).split('\n')) {
      const d = /^Display (\d+)/.exec(line);
      if (d) { cur = { num: d[1], monitor: '' }; found.push(cur); continue; }
      const m = /^\s+Monitor:\s+(.*)$/.exec(line);
      if (m && cur) cur.monitor = m[1].trim();
    }
    this.nums.clear();
    return found.map((d) => {
      const model = (d.monitor.split(':')[1] || '').trim(); // fabricant:modèle:numéro de série
      const id = d.monitor || `display-${d.num}`;
      this.nums.set(id, d.num);
      return { id, name: model || d.monitor || `Écran ${d.num}` };
    });
  }
  num(id) { const n = this.nums.get(id); if (!n) throw new Error('écran débranché'); return n; }
  code(prop) { return prop === 'volume' ? '62' : '10'; }
  async get(id, prop) {
    const out = await run(this.bin, ['-d', this.num(id), 'getvcp', this.code(prop), '--brief']); // « VCP 10 C 50 100 » : valeur, maximum
    const m = /VCP\s+\w+\s+C\s+(\d+)\s+(\d+)/.exec(out);
    if (!m) throw new Error(`réponse DDC/CI inattendue : ${out.trim()}`);
    const max = Number(m[2]) || 100;
    this.max.set(`${id}:${prop}`, max);
    return Math.round((Number(m[1]) * 100) / max);
  }
  async set(id, prop, value) {
    const max = this.max.get(`${id}:${prop}`) || 100;
    await run(this.bin, ['-d', this.num(id), 'setvcp', this.code(prop), String(Math.round((value * max) / 100))]);
  }
}

/** Écran simulé (tests automatiques, BOOTH_SCREEN=mock) : garde les valeurs en mémoire. */
export class MockScreen {
  name = 'mock';
  constructor() { this.values = { brightness: 100, volume: 0 }; }
  async list() { return [{ id: 'mock-1', name: 'Écran simulé' }]; }
  async get(id, prop) { return this.values[prop]; }
  async set(id, prop, value) { this.values[prop] = value; }
}

export class Screen extends EventEmitter {
  constructor({ config, driver = process.env.BOOTH_SCREEN || 'auto' }) {
    super();
    this.config = config;
    this.driverName = driver; // auto | mock | off
    this.driver = null;
    this.state = { tool: null, displays: [], display: null, brightness: null, volume: null, volumeOk: true, error: null, checkedAt: null };
    this.applied = {}; // dernière valeur envoyée par réglage : la même n'est pas renvoyée à chaque changement de config
    this.queue = Promise.resolve();
    this.timer = null;
  }

  cfg() { return this.config.get().screen || {}; }
  /** Une commande à la fois : le DDC/CI n'aime pas les requêtes qui se chevauchent. */
  enqueue(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; }

  async start() {
    if (this.driverName === 'off') return;
    if (this.driverName === 'mock') this.driver = new MockScreen();
    else if (process.platform === 'darwin') {
      const bin = await findBinary('m1ddc', ['/opt/homebrew/bin/m1ddc', '/usr/local/bin/m1ddc']);
      if (bin) this.driver = new M1ddc(bin); else this.state.error = 'm1ddc non installé (brew install m1ddc)';
    } else {
      const bin = await findBinary('ddcutil', ['/usr/bin/ddcutil', '/usr/local/bin/ddcutil']);
      if (bin) this.driver = new Ddcutil(bin); else this.state.error = 'ddcutil non installé (sudo apt install ddcutil, puis utilisateur dans le groupe i2c)';
    }
    this.state.tool = this.driver?.name || null;
    if (!this.driver) { console.warn(`[screen] ${this.state.error}`); return; }
    this.timer = setInterval(() => this.refresh().catch(() => {}), RESCAN_MS);
    this.timer.unref?.();
    await this.refresh();
    const s = this.state;
    console.log(s.display
      ? `[screen] écran ${s.display.name || s.display.id} : luminosité ${s.brightness ?? '?'} %${s.volumeOk ? `, volume ${s.volume ?? '?'} %` : ''} (${this.driver.name})`
      : `[screen] aucun écran pilotable en DDC/CI (${this.driver.name}${s.error ? ` : ${s.error}` : ''})`);
  }

  /** Relit les écrans branchés et leurs valeurs, puis renvoie les réglages de la config si l'écran s'en est écarté. */
  refresh() {
    if (!this.driver) return Promise.resolve();
    return this.enqueue(async () => {
      const s = this.state;
      try {
        s.displays = await this.driver.list();
        const wanted = String(this.cfg().display || '');
        s.display = (wanted && s.displays.find((d) => d.id === wanted || d.name === wanted)) || s.displays.find((d) => d.name) || null;
        s.error = null;
        if (s.display) {
          s.brightness = await this.driver.get(s.display.id, 'brightness');
          try { s.volume = await this.driver.get(s.display.id, 'volume'); s.volumeOk = true; } catch { s.volume = null; s.volumeOk = false; }
        } else { s.brightness = null; s.volume = null; }
      } catch (e) {
        s.error = firstLine(e);
        s.display = null;
      }
      s.checkedAt = new Date().toISOString();
      await this._apply();
    });
  }

  /** Envoie à l'écran les réglages de la config (voir _apply), dans la file. */
  apply() { return this.driver ? this.enqueue(() => this._apply()) : Promise.resolve(); }
  async _apply() {
    const s = this.state;
    if (!s.display) return;
    const cfg = this.cfg();
    for (const prop of PROPS) {
      const v = cfg[prop];
      if (typeof v !== 'number') { delete this.applied[prop]; continue; } // null : l'écran garde son réglage
      if (prop === 'volume' && !s.volumeOk) continue;
      if (s[prop] === v && this.applied[prop] === v) continue;
      try {
        await this.driver.set(s.display.id, prop, v);
        this.applied[prop] = v;
        s[prop] = await this.driver.get(s.display.id, prop).catch(() => v);
        s.error = null;
      } catch (e) { s.error = `${prop === 'volume' ? 'volume' : 'luminosité'} : ${firstLine(e)}`; }
    }
  }

  status() {
    const cfg = this.cfg();
    return { off: this.driverName === 'off', available: !!this.driver, ...this.state, managed: typeof cfg.brightness === 'number' || typeof cfg.volume === 'number' };
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
