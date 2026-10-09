import dgram from 'node:dgram';
import os from 'node:os';

/**
 * Lumières Govee pilotées en local (option « LAN Control » de l'app Govee Home, à activer sur chaque appareil) :
 * JSON en UDP, sans compte ni internet, réponse en quelques dizaines de ms.
 *   recherche : { cmd: 'scan' } en multicast 239.255.255.250:4001, réponses sur notre port 4002
 *   commandes : unicast vers <ip>:4003 (turn, brightness, colorwc, devStatus → réponse sur 4002)
 * Deux pièges vus sur le terrain :
 *   - le multicast doit partir par l'interface du réseau local (sinon macOS le sort ailleurs : aucune réponse) ;
 *   - le tube H6076 ignore le multicast : il ne répond qu'à un scan envoyé à son adresse, d'où l'appel direct
 *     de chaque adresse du réseau (254 petits paquets, rien pour le réseau).
 */
const MCAST = '239.255.255.250';
const SCAN_PORT = 4001;
const REPLY_PORT = 4002;
const CMD_PORT = 4003;
const SCAN_MSG = { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } };
// Modèles qui font un fondu d'eux-mêmes vers la nouvelle couleur : une couleur par seconde suffit. Les autres
// (tube H6076…) sautent d'une couleur à l'autre : il leur faut des pas plus petits et plus fréquents.
const FADES = new Set(['H6008']);
const fades = (sku) => FADES.has(sku);

/** Adresse IPv4 du réseau local (Wi-Fi ou Ethernet), et son masque. Interfaces virtuelles écartées. */
export function lanAddress() {
  const skip = /^(lo|utun|awdl|llw|bridge|docker|veth|vmnet|vboxnet|tailscale|zt|tun|tap)/i;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  // Réseau privé d'abord (192.168, 10., 172.16-31), en0 / wlan / eth avant le reste
  const score = (a) => (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address) ? 0 : 2) + (/^(en0|wl|eth|en)/.test(a.name) ? 0 : 1);
  return found.sort((a, b) => score(a) - score(b))[0] || null;
}

/** Adresses à appeler une à une : le /24 de la borne (ou son sous-réseau s'il est plus petit), sans elle-même. */
export function subnetHosts({ address, netmask }) {
  const toInt = (ip) => ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
  const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  const mask = Math.max(toInt(netmask), toInt('255.255.255.0')) >>> 0;
  const net = (toInt(address) & mask) >>> 0;
  const size = (~mask >>> 0) + 1;
  const out = [];
  for (let i = 1; i < size - 1; i++) { const ip = toIp(net + i); if (ip !== address) out.push(ip); }
  return out;
}

export class GoveeLan {
  constructor() {
    this.socket = null;
    this.local = null;
    this.error = null;
    this.onScan = null;       // (device) => void, pour chaque réponse à une recherche
    this.waiters = new Map(); // ip → [resolve] en attente d'un devStatus
  }

  fades(sku) { return fades(sku); }

  async start() {
    if (this.socket) return;
    this.local = lanAddress();
    if (!this.local) { this.error = 'Aucun réseau local'; return; }
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => this.receive(buf, rinfo));
    sock.on('error', (e) => { this.error = e.message; });
    try {
      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(REPLY_PORT, () => { sock.off('error', reject); resolve(); });
      });
      sock.setMulticastInterface(this.local.address);
      sock.setMulticastTTL(2);
      this.socket = sock;
      this.error = null;
    } catch (e) {
      sock.close();
      this.error = e.code === 'EADDRINUSE' ? `Port ${REPLY_PORT} déjà pris par un autre programme` : e.message;
    }
  }

  async stop() {
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise((r) => s.close(r));
  }

  receive(buf, rinfo) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8'))?.msg; } catch { return; }
    if (!msg) return;
    if (msg.cmd === 'scan' && msg.data?.device) {
      this.onScan?.({ id: msg.data.device, sku: msg.data.sku || '', ip: msg.data.ip || rinfo.address, firmware: msg.data.wifiVersionSoft || '' });
    } else if (msg.cmd === 'devStatus') {
      const list = this.waiters.get(rinfo.address);
      if (list) { this.waiters.delete(rinfo.address); for (const fn of list) fn(msg.data || null); }
    }
  }

  send(ip, port, msg) {
    if (!this.socket) return;
    // Erreurs d'envoi (hôte injoignable…) sans conséquence : une lumière absente ne bloque jamais la borne
    this.socket.send(JSON.stringify(msg), port, ip, () => {});
  }

  /**
   * Lance une recherche ; les réponses arrivent par onScan pendant `ms`. hosts : adresses appelées une à une (lumières
   * déjà connues), sinon tout le réseau local ; le multicast part dans les deux cas.
   */
  async scan({ hosts = null } = {}, ms = 2500) {
    // Réseau absent au démarrage, revenu ou changé depuis : le socket est rouvert sur la bonne interface
    const now = lanAddress();
    if (this.socket && now?.address !== this.local?.address) await this.stop();
    if (!this.socket) await this.start();
    if (!this.socket) return;
    this.send(MCAST, SCAN_PORT, SCAN_MSG);
    for (const ip of hosts || subnetHosts(this.local)) this.send(ip, SCAN_PORT, SCAN_MSG);
    await new Promise((r) => setTimeout(r, ms));
  }

  command(ip, cmd, data) {
    this.send(ip, CMD_PORT, { msg: { cmd, data } });
  }

  /** État de la lumière : { onOff, brightness, color: {r,g,b}, colorTemInKelvin }, ou null sans réponse. */
  status(ip, ms = 1500) {
    if (!this.socket) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => {
        const list = this.waiters.get(ip)?.filter((f) => f !== finish);
        if (list?.length) this.waiters.set(ip, list); else this.waiters.delete(ip);
        finish(null);
      }, ms);
      this.waiters.set(ip, [...(this.waiters.get(ip) || []), finish]);
      this.command(ip, 'devStatus', {});
    });
  }
}

/** Lumières simulées (tests, démo sans matériel) : mêmes appareils que la borne de démonstration. */
export class MockGovee {
  constructor() {
    this.error = null;
    this.onScan = null;
    this.sent = []; // [ip, cmd, data], pour les tests
    this.devices = [
      { id: 'AA:00:00:00:00:00:00:01', sku: 'H6008', ip: '10.0.0.11', firmware: 'mock' },
      { id: 'AA:00:00:00:00:00:00:02', sku: 'H6008', ip: '10.0.0.12', firmware: 'mock' },
      { id: 'AA:00:00:00:00:00:00:03', sku: 'H6076', ip: '10.0.0.13', firmware: 'mock' }
    ];
    this.state = Object.fromEntries(this.devices.map((d, i) => [d.ip, { onOff: i < 2 ? 1 : 0, brightness: 20 + i * 10, color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 3000 }])); // la 3e éteinte
  }

  fades(sku) { return fades(sku); }
  async start() {}
  async stop() {}
  async scan() {
    for (const d of this.devices) this.onScan?.({ ...d });
    await new Promise((r) => setTimeout(r, 50));
  }

  command(ip, cmd, data) {
    this.sent.push([ip, cmd, data]);
    const s = this.state[ip];
    if (!s) return;
    if (cmd === 'turn') s.onOff = data.value;
    if (cmd === 'brightness') s.brightness = data.value;
    if (cmd === 'colorwc') { s.color = { ...data.color }; s.colorTemInKelvin = data.colorTemInKelvin; }
  }

  async status(ip) {
    return this.state[ip] ? structuredClone(this.state[ip]) : null;
  }
}
