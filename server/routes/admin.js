import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { UPLOADS_DIR, OUTPUT_DIR } from '../paths.js';
import { samplePhotos } from '../samples.js';
import { HttpError, parseCookies } from '../util.js';
import { CAMERA_DRIVERS, CAMERA_FALLBACKS } from '../camera/index.js';
import { MANUAL_SETTINGS, MAX_SHOTS } from '../camera/control.js';
import { PRINTER_DRIVERS, PRINTER_FALLBACKS } from '../printer/index.js';
import { FORMATS, FONTS, DEFAULT_FORMAT, normalizeLayers } from '../templates.js';
import { compose } from '../compositor.js';
import { modelStatus, downloadModel } from '../models.js';
import { cutoutPerf } from '../cutout-ai.js';
import { buildPreviews } from '../template-previews.js';
import { buildBundle, readBundle, describeBundle, applyBundle, backupBeforeImport, revertLastImport, lastImportBackup } from '../config-bundle.js';
import { MjpegBroadcaster } from '../camera/mjpeg.js';
import { OUTPUT_DIR as OUT } from '../paths.js';

const EDITABLE_SECTIONS = ['booth', 'camera', 'printer', 'limits', 'templates', 'theme', 'texts', 'admin', 'share', 'gallery', 'lights', 'screen', 'usb'];
const SESSIONS_PER_PAGE = 48;

/** Réglages de l'écran (DDC/CI) : luminosité et volume de 0 à 100, ou null = la borne n'y touche pas. */
function screenPatch(body = {}) {
  const out = {};
  for (const k of ['brightness', 'volume']) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 100)) throw new HttpError(400, 'SCREEN_VALUE', `${k === 'volume' ? 'Volume' : 'Luminosité'} de l'écran : nombre entier de 0 à 100, ou vide`);
    out[k] = v;
  }
  if ('display' in body) out.display = String(body.display || '').slice(0, 120);
  return out;
}
const IMAGE_EXT = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function adminRouter({ booth, config, store, templates, themes, devices, deck, lights = null, screen = null, setup = null, updater = null, usb = null, shutdown, restart, kioskScreen = () => null, remoteScreen = null }) {
  const r = express.Router();
  const tokens = new Set();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

  const isAuthed = (req) => {
    if (!String(config.get().admin.pin ?? '')) return true; // code vide : admin ouvert (phase de test)
    const cookie = parseCookies(req.headers.cookie)['booth_admin'];
    if (cookie && tokens.has(cookie)) return true;
    const pin = req.headers['x-admin-pin'];
    return pin !== undefined && String(pin) === String(config.get().admin.pin);
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

  r.post('/login', (req, res) => {
    if (String(req.body?.pin ?? '') !== String(config.get().admin.pin)) throw new HttpError(401, 'BAD_PIN', 'Code incorrect');
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    res.setHeader('Set-Cookie', `booth_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
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
      cameraSettings: MANUAL_SETTINGS, // réglages du mode manuel, dans l'ordre, avec leur libellé
      canShutdown: !!shutdown,
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
    if (patch.booth?.touch && !['auto', 'touch', 'buttons'].includes(patch.booth.touch)) throw new HttpError(400, 'TOUCH', 'Mode d\'écran tactile inconnu');
    if (patch.booth?.window && !['kiosk', 'fullscreen'].includes(patch.booth.window)) throw new HttpError(400, 'WINDOW', 'Mode de fenêtre inconnu');
    if (patch.screen) patch.screen = screenPatch(patch.screen);
    if (patch.usb?.content && !['originals', 'finals', 'both'].includes(patch.usb.content)) throw new HttpError(400, 'USB_CONTENT', 'Contenu attendu : originals, finals ou both');
    if (patch.camera?.driver && !CAMERA_DRIVERS.includes(patch.camera.driver)) throw new HttpError(400, 'DRIVER', 'Pilote caméra inconnu');
    if (patch.camera?.fallback && !CAMERA_FALLBACKS.includes(patch.camera.fallback)) throw new HttpError(400, 'DRIVER', 'Repli caméra inconnu');
    if (patch.printer?.driver && !PRINTER_DRIVERS.includes(patch.printer.driver)) throw new HttpError(400, 'DRIVER', 'Pilote imprimante inconnu');
    if (patch.printer?.fallback && !PRINTER_FALLBACKS.includes(patch.printer.fallback)) throw new HttpError(400, 'DRIVER', 'Repli imprimante inconnu');
    if (patch.templates?.defaultFormat && !FORMATS[patch.templates.defaultFormat]) throw new HttpError(400, 'FORMAT', 'Format inconnu');
    res.json({ config: config.update(patch) });
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
  const previews = (id) => buildPreviews(templates.get(id)).catch((e) => console.warn(`[templates] miniature de ${id} : ${e.message}`));

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
    const enabled = cfg.templates.enabled.includes(t.id) ? cfg.templates.enabled : [...cfg.templates.enabled, t.id];
    await previews(t.id);
    config.update({ templates: { enabled, default: cfg.templates.default && templates.items.has(cfg.templates.default) ? cfg.templates.default : t.id } });
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
    const cfg = config.get();
    const enabled = cfg.templates.enabled.filter((id) => id !== req.params.id);
    config.update({ templates: { enabled, default: enabled.includes(cfg.templates.default) ? cfg.templates.default : (enabled[0] || '') } });
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
    const base = `${event.date} ${event.name}`.replace(/[\\/:*?"<>|]+/g, '-').trim();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(`${base} - ${label}.zip`)}`);
    // Les JPEG sont déjà compressés : stockés tels quels, l'archive part tout de suite et la borne ne peine pas
    const zip = archiver('zip', { store: true });
    zip.on('warning', (e) => console.warn(`[export] ${e.message}`));
    zip.on('error', (e) => { console.warn(`[export] ${e.message}`); res.destroy(e); });
    res.on('close', () => { if (!res.writableFinished) zip.abort(); }); // téléchargement annulé
    zip.pipe(res);
    for (const f of files) zip.file(f.file, { name: `${base}/${f.name}` });
    zip.finalize();
  });

  // ---------- Export et import de la configuration (voir config-bundle.js) ----------
  const bundleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
  let pendingImport = null; // fichier lu, en attente du choix de l'admin : { id, bundle, at }
  const bundleCtx = () => ({ config, templates });
  const bundleInfo = () => ({ boothName: config.get().booth.name || '', appVersion: updater?.status?.().version || '' });

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
    const backup = await backupBeforeImport({ ...bundleCtx(), ...bundleInfo() });
    const done = applyBundle(pendingImport.bundle, sel, bundleCtx());
    pendingImport = null;
    console.log(`[config] import : ${done.sections} section(s), ${done.templates} template(s) (sauvegarde ${path.basename(backup)})`);
    res.json({ done, backup: { name: path.basename(backup) } });
  });

  r.get('/config/import/backup', (req, res) => {
    const last = lastImportBackup(config);
    res.json({ backup: last ? { name: last.name, at: last.at } : null });
  });

  r.post('/config/import/revert', (req, res) => {
    const done = revertLastImport(bundleCtx());
    console.log('[config] import annulé : état d\'avant rétabli');
    res.json({ done });
  });

  r.all('/{*rest}', () => {
    throw new HttpError(404, 'NOT_FOUND', 'Route admin inconnue');
  });

  return r;
}
