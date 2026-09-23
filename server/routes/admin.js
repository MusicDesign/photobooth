import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { UPLOADS_DIR, SAMPLES_DIR } from '../paths.js';
import { HttpError, parseCookies } from '../util.js';
import { CAMERA_DRIVERS, CAMERA_FALLBACKS } from '../camera/index.js';
import { PRINTER_DRIVERS, PRINTER_FALLBACKS } from '../printer/index.js';
import { FORMATS, FONTS, DEFAULT_FORMAT } from '../templates.js';

const EDITABLE_SECTIONS = ['booth', 'camera', 'printer', 'limits', 'templates', 'theme', 'texts', 'admin', 'share'];
const IMAGE_EXT = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function adminRouter({ booth, config, store, templates, themes, devices, deck }) {
  const r = express.Router();
  const tokens = new Set();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

  const isAuthed = (req) => {
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

  r.get('/state', async (req, res) => {
    const samples = fs.existsSync(SAMPLES_DIR)
      ? fs.readdirSync(SAMPLES_DIR).filter((f) => /\.jpe?g$/i.test(f)).sort().map((f) => `/samples/${f}`)
      : [];
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
      sessions: store.listSessions(50).map((s) => booth.view(s)),
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
    if (req.body?.reset) patch.printed = 0;
    if (Number.isInteger(req.body?.printed)) patch.printed = req.body.printed;
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
    const removed = booth.resetSessions();
    res.json({ ok: true, removed, counters: booth.publicCounters() });
  });

  r.all('/{*rest}', () => {
    throw new HttpError(404, 'NOT_FOUND', 'Route admin inconnue');
  });

  return r;
}
