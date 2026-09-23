import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { BaseCamera } from './base.js';
import { JpegFrameParser, MjpegBroadcaster } from './mjpeg.js';
import { sleep } from '../util.js';

const execFileP = promisify(execFile);
// Boîtiers qui acceptent popupflash sans lever le flash (vérifié sur le 2000D, alias 1500D / Rebel T7 / Kiss X90).
const NO_REMOTE_FLASH = /\b(1500D|2000D|Rebel T7|Kiss X90|3000D|4000D|Rebel T100)\b/i;
/** Balise EXIF Flash (0x9209), bit 0 = flash déclenché. Retourne true / false, ou null si absente. */
function exifFlashFired(buf) {
  if (!buf || buf.length < 14) return null;
  let o = buf.indexOf('Exif\0\0') === 0 ? 6 : 0;
  const le = buf.toString('ascii', o, o + 2) === 'II';
  const u16 = (i) => (le ? buf.readUInt16LE(o + i) : buf.readUInt16BE(o + i));
  const u32 = (i) => (le ? buf.readUInt32LE(o + i) : buf.readUInt32BE(o + i));
  const find = (ifd, tag) => {
    if (ifd + 2 > buf.length - o) return null;
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > buf.length - o) return null;
      if (u16(e) === tag) return e;
    }
    return null;
  };
  try {
    const exifPtr = find(u32(4), 0x8769);
    if (exifPtr === null) return null;
    const flash = find(u32(exifPtr + 8), 0x9209);
    if (flash === null) return null;
    return (u16(flash + 8) & 1) === 1;
  } catch { return null; }
}

const quoteArg = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

/**
 * Pilote Canon EOS (2000D) via gphoto2 en ligne de commande.
 *
 * ÉTAPE 2 : écrit d'après la documentation gphoto2, À VALIDER avec le boîtier.
 * Les commandes sont configurables dans data/config.json (camera.gphoto2) pour
 * pouvoir s'adapter au 2000D sans toucher au code.
 *
 * Principe : un seul processus peut tenir l'appareil. Le live view
 * (capture-movie --stdout) ne tourne que lorsqu'au moins un écran l'affiche :
 * il démarre au premier client MJPEG et s'arrête liveIdleMs après le dernier,
 * ce qui referme l'obturateur du boîtier (miroir baissé, capteur au repos).
 * Au moment de la photo on l'arrête, on déclenche, on télécharge le JPEG, puis
 * on le relance si un écran l'attend encore.
 */
export class Gphoto2Camera extends BaseCamera {
  name = 'gphoto2';

  constructor(opts = {}) {
    super();
    this.opts = {
      flash: 'off',              // 'off' | 'on' | 'auto' (voir config.js)
      flashUpCommand: 'gphoto2 --set-config popupflash=1', // lancée à part avant la photo : un refus n'empêche pas la photo
      flashAutoThreshold: 60,
      captureCommand: 'gphoto2 --set-config capturetarget=0 --capture-image-and-download --filename {file} --force-overwrite',
      // Décompte + déclenchement en UNE session gphoto2, lancée pendant le décompte (live coupé) :
      // demi-pression (1 = « Press Half AF ») → mise au point pendant {wait} ms → pression complète sans
      // refaire le point (4) exactement à « 0 » → téléchargement dès FILEADDED → relâchements (6 puis 5).
      // Mesuré : photo prise à l'instant prévu, fichier ~1 s plus tard. Vide = ancien chemin (tout à « 0 »).
      armFireCommand: 'gphoto2 --set-config capturetarget=0 --set-config-index eosremoterelease=1 --wait-event={wait}ms --set-config-index eosremoterelease=4 --wait-event-and-download=FILEADDED --set-config-index eosremoterelease=6 --set-config-index eosremoterelease=5 --filename {file} --force-overwrite',
      armOpenMs: 600,   // ouverture de la liaison gphoto2 avant la demi-pression (retranchée de l'attente)
      liveviewCommand: 'gphoto2 --capture-movie --stdout',
      // Relâche le déclencheur à distance (6 = complètement, 5 = à moitié). Un boîtier laissé « bouton enfoncé »
      // par une commande interrompue refuse le live view (« Erreur d'acquisition vidéo ») et les photos.
      recoverCommand: 'gphoto2 --set-config-index eosremoterelease=6 --set-config-index eosremoterelease=5',
      liveview: true,
      settleMs: 800,
      liveIdleMs: 8000, // délai avant de couper le live quand plus aucun écran ne l'affiche
      // Exécutée une fois quand le boîtier est détecté (réglages à pousser). Vide par défaut : le 2000D
      // accepte la commande autopoweroff sans en tenir compte, l'arrêt auto se désactive dans son menu.
      setupCommand: '',
      ...opts
    };
    this.mjpeg = new MjpegBroadcaster();
    this.live = null;
    this.stopping = false;
    this.busy = false;
    this.lastError = null;
    this.failing = false; // dernier lancement du live en échec (appareil absent, occupé…)
    this.starting = false;
    this.idleTimer = null;
    this.gotFrame = false; // au moins une image reçue du live en cours
    this.sceneLuma = null; // luminosité moyenne (0-255) de la dernière image du live, pour le flash auto
    this.lumaBusy = false;
    this.lumaAt = 0;
    this.lastFlash = null; // le flash a-t-il été demandé pour la dernière photo ?
    this.lastFlashError = null;
    this.noFrameExits = 0; // lancements consécutifs du live terminés sans aucune image
    this.arming = null;   // promesse du pré-armement en cours (arrêt du live + lancement de la commande)
    this.pending = null;  // { file, promise, kill } : déclenchement programmé, en cours ou terminé, pas encore consommé
    this.pendingTimer = null;
    this.capturing = false;
  }

