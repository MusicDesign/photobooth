import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import { UPLOADS_DIR, OUTPUT_DIR } from '../paths.js';
import { samplePhotos } from '../samples.js';
import { HttpError, parseCookies, safeName, localDate } from '../util.js';
import { LOG_FILE, LOG_CATEGORIES, recentLogs, onLog, publicEntry, runLogText } from '../log.js';
import { validateConfigPatch, screenPatch, EDITABLE_SECTIONS } from '../config-validate.js';
import { CAMERA_DRIVERS, CAMERA_FALLBACKS } from '../camera/index.js';
import { MANUAL_SETTINGS, MAX_SHOTS } from '../camera/control.js';
import { PRINTER_DRIVERS, PRINTER_FALLBACKS } from '../printer/index.js';
import { FORMATS, FONTS, DEFAULT_FORMAT, normalizeLayers } from '../templates.js';
import { compose } from '../compositor.js';
import { PATTERNS } from '../themes.js';
import { modelStatus, downloadModel } from '../models.js';
import { cutoutPerf } from '../cutout-ai.js';
import { buildPreviews, buildAllPreviews } from '../template-previews.js';
import { buildBundle, readBundle, describeBundle, checkBundle, applyBundle, backupBeforeImport, revertLastImport, lastImportBackup } from '../config-bundle.js';
import { MjpegBroadcaster } from '../camera/mjpeg.js';
import { OUTPUT_DIR as OUT } from '../paths.js';

const SESSIONS_PER_PAGE = 48;
const SESSION_MS = 12 * 60 * 60 * 1000; // connexion admin (cookie) : 12 h
const LEAVE_MS = 2 * 60 * 1000; // « Retour à la borne » : l'admin se rouvre sans code pendant 2 min

/**
 * Codes admin faux, par adresse IP (téléphones du hotspot compris) : 5 essais, puis 30 s d'attente, doublée à chaque
 * nouvel échec (1 h au plus). Vaut pour la connexion comme pour l'en-tête x-admin-pin. En mémoire : remis à zéro au
 * redémarrage, et pour une adresse dès qu'elle donne le bon code.
 */
export class LoginGuard {
  constructor({ free = 5, baseMs = 30000, maxMs = 60 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { free, baseMs, maxMs, now });
    this.ips = new Map(); // ip → { fails, until }
  }

  check(ip) {
    const wait = (this.ips.get(ip)?.until || 0) - this.now();
    if (wait > 0) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `Trop d'essais : réessayez dans ${Math.ceil(wait / 1000)} s`);
  }

  fail(ip) {
    const e = this.ips.get(ip) || { fails: 0, until: 0 };
    e.fails += 1;
    if (e.fails >= this.free) e.until = this.now() + Math.min(this.maxMs, this.baseMs * 2 ** (e.fails - this.free));
    this.ips.set(ip, e);
    if (this.ips.size > 1000) for (const [k, v] of this.ips) if (v.until < this.now()) this.ips.delete(k);
  }

  success(ip) { this.ips.delete(ip); }
  reset() { this.ips.clear(); }
}
const DISK_LOW = 5 * 1024 ** 3; // sous 5 Go libres : alerte au tableau de bord

/** Place libre sur le disque des photos (output/). */
async function diskStatus() {
  try {
    const st = await fs.promises.statfs(OUTPUT_DIR);
    const free = Number(st.bavail) * Number(st.bsize);
    return { free, total: Number(st.blocks) * Number(st.bsize), low: free < DISK_LOW };
  } catch { return null; }
}

