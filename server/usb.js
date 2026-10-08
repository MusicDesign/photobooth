import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeName } from './util.js';

const execFileP = promisify(execFile);

/**
 * Clé USB branchée sur la borne : les photos de l'événement en cours y sont copiées, automatiquement au branchement
 * (usb.autoExport) ou à la demande depuis l'admin. Dossier <clé>/Cheeesy/<date nom de l'événement>/ avec montages/
 * et originaux/ selon usb.content (originals | finals | both), mêmes fichiers que l'export ZIP. Un fichier déjà là
 * (même taille) n'est pas recopié : rebrancher la clé plus tard n'ajoute que les nouvelles photos. Le dossier porte
 * un marqueur .cheeesy-event-<id> : l'événement renommé ensuite continue d'aller dans le même dossier.
 * Détection toutes les POLL_MS : volumes de /Volumes hors disque système (macOS), /media/<utilisateur> et
 * /run/media/<utilisateur> (Linux, montage automatique du bureau). Tests : BOOTH_USB_DIRS (dossiers pris pour des
 * clés) ; BOOTH_USB=off coupe tout.
 */
const POLL_MS = 3000;
const EJECT_TRIES = 5;
const CONTENTS = ['originals', 'finals', 'both'];
const MARKER = (eventId) => `.cheeesy-event-${eventId}`;

/** Dossier de l'événement sur la clé : celui qui porte son marqueur, sinon un nouveau (date + nom), marqué. */
async function eventFolder(root, event) {
  let names = [];
  try { names = await fs.promises.readdir(root); } catch { /* première copie sur cette clé */ }
  for (const n of names) {
    try { await fs.promises.access(path.join(root, n, MARKER(event.id))); return path.join(root, n); } catch { /* pas lui */ }
  }
  const base = safeName(`${event.date} ${event.name}`);
  for (let i = 1; ; i++) {
    const dir = path.join(root, i === 1 ? base : `${base} (${i})`);
    // Dossier d'une copie d'avant les marqueurs (aucun marqueur) : repris ; marqué pour un autre événement : suivant
    let taken = false;
    try { taken = (await fs.promises.readdir(dir)).some((f) => f.startsWith('.cheeesy-event-')); } catch { /* libre */ }
    if (taken) continue;
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, MARKER(event.id)), '');
    return dir;
  }
}

export class Usb extends EventEmitter {
  constructor({ config, booth, store, driver = process.env.BOOTH_USB || 'auto' }) {
    super();
    this.config = config;
    this.booth = booth;
    this.store = store;
    this.driverName = driver;
    this.state = { volume: null, exporting: null, lastExport: null, error: null };
    this.queue = Promise.resolve();
    this.timer = null;
    this.abort = false;
  }

  cfg() { return this.config.get().usb || {}; }

  /** Volumes amovibles montés et accessibles en écriture : { path, name, free, total }. */
  volumes() {
    if (this.driverName === 'off') return [];
    const dirs = [];
    if (process.env.BOOTH_USB_DIRS) {
      dirs.push(...process.env.BOOTH_USB_DIRS.split(':').filter((d) => d && fs.existsSync(d)));
    } else if (process.platform === 'darwin') {
      const rootDev = fs.statSync('/').dev;
      for (const name of fs.readdirSync('/Volumes')) {
        if (name.startsWith('.') || name.startsWith('com.apple.')) continue;
        const p = path.join('/Volumes', name);
        try { if (fs.statSync(p).dev !== rootDev) dirs.push(p); } catch { /* volume parti entre-temps */ }
      }
    } else if (process.platform === 'linux') {
      const user = os.userInfo().username;
      for (const base of [`/media/${user}`, `/run/media/${user}`]) {
        if (!fs.existsSync(base)) continue;
        for (const name of fs.readdirSync(base)) {
          const p = path.join(base, name);
          try { if (fs.statSync(p).isDirectory()) dirs.push(p); } catch { /* parti */ }
        }
      }
    }
    const out = [];
    for (const p of dirs) {
      try { fs.accessSync(p, fs.constants.W_OK); } catch { continue; } // lecture seule : pas pour nous
      let free = null, total = null;
      try { const st = fs.statfsSync(p); free = Number(st.bavail) * Number(st.bsize); total = Number(st.blocks) * Number(st.bsize); } catch { /* inconnu */ }
      out.push({ path: p, name: path.basename(p), free, total });
    }
    return out;
  }

  start() {
    if (this.driverName === 'off') return;
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.abort = true;
  }

  /** Clé branchée ou retirée : état mis à jour, copie automatique de l'événement en cours au branchement. */
  tick() {
    let vols;
    try { vols = this.volumes(); } catch (e) { this.state.error = e.message; return; }
    const cur = vols.find((v) => v.path !== this.ejecting) || null; // une clé à la fois : la première trouvée
    if ((cur?.path || null) !== (this.state.volume?.path || null)) {
      if (!cur && this.state.exporting) this.abort = true; // retirée en pleine copie : on arrête
      this.state.volume = cur;
      if (cur) this.state.error = null;
      this.emit('change');
      if (cur && this.cfg().autoExport !== false && this.store.data.activeEventId) this.export(this.store.data.activeEventId).catch(() => {});
    } else if (cur) {
      this.state.volume = { ...this.state.volume, free: cur.free, total: cur.total };
    }
  }