  async init() {
    try {
      const { stdout } = await execFileP('gphoto2', ['--version']);
      console.log(`[gphoto2] ${stdout.split('\n')[0]}`);
    } catch {
      throw new Error('gphoto2 introuvable. Installer : sudo apt install gphoto2 (Pi) ou brew install gphoto2 (Mac).');
    }
    // Un live view orphelin (serveur tué brutalement) garderait l'obturateur ouvert et l'appareil réservé.
    await this.killOrphans();
    if (process.platform === 'darwin') {
      // macOS accapare l'appareil avec son propre démon PTP.
      try { await execFileP('killall', ['ptpcamerad']); } catch { /* pas lancé */ }
    }
    await this.probe();
  }

  async killOrphans() {
    try {
      await execFileP('pkill', ['-INT', '-f', 'gphoto2 --capture-movie']);
      console.warn('[gphoto2] live view orphelin arrêté');
      await sleep(1500);
    } catch { /* aucun orphelin : pkill renvoie 1 */ }
  }

  /** Vérifie la présence du boîtier sans le réserver, pour le tableau de bord, puis le prépare. */
  async probe() {
    try {
      const { stdout } = await execFileP('gphoto2', ['--auto-detect']);
      const line = stdout.split('\n').find((l) => /usb:/i.test(l));
      const found = !!line;
      if (found) this.model = line.replace(/\s+usb:.*$/i, '').trim();
      this.failing = !found;
      this.lastError = found ? null : 'Aucun appareil détecté en USB (allumé ? câble ? Wi-Fi du boîtier coupé ?)';
      if (found) await this.setup();
    } catch (e) {
      this.failing = true;
      this.lastError = e.message;
    }
  }

  /** Réglages poussés au boîtier à la détection (arrêt auto…). Un échec est journalisé, jamais bloquant. */
  async setup() {
    const cmd = (this.opts.setupCommand || '').trim();
    if (!cmd || this.live || this.busy || this.starting) return;
    try {
      await execFileP('sh', ['-c', cmd], { timeout: 15000 });
      console.log(`[gphoto2] préparation du boîtier : ${cmd}`);
    } catch (e) {
      const line = (e.stderr || e.message || '').toString().trim().split('\n').filter(Boolean).pop();
      console.warn(`[gphoto2] préparation du boîtier refusée (${line}) : vérifier la commande dans l'admin`);
    }
  }

  /** Le live view n'a de raison d'être que si un écran l'affiche. */
  wanted() {
    return this.opts.liveview && this.mjpeg.clients.size > 0;
  }

