import { lanAddress, subnetHosts } from './govee.js';

/**
 * Philips Hue : pont Hue du réseau local, API HTTP v1, sans compte ni internet.
 *   GET  http://<pont>/api/config                    → identifiant du pont (sans association)
 *   POST http://<pont>/api { devicetype }            → association : renvoie un nom d'utilisateur une fois le
 *                                                      bouton du pont pressé (sinon erreur 101)
 *   GET  http://<pont>/api/<user>/lights             → ampoules : nom, type, état
 *   PUT  http://<pont>/api/<user>/lights/<n>/state   → on, bri (1-254), ct (mireds 153-500), xy, transitiontime
 * Les ampoules partagent l'adresse du pont : chacune est désignée par « <pont>#<n> » (le champ ip du gestionnaire).
 * Même interface que GoveeLan et ElgatoLan (scan, command, status). Le pont encaisse une dizaine de commandes
 * par seconde : une requête à la fois par ampoule, les suivantes fusionnées (seule la dernière valeur part).
 */
const DEVICE_TYPE = 'cheeesy#borne';
const ok = (res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); };
const call = (url, opts = {}, ms = 2500) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }).then(ok);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));

/** Couleur sRGB (0-255) → coordonnées xy du pont (formule de Philips, gamme large). */
export function rgbToXy({ r, g, b }) {
  const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const sum = X + Y + Z;
  return sum ? [Math.round((X / sum) * 10000) / 10000, Math.round((Y / sum) * 10000) / 10000] : [0.3227, 0.329];
}
function xyToRgb([x, y]) {
  const Y = 1, X = (Y / y) * x, Z = (Y / y) * (1 - x - y);
  const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  let rgb = [X * 1.656492 - Y * 0.354851 - Z * 0.255038, -X * 0.707196 + Y * 1.655397 + Z * 0.036152, X * 0.051713 - Y * 0.121364 + Z * 1.01153].map((c) => Math.max(0, gam(c)));
  const m = Math.max(...rgb, 1e-6);
  rgb = rgb.map((c) => Math.round((c / m) * 255));
  return { r: rgb[0], g: rgb[1], b: rgb[2] };
}

/** Types d'ampoules Hue : couleur (xy + blanc), blanc réglable (ct), blanc simple (luminosité seulement). */
const supportsColor = (type) => /color light/i.test(type || '');
const supportsCt = (type) => /color light|color temperature/i.test(type || '');

/** Commande générique (turn, brightness, colorwc) → champs du pont pour cette ampoule. */
function toHue(cmd, data, type) {
  if (cmd === 'turn') return { on: !!data.value };
  if (cmd === 'brightness') return { on: true, bri: clamp((data.value / 100) * 254, 1, 254) };
  if (cmd === 'colorwc') {
    if (data.colorTemInKelvin > 0) return supportsCt(type) ? { ct: clamp(1e6 / data.colorTemInKelvin, 153, 500) } : null;
    return supportsColor(type) ? { xy: rgbToXy(data.color || { r: 255, g: 255, b: 255 }) } : null;
  }
  return null;
}
function fromHue(st) {
  if (!st) return null;
  return {
    onOff: st.on ? 1 : 0,
    brightness: clamp(((st.bri ?? 254) / 254) * 100, 1, 100),
    color: st.colormode === 'xy' && st.xy ? xyToRgb(st.xy) : { r: 0, g: 0, b: 0 },
    colorTemInKelvin: st.colormode === 'ct' && st.ct ? Math.round(1e6 / st.ct / 10) * 10 : st.colormode === 'xy' ? 0 : (st.ct ? Math.round(1e6 / st.ct / 10) * 10 : 0)
  };
}

export class HueLan {
  /** auth() : { ip, username } du pont associé (config lights.hue), ou null. */
  constructor({ auth = () => null } = {}) {
    this.auth = auth;
    this.error = null;
    this.onScan = null;
    this.types = new Map();    // « pont#n » → type d'ampoule
    this.pending = new Map();
    this.inflight = new Map();
  }

  async start() {}
  async stop() { await Promise.all([...this.inflight.values()]); }
  fades() { return true; }
  /** Ampoule blanche (sans couleur) : l'ambiance lui donne du blanc chaud ↔ froid au lieu des couleurs. */
  whiteOnly(sku) { return !/color light/i.test(sku || ''); }

