/**
 * Surveille les appareils (boîtier, imprimante, Wi-Fi, écran, Stream Deck, lumières) et annonce chaque connexion ou
 * déconnexion : { type: 'device', id, label, connected } sur le WebSocket, affichée en notification par l'admin et la borne.
 *
 * Ce qui était déjà branché au démarrage reste silencieux (délai de grâce) ; ensuite, tout changement d'état compte.
 * Une déconnexion est annoncée tout de suite ; une connexion, après deux lectures de suite (pas de clignotement).
 */
const POLL_MS = 1000;
const GRACE_MS = 20000;

export class DeviceWatch {
  /** sources : () => [{ id, label, connected }] ; connected null = pas surveillé (état inconnu ou non applicable). */
  constructor({ sources, notify, graceMs = GRACE_MS, pollMs = POLL_MS }) {
    this.sources = sources;
    this.notify = notify;
    this.graceMs = graceMs;
    this.pollMs = pollMs;
    this.known = new Map();   // id → dernier état annoncé ou retenu au démarrage
    this.pending = new Map(); // id → état vu une fois, à confirmer
    this.t0 = Date.now();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.check(), this.pollMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  check() {
    let list;
    try { list = this.sources(); } catch { return; }
    const quiet = Date.now() - this.t0 < this.graceMs;
    for (const { id, label, connected } of list) {
      if (connected == null) { this.pending.delete(id); continue; }
      const now = !!connected;
      if (this.known.get(id) === now) { this.pending.delete(id); continue; }
      if (now && this.pending.get(id) !== now) { this.pending.set(id, now); continue; } // connexion : à confirmer à la lecture suivante
      this.pending.delete(id);
      const first = !this.known.has(id);
      this.known.set(id, now);
      if (first && (quiet || !now)) continue; // présent au démarrage, ou jamais vu : rien à annoncer
      console.log(`[devices] ${label} : ${now ? 'connecté' : 'déconnecté'}`);
      this.notify({ type: 'device', id, label, connected: now });
    }
  }
}

/** Appareils de la borne, lus dans les gestionnaires existants. */
export function deviceSources({ devices, deck, lights, screen }) {
  return () => {
    const out = [];
    const st = devices.status();
    const cam = st.camera;
    if (cam && cam.driver !== 'starting' && ['auto', 'gphoto2'].includes(cam.requested)) out.push({ id: 'camera', label: 'Boîtier photo', connected: cam.driver === 'gphoto2' });
    const pr = st.printer;
    if (pr && !['mock', 'none'].includes(pr.requested)) out.push({ id: 'printer', label: 'Imprimante', connected: pr.driver === 'cups' });
    if (st.network) out.push({ id: 'wifi', label: 'Wi-Fi', connected: !!st.network.wifi });
    const d = deck.status();
    if (d.enabled) out.push({ id: 'deck', label: d.model ? `Stream Deck ${d.model}` : 'Stream Deck', connected: !!d.connected });
    const sc = screen.status();
    if (sc.available && !sc.off && sc.checkedAt) out.push({ id: 'screen', label: sc.display?.name ? `Écran ${sc.display.name}` : 'Écran', connected: !!sc.display });
    const L = lights.status();
    if (L.running) for (const l of L.devices) out.push({ id: `light:${l.id}`, label: `Lumière ${l.name || `${l.type} ${l.ip.split('.').pop()}`}`, connected: l.online });
    return out;
  };
}