  /** Après une photo : le flash est-il parti ? Lu dans l'EXIF, seule source fiable sur les Rebel. */
  async noteFlash(file) {
    try {
      const { exif } = await sharp(file).metadata();
      const fired = exifFlashFired(exif);
      if (fired === null) return;
      this.flashFired = fired;
      this.flashFiredAt = new Date().toISOString();
    } catch { /* EXIF illisible : on garde la dernière valeur */ }
  }

  /** Le boîtier sait-il lever son flash par USB ? */
  flashControl() {
    return !NO_REMOTE_FLASH.test(this.model || '');
  }

  startLive() {
    if (this.live || this.starting || this.stopping || this.busy || !this.wanted()) return;
    clearTimeout(this.idleTimer);
    this.starting = true;
    const go = () => {
      this.starting = false;
      if (this.live || this.stopping || this.busy || !this.wanted()) return;
      this.spawnLive();
    };
    // macOS relance son démon PTP à chaque branchement du boîtier : on le libère avant chaque live.
    if (process.platform === 'darwin') execFile('killall', ['ptpcamerad'], () => go());
    else go();
  }

  streaming() { return this.gotFrame; }

  /**
   * Avance avec laquelle la borne appelle arm() avant le « 0 » : arrêt de gphoto2 (~0,9 s), ouverture
   * de la liaison (~0,6 s), puis il reste ~1,7 s de mise au point avant le déclenchement.
   */
  armLeadMs() {
    if (!(this.opts.armFireCommand || '').trim()) return 0;
    return 3200 + ((this.opts.flash || 'off') !== 'off' ? 1000 : 0); // + la levée du flash, commande à part
  }