  /** Ponts Hue du réseau : chaque adresse est interrogée sur /api/config (sans association). */
  static async discover() {
    const local = lanAddress();
    if (!local) return [];
    const found = [];
    const probe = async (ip) => {
      try {
        const c = await call(`http://${ip}/api/config`, {}, 1200);
        if (c?.bridgeid) found.push({ ip, id: c.bridgeid, name: c.name || 'Pont Hue' });
      } catch { /* pas un pont */ }
    };
    const hosts = subnetHosts(local);
    for (let i = 0; i < hosts.length; i += 64) await Promise.all(hosts.slice(i, i + 64).map(probe));
    return found;
  }

  /** Association : réussit seulement si le bouton du pont a été pressé dans les 30 s précédentes. */
  static async pair(ip) {
    const res = await call(`http://${ip}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devicetype: DEVICE_TYPE }) });
    const r = Array.isArray(res) ? res[0] : res;
    if (r?.success?.username) return r.success.username;
    if (r?.error?.type === 101) return null; // bouton pas encore pressé
    throw new Error(r?.error?.description || 'réponse inattendue du pont');
  }

  async scan() {
    const a = this.auth();
    if (!a?.ip || !a?.username) return;
    try {
      const lights = await call(`http://${a.ip}/api/${a.username}/lights`);
      if (Array.isArray(lights) && lights[0]?.error) throw new Error(lights[0].error.description);
      this.error = null;
      for (const [n, l] of Object.entries(lights || {})) {
        if (l.state?.reachable === false) continue; // éteinte à l'interrupteur
        const addr = `${a.ip}#${n}`;
        this.types.set(addr, l.type);
        this.onScan?.({ id: l.uniqueid || `hue-${a.ip}-${n}`, sku: `Hue ${l.type || 'light'}`, ip: addr, name: l.name || '', firmware: l.swversion || '' });
      }
    } catch (e) { this.error = `Hue : ${e.message}`; }
  }

  command(addr, cmd, data) {
    const fields = toHue(cmd, data, this.types.get(addr));
    if (!fields) return;
    this.pending.set(addr, { ...(this.pending.get(addr) || {}), ...fields });
    if (!this.inflight.has(addr)) setImmediate(() => this.flush(addr));
  }

  flush(addr) {
    const body = this.pending.get(addr);
    const a = this.auth();
    if (!body || this.inflight.has(addr) || !a?.username) return;
    this.pending.delete(addr);
    const [ip, n] = addr.split('#');
    const req = fetch(`http://${ip}/api/${a.username}/lights/${n}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transitiontime: 3, ...body }), signal: AbortSignal.timeout(2000)
    }).catch(() => { /* ampoule ou pont injoignable : ignorée */ }).finally(() => {
      this.inflight.delete(addr);
      if (this.pending.has(addr)) this.flush(addr);
    });
    this.inflight.set(addr, req);
  }

  async status(addr) {
    const a = this.auth();
    if (!a?.username) return null;
    const [ip, n] = addr.split('#');
    try { return fromHue((await call(`http://${ip}/api/${a.username}/lights/${n}`)).state); } catch { return null; }
  }
}

/** Pont Hue simulé (tests) : deux ampoules, une couleur et une blanche réglable, associées au premier essai. */
export class MockHue {
  constructor({ auth = () => null } = {}) {
    this.auth = auth;
    this.error = null;
    this.onScan = null;
    this.sent = [];
    this.lights = { 1: { type: 'Extended color light', name: 'Salon', state: { on: false, bri: 100, ct: 366, colormode: 'ct' } }, 2: { type: 'Color temperature light', name: 'Entrée', state: { on: true, bri: 200, ct: 250, colormode: 'ct' } } };
  }
  async start() {}
  async stop() {}
  fades() { return true; }
  whiteOnly(sku) { return !/color light/i.test(sku || ''); }
  static async discover() { return [{ ip: '10.0.0.30', id: 'MOCKBRIDGE', name: 'Pont Hue simulé' }]; }
  static async pair() { return 'mock-user'; }
  async scan() {
    if (!this.auth()?.username) return;
    for (const [n, l] of Object.entries(this.lights)) this.onScan?.({ id: `hue-mock-${n}`, sku: `Hue ${l.type}`, ip: `10.0.0.30#${n}`, name: l.name });
  }
  command(addr, cmd, data) {
    const n = addr.split('#')[1];
    const fields = toHue(cmd, data, this.lights[n]?.type);
    if (!fields) return;
    this.sent.push([addr, fields]);
    Object.assign(this.lights[n].state, fields, fields.xy ? { colormode: 'xy' } : fields.ct ? { colormode: 'ct' } : {});
  }
  async status(addr) { return fromHue(this.lights[addr.split('#')[1]]?.state); }
}