/** Comparaison des codes en temps constant. */
const samePin = (a, b) => {
  const h = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

const IMAGE_EXT = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function adminRouter({ booth, config, store, templates, themes, devices, deck, lights = null, screen = null, setup = null, updater = null, usb = null, shutdown, restart, powerOff = null, reboot = null, canMachine = () => false, kioskScreen = () => null, remoteScreen = null, guard = new LoginGuard() }) {
  const r = express.Router();
  const tokens = new Map(); // jeton du cookie → fin de validité
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
  const adminPin = () => String(config.get().admin.pin ?? '');
  const ipOf = (req) => req.socket.remoteAddress || '';

  // Code admin changé (admin, import) : toutes les connexions ouvertes avec l'ancien code sont fermées
  let knownPin = adminPin();
  config.on('change', () => {
    if (adminPin() === knownPin) return;
    knownPin = adminPin();
    tokens.clear();
  });
  const openSession = (res) => {
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    for (const [t, exp] of tokens) if (exp <= now) tokens.delete(t);
    tokens.set(token, now + SESSION_MS);
    res.setHeader('Set-Cookie', `booth_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`);
  };

  const isAuthed = (req) => {
    if (!adminPin()) return true; // code vide : admin ouvert (phase de test)
    const cookie = parseCookies(req.headers.cookie)['booth_admin'];
    const exp = cookie && tokens.get(cookie);
    if (exp && exp > Date.now()) return true;
    if (exp) tokens.delete(cookie);
    const pin = req.headers['x-admin-pin'];
    if (pin === undefined) return false;
    guard.check(ipOf(req));
    if (samePin(pin, adminPin())) { guard.success(ipOf(req)); return true; }
    guard.fail(ipOf(req));
    return false;
  };

  const saveUpload = (file, prefix, allowed) => {
    if (!file) throw new HttpError(400, 'FILE_REQUIRED', 'Fichier manquant');
    const ext = allowed[file.mimetype];
    if (!ext) throw new HttpError(400, 'FILE_TYPE', `Format attendu : ${Object.values(allowed).join(', ')}`);
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${prefix}-${Date.now()}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), file.buffer);
    return `/uploads/${name}`;
  };

  const notifyBooth = () => booth.broadcast({ type: 'config' });

  // Avant d'afficher le pavé du code : encore connecté (retour à la borne récent) → admin sans code, connexion
  // prolongée ; sinon 429 tant que les essais sont bloqués (la borne montre le délai, pas le pavé).
  r.get('/login', (req, res) => {
    const cookie = parseCookies(req.headers.cookie)['booth_admin'];
    if (adminPin() && cookie && tokens.get(cookie) > Date.now()) {
      tokens.set(cookie, Date.now() + SESSION_MS);
      return res.json({ ok: true, authed: true });
    }
    guard.check(ipOf(req));
    res.json({ ok: true, authed: false });
  });
  r.post('/login', (req, res) => {
    const ip = ipOf(req);
    guard.check(ip);
    if (!samePin(req.body?.pin ?? '', adminPin())) { guard.fail(ip); guard.check(ip); throw new HttpError(401, 'BAD_PIN', 'Code incorrect'); } // dernier essai : le blocage tout de suite
    guard.success(ip);
    openSession(res);
    res.json({ ok: true });
  });

  // « Retour à la borne » : la connexion ne dure plus que LEAVE_MS
  r.post('/leave', (req, res) => {
    const cookie = parseCookies(req.headers.cookie)['booth_admin'];
    const exp = cookie && tokens.get(cookie);
    if (exp) tokens.set(cookie, Math.min(exp, Date.now() + LEAVE_MS));
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    const cookie = parseCookies(req.headers.cookie)['booth_admin'];
    if (cookie) tokens.delete(cookie);
    res.setHeader('Set-Cookie', 'booth_admin=; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  r.use((req, res, next) => {
    if (!isAuthed(req)) throw new HttpError(401, 'UNAUTHORIZED', 'Connexion admin requise');
    next();
  });

  // ---------- Écran déporté (page /remote) ----------
  // Disponible seulement dans l'app de la borne (Electron) : c'est elle qui a la fenêtre à montrer.
  const remoteOk = () => { if (!remoteScreen?.available()) throw new HttpError(409, 'REMOTE_UNAVAILABLE', 'Écran déporté disponible seulement quand la borne tourne dans son application'); };
  const remoteStream = new MjpegBroadcaster();
  let remoteStop = null;
  r.get('/remote/info', (req, res) => { remoteOk(); res.json(remoteScreen.size()); });
  r.get('/remote/stream.mjpeg', (req, res) => {
    remoteOk();
    remoteStream.attach(res);
    remoteStop ||= remoteScreen.subscribe((jpeg) => remoteStream.push(jpeg)); // capture seulement quand on regarde
    console.log(`[remote] écran déporté connecté (${remoteStream.clients.size})`);
    res.on('close', () => {
      remoteStream.clients.delete(res);
      if (!remoteStream.clients.size && remoteStop) { remoteStop(); remoteStop = null; }
    });
  });
  r.post('/remote/input', async (req, res) => {
    remoteOk();
    for (const ev of Array.isArray(req.body?.events) ? req.body.events : [req.body]) await remoteScreen.input(ev);
    res.json({ ok: true });
  });

  r.post('/shutdown', (req, res) => {
    if (!shutdown) throw new HttpError(409, 'SHUTDOWN_UNAVAILABLE', 'Arrêt non disponible dans ce mode de lancement');
    if (booth.printing() && !req.body?.force) throw new HttpError(409, 'PRINTING', 'Une impression est en cours');
    res.json({ ok: true });
    shutdown();
  });
  // Éteindre ou redémarrer l'ordinateur (Linux, autorisé à la session sans mot de passe)
  for (const [verb, action, label] of [['poweroff', powerOff, 'Extinction'], ['reboot', reboot, 'Redémarrage']]) {
    r.post(`/${verb}`, (req, res) => {
      if (!action || !canMachine(verb)) throw new HttpError(409, 'MACHINE_UNAVAILABLE', `${label} de l'ordinateur non disponible sur cette machine`);
      if (booth.printing() && !req.body?.force) throw new HttpError(409, 'PRINTING', 'Une impression est en cours');
      res.json({ ok: true });
      action();
    });
  }

  // ---------- Boîtier : réglages de prise de vue et calibrage ----------
  const camera = () => {
    if (booth.camera.name !== 'gphoto2' || !booth.camera.readSettings) throw new HttpError(409, 'NO_CAMERA_CONTROL', 'Réglages disponibles seulement avec un boîtier branché (pilote gphoto2)');
    return booth.camera;
  };
  /** État du matériel, léger (lu en mémoire, rien n'est envoyé au boîtier) : l'admin le relit au branchement. */
  r.get('/devices', async (req, res) => res.json({ camera: await booth.cameraStatus(), devices: devices.status(), screen: screen?.status() || null }));

  r.get('/camera/settings', async (req, res) => {
    try { res.json({ settings: await camera().readSettings() }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(409, 'CAMERA_BUSY', e.message); }
  });

  // Dernier calibrage (et celui en cours) : l'admin l'interroge pendant qu'il tourne.
  // Photos de test : sur le disque tant que l'écran du calibrage est ouvert, supprimées quand on le quitte
  // (réglage gardé, fermeture, nouvel essai), voir /camera/calibration/discard.
  let calibration = null;
  const calibDir = path.join(OUTPUT_DIR, 'calibration');
  const wipeCalibDir = () => fs.rmSync(calibDir, { recursive: true, force: true });
  wipeCalibDir(); // restes d'une version précédente ou d'un arrêt en plein calibrage
  const urlOf = (file) => `/output/calibration/${path.relative(calibDir, file).split(path.sep).join('/')}`;
  // settings + flash : de quoi garder n'importe quelle photo de test comme réglage (choix à la main)
  const shotView = (s) => ({ n: s.n, label: s.label, summary: s.summary, mean: s.mean, clipped: Math.round(s.clipped * 1000) / 10, ok: s.ok, thumb: urlOf(s.thumb), url: urlOf(s.file), settings: s.settings, flash: !!s.flash, light: s.light ?? null, score: s.score, best: !!s.best });
  r.get('/camera/calibration', (req, res) => res.json({ calibration }));
  /** Écran du calibrage quitté : plus aucune photo de test. En plein calibrage, ce sera fait à la fin. */
  r.post('/camera/calibration/discard', (req, res) => {
    if (calibration?.state === 'running') calibration.discard = true;
    else { calibration = null; wipeCalibDir(); }
    res.json({ ok: true });
  });
  r.post('/camera/calibrate', (req, res) => {
    const cam = camera();
    if (cam.calibrating || calibration?.state === 'running') throw new HttpError(409, 'CALIBRATING', 'Calibrage déjà en cours');
    // Refus seulement si la borne affiche vraiment un écran de séance (admin ouverte sur la borne : aucun invité)
    const screen = kioskScreen();
    if (['template', 'capture', 'review', 'copies', 'printing', 'done'].includes(screen)) {
      throw new HttpError(409, 'GUEST_ACTIVE', 'Un invité est en pleine séance sur la borne : relance le calibrage quand elle est revenue à l\'accueil');
    }
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    wipeCalibDir(); // nouvel essai : les photos du précédent disparaissent
    calibration = { id, state: 'running', step: 0, label: 'Préparation du boîtier', shots: [], maxShots: MAX_SHOTS };
    res.json({ calibration });
    console.log('[booth] calibrage du boîtier lancé depuis l\'admin');
    // Lumières de prise de vue allumées et stabilisées avant la première mesure : le calibrage (et sa décision
    // de sortir le flash) se fait dans la lumière des vraies photos
    if (lights?.running) calibration = { ...calibration, label: 'Allumage des lumières' };
    const lit = lights ? lights.hold('calibration').catch(() => false) : Promise.resolve(false);
    lit.then((on) => {
      if (on) calibration = { ...calibration, lights: true };
      // Ring light : calibrage à plusieurs luminosités, sans flash
      const light = on && lights?.hasRingLight() ? { set: (b, k) => lights.setRingLight(b, k) } : null;
      if (light) calibration = { ...calibration, ringLight: true };
      return cam.calibrateVenue(path.join(calibDir, id), (s) => { calibration = { ...calibration, step: s.step, label: s.label, shots: s.shots.map(shotView) }; }, { evictViewers: true, light });
    })
      .then((result) => {
        calibration = { ...calibration, state: 'done', profile: result.profile, reason: result.reason, shots: result.shots.map(shotView), flashRaised: result.shots.some((s) => s.flashFired) };
        console.log(`[booth] calibrage terminé : ${result.reason}`);
      })
      .catch((e) => {
        calibration = { ...calibration, state: 'error', error: e.message };
        console.warn(`[booth] calibrage : ${e.message}`);
      })
      .finally(() => {
        lights?.setRingLight(null).catch(() => {});
        lights?.release('calibration');
        if (calibration?.discard) { calibration = null; wipeCalibDir(); } // écran quitté pendant le calibrage
      });
  });

  r.post('/restart', (req, res) => {
    if (!restart) throw new HttpError(409, 'RESTART_UNAVAILABLE', 'Redémarrage non disponible dans ce mode de lancement (serveur lancé dans un terminal)');
    if (booth.printing() && !req.body?.force) throw new HttpError(409, 'PRINTING', 'Une impression est en cours');
    res.json({ ok: true });
    restart();
  });

  r.get('/state', async (req, res) => {
    const samples = samplePhotos().map((s) => s.url);
    const sampleCutouts = samplePhotos().map((s) => s.cutoutUrl || null);
    res.json({
      config: config.get(),
      counters: booth.publicCounters(),
      rawCounters: store.counters(),
      templates: templates.sorted(config.get()).map((t) => templates.toPublic(t)), // ordre d'affichage choisi
      formats: FORMATS,
      defaultFormat: DEFAULT_FORMAT,
      fonts: Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.name])),
      samples,
      sampleCutouts, // même photo détourée (.png), pour les calques avec détourage
      themes: themes.all(),
      patterns: Object.entries(PATTERNS).map(([id, name]) => ({ id, name })), // motifs de fond, au choix du thème personnalisé
      theme: themes.resolve(config.get()),
      drivers: { camera: CAMERA_DRIVERS, printer: PRINTER_DRIVERS, cameraFallbacks: CAMERA_FALLBACKS, printerFallbacks: PRINTER_FALLBACKS },
      camera: await booth.cameraStatus(),
      printer: await booth.printerStatus(),
      devices: devices.status(),
      streamDeck: deck.status(),
      lights: lights?.status() || null,
      screen: screen?.status() || null, // écran de la borne (DDC/CI) : luminosité, volume
      setup: setup?.status() || null, // installation : dépendances présentes ou manquantes
      update: updater?.status() || null, // version en cours, mise à jour disponible
      usb: usb?.status() || null, // clé USB branchée, copie en cours ou dernière copie
      disk: await diskStatus(), // place libre pour les photos
      cameraSettings: MANUAL_SETTINGS, // réglages du mode manuel, dans l'ordre, avec leur libellé
      canShutdown: !!shutdown,
      canPowerOff: !!powerOff && canMachine('poweroff'),
      canReboot: !!reboot && canMachine('reboot'),
      canRestart: !!restart,
      dataWarnings: [store.warning, store.sessionWarning, config.warning].filter(Boolean), // base ou configuration reprise d'une sauvegarde, fiches de session illisibles
      subjectModel: modelStatus('subject'), // modèle de détourage précis : installé ou à télécharger
      cutoutPerf: cutoutPerf(), // vitesse mesurée du modèle précis sur cette machine
      events: store.listEvents().map((ev) => booth.eventView(ev)),
      activeEventId: store.data.activeEventId,
      sessions: store.sessionsOfEvent(store.data.activeEventId).slice(0, SESSIONS_PER_PAGE).map((s) => booth.view(s)), // première page
      sessionsPerPage: SESSIONS_PER_PAGE,
      prints: store.listPrints(50),
      shareBaseUrl: booth.shareBaseUrl()
    });
  });

  r.put('/config', (req, res) => {
    const patch = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (EDITABLE_SECTIONS.includes(k) && v && typeof v === 'object') patch[k] = v;
    }
    if (patch.templates) delete patch.templates.schema; // tenu par la borne (Templates.selection)
    validateConfigPatch(patch, { templateIds: new Set(templates.items.keys()) });
    const pinBefore = adminPin();
    const cfg = config.update(patch);
    if (adminPin() !== pinBefore && adminPin()) openSession(res); // les autres connexions sont fermées, pas celle-ci
    res.json({ config: cfg });
  });

  // Mise à jour (dépôt git) : version, recherche, installation en arrière-plan suivie par la page Installation
  const updaterOrFail = () => { if (!updater?.status().available) throw new HttpError(409, 'UPDATE_OFF', 'Mise à jour indisponible : la borne n\'est pas un dépôt git'); return updater; };
  r.get('/update', (req, res) => res.json({ update: updater?.status() || null }));
  r.post('/update/check', async (req, res) => res.json({ update: await updaterOrFail().check() }));
  r.post('/update/install', (req, res) => {
    const u = updaterOrFail();
    u.update().catch(() => {});
    res.json({ update: u.status() });
  });

  // Clé USB : état, copie d'un événement (en arrière-plan), éjection
  const usbOrFail = () => { if (!usb?.status().available) throw new HttpError(409, 'USB_OFF', 'Clé USB désactivée (BOOTH_USB=off)'); return usb; };
  r.get('/usb', (req, res) => res.json({ usb: usb?.status() || null }));
  r.post('/usb/export', (req, res) => {
    const u = usbOrFail();
    if (!u.status().volume) throw new HttpError(409, 'USB_NONE', 'Aucune clé USB branchée');
    const eventId = String(req.body?.eventId || store.data.activeEventId);
    booth.event(eventId); // 404 si inconnu
    u.export(eventId).catch(() => {});
    res.json({ usb: u.status() });
  });
  r.post('/usb/eject', async (req, res) => {
    try { res.json({ usb: await usbOrFail().eject() }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(409, 'USB_EJECT', e.message); }
  });

  // Installation : état revérifié à la demande, installation de ce qui manque en arrière-plan (suivie par le tableau de bord)
  r.get('/setup', (req, res) => { setup?.check(); res.json({ setup: setup?.status() || null }); });
  r.post('/setup/install', (req, res) => {
    if (!setup) throw new HttpError(409, 'SETUP_OFF', 'Installation indisponible');
    setup.install().catch(() => {});
    res.json({ setup: setup.status() });
  });

  // Écran de la borne (DDC/CI) : réglage enregistré puis envoyé à l'écran, qui est relu ; « Relire l'écran » après un branchement
  const screenOrFail = () => { if (!screen || screen.status().off) throw new HttpError(409, 'SCREEN_OFF', 'Écran non piloté par cette borne (BOOTH_SCREEN=off)'); return screen; };
  r.post('/screen', async (req, res) => {
    const sc = screenOrFail();
    config.update({ screen: screenPatch(req.body) });
    await sc.apply();
    res.json({ screen: sc.status() });
  });
  r.post('/screen/refresh', async (req, res) => {
    const sc = screenOrFail();
    await sc.refresh();
    res.json({ screen: sc.status() });
  });

  // Appareils connectés (lumières Govee du réseau local)
  const lightsOrFail = () => { if (!lights) throw new HttpError(409, 'LIGHTS_OFF', 'Lumières indisponibles'); return lights; };
  r.get('/lights', (req, res) => res.json({ lights: lightsOrFail().status() }));
  r.post('/lights/discover', async (req, res) => {
    try { res.json({ lights: await lightsOrFail().discover() }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(409, 'LIGHTS', e.message); }
  });
  // Philips Hue : recherche du pont, association (bouton du pont, 30 s), dissociation
  r.post('/lights/hue/discover', async (req, res) => {
    try { res.json({ bridges: await lightsOrFail().discoverHue() }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(409, 'HUE', e.message); }
  });
  r.post('/lights/hue/pair', async (req, res) => {
    const ip = String(req.body?.ip || '');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new HttpError(400, 'HUE_IP', 'Adresse du pont invalide');
    let paired;
    try { paired = await lightsOrFail().pairHue({ ip, name: String(req.body?.name || '').slice(0, 60) }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(409, 'HUE', e.message); }
    if (!paired) throw new HttpError(408, 'HUE_BUTTON', 'Bouton du pont non pressé à temps');
    res.json({ lights: lights.status() });
  });
  r.post('/lights/hue/forget', (req, res) => { lightsOrFail().forgetHue(); res.json({ lights: lights.status() }); });

  r.post('/lights/identify', async (req, res) => {
    try { await lightsOrFail().identify(String(req.body?.id || '')); } catch (e) { throw e instanceof HttpError ? e : new HttpError(404, 'LIGHT', e.message); }
    res.json({ ok: true });
  });
  r.post('/lights/try-shooting', async (req, res) => {
    await lightsOrFail().tryShooting();
    res.json({ lights: lights.status() });
  });
  /** Oublie une lumière (vendue, remplacée) : elle reviendra si elle répond encore à une recherche. */
  r.delete('/lights/:id', (req, res) => {
    config.remove(['lights', 'devices', req.params.id]);
    res.json({ lights: lightsOrFail().status() });
  });

  /** Relance la détection caméra / imprimante sans attendre le prochain passage. */
  r.post('/devices/refresh', async (req, res) => {
    await devices.refresh();
    res.json({ devices: devices.status(), camera: await booth.cameraStatus(), printer: await booth.printerStatus() });
  });

  // Logo et image de fond de la borne (valables pour tous les thèmes).
  r.post('/logo', upload.single('logo'), (req, res) => {
    const url = saveUpload(req.file, 'logo', IMAGE_EXT);
    config.update({ booth: { logo: url } });
    res.json({ logo: url });
  });

  r.post('/background', upload.single('image'), (req, res) => {
    const { 'image/svg+xml': _svg, ...raster } = IMAGE_EXT;
    const url = saveUpload(req.file, 'bg', raster);
    config.update({ booth: { backgroundImage: url } });
    res.json({ backgroundImage: url });
  });

  // ---------- Templates ----------

  /** Création : un nom suffit (id et taille déduits). PNG complet optionnel (avancé). */
  /**
   * Essai du détourage depuis l'éditeur : monte le template tel qu'il est à l'écran (pas encore enregistré)
   * avec la dernière photo prise par la borne ou la photo d'exemple, exactement comme la photo finale.
   */
  r.post('/templates/test-cutout', async (req, res) => {
    const { template: raw = {}, id, source = 'last' } = req.body || {};
    const saved = id && templates.items.get(id);
    const layers = normalizeLayers(raw.layers);
    const t = { width: Math.round(raw.width) || saved?.width || 1800, height: Math.round(raw.height) || saved?.height || 1200, background: raw.background || '#ffffff', layers, dir: saved?.dir || '' };
    let photo = null;
    if (source === 'last') {
      const shots = Object.values(store.data.sessions).flatMap((s) => (s.shots || []).filter(Boolean).map((sh) => ({ file: sh.file, at: sh.takenAt || s.createdAt })))
        .filter((sh) => sh.file && fs.existsSync(sh.file)).sort((a, b) => (a.at < b.at ? 1 : -1));
      photo = shots[0]?.file;
      if (!photo) throw new HttpError(404, 'NO_PHOTO', 'Pas encore de photo prise par la borne : essaie avec la photo d\'exemple');
    } else {
      photo = samplePhotos()[0]?.file;
      if (!photo) throw new HttpError(404, 'NO_SAMPLE', 'Aucune photo d\'exemple');
    }
    const dir = path.join(OUT, 'cutout-test');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); // un seul essai gardé
    const name = `essai-${Date.now()}.jpg`;
    const t0 = Date.now();
    const shots = Math.max(...layers.filter((l) => l.type === 'photo').map((l) => l.shot)) + 1;
    await compose(t, Array.from({ length: shots }, () => photo), path.join(dir, name));
    res.json({ url: `/output/cutout-test/${name}`, ms: Date.now() - t0, source: source === 'last' ? 'dernière photo de la borne' : 'photo d\'exemple' });
  });

  /** Miniatures du template (choix du cadre) : calculées ici, une fois, plutôt qu'à chaque affichage sur la borne. */
  const previews = (id) => buildPreviews(templates.get(id), { fresh: () => templates.items.get(id) }).catch((e) => console.warn(`[templates] miniature de ${id} : ${e.message}`));

  r.post('/templates', upload.single('overlay'), async (req, res) => {
    const cfg = config.get();
    if (req.file && req.file.mimetype !== 'image/png') throw new HttpError(400, 'FILE_TYPE', 'Le PNG importé doit être un PNG avec transparence');
    const t = templates.create({
      name: req.body?.name,
      kind: ['gif', 'boomerang'].includes(req.body?.kind) ? req.body.kind : 'photo',
      format: req.body?.format || cfg.templates.defaultFormat || DEFAULT_FORMAT,
      background: req.body?.background,
      overlayBuffer: req.file?.buffer || null
    });
    await previews(t.id);
    // Relue après le calcul des miniatures : un enregistrement fait entre-temps n'est pas écrasé
    const tc = config.get().templates;
    const cur = Array.isArray(tc.enabled) ? tc.enabled : [];
    const enabled = cur.includes(t.id) ? cur : [...cur, t.id];
    config.update({ templates: { enabled, default: tc.default && templates.items.has(tc.default) ? tc.default : t.id } });
    res.json(templates.toPublic(templates.get(t.id)));
  });

  /** Enregistrement depuis l'éditeur de calques. */
  r.put('/templates/:id', async (req, res) => {
    const t = templates.update(req.params.id, req.body || {});
    await previews(t.id); // prêtes avant que la borne recharge ses cadres
    notifyBooth();
    res.json(templates.toPublic(templates.get(t.id)));
  });

  /** Modèle de détourage précis : état, et téléchargement (une fois, borne connectée à internet). */
  r.get('/models/subject', (req, res) => res.json(modelStatus('subject')));
  r.post('/models/subject/download', (req, res) => {
    downloadModel('subject').catch(() => { /* erreur gardée dans modelStatus */ });
    res.json(modelStatus('subject'));
  });

  /** « Retirer le fond » en un clic : méthode et réglages choisis d'après l'image. */
  r.post('/templates/:id/assets/auto-cutout', async (req, res) => {
    res.json(await templates.autoCutout(req.params.id, req.body?.src));
  });

  /** Image ajoutée dans un template (logo, cadre…). */
  r.post('/templates/:id/assets', upload.single('image'), async (req, res) => {
    res.json(await templates.addAsset(req.params.id, req.file));
  });
  // Retirer le fond d'une image du template (éditeur) : rend la version transparente à utiliser
  r.post('/templates/:id/assets/cutout', async (req, res) => {
    const { src, ...opts } = req.body || {};
    res.json(await templates.cutoutAsset(req.params.id, src, opts));
  });
  r.post('/templates/:id/assets/corner-color', async (req, res) => {
    res.json({ color: await templates.cornerColor(req.params.id, req.body?.src) });
  });

  r.delete('/templates/:id', (req, res) => {
    templates.remove(req.params.id);
    const tc = config.get().templates;
    const enabled = (Array.isArray(tc.enabled) ? tc.enabled : []).filter((id) => id !== req.params.id);
    config.update({ templates: { enabled, default: enabled.includes(tc.default) ? tc.default : (enabled[0] || '') } });
    res.json({ ok: true });
  });

  // ---------- Compteurs, réimpression ----------

  r.post('/counters', (req, res) => {
    const patch = {};
    // Compteur de tirages : celui de l'événement en cours (le total historique n'est pas touché)
    if (req.body?.reset) store.updateEvent(store.data.activeEventId, { printed: 0 });
    if (Number.isInteger(req.body?.printed)) store.updateEvent(store.data.activeEventId, { printed: Math.max(0, req.body.printed) });
    if (req.body?.paperRemaining === null) patch.paperRemaining = null;
    else if (Number.isInteger(req.body?.paperRemaining)) patch.paperRemaining = req.body.paperRemaining;
    store.updateCounters(patch);
    const counters = booth.publicCounters();
    booth.broadcast({ type: 'counters', counters });
    res.json(counters);
  });

  r.post('/reprint/:id', async (req, res) => {
    res.json(await booth.reprint(req.params.id, Number(req.body?.copies ?? 1)));
  });

  // ---------- Sessions ----------

  r.delete('/sessions/:id', (req, res) => {
    booth.deleteSession(req.params.id);
    res.json({ ok: true, counters: booth.publicCounters() });
  });

  r.post('/sessions/reset', (req, res) => {
    const removed = booth.resetSessions(req.body?.eventId || undefined);
    res.json({ ok: true, removed, counters: booth.publicCounters() });
  });

  r.post('/sessions/:id/move', (req, res) => {
    res.json(booth.moveSession(req.params.id, String(req.body?.eventId || '')));
  });

  // ---------- Événements (dossiers de sessions) ----------

  // Sessions d'un événement, par page (les plus récentes d'abord) : l'admin n'affiche jamais des milliers de lignes
  r.get('/events/:id/sessions', (req, res) => {
    const ev = booth.event(req.params.id);
    const all = store.sessionsOfEvent(ev.id);
    const per = Math.min(500, Math.max(1, Number(req.query.per) || SESSIONS_PER_PAGE));
    const pages = Math.max(1, Math.ceil(all.length / per));
    const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    res.json({ event: booth.eventView(ev), sessions: all.slice((page - 1) * per, page * per).map((s) => booth.view(s)), page, pages, per, total: all.length });
  });

  r.post('/events', (req, res) => {
    const ev = booth.createEvent({ name: req.body?.name, date: req.body?.date, activate: !!req.body?.activate });
    res.json(booth.eventView(ev));
  });

  r.put('/events/:id', (req, res) => {
    res.json(booth.eventView(booth.updateEvent(req.params.id, { name: req.body?.name, date: req.body?.date })));
  });

  r.post('/events/:id/activate', (req, res) => {
    booth.activateEvent(req.params.id);
    res.json({ ok: true, counters: booth.publicCounters() });
  });

  r.delete('/events/:id', (req, res) => {
    res.json({ ok: true, removed: booth.deleteEvent(req.params.id) });
  });

  /** Archive ZIP des photos d'un événement : ?content=originals | finals | both. Envoyée au fil de l'eau. */
  r.get('/events/:id/export', (req, res) => {
    const content = String(req.query.content || 'both');
    const { event, files } = booth.exportFiles(req.params.id, content);
    if (!files.length) throw new HttpError(404, 'EXPORT_EMPTY', 'Aucune photo à exporter pour cet événement');
    const label = { originals: 'originaux', finals: 'montages', both: 'complet' }[content];
    const base = safeName(`${event.date} ${event.name}`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(`${base} - ${label}.zip`)}`);
    // Les JPEG sont déjà compressés : stockés tels quels, l'archive part tout de suite et la borne ne peine pas
    const zip = new ZipArchive({ store: true });
    zip.on('warning', (e) => console.warn(`[export] ${e.message}`));
    zip.on('error', (e) => { console.warn(`[export] ${e.message}`); res.destroy(e); });
    booth.beginExport(event.id); // l'événement ne peut pas être vidé ni supprimé pendant le téléchargement
    res.once('close', () => {
      booth.endExport(event.id);
      if (!res.writableFinished) zip.abort(); // téléchargement annulé
    });
    zip.pipe(res);
    for (const f of files) zip.file(f.file, { name: `${base}/${f.name}` });
    zip.finalize();
  });

  /** Journal du serveur (data/logs/booth.log et l'ancien booth.log.1), en ZIP : lisible sans terminal sur la borne. */
  // Journal en direct (page Journal) : les lignes en mémoire, puis chaque nouvelle ligne (Server-Sent Events)
  r.get('/logs/live', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('init', { categories: LOG_CATEGORIES, entries: recentLogs() });
    const off = onLog((e) => send('log', publicEntry(e)));
    const keep = setInterval(() => res.write(': \n\n'), 20000); // proxy, veille : la connexion reste ouverte
    req.on('close', () => { off(); clearInterval(keep); });
  });

  // Journal depuis le lancement du logiciel (bouton Télécharger de la page Journal), en texte
  r.get('/logs/run', (req, res) => {
    const now = new Date();
    const base = safeName(`${config.get().booth.name || 'Borne'} - journal ${localDate(now)} ${String(now.getHours()).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="journal.log"; filename*=UTF-8''${encodeURIComponent(`${base}.log`)}`);
    res.send(runLogText());
  });

  r.get('/logs', (req, res) => {
    const files = [LOG_FILE, `${LOG_FILE}.1`].filter((f) => fs.existsSync(f));
    if (!files.length) throw new HttpError(404, 'LOG_EMPTY', 'Aucun journal enregistré');
    const base = safeName(`${config.get().booth.name || 'Borne'} - journal ${localDate()}`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="journal.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', (e) => { console.warn(`[logs] ${e.message}`); res.destroy(e); });
    res.on('close', () => { if (!res.writableFinished) zip.abort(); });
    zip.pipe(res);
    for (const f of files) zip.file(f, { name: path.basename(f) });
    zip.finalize();
  });

  // ---------- Export et import de la configuration (voir config-bundle.js) ----------
  const bundleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
  let pendingImport = null; // fichier lu, en attente du choix de l'admin : { id, bundle, at }
  const bundleCtx = () => ({ config, templates });
  const bundleInfo = () => ({ boothName: config.get().booth.name || '', appVersion: updater?.status?.().version || '' });
  /** Après un import ou son annulation : cadres proposés ramenés aux templates présents, miniatures recalculées. */
  const afterImport = () => {
    templates.reconcile(config);
    buildAllPreviews(templates).then((n) => { if (n) notifyBooth(); });
  };

  // Un template seul (liste des templates, menu « … ») : même archive qu'une sauvegarde, à importer depuis Sauvegarde
  r.get('/templates/:id/export', (req, res) => {
    const t = templates.get(req.params.id); // inconnu : 404
    const { boothName, appVersion } = bundleInfo();
    const base = `${t.name || t.id} - template`.replace(/[\\/:*?"<>|]+/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="template.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`);
    const zip = buildBundle({ config, templates, parts: { settings: false, templates: true }, templateIds: [t.id], boothName, appVersion });
    zip.on('error', (e) => { console.warn(`[export] ${e.message}`); res.destroy(e); });
    res.on('close', () => { if (!res.writableFinished) zip.abort(); });
    zip.pipe(res);
    zip.finalize();
  });

  r.get('/config/export', (req, res) => {
    const on = (k, def) => (req.query[k] === undefined ? def : req.query[k] === '1');
    const parts = { settings: on('settings', true), templates: on('templates', false) };
    if (!parts.settings && !parts.templates) throw new HttpError(400, 'EXPORT_EMPTY', 'Rien à exporter : coche au moins un contenu');
    const { boothName, appVersion } = bundleInfo();
    const base = `${boothName || 'Borne'} - configuration ${new Date().toISOString().slice(0, 10)}`.replace(/[\\/:*?"<>|]+/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="configuration.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`);
    const zip = buildBundle({ config, templates, parts, secrets: on('secrets', false), boothName, appVersion });
    zip.on('warning', (e) => console.warn(`[export] ${e.message}`));
    zip.on('error', (e) => { console.warn(`[export] ${e.message}`); res.destroy(e); });
    res.on('close', () => { if (!res.writableFinished) zip.abort(); });
    zip.pipe(res);
    zip.finalize();
  });

  r.post('/config/import/preview', bundleUpload.single('file'), (req, res) => {
    if (!req.file) throw new HttpError(400, 'FILE_REQUIRED', 'Fichier manquant');
    const bundle = readBundle(req.file.buffer);
    pendingImport = { id: crypto.randomBytes(8).toString('hex'), bundle, at: Date.now() };
    res.json({ import: { id: pendingImport.id, ...describeBundle(bundle, { templates }) } });
  });

  r.post('/config/import/apply', async (req, res) => {
    const b = req.body || {};
    if (!pendingImport || pendingImport.id !== b.id || Date.now() - pendingImport.at > 30 * 60 * 1000) throw new HttpError(409, 'IMPORT_EXPIRED', 'Fichier à relire : l\'import a expiré');
    const sel = { sections: [].concat(b.sections || []), templates: [].concat(b.templates || []), secrets: !!b.secrets };
    if (!sel.sections.length && !sel.templates.length) throw new HttpError(400, 'IMPORT_EMPTY', 'Rien de coché');
    const pending = pendingImport; // un autre fichier peut être relu pendant la sauvegarde : on applique celui-ci
    checkBundle(pending.bundle, sel);
    const backup = await backupBeforeImport({ ...bundleCtx(), ...bundleInfo(), bundle: pending.bundle, sel });
    const done = applyBundle(pending.bundle, sel, bundleCtx());
    if (pendingImport === pending) pendingImport = null;
    afterImport();
    console.log(`[config] import : ${done.sections} section(s), ${done.templates} template(s) (sauvegarde ${path.basename(backup)})`);
    res.json({ done, backup: { name: path.basename(backup) } });
  });

  r.get('/config/import/backup', (req, res) => {
    const last = lastImportBackup(config);
    res.json({ backup: last ? { name: last.name, at: last.at } : null });
  });

  r.post('/config/import/revert', (req, res) => {
    const done = revertLastImport(bundleCtx());
    afterImport();
    console.log('[config] import annulé : état d\'avant rétabli');
    res.json({ done });
  });

  r.all('/{*rest}', () => {
    throw new HttpError(404, 'NOT_FOUND', 'Route admin inconnue');
  });

  return r;
}