  /** Lance une commande shell avec délai maximal. Retourne { promise, kill } ; la promesse rejette avec la dernière ligne d'erreur. */
  run(cmd, timeoutMs) {
    const p = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let err = '';
    let out = '';
    let killed = false;
    const kill = (sig = 'SIGINT') => { killed = true; try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch { /* déjà parti */ } } };
    const promise = new Promise((resolve, reject) => {
      const t = setTimeout(() => { err += `\ngphoto2 n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`; kill('SIGKILL'); }, timeoutMs);
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('exit', (code) => {
        clearTimeout(t);
        const last = err.trim().split('\n').filter((l) => l && !/^UNKNOWN/.test(l)).pop() || '';
        if (code === 0) resolve(out);
        else reject(new Error(killed && !last ? 'commande interrompue' : `gphoto2 a échoué (code ${code}) : ${last}`));
      });
    });
    return { promise, kill };
  }

  sh(cmd, timeoutMs) {
    return this.run(cmd, timeoutMs).promise;
  }

  spawnLive() {
    this.gotFrame = false;
    const parser = new JpegFrameParser((frame) => {
      this.failing = false;
      this.lastError = null;
      if (!this.gotFrame) {
        this.gotFrame = true;
        this.onLive?.(true); // la borne ouvre son obturateur
      }
      this.mjpeg.push(frame);
      this.measureLuma(frame);
    });
    // detached : le processus a son propre groupe, que stopLive() tue en entier (shell + gphoto2).
    // Sans ça, tuer le shell laisserait gphoto2 orphelin, obturateur ouvert et appareil réservé.
    const proc = spawn('sh', ['-c', this.opts.liveviewCommand], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.live = proc;
    let stderr = '';
    proc.stdout.on('data', (chunk) => parser.feed(chunk));
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.on('exit', (code) => {
      if (this.live === proc) this.live = null;
      const hadFrames = this.gotFrame;
      if (hadFrames) {
        this.gotFrame = false;
        this.noFrameExits = 0;
        this.onLive?.(false); // plus d'images : la borne referme son obturateur
      }
      if (this.stopping || this.busy) return;
      const lastLine = stderr.trim().split('\n').filter((l) => l && !/^UNKNOWN/.test(l)).pop();
      if (code !== 0 || !hadFrames) {
        // gphoto2 rend 0 même quand l'acquisition échoue tout de suite : sans image, c'est un échec.
        this.failing = true;
        this.lastError = lastLine || `gphoto2 terminé (code ${code}) sans image`;
      }
      if (!this.wanted()) return;
      if (!hadFrames) {
        this.noFrameExits += 1;
        console.warn(`[gphoto2] live view sans image (${this.lastError}) : relâchement du déclencheur puis relance`);
        this.recover().finally(() => setTimeout(() => this.startLive(), Math.min(5000, 1500 * this.noFrameExits)));
      } else {
        console.warn(`[gphoto2] live view terminé (code ${code}), relance dans 2 s`);
        setTimeout(() => this.startLive(), 2000);
      }
    });
  }

  /** Luminosité moyenne de la scène, une image par seconde, pour décider du flash en mode auto. */
  measureLuma(frame) {
    const now = Date.now();
    if (this.lumaBusy || now - this.lumaAt < 1000) return;
    this.lumaBusy = true;
    this.lumaAt = now;
    sharp(frame).resize(24, 16, { fit: 'fill' }).greyscale().raw().toBuffer()
      .then((buf) => { let sum = 0; for (const v of buf) sum += v; this.sceneLuma = Math.round(sum / buf.length); })
      .catch(() => {})
      .finally(() => { this.lumaBusy = false; });
  }

  /** Le flash intégré doit-il être levé pour la prochaine photo ? (mode on, ou auto et scène sombre) */
  wantFlash() {
    const mode = this.opts.flash || 'off';
    if (mode === 'on') return true;
    if (mode === 'auto') return this.sceneLuma !== null && this.sceneLuma < (this.opts.flashAutoThreshold ?? 60);
    return false;
  }

  /**
   * Lève le flash intégré (commande séparée, live coupé). Un refus du boîtier est journalisé et la
   * photo se fait quand même. Lever un flash déjà levé est sans effet.
   */
  async raiseFlash() {
    if (!this.flashControl()) { this.lastFlash = null; return; } // sans effet sur ce boîtier : on n'envoie rien
    const use = this.wantFlash();
    this.lastFlash = use;
    const cmd = (this.opts.flashUpCommand || '').trim();
    if (!use || !cmd) return;
    try {
      await this.sh(cmd, 6000);
      console.log(`[gphoto2] flash intégré levé (mode ${this.opts.flash}${this.opts.flash === 'auto' ? `, luminosité ${this.sceneLuma}` : ''})`);
    } catch (e) {
      console.warn(`[gphoto2] levée du flash refusée : ${e.message}`);
      this.lastFlashError = e.message;
    }
  }

  /** Relâche le déclencheur à distance si une commande a été interrompue. Jamais bloquant. */
  async recover() {
    const cmd = (this.opts.recoverCommand || '').trim();
    if (!cmd || this.live) return;
    try {
      await this.sh(cmd, 8000);
      console.log('[gphoto2] déclencheur relâché');
    } catch (e) {
      console.warn(`[gphoto2] relâchement du déclencheur : ${e.message}`);
    }
  }

  /** Plus aucun écran n'affiche l'aperçu : on coupe le live après un court délai. */
  scheduleIdleStop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.wanted() && this.live && !this.busy) {
        console.log('[gphoto2] aucun écran n\'affiche l\'aperçu : arrêt du live view, obturateur fermé');
        this.stopLive().catch(() => {});
      }
    }, this.opts.liveIdleMs);
  }

  async stopLive(settle = true) {
    const proc = this.live;
    if (!proc) return;
    this.stopping = true;
    const killGroup = (sig) => {
      try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch { /* déjà parti */ } }
    };
    await new Promise((resolve) => {
      const t = setTimeout(() => killGroup('SIGKILL'), 3000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      killGroup('SIGINT');
    });
    this.live = null;
    this.stopping = false;
    if (settle) await sleep(this.opts.settleMs);
    // Un écran s'est branché pendant l'arrêt (hors capture) : on repart.
    if (!this.busy) this.startLive();
  }

  /**
   * Pré-armement pendant le décompte. Coupe le live view (miroir baissé) puis lance UNE session gphoto2
   * qui fait la mise au point tout de suite (demi-pression), attend, déclenche sans refaire le point à
   * l'instant prévu (fireInMs après l'appel) et télécharge la photo dans `file`. capture() récupère
   * ensuite le résultat. Le déclenchement est ainsi calé côté serveur, sans dépendre du réseau à « 0 ».
   */
  async arm({ fireInMs = 0, file } = {}) {
    const tpl = (this.opts.armFireCommand || '').trim();
    if (!tpl || !file || this.capturing || this.arming || this.pending) return;
    const t0 = Date.now();
    this.busy = true; // bloque la relance du live et la bascule de pilote
    this.arming = (async () => {
      await this.stopLive(false); // l'ouverture de la liaison gphoto2 sert de pause de stabilisation
      const wait = Math.max(150, Math.round(fireInMs - (Date.now() - t0) - (this.opts.armOpenMs || 0)));
      await this.raiseFlash();
      const cmd = tpl.replace('{flash}', '').replace('{wait}', String(wait)).replace('{file}', quoteArg(file));
      const job = this.run(cmd, wait + 15000);
      const pending = { file, kill: job.kill };
      pending.promise = job.promise.then(() => {
        if (!fs.existsSync(file)) throw new Error('gphoto2 a terminé sans produire de fichier');
        return file;
      });
      pending.promise.catch(() => {}); // consommée par capture()
      this.pending = pending;
      console.log(`[gphoto2] déclenchement programmé dans ${wait + (this.opts.armOpenMs || 0)} ms, mise au point en cours`);
      job.promise
        .catch(() => this.recover()) // ne jamais laisser le déclencheur « enfoncé »
        .finally(() => {
          this.busy = false;
          setTimeout(() => this.startLive(), this.opts.settleMs);
          // Résultat jamais réclamé (borne partie) : on l'oublie après un délai.
          clearTimeout(this.pendingTimer);
          this.pendingTimer = setTimeout(() => { if (this.pending === pending) this.pending = null; }, 10000);
        });
    })().finally(() => { this.arming = null; });
    await this.arming;
  }

  /** L'invité a annulé pendant le décompte : on interrompt le déclenchement programmé. */
  async disarm() {
    if (this.arming) await this.arming;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.kill('SIGINT');
    console.log('[gphoto2] déclenchement programmé annulé');
  }

  async capture(destFile) {
    if (this.capturing) throw new Error('Appareil occupé');
    this.capturing = true;
    try {
      if (this.arming) await this.arming;
      const pending = this.pending;
      if (pending) {
        // Photo déjà programmée par arm() : on attend le fichier.
        this.pending = null;
        clearTimeout(this.pendingTimer);
        const file = await pending.promise;
        if (file !== destFile) fs.renameSync(file, destFile);
        await this.noteFlash(destFile);
        return destFile;
      }
      // Sans pré-armement : on coupe le live maintenant et tout se fait à « 0 » (mise au point comprise).
      this.busy = true;
      await this.stopLive();
      await this.raiseFlash();
      const cmd = this.opts.captureCommand.replace('{flash}', '').replace('{file}', quoteArg(destFile));
      try {
        await this.sh(cmd, 20000);
        if (!fs.existsSync(destFile)) throw new Error('gphoto2 a terminé sans produire de fichier');
      } catch (e) {
        await this.recover(); // ne jamais laisser le déclencheur « enfoncé »
        throw e;
      }
      this.busy = false;
      setTimeout(() => this.startLive(), this.opts.settleMs);
      await this.noteFlash(destFile);
      return destFile;
    } finally {
      this.capturing = false;
    }
  }

  attachLiveClient(res) {
    this.mjpeg.attach(res);
    clearTimeout(this.idleTimer);
    this.startLive();
    res.on('close', () => this.scheduleIdleStop());
  }

  status() {
    return {
      driver: this.name,
      mode: this.mode,
      ok: !this.failing,
      liveview: !!this.live,
      standby: this.opts.liveview && !this.live && !this.starting && !this.failing,
      model: this.model || null,
      flashControl: this.flashControl(),
      flashFired: this.flashFired ?? null, // dernière photo : true = flash parti, false = non, null = pas encore de photo
      flashFiredAt: this.flashFiredAt || null,
      flash: this.opts.flash || 'off',
      sceneLuma: this.sceneLuma,
      lastFlash: this.lastFlash,
      lastFlashError: this.lastFlashError || null,
      lastError: this.failing ? this.lastError : null
    };
  }

  async shutdown() {
    this.opts.liveview = false;
    clearTimeout(this.idleTimer);
    clearTimeout(this.pendingTimer);
    await this.disarm().catch(() => {});
    await this.stopLive();
    this.mjpeg.close();
  }
}