  /** Copie les photos d'un événement sur la clé. Une copie à la fois. */
  export(eventId) {
    const p = this.queue.then(() => this._export(eventId));
    this.queue = p.catch(() => {});
    return p;
  }

  async _export(eventId) {
    const vol = this.state.volume;
    if (!vol) throw new Error('Aucune clé USB branchée');
    const content = CONTENTS.includes(this.cfg().content) ? this.cfg().content : 'both';
    const { event, files } = this.booth.exportFiles(eventId, content);
    if (process.platform === 'darwin') { try { fs.writeFileSync(path.join(vol.path, '.metadata_never_index'), ''); } catch { /* lecture seule */ } }
    const prog = { eventId, eventName: event.name, dest: null, total: files.length, done: 0, copied: 0, skipped: 0, startedAt: new Date().toISOString() };
    this.state.exporting = prog;
    this.state.error = null;
    this.abort = false;
    this.booth.beginExport(eventId); // pas de suppression de l'événement pendant la copie
    this.emit('change');
    let dest = null;
    try {
      dest = prog.dest = await eventFolder(path.join(vol.path, 'Cheeesy'), event);
      for (const f of files) {
        if (this.abort) throw new Error('clé retirée pendant la copie');
        const target = path.join(dest, f.name);
        try {
          if (fs.statSync(target).size === fs.statSync(f.file).size) { prog.skipped++; prog.done++; continue; }
        } catch { /* pas encore copié */ }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(f.file, target); // asynchrone : la borne ne bloque pas pendant la copie
        try { const st = await fs.promises.stat(f.file); await fs.promises.utimes(target, st.atime, st.mtime); } catch { /* date de la copie gardée */ }
        prog.copied++;
        prog.done++;
      }
      this.state.lastExport = { ...prog, at: new Date().toISOString(), ok: true };
      console.log(`[usb] ${event.name} : ${prog.copied} fichier(s) copié(s), ${prog.skipped} déjà là → ${dest}`);
    } catch (e) {
      const msg = e.code === 'ENOSPC' ? 'clé pleine' : e.message;
      this.state.error = `copie interrompue : ${msg}`;
      this.state.lastExport = { ...prog, at: new Date().toISOString(), ok: false, error: msg };
      console.warn(`[usb] ${this.state.error}`);
      throw new Error(this.state.error);
    } finally {
      this.booth.endExport(eventId);
      this.state.exporting = null;
      this.emit('change');
    }
    return this.status();
  }

  /**
   * Éjecte la clé (disque entier, pas seulement le volume) pour la retirer sans risque. Juste après une copie, macOS
   * indexe souvent la clé (Spotlight) ou garde un journal ouvert : le volume est « occupé » quelques secondes.
   * On réessaie donc jusqu'à EJECT_TRIES fois, puis on dit quel programme la retient.
   */
  async eject() {
    const vol = this.state.volume;
    if (!vol) throw new Error('Aucune clé USB branchée');
    if (this.state.exporting) throw new Error('Copie en cours : attendez la fin');
    this.ejecting = vol.path; // tick() ne la redétecte pas pendant l'éjection
    try {
      if (!process.env.BOOTH_USB_DIRS) {
        let last = null;
        for (let i = 0; i < EJECT_TRIES; i++) {
          try { await this.ejectOnce(vol.path); last = null; break; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500)); }
        }
        if (last) {
          const who = await execFileP('lsof', ['-Fc', '+D', vol.path], { timeout: 8000 }).then((r) => [...new Set(r.stdout.split('\n').filter((l) => l.startsWith('c')).map((l) => l.slice(1)))].join(', ')).catch(() => '');
          throw new Error(`clé occupée${who ? ` par ${who}` : ''} : réessayez dans quelques secondes`);
        }
      }
      console.log(`[usb] clé « ${vol.name} » éjectée`);
      this.state.volume = null;
      this.state.lastExport = null;
      this.emit('change');
      return this.status();
    } finally { this.ejecting = null; }
  }

  async ejectOnce(mount) {
    const tool = (bin, args) => execFileP(bin, args, { timeout: 30000, env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/sbin:/sbin:/usr/bin:/bin` } });
    if (process.platform === 'darwin') { await tool('diskutil', ['eject', mount]); return; } // eject : le disque entier
    const dev = (await tool('findmnt', ['-n', '-o', 'SOURCE', mount])).stdout.trim();
    await tool('udisksctl', ['unmount', '-b', dev]);
    const disk = (await tool('lsblk', ['-no', 'PKNAME', dev]).catch(() => ({ stdout: '' }))).stdout.trim();
    if (disk) await tool('udisksctl', ['power-off', '-b', `/dev/${disk}`]).catch(() => {}); // facultatif : la clé s'éteint
  }

  status() {
    return { available: this.driverName !== 'off', ...this.state };
  }
}
