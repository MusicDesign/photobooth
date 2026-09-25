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
import { FORMATS, FONTS, DEFAULT_FORMAT } from '../templates.js';

const EDITABLE_SECTIONS = ['booth', 'camera', 'printer', 'limits', 'templates', 'theme', 'texts', 'admin', 'share', 'gallery'];
const IMAGE_EXT = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function adminRouter({ booth, config, store, templates, themes, devices, deck, shutdown, restart }) {
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
  r.get('/camera/settings', async (req, res) => {
    try { res.json({ settings: await camera().readSettings() }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(409, 'CAMERA_BUSY', e.message); }
  });

  // Dernier calibrage (et celui en cours) : l'admin l'interroge pendant qu'il tourne.
  let calibration = null;
  const calibDir = path.join(OUTPUT_DIR, 'calibration');
  const urlOf = (file) => `/output/calibration/${path.relative(calibDir, file).split(path.sep).join('/')}`;
  // settings + flash : de quoi garder n'importe quelle photo de test comme réglage (choix à la main)
  const shotView = (s) => ({ n: s.n, label: s.label, summary: s.summary, mean: s.mean, clipped: Math.round(s.clipped * 1000) / 10, ok: s.ok, thumb: urlOf(s.thumb), url: urlOf(s.file), settings: s.settings, flash: /flash/i.test(s.label) || !!s.flashFired });
  r.get('/camera/calibration', (req, res) => res.json({ calibration }));
  r.post('/camera/calibrate', (req, res) => {
    const cam = camera();
    if (cam.calibrating) throw new HttpError(409, 'CALIBRATING', 'Calibrage déjà en cours');
    if (booth.guestActive()) throw new HttpError(409, 'GUEST_ACTIVE', 'Un invité est en pleine séance : relance le calibrage quand la borne est revenue à l\'accueil');
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    // On ne garde que les 3 derniers calibrages sur le disque
    try { fs.readdirSync(calibDir).sort().slice(0, -2).forEach((d) => fs.rmSync(path.join(calibDir, d), { recursive: true, force: true })); } catch { /* pas encore de dossier */ }
    calibration = { id, state: 'running', step: 0, label: 'Préparation du boîtier', shots: [], maxShots: MAX_SHOTS };
    res.json({ calibration });
    console.log('[booth] calibrage du boîtier lancé depuis l\'admin');
    cam.calibrateVenue(path.join(calibDir, id), (s) => { calibration = { ...calibration, step: s.step, label: s.label, shots: s.shots.map(shotView) }; }, { evictViewers: true })
      .then((result) => {
        calibration = { ...calibration, state: 'done', profile: result.profile, reason: result.reason, shots: result.shots.map(shotView), flashRaised: result.shots.some((s) => s.flashFired) };
        console.log(`[booth] calibrage terminé : ${result.reason}`);
      })
      .catch((e) => {
        calibration = { ...calibration, state: 'error', error: e.message };
        console.warn(`[booth] calibrage : ${e.message}`);
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
    res.json({
      config: config.get(),
      counters: booth.publicCounters(),
      rawCounters: store.counters(),
      templates: templates.all().map((t) => templates.toPublic(t)),
      formats: FORMATS,
      defaultFormat: DEFAULT_FORMAT,
      fonts: Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.name])),
      samples,
      themes: themes.all(),
      theme: themes.resolve(config.get()),
      drivers: { camera: CAMERA_DRIVERS, printer: PRINTER_DRIVERS, cameraFallbacks: CAMERA_FALLBACKS, printerFallbacks: PRINTER_FALLBACKS },
      camera: await booth.cameraStatus(),
      printer: await booth.printerStatus(),
      devices: devices.status(),
      streamDeck: deck.status(),
      cameraSettings: MANUAL_SETTINGS, // réglages du mode manuel, dans l'ordre, avec leur libellé
      canShutdown: !!shutdown,
      canRestart: !!restart,
      events: store.listEvents().map((ev) => booth.eventView(ev)),
      activeEventId: store.data.activeEventId,
      sessions: store.sessionsOfEvent(store.data.activeEventId).map((s) => booth.view(s)),
      prints: store.listPrints(50),
      shareBaseUrl: booth.shareBaseUrl()
    });
  });

  r.put('/config', (req, res) => {
    const patch = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (EDITABLE_SECTIONS.includes(k) && v && typeof v === 'object') patch[k] = v;
    }
    if (patch.camera?.driver && !CAMERA_DRIVERS.includes(patch.camera.driver)) throw new HttpError(400, 'DRIVER', 'Pilote caméra inconnu');
    if (patch.camera?.fallback && !CAMERA_FALLBACKS.includes(patch.camera.fallback)) throw new HttpError(400, 'DRIVER', 'Repli caméra inconnu');
    if (patch.printer?.driver && !PRINTER_DRIVERS.includes(patch.printer.driver)) throw new HttpError(400, 'DRIVER', 'Pilote imprimante inconnu');
    if (patch.printer?.fallback && !PRINTER_FALLBACKS.includes(patch.printer.fallback)) throw new HttpError(400, 'DRIVER', 'Repli imprimante inconnu');
    if (patch.templates?.defaultFormat && !FORMATS[patch.templates.defaultFormat]) throw new HttpError(400, 'FORMAT', 'Format inconnu');
    res.json({ config: config.update(patch) });
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
  r.post('/templates', upload.single('overlay'), (req, res) => {
    const cfg = config.get();
    if (req.file && req.file.mimetype !== 'image/png') throw new HttpError(400, 'FILE_TYPE', 'Le PNG importé doit être un PNG avec transparence');
    const t = templates.create({
      name: req.body?.name,
      format: req.body?.format || cfg.templates.defaultFormat || DEFAULT_FORMAT,
      background: req.body?.background,
      overlayBuffer: req.file?.buffer || null
    });
    const enabled = cfg.templates.enabled.includes(t.id) ? cfg.templates.enabled : [...cfg.templates.enabled, t.id];
    config.update({ templates: { enabled, default: cfg.templates.default && templates.items.has(cfg.templates.default) ? cfg.templates.default : t.id } });
    res.json(t);
  });

  /** Enregistrement depuis l'éditeur de calques. */
  r.put('/templates/:id', (req, res) => {
    const t = templates.update(req.params.id, req.body || {});
    notifyBooth();
    res.json(t);
  });

  /** Image ajoutée dans un template (logo, cadre…). */
  r.post('/templates/:id/assets', upload.single('image'), async (req, res) => {
    res.json(await templates.addAsset(req.params.id, req.file));
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

  r.get('/events/:id/sessions', (req, res) => {
    const ev = booth.event(req.params.id);
    res.json({ event: booth.eventView(ev), sessions: store.sessionsOfEvent(ev.id).map((s) => booth.view(s)) });
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

  r.all('/{*rest}', () => {
    throw new HttpError(404, 'NOT_FOUND', 'Route admin inconnue');
  });

  return r;
}
