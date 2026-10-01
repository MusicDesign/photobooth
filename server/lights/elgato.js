import { lanAddress, subnetHosts } from './govee.js';

/**
 * Lumières Elgato (Ring Light, Key Light…) : API HTTP locale sur le port 9123, toujours active une fois la lumière
 * sur le Wi-Fi (app Elgato Control Center), sans compte.
 *   GET  /elgato/accessory-info  → modèle, nom, numéro de série
 *   GET  /elgato/lights          → { lights: [{ on, brightness (3-100), temperature (mireds 143-344) }] }
 *   PUT  /elgato/lights          → mêmes champs, seuls ceux donnés changent
 * Lumière blanche seulement : les couleurs de l'ambiance ne la concernent pas, elle garde son blanc.
 * Même interface que GoveeLan (scan, command, status) : le gestionnaire pilote les deux de la même façon.
 */
const PORT = 9123;
const MIRED_MIN = 143; // ≈ 7000 K
const MIRED_MAX = 344; // ≈ 2900 K

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
export const kelvinToMired = (k) => clamp(1e6 / k, MIRED_MIN, MIRED_MAX);
const miredToKelvin = (m) => Math.round(1e6 / m / 10) * 10;

/** Commande Govee (turn, brightness, colorwc) → champs Elgato. Une couleur sans blanc ne donne rien. */
function toElgato(cmd, data) {
  if (cmd === 'turn') return { on: data.value ? 1 : 0 };
  if (cmd === 'brightness') return { brightness: clamp(data.value, 3, 100) };
  if (cmd === 'colorwc' && data.colorTemInKelvin > 0) return { temperature: kelvinToMired(data.colorTemInKelvin) };
  return null;
}
function fromElgato(l) {
  return l ? { onOff: l.on ? 1 : 0, brightness: l.brightness, color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: miredToKelvin(l.temperature) } : null;
}

export class ElgatoLan {
  constructor() {
    this.error = null;
    this.local = null;
    this.onScan = null;
    this.pending = new Map(); // ip → champs à envoyer au prochain PUT (les commandes d'un même instant regroupées)
    this.chain = new Map();   // ip → dernier PUT, pour qu'ils arrivent dans l'ordre
  }

  async start() { this.local = lanAddress(); }
  async stop() { await Promise.all([...this.chain.values()]); }

  /** Les Elgato font un fondu d'elles-mêmes entre deux niveaux. */
  fades() { return true; }

  async get(ip, p, ms = 1500) {
    const res = await fetch(`http://${ip}:${PORT}${p}`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Chaque adresse du réseau est appelée sur le port 9123 (64 à la fois) : seules les Elgato répondent. */
  async scan() {
    if (!this.local) return;
    const hosts = subnetHosts(this.local);
    const probe = async (ip) => {
      try {
        const info = await this.get(ip, '/elgato/accessory-info', 1200);
        this.onScan?.({ id: info.serialNumber || info.macAddress || ip, sku: info.productName || 'Elgato', ip, firmware: info.firmwareVersion || '' });
      } catch { /* pas une Elgato */ }
    };
    for (let i = 0; i < hosts.length; i += 64) await Promise.all(hosts.slice(i, i + 64).map(probe));
  }

  command(ip, cmd, data) {
    const fields = toElgato(cmd, data);
    if (!fields) return;
    const queued = this.pending.get(ip);
    if (queued) { Object.assign(queued, fields); return; }
    this.pending.set(ip, { ...fields });
    setImmediate(() => {
      const body = this.pending.get(ip);
      this.pending.delete(ip);
      const prev = this.chain.get(ip) || Promise.resolve();
      const next = prev.then(() => fetch(`http://${ip}:${PORT}/elgato/lights`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numberOfLights: 1, lights: [body] }), signal: AbortSignal.timeout(2000)
      })).catch(() => { /* lumière débranchée : ignorée */ });
      this.chain.set(ip, next);
      next.then(() => { if (this.chain.get(ip) === next) this.chain.delete(ip); });
    });
  }

  async status(ip) {
    try { return fromElgato((await this.get(ip, '/elgato/lights')).lights?.[0]); } catch { return null; }
  }
}

/** Ring light simulée (tests, démo sans matériel). */
export class MockElgato {
  constructor() {
    this.error = null;
    this.onScan = null;
    this.sent = [];
    this.devices = [{ id: 'EL00000000001', sku: 'Elgato Ring Light', ip: '10.0.0.21', firmware: 'mock' }];
    this.state = { '10.0.0.21': { on: 1, brightness: 40, temperature: 250 } };
  }

  async start() {}
  async stop() {}
  fades() { return true; }
  async scan() { for (const d of this.devices) this.onScan?.({ ...d }); }

  command(ip, cmd, data) {
    const fields = toElgato(cmd, data);
    if (!fields || !this.state[ip]) return;
    this.sent.push([ip, fields]);
    Object.assign(this.state[ip], fields);
  }

  async status(ip) { return fromElgato(this.state[ip]); }
}
