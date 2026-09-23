import express from 'express';
import multer from 'multer';
import { HttpError } from '../util.js';

export function apiRouter({ booth }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

  r.get('/bootstrap', (req, res) => res.json(booth.bootstrap()));

  r.get('/live.mjpeg', (req, res) => booth.camera.attachLiveClient(res));

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

  r.post('/session/:id/shot/:index', upload.single('photo'), async (req, res) => {
    const index = Number(req.params.index);
    res.json(await booth.addShot(req.params.id, index, req.file?.buffer || null));
  });

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

  r.all('/{*rest}', () => {
    throw new HttpError(404, 'NOT_FOUND', 'Route API inconnue');
  });

  return r;
}
