import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { BaseCamera } from './base.js';
import { JpegFrameParser, MjpegBroadcaster } from './mjpeg.js';
import { parseAutoDetect, NOT_A_CAMERA } from './detect.js';
import { sleep } from '../util.js';
import { AUTO_BASE, AUTO_DEFAULT, MANUAL_KEYS, calibrate as runCalibration, isFlashBlocked } from './control.js';

const execFileP = promisify(execFile);
// Boîtiers qui acceptent popupflash sans lever le flash (vérifié sur le 2000D, alias 1500D / Rebel T7 / Kiss X90)…
const NO_REMOTE_FLASH = /\b(1500D|2000D|Rebel T7|Kiss X90|3000D|4000D|Rebel T100)\b/i;
// … sauf à partir de ce firmware : le 2000D en 1.2.1 lève bien son flash par USB (vérifié, absent des notes de Canon).
const REMOTE_FLASH_FIRMWARE = { re: /\b(1500D|2000D|Rebel T7|Kiss X90)\b/i, min: [1, 2, 1] };
/** « 3-1.2.1 » (deviceversion) → [1, 2, 1], ou null. */
function parseFirmware(v) {
  const m = /(\d+)\.(\d+)\.(\d+)\s*$/.exec(v || '');
  return m ? m.slice(1).map(Number) : null;
}
const atLeast = (v, min) => { for (let i = 0; i < min.length; i++) { if (v[i] !== min[i]) return v[i] > min[i]; } return true; };
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
      // Attente en tête de chaque commande qui agit sur le boîtier (voir whenReady). Après l'ouverture d'une liaison
      // gphoto2, le 2000D met environ une demi-seconde à être prêt : une action envoyée avant est perdue sans erreur.
      // La demi-pression ne fait pas la mise au point (« Focus Points {} »), le boîtier refuse alors de déclencher
      // (« Full-Press failed / Device Busy » au bout de 10 s) et le flash ne se lève pas. Mesuré le 05/10/2026 à
      // midi : aucune réussite jusqu'à 400 ms d'attente (0 sur 18), toutes à partir de 600 ms (20 sur 20). Ce délai
      // varie : nul certains jours, plus de 800 ms le soir même (photos refusées à 800 ms, passées à 2 s). Piste non
      // vérifiée : gphoto2 bascule la destination des photos (PC à l'ouverture, carte à la fermeture) et le boîtier
      // perd l'action reçue pendant la bascule. 0 = pas d'attente.
      readyMs: 800,
      liveviewCommand: 'gphoto2 --capture-movie --stdout',
      // Relâche le déclencheur à distance (6 = complètement, 5 = à moitié). Un boîtier laissé « bouton enfoncé »
      // par une commande interrompue refuse le live view (« Erreur d'acquisition vidéo ») et les photos.
      recoverCommand: 'gphoto2 --set-config-index eosremoterelease=6 --set-config-index eosremoterelease=5',
      // Boomerang : mise au point seule (demi-pression, le temps que l'AF accroche, relâchement), live coupé.
      // Le point reste ensuite en place pendant la vidéo filmée dans l'aperçu.
      focusCommand: 'gphoto2 --set-config-index eosremoterelease=1 --wait-event=900ms --set-config-index eosremoterelease=5',
      liveview: true,
      settleMs: 800,
      liveIdleMs: 8000, // délai avant de couper le live quand plus aucun écran ne l'affiche
      // Exécutée une fois quand le boîtier est détecté (réglages à pousser). Vide par défaut : le 2000D
      // accepte la commande autopoweroff sans en tenir compte, l'arrêt auto se désactive dans son menu.
      setupCommand: 'gphoto2 --set-config-index drivemode=0', // mode « Unique », voir config.js
      ...opts
    };
    this.mjpeg = new MjpegBroadcaster();
    this.port = null; // voir setPort
    this.live = null;
    this.stopping = false;
    this.busy = false;
    this.lastError = null;
    this.failing = false; // dernier lancement du live en échec (appareil absent, occupé…)
    this.starting = false;
    this.idleTimer = null;
    this.statusRead = null;   // lecture d'état en cours (promesse) : photo et live l'attendent
    this.control = { mode: 'camera' }; // réglages de prise de vue imposés depuis l'admin (voir control.js)
    this.applied = {};                 // valeurs déjà poussées au boîtier depuis sa détection
    this.calibrating = null;           // calibrage en cours : { step, label, shots }
    this.gotFrame = false; // au moins une image reçue du live en cours
    this.sceneLuma = null; // luminosité moyenne (0-255) de la dernière image du live, pour le flash auto
    this.lumaBusy = false;
    this.lumaAt = 0;
    this.lastFlash = null; // le flash a-t-il été demandé pour la dernière photo ?
    this.lastFlashError = null;
    this.noFrameExits = 0; // lancements consécutifs du live terminés sans aucune image
    this.arming = null;   // promesse du pré-armement en cours (arrêt du live + lancement de la commande)
    this.procs = new Set(); // commandes gphoto2 en cours (voir run), arrêtées à la fermeture
    this.pending = null;  // { file, promise, kill } : déclenchement programmé, en cours ou terminé, pas encore consommé
    this.pendingTimer = null;
    this.capturing = false;
  }

  async init() {
    try {
      const { stdout } = await execFileP('gphoto2', ['--version']);
      console.log(`[gphoto2] ${stdout.split('\n')[0]}`);
    } catch {
      throw new Error('gphoto2 introuvable. Installer : sudo dnf install gphoto2 (Fedora), sudo apt install gphoto2 (Ubuntu) ou brew install gphoto2 (Mac).');
    }
    // Démarrage = remise à zéro : commandes restées d'une exécution précédente arrêtées, démon photo de
    // macOS libéré, puis connexion USB du boîtier réinitialisée (sort le 2000D d'un « Device Busy » persistant).
    await this.killOrphans();
    if (process.platform === 'darwin') {
      // macOS accapare l'appareil avec son propre démon PTP.
      try { await execFileP('killall', ['ptpcamerad']); } catch { /* pas lancé */ }
    }
    await this.resetUsb();
    await this.probe();
  }

  /**
   * Commandes gphoto2 restées d'une exécution précédente (app fermée pendant une photo, serveur tué) : elles
   * gardent le boîtier réservé et la borne ne peut plus rien faire (« Could not claim the USB device »).
   * Arrêt en douceur, SIGTERM si elles résistent, puis déclencheur relâché.
   */
  async killOrphans() {
    const alive = async () => { try { await execFileP('pgrep', ['-x', 'gphoto2']); return true; } catch { return false; } };
    if (!(await alive())) return;
    await execFileP('pkill', ['-INT', '-x', 'gphoto2']).catch(() => {});
    for (let i = 0; i < 15 && (await alive()); i++) await sleep(200);
    if (await alive()) { await execFileP('pkill', ['-TERM', '-x', 'gphoto2']).catch(() => {}); await sleep(1000); }
    console.warn('[gphoto2] commande gphoto2 orpheline arrêtée (exécution précédente) : déclencheur relâché');
    await this.recover().catch(() => {});
  }

  /** Le boîtier est-il occupé (live, photo programmée ou en cours, réglages, lecture d'état, commande) ? */
  inUse() {
    return !!(this.live || this.busy || this.starting || this.stopping || this.arming || this.pending
      || this.capturing || this.statusRead || this.calibrating || this.procs.size);
  }

  /** Réinitialise la connexion USB du boîtier (gphoto2 --reset), puis relâche le déclencheur. Jamais bloquant. */
  async resetUsb() {
    try {
      await execFileP('gphoto2', [...(this.port ? ['--port', this.port] : []), '--reset'], { timeout: 10000 });
      await sleep(2000); // le boîtier se réannonce sur l'USB
      console.log('[gphoto2] connexion USB du boîtier réinitialisée');
      this.responsive = await this.recover().catch(() => false); // figé : il ne répond même pas au relâchement
    } catch { /* pas de boîtier branché : rien à réinitialiser */ }
  }

  /** Arrête toutes les commandes gphoto2 en cours (fermeture) : SIGINT, puis SIGTERM 3 s plus tard. */
  async stopAllCommands() {
    if (!this.procs.size) return false;
    const jobs = [...this.procs];
    console.log(`[gphoto2] arrêt de ${jobs.length} commande(s) en cours : ${jobs.map((j) => j.cmd.replace(/^LANG=C LC_ALL=C /, '').split(' --')[0] + ' --' + (j.cmd.split(' --')[1] || '')).join(' ; ')}`);
    for (const j of jobs) j.kill('SIGINT');
    for (let i = 0; i < 15 && jobs.some((j) => !j.exited()); i++) await sleep(200);
    for (const j of jobs) if (!j.exited()) j.kill('SIGTERM');
    return true;
  }

  /** Vérifie la présence du boîtier sans le réserver, pour le tableau de bord, puis le prépare. */
  async probe() {
    try {
      const { stdout } = await execFileP('gphoto2', ['--auto-detect']);
      const all = parseAutoDetect(stdout);
      const cam = all.find((d) => !NOT_A_CAMERA.test(d.model)); // pas un iPhone branché à côté
      const found = !!cam;
      if (found) { this.model = cam.model; this.setPort(all.length > 1 ? cam.port : null); }
      this.failing = !found;
      this.lastError = found ? null : 'Aucun appareil détecté en USB (allumé ? câble ? Wi-Fi du boîtier coupé ?)';
      if (found && this.responsive === false) {
        // Figé (il ne répond pas au relâchement du déclencheur) : inutile d'enchaîner les commandes, chacune
        // attendrait son délai maximal et la borne mettrait plus d'une minute à démarrer. Réessai plus tard.
        this.failing = true;
        this.frozen = true;
        this.frozenAt = Date.now();
        this.lastError = 'Le boîtier ne répond plus (figé) : éteignez-le puis rallumez-le. La borne le reprend toute seule dans les 30 s.';
        console.warn(`[gphoto2] ${this.lastError}`);
        return;
      }
      if (found) await this.readFirmware();
      if (found) await this.setup();
      if (found) { this.applied = {}; await this.applyControl().catch((e) => console.warn(`[gphoto2] réglages du boîtier refusés : ${e.message}`)); }
    } catch (e) {
      this.failing = true;
      this.lastError = e.message;
    }
  }

  /**
   * Lit le firmware à la détection (décide si le flash se lève par USB sur les petits Rebel). La batterie
   * n'est plus lue : toute commande en plus pendant l'usage a bloqué le 2000D. Jamais en même temps qu'une autre commande : l'appelant
   * s'assure que le boîtier est libre, et un dépassement de délai arrête gphoto2 en douceur (SIGINT), jamais
   * SIGKILL (le 2000D se bloque si on coupe une transaction en cours).
   */
  async readStatus({ firmware = false } = {}) {
    const keys = firmware ? ['/main/status/deviceversion'] : [];
    if (!keys.length) return;
    const out = await this.run(`gphoto2 ${keys.map((k) => `--get-config ${k}`).join(' ')}`, 8000, { timeoutSignal: 'SIGINT' }).promise;
    const values = [...out.matchAll(/^Current:\s*(.+)$/gm)].map((m) => m[1].trim());
    if (firmware) {
      this.firmware = values.shift() || this.firmware || null;
      if (this.firmware) console.log(`[gphoto2] ${this.model} · firmware ${this.firmware}${this.flashControl() ? ' · flash pilotable par USB' : ''}`);
    }
  }

  async readFirmware() {
    if (this.live || this.busy || this.starting) return;
    this.statusRead = this.readStatus({ firmware: true }).catch(() => { /* illisible : règle du modèle */ });
    await this.statusRead;
    this.statusRead = null;
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
      // Parti alors que la borne ne l'a pas demandé : levé à la main (il ne se rabat pas par USB)
      const stray = fired && this.lastFlash === false;
      if (stray && !this.flashStray) console.warn('[gphoto2] le flash est parti sans être demandé : il est levé, à rabattre à la main');
      this.flashStray = stray;
      if (!fired) this.flashUpKnown = false; // parti sans flash : il a été rabattu
      this.refreshFlashWarning();
    } catch { /* EXIF illisible : on garde la dernière valeur */ }
  }

  /**
   * « Flash levé : à rabattre » : il est parti sans être demandé sur la dernière photo, ou la borne vient de le
   * lever (calibrage) alors que le réglage en place est sans flash. Prévient la borne et l'admin à chaque changement.
   */
  refreshFlashWarning() {
    const warn = !!this.flashStray || (!!this.flashUpKnown && !this.wantFlash());
    if (warn === !!this.flashWarn) return;
    this.flashWarn = warn;
    this.onFlashStray?.(warn);
  }

  /** Le boîtier sait-il lever son flash par USB ? */
  flashControl() {
    const model = this.model || '';
    if (!NO_REMOTE_FLASH.test(model)) return true;
    const fw = parseFirmware(this.firmware);
    return !!fw && REMOTE_FLASH_FIRMWARE.re.test(model) && atLeast(fw, REMOTE_FLASH_FIRMWARE.min);
  }

  startLive() {
    if (this.live || this.starting || this.stopping || this.busy || !this.wanted()) return;
    clearTimeout(this.idleTimer);
    this.starting = true;
    const go = async () => {
      // Flash à lever (réglage avec flash) et pas levé récemment : levé avant l'aperçu. Flash levé, le Canon ne
      // simule plus l'exposition des photos au flash : l'aperçu (et le boomerang filmé dedans) n'est plus noir.
      // Aperçu coupé pendant la commande : jamais deux commandes gphoto2 à la fois (le boîtier se figerait).
      if (!this.live && !this.stopping && !this.busy && this.wanted() && !this.noFlashViewers && !this.calibrating
        && this.flashControl() && this.wantFlash() && Date.now() - (this.flashRaisedAt || 0) > 30000) {
        await this.raiseFlash().catch(() => {});
      }
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
   * de la liaison (~0,6 s), boîtier prêt (readyMs, 0,8 s), puis il reste ~0,9 s de mise au point avant le
   * déclenchement.
   */
  armLeadMs() {
    if (!(this.opts.armFireCommand || '').trim()) return 0;
    return 3200 + ((this.opts.flash || 'off') !== 'off' ? 1000 : 0); // + la levée du flash, commande à part
  }

  /** Lance une commande shell avec délai maximal. Retourne { promise, kill } ; la promesse rejette avec la dernière ligne d'erreur. */
  /**
   * Lance une commande gphoto2 (groupe de processus à part). Délai dépassé : arrêt en douceur (SIGINT, gphoto2
   * referme sa session), puis SIGTERM 3 s plus tard s'il ne répond toujours pas ; jamais SIGKILL d'emblée,
   * qui coupe une transaction et fige le 2000D. Chaque commande en cours est suivie (this.procs) pour être
   * arrêtée à la fermeture de l'app : sinon elle survit et garde le boîtier réservé.
   */
  /**
   * Autre appareil USB branché (iPhone…) : port du boîtier imposé à chaque commande gphoto2, sinon gphoto2
   * prend le premier de la liste. null : un seul appareil, commandes inchangées.
   */
  setPort(port) {
    if (port === this.port) return;
    this.port = port || null;
    console.log(`[gphoto2] ${this.port ? `plusieurs appareils USB : commandes adressées au boîtier (${this.port})` : 'un seul appareil USB'}`);
  }
  withPort(cmd) {
    return this.port ? cmd.replace(/(^|[\s;&|(])gphoto2(?=\s)/g, `$1gphoto2 --port ${this.port}`) : cmd;
  }

  readyMs() {
    return Math.max(0, Math.round(Number(this.opts.readyMs) || 0));
  }

  /**
   * Commande qui agit sur le boîtier (mise au point, déclenchement, levée du flash) : gphoto2 ouvre la liaison,
   * attend que le boîtier soit prêt (readyMs), puis seulement envoie l'action. Voir readyMs.
   */
  whenReady(cmd, ms = this.readyMs()) {
    return ms > 0 ? cmd.replace(/(^|[\s;&|(])gphoto2(?=\s)/g, `$1gphoto2 --wait-event=${ms}ms`) : cmd;
  }

  run(cmd, timeoutMs, { timeoutSignal = 'SIGINT' } = {}) {
    cmd = this.withPort(cmd);
    const p = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let err = '';
    let out = '';
    let killed = false;
    let exited = false;
    const kill = (sig = 'SIGINT') => { killed = true; try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch { /* déjà parti */ } } };
    const job = { kill, cmd, exited: () => exited };
    this.procs.add(job);
    const promise = new Promise((resolve, reject) => {
      let t2 = null;
      const t = setTimeout(() => {
        err += `\ngphoto2 n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`;
        kill(timeoutSignal);
        t2 = setTimeout(() => { if (!exited) kill('SIGTERM'); }, 3000);
      }, timeoutMs);
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('exit', (code) => {
        exited = true;
        this.procs.delete(job);
        clearTimeout(t);
        clearTimeout(t2);
        const lines = err.trim().split('\n').map((l) => l.trim()).filter((l) => l && !/^UNKNOWN|^\*\*\*|^Pour obtenir|^Ces messages|^l'intention|^diffusion|^en anglais|^env LANG|^For debugging|^These debug|^intend to send|^mailing list|^please run|^Please make sure/i.test(l));
        const last = lines.slice(-3).join(' | ');
        if (code === 0) resolve(out);
        else reject(new Error(killed && !last ? 'commande interrompue' : `gphoto2 a échoué (code ${code}${killed ? ', arrêté' : ''}) : ${last}`));
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
    const proc = spawn('sh', ['-c', this.withPort(this.opts.liveviewCommand)], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.live = proc;
    const liveStart = Date.now();
    console.log('[gphoto2] live view : démarrage');
    let stderr = '';
    proc.stdout.on('data', (chunk) => parser.feed(chunk));
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.on('exit', (code) => {
      if (this.live === proc) this.live = null;
      console.log(`[gphoto2] live view : arrêté après ${Date.now() - liveStart} ms (code ${code}${this.gotFrame ? '' : ', aucune image'})`);
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
        // « 0 trames » : le boîtier ne renvoie plus d'image (batterie vide, éteint, en veille ou câble débranché)
        if (/\b0\s(trames|frames)\b|No camera found|Aucun appareil/i.test(this.lastError)) { // \s : gphoto2 met une espace insécable
          this.lastError = 'Le boîtier n\'envoie plus d\'image : batterie vide, boîtier éteint ou en veille, ou câble débranché. Vérifiez la batterie, rallumez-le (ou appuyez à mi-course sur le déclencheur), et désactivez « Arrêt auto » dans son menu (clé jaune).';
        }
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

  // ---------- Réglages de prise de vue (admin → Matériel → Boîtier) ----------

  /** Donne le boîtier à fn seul : attend qu'il soit libre, coupe le live, et le rend ensuite (live relancé si besoin). */
  async exclusive(fn, { timeoutMs = 60000, noViewers = false } = {}) {
    const t0 = Date.now();
    const occupied = () => this.busy || this.arming || this.capturing || this.pending || this.statusRead || this.starting || this.stopping || (noViewers && this.wanted());
    while (occupied()) {
      if (Date.now() - t0 > timeoutMs) throw new Error('Appareil occupé, réessayez dans un instant');
      await sleep(200);
    }
    this.busy = true; // posé sans attente depuis le test : aucune autre commande ne peut s'intercaler
    let release;
    this.statusRead = new Promise((r) => { release = r; }); // les photos attendent la fin
    try {
      if (this.live) await this.stopLive();
      return await fn();
    } finally {
      release();
      this.statusRead = null;
      this.busy = false;
      if (this.wanted()) this.startLive();
    }
  }

  /**
   * gphoto2 en anglais (valeurs stables quelle que soit la langue), arrêt en douceur au dépassement de délai.
   * ready : attente du boîtier avant une action (ms, voir whenReady) ; rien pour lire ou écrire des réglages.
   */
  gp(args, timeoutMs = 20000, { ready = 0 } = {}) {
    return this.run(this.whenReady(`LANG=C LC_ALL=C gphoto2 ${args}`, ready), timeoutMs, { timeoutSignal: 'SIGINT' }).promise;
  }

  /** { clé: { label, readonly, current, choices } } pour les réglages demandés, en une commande. */
  async readConfig(keys) {
    const out = await this.gp(keys.map((k) => `--get-config ${k}`).join(' '));
    const result = {};
    const blocks = out.split(/^END\s*$/m);
    keys.forEach((key, i) => {
      const b = blocks[i] || '';
      const field = (name) => (new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(b) || [])[1]?.trim();
      if (!field('Label')) return;
      result[key] = {
        label: field('Label'),
        readonly: field('Readonly') === '1',
        current: field('Current') ?? '',
        choices: [...b.matchAll(/^Choice:\s*\d+\s+(.*)$/gm)].map((m) => m[1].trim())
      };
    });
    return result;
  }

  /** Pousse des réglages (le mode d'exposition d'abord : vitesse et ouverture n'existent qu'en manuel). */
  async writeConfig(values) {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (!entries.length) return;
    entries.sort(([a], [b]) => (a === 'autoexposuremodedial' ? -1 : b === 'autoexposuremodedial' ? 1 : 0));
    await this.gp(entries.map(([k, v]) => `--set-config ${k}=${quoteArg(v)}`).join(' '));
    console.log(`[gphoto2] réglages : ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  /** Réglages voulus selon le mode : rien (boîtier), ceux de l'admin (manuel), base + calibrage (auto). */
  controlTarget() {
    const c = this.control || {};
    if (c.mode === 'manual') return Object.fromEntries(Object.entries(c.manual || {}).filter(([k, v]) => MANUAL_KEYS.includes(k) && v !== ''));
    if (c.mode === 'auto') return { ...AUTO_BASE, ...(c.auto?.profile || AUTO_DEFAULT).settings };
    return {};
  }

  /** Pousse ce qui diffère de ce qui a déjà été appliqué depuis la détection. */
  async applyControl() {
    const target = this.controlTarget();
    const diff = Object.fromEntries(Object.entries(target).filter(([k, v]) => this.applied[k] !== v));
    if (!Object.keys(diff).length) return;
    await this.writeConfig(diff);
    Object.assign(this.applied, diff);
  }

  /** Nouveau réglage de l'admin : appliqué dès que plus personne n'utilise la borne (jamais pendant une séance). */
  setControl(control) {
    const next = control || { mode: 'camera' };
    if (JSON.stringify(next) === JSON.stringify(this.control)) return;
    this.control = next;
    this.refreshFlashWarning(); // réglage sans flash gardé juste après un calibrage qui l'a levé
    if (!this.model) return; // pas encore détecté : appliqué à la détection
    clearTimeout(this.controlTimer);
    this.controlTimer = setTimeout(() => {
      this.exclusive(() => this.applyControl(), { timeoutMs: 10 * 60 * 1000, noViewers: true })
        .catch((e) => console.warn(`[gphoto2] réglages du boîtier non appliqués : ${e.message}`));
    }, 500);
  }

  /** Admin : valeurs actuelles et choix possibles de chaque réglage, lus sur le boîtier. */
  readSettings() {
    return this.exclusive(() => this.readConfig(MANUAL_KEYS), { timeoutMs: 15000 });
  }

  /**
   * Calibrage sur place (mode auto) : photos de test pour trouver l'exposition du lieu (voir control.js).
   * Refusé pendant une séance. Les réglages du boîtier sont remis comme avant à la fin ; le profil trouvé
   * n'est appliqué que si l'admin le garde.
   */
  async calibrateVenue(dir, onStep = () => {}, { evictViewers = false, light = null } = {}) {
    if (this.calibrating) throw new Error('Calibrage déjà en cours');
    // Aucune séance en cours (vérifié par l'appelant) : le seul aperçu ouvert est celui de l'écran de
    // calibrage, qu'on ferme ici plutôt que d'attendre que le navigateur coupe sa connexion.
    if (evictViewers) this.mjpeg.close();
    for (let i = 0; i < 30 && this.wanted(); i++) await sleep(200);
    if (this.wanted()) throw new Error('Une séance est en cours sur la borne : réessayez quand elle est revenue à l\'accueil');
    this.calibrating = { step: 0, label: 'Préparation du boîtier', shots: [] };
    onStep(this.calibrating);
    try {
      return await this.exclusive(async () => {
        const keys = [...new Set([...Object.keys(AUTO_BASE), 'shutterspeed', 'aperture', 'iso'])];
        const before = await this.readConfig(keys);
        try {
          const result = await runCalibration({
            light, // ring light : calibrage à sa luminosité, sans flash (voir control.js)
            flashControl: this.flashControl(),
            write: (v) => this.writeConfig(v),
            shoot: async (file) => {
              const capture = (ready) => this.gp(`--set-config capturetarget=0 --capture-image-and-download --filename ${quoteArg(file)} --force-overwrite`, 30000, { ready });
              // Comme pour les vraies photos : si le boîtier refuse (mise au point qui n'accroche pas, « Device Busy »),
              // on relâche le déclencheur et on réessaie une fois avant d'abandonner, en lui laissant plus de temps
              // pour être prêt (un refus coûte 10 s : le boîtier cherche le point avant de répondre)
              await capture(this.readyMs()).catch(async (e) => {
                if (!/Full-Press failed|0x2019/.test(e.message)) throw e;
                console.warn('[gphoto2] calibrage : le boîtier refuse de déclencher (Device Busy) : déclencheur relâché, nouvel essai');
                await this.recover();
                await capture(this.readyMs() + 1200);
              }).catch(async (e) => {
                await this.recover();
                // « Full-Press failed / Device Busy » : mise au point impossible (scène presque noire, rien devant l'objectif)
                if (/Full-Press failed|0x2019/.test(e.message)) throw new Error(`Le boîtier n'arrive pas à déclencher (mise au point impossible : scène trop sombre ? lumières éteintes ?). ${e.message.split('\n')[0]}`);
                throw e;
              });
              if (!fs.existsSync(file)) throw new Error('le boîtier n\'a pas rendu de photo');
            },
            // Lever le flash (sans effet s'il l'est déjà) ; un refus est journalisé, la photo le révélera (EXIF)
            raiseFlash: () => this.gp('--set-config popupflash=1', 8000, { ready: this.readyMs() }).catch((e) => console.warn(`[gphoto2] calibrage : levée du flash refusée (${e.message.split('\n')[0]})`))
          }, {
            dir,
            onStep: (s) => {
              this.calibrating = { ...this.calibrating, step: s.step, label: s.label, shots: s.shot ? [...this.calibrating.shots, s.shot] : this.calibrating.shots };
              onStep(this.calibrating);
            }
          });
          // Une photo de test a flashé : le flash est levé (il ne se rabat qu'à la main)
          if (result.shots.some((sh) => sh.flashFired)) { this.flashUpKnown = true; this.refreshFlashWarning(); }
          return result;
        } finally {
          // Réglages d'avant le calibrage, puis ceux du mode choisi dans l'admin
          await this.writeConfig(Object.fromEntries(Object.entries(before).filter(([, v]) => !v.readonly).map(([k, v]) => [k, v.current]))).catch(() => {});
          this.applied = {};
          await this.applyControl().catch(() => {});
        }
      }, { timeoutMs: 15000, noViewers: true });
    } finally {
      this.calibrating = null;
    }
  }

  /** Le flash intégré doit-il être levé pour la prochaine photo ? (mode on, ou auto et scène sombre) */
  wantFlash() {
    if (isFlashBlocked()) return false; // ring light branchée : jamais de flash
    if (this.control?.mode === 'auto') return !!(this.control.auto?.profile || AUTO_DEFAULT).flash; // choisi par le calibrage
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
      await this.sh(this.whenReady(cmd), 6000);
      this.flashRaisedAt = Date.now();
      console.log(`[gphoto2] flash intégré levé (mode ${this.opts.flash}${this.opts.flash === 'auto' ? `, luminosité ${this.sceneLuma}` : ''})`);
    } catch (e) {
      console.warn(`[gphoto2] levée du flash refusée : ${e.message}`);
      this.lastFlashError = e.message;
    }
  }

  /** Échec d'une prise de vue : journalisé en entier et affiché dans le tableau de bord. */
  noteCaptureError(e) {
    this.lastCaptureError = { message: e.message, at: new Date().toISOString() };
    console.warn(`[gphoto2] ÉCHEC de la prise de vue : ${e.message}`);
  }

  /** Relâche le déclencheur à distance si une commande a été interrompue. Jamais bloquant. */
  /** Relâche le déclencheur. Rend false si le boîtier ne répond pas (figé, délai PTP dépassé). */
  async recover() {
    const cmd = (this.opts.recoverCommand || '').trim();
    if (!cmd || this.live) return true;
    try {
      await this.sh(cmd, 8000);
      console.log('[gphoto2] déclencheur relâché');
      return true;
    } catch (e) {
      console.warn(`[gphoto2] relâchement du déclencheur : ${e.message}`);
      return !/Délai d'attente|Timeout|n'a pas répondu/i.test(e.message);
    }
  }

  /**
   * Boîtier figé au démarrage, ou firmware jamais lu (flash pilotable ou non) : réessai (appelé par devices.js
   * toutes les 10 s, au plus une fois toutes les 30 s, jamais pendant une utilisation). Dès qu'il répond
   * (éteint et rallumé), tout est repris : firmware, préparation, réglages.
   */
  async retryIfFrozen() {
    const needed = this.frozen || (this.model && !this.firmware);
    if (!needed || this.retrying || this.inUse() || Date.now() - (this.frozenAt || 0) < 30000) return;
    this.retrying = true;
    try {
      this.frozenAt = Date.now();
      if (!(await this.recover())) return;
      console.log('[gphoto2] le boîtier répond de nouveau : réglages renvoyés');
      this.frozen = false;
      this.responsive = true;
      await this.probe();
    } finally {
      this.retrying = false;
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
      if (this.statusRead) await this.statusRead; // lecture ou réglage en cours : il finit d'abord
      while (this.starting) await sleep(50); // aperçu en train de démarrer (flash levé avant) : il finit d'abord
      const tStop = Date.now();
      await this.stopLive(false); // l'ouverture de la liaison gphoto2 sert de pause de stabilisation
      if (this.clipExposure) { this.clipExposure = false; await this.applyControl().catch(() => {}); } // boomerang abandonné : ISO des photos
      const stopMs = Date.now() - tStop;
      await this.raiseFlash(); // avant le calcul de l'attente : la levée du flash ne retarde pas le déclenchement
      // Délai entre le lancement de la commande et la demi-pression : ouverture de la liaison, puis boîtier prêt
      const open = (this.opts.armOpenMs || 0) + this.readyMs();
      // Jamais moins d'une demi-seconde de mise au point : avance trop courte (flash à lever, décompte bref), la
      // photo part un peu après « 0 » plutôt que sans le point
      const wait = Math.max(500, Math.round(fireInMs - (Date.now() - t0) - open));
      const cmd = this.whenReady(tpl.replace('{flash}', '').replace('{wait}', String(wait)).replace('{file}', quoteArg(file)));
      // Photo attendue 1 à 2 s après le déclenchement : au-delà de 8 s, elle ne viendra pas (voir le repli)
      const job = this.run(cmd, this.readyMs() + wait + 8000);
      const pending = { file, kill: (sig) => { pending.cancelled = true; job.kill(sig); } };
      const shot = job.promise.then(() => {
        if (!fs.existsSync(file)) throw new Error('gphoto2 a terminé sans produire de fichier');
        return file;
      });
      // Repli : en « One Shot », le boîtier refuse de déclencher tant que la mise au point n'accroche pas (pièce
      // presque noire, rien devant l'objectif) ; l'écran reste alors sur « Gardez la pose ». On relâche le
      // déclencheur et on prend la photo en déclenchement direct (celui du calibrage), sans attendre le point.
      // Même prise en main du boîtier (busy), aucune commande en parallèle. Pas de repli si l'invité est parti.
      pending.promise = shot.catch(async (e) => {
        if (pending.cancelled || this.closing) throw e;
        console.warn(`[gphoto2] pas de photo après la mise au point (${e.message.split('\n')[0]}) : photo en déclenchement direct, sans attendre le point`);
        await this.recover();
        const direct = this.whenReady(this.opts.captureCommand.replace('{flash}', '').replace('{file}', quoteArg(file)));
        await this.sh(direct, 20000);
        if (!fs.existsSync(file)) throw new Error('gphoto2 a terminé sans produire de fichier');
        pending.direct = true;
        return file;
      });
      pending.promise.catch(() => {}); // consommée par capture()
      this.pending = pending;
      console.log(`[gphoto2] déclenchement programmé dans ${wait + open} ms, mise au point en cours (arrêt du live : ${stopMs} ms)`);
      const tFire = Date.now();
      pending.promise
        // Échec : ne jamais laisser le déclencheur « enfoncé »
        .then(() => {
          console.log(`[gphoto2] photo reçue ${Date.now() - tFire} ms après le lancement de la commande${pending.direct ? ' (déclenchement direct, mise au point non accrochée)' : ''}`);
        }, (e) => {
          this.noteCaptureError(e);
          return this.recover();
        })
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

  /**
   * Boomerang : mise au point avant de filmer dans l'aperçu (l'aperçu ne la fait pas, et une seconde commande
   * gphoto2 en parallèle bloquerait le boîtier). Live coupé le temps de l'AF, puis relancé (écran branché).
   */
  async focus() {
    const cmd = (this.opts.focusCommand || '').trim();
    if (!cmd) return;
    const t0 = Date.now();
    try {
      await this.exclusive(async () => {
        // La vidéo est filmée sans flash : avec l'exposition des photos au flash (ISO 200…), elle sort noire dans
        // une salle un peu sombre. ISO automatique le temps du boomerang, réglage des photos remis après (recordClip).
        if (this.control?.mode && this.control.mode !== 'camera' && this.applied?.iso !== 'Auto') {
          await this.writeConfig({ iso: 'Auto' }).catch((e) => console.warn(`[gphoto2] ISO auto pour la vidéo refusé : ${e.message}`));
          this.applied.iso = 'Auto'; // applyControl remettra l'ISO des photos
          this.clipExposure = true;
        }
        try { await this.sh(this.whenReady(cmd), 10000); } catch (e) { await this.recover(); throw e; } // ne jamais laisser le déclencheur enfoncé
      }, { timeoutMs: 8000 });
      // Rendu seulement quand l'aperçu renvoie des images : la vidéo peut commencer tout de suite
      for (const tw = Date.now(); !this.gotFrame && Date.now() - tw < 5000;) await sleep(100);
      console.log(`[gphoto2] mise au point avant la vidéo : ${Date.now() - t0} ms (aperçu ${this.gotFrame ? 'relancé' : 'pas encore relancé'})`);
    } catch (e) {
      console.warn(`[gphoto2] mise au point avant la vidéo : ${e.message}`);
    }
  }

  /** Boomerang filmé dans l'aperçu ; ensuite, réglage des photos remis (ISO automatique posé pour la vidéo). */
  async recordClip(opts) {
    try {
      return await super.recordClip(opts);
    } finally {
      if (this.clipExposure) {
        this.clipExposure = false;
        this.exclusive(() => this.applyControl()).catch((e) => console.warn(`[gphoto2] réglage des photos après la vidéo : ${e.message}`));
      }
    }
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
      if (this.statusRead) await this.statusRead; // lecture ou réglage en cours : il finit d'abord
      while (this.starting) await sleep(50); // aperçu en train de démarrer : il finit d'abord
      this.busy = true;
      await this.stopLive();
      await this.raiseFlash();
      const cmd = this.whenReady(this.opts.captureCommand.replace('{flash}', '').replace('{file}', quoteArg(destFile)));
      try {
        await this.sh(cmd, 20000);
        if (!fs.existsSync(destFile)) throw new Error('gphoto2 a terminé sans produire de fichier');
      } catch (e) {
        this.noteCaptureError(e);
        await this.recover(); // ne jamais laisser le déclencheur « enfoncé »
        this.busy = false; // sinon le live ne repartirait plus jamais
        setTimeout(() => this.startLive(), this.opts.settleMs);
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

  /** noFlash : aperçu du calibrage, qui commence par des photos sans flash (il lève le flash lui-même ensuite). */
  attachLiveClient(res, { noFlash = false } = {}) {
    this.mjpeg.attach(res);
    if (noFlash) this.noFlashViewers = (this.noFlashViewers || 0) + 1;
    clearTimeout(this.idleTimer);
    this.startLive();
    res.on('close', () => {
      if (noFlash) this.noFlashViewers -= 1;
      this.scheduleIdleStop();
    });
  }

  status() {
    return {
      driver: this.name,
      mode: this.mode,
      ok: !this.failing,
      liveview: !!this.live,
      standby: this.opts.liveview && !this.live && !this.starting && !this.failing,
      model: this.model || null,
      firmware: this.firmware || null,
      control: this.control?.mode || 'camera',
      calibrating: this.calibrating ? { step: this.calibrating.step, label: this.calibrating.label } : null,
      flashControl: this.flashControl(),
      flashFired: this.flashFired ?? null, // dernière photo : true = flash parti, false = non, null = pas encore de photo
      flashFiredAt: this.flashFiredAt || null,
      flashStray: !!this.flashWarn, // flash levé alors que la borne ne le veut pas : à rabattre à la main
      flash: this.opts.flash || 'off',
      sceneLuma: this.sceneLuma,
      lastCaptureError: this.lastCaptureError || null,
      lastFlash: this.lastFlash,
      lastFlashError: this.lastFlashError || null,
      lastError: this.failing ? this.lastError : null
    };
  }

  async shutdown() {
    this.closing = true; // plus de repli de photo : on s'arrête
    this.opts.liveview = false;
    clearTimeout(this.controlTimer);
    // Photo ou réglage en cours : on les laisse finir (20 s au plus). Coupée en pleine transaction, une commande
    // fige le 2000D (plus de réponse USB jusqu'à ce qu'on l'éteigne) ; vu au redémarrage demandé pendant une photo.
    if (this.procs.size) {
      console.log(`[gphoto2] ${this.procs.size} commande(s) en cours : on les laisse finir avant d'arrêter`);
      for (let i = 0; i < 100 && this.procs.size; i++) await sleep(200);
    }
    // Toujours en cours : arrêtées ici, puis déclencheur relâché
    if (await this.stopAllCommands()) { await sleep(1200); await this.recover().catch(() => {}); } // le boîtier se libère d'abord
    if (this.statusRead) await this.statusRead;
    clearTimeout(this.idleTimer);
    clearTimeout(this.pendingTimer);
    await this.disarm().catch(() => {});
    await this.stopLive();
    this.mjpeg.close();
  }
}
