import express from 'express';
import multer from 'multer';
import { HttpError, isLocalRequest } from '../util.js';

export function apiRouter({ booth }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

  r.get('/bootstrap', (req, res) => res.json(booth.bootstrap()));

  // ?calib=1 : aperçu de l'écran du calibrage (flash pas levé : les premières photos de test sont sans flash)
  r.get('/live.mjpeg', (req, res) => booth.camera.attachLiveClient(res, { noFlash: req.query.calib === '1' }));

  r.post('/session', async (req, res) => {
    res.json(await booth.createSession(req.body?.templateId || null));
  });

  r.get('/session/:id', (req, res) => res.json(booth.view(booth.load(req.params.id))));

  /** Envoyé par la borne pendant le décompte : mise au point et déclenchement programmé dans fireInMs. Réponse immédiate. */
  r.post('/session/:id/arm', (req, res) => {
    booth.arm(req.params.id, { index: Number(req.body?.index), fireInMs: Number(req.body?.fireInMs) });
    res.json({ ok: true });
  });

  r.post('/session/:id/disarm', async (req, res) => {
    await booth.disarm(req.params.id);
    res.json({ ok: true });
  });

  /** « Je la garde » : la session sera conservée. */
  r.post('/session/:id/keep', (req, res) => res.json(booth.keepSession(req.params.id)));

  /** La borne revient à l'accueil : la session est supprimée si l'invité ne l'a pas validée. */
  r.post('/session/:id/abandon', async (req, res) => {
    res.json({ deleted: await booth.abandonSession(req.params.id) });
  });

  r.post('/session/:id/shot/:index', upload.single('photo'), async (req, res) => {
    const index = Number(req.params.index);
    res.json(await booth.addShot(req.params.id, index, req.file?.buffer || null));
  });

  /** Boomerang : mise au point au début du décompte ; répond quand l'aperçu est reparti. */
  r.post('/session/:id/focus', async (req, res) => {
    await booth.focusForClip(req.params.id);
    res.json({ ok: true });
  });

  /** Boomerang : la vidéo (filmée par le serveur, ou images envoyées par le navigateur). */
  r.post('/session/:id/clip', upload.array('frames', 80), async (req, res) => {
    res.json(await booth.addClip(req.params.id, req.files?.map((f) => f.buffer) || null));
  });

  /** GIF : toutes les poses sont reprises. */
  r.post('/session/:id/restart', (req, res) => res.json(booth.restartShots(req.params.id)));

  r.post('/session/:id/compose', async (req, res) => {
    res.json(await booth.composeSession(req.params.id));
  });

  r.post('/session/:id/unlock', (req, res) => {
    res.json(booth.unlock(req.params.id, req.body?.pin));
  });

  r.post('/session/:id/print', async (req, res) => {
    const copies = Number(req.body?.copies);
    res.json(await booth.print(req.params.id, copies));
  });

  r.get('/session/:id/qr', async (req, res) => res.json(await booth.qr(req.params.id)));

  r.get('/wifi', async (req, res) => res.json({ wifi: await booth.wifiQr() }));

  // Interrogé par la page distante (adresse publique) : répondre ici, c'est que le téléphone est sur le Wi-Fi de la borne.
  r.get('/ping', (req, res) => res.set('Cache-Control', 'no-store').json({ photobooth: true }));

  // Galerie : sur l'écran de la borne si gallery.booth, depuis un téléphone si gallery.web.
  // La réimpression n'est acceptée que depuis la borne elle-même.
  r.get('/gallery', (req, res) => {
    const g = booth.cfg().gallery;
    if (!((g.booth && isLocalRequest(req)) || g.web)) throw new HttpError(403, 'GALLERY_DISABLED', 'La galerie n\'est pas ouverte');
    res.json({ items: booth.gallery() });
  });

  r.post('/gallery/:id/print', async (req, res) => {
    if (!booth.cfg().gallery.booth || !isLocalRequest(req)) throw new HttpError(403, 'GALLERY_DISABLED', 'Réimpression possible uniquement sur la borne');
    res.json(await booth.galleryPrint(req.params.id, Number(req.body?.copies), req.body?.pin));
  });

  r.all('/{*rest}', () => {
    throw new HttpError(404, 'NOT_FOUND', 'Route API inconnue');
  });

  return r;
}
