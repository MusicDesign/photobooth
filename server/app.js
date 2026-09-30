import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Config } from './config.js';
import { Store } from './store.js';
import { Templates } from './templates.js';
import { buildAllPreviews } from './template-previews.js';
import { Themes, DEFAULT_LOGO } from './themes.js';
import { Booth } from './booth.js';
import { Devices } from './devices.js';
import { StreamDeckRemote } from './streamdeck.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { galleryHtml, eventGalleryHtml } from './gallery.js';
import { HttpError, isLocalRequest } from './util.js';
import { ROOT, OUTPUT_DIR, PUBLIC_DIR, SESSIONS_DIR, PRINTS_DIR, TEMPLATES_DIR, UPLOADS_DIR, SAMPLES_DIR } from './paths.js';

/**
 * Assemble l'application. Les variables d'environnement BOOTH_CAMERA et
 * BOOTH_PRINTER forcent un pilote sans toucher au fichier de config (tests).
 * onShutdown : appelé quand l'admin éteint la borne, après fermeture du serveur
 * (le lanceur quitte alors le processus, l'app Electron ferme sa fenêtre).
 * onRestart : pareil pour « Redémarrer » ; seul un lanceur capable de se relancer le fournit (app Electron).
 */
export async function createApp({ port = Number(process.env.PORT) || 3000, onShutdown = null, onRestart = null, remoteScreen = null } = {}) {
  for (const d of [OUTPUT_DIR, SESSIONS_DIR, PRINTS_DIR, TEMPLATES_DIR, UPLOADS_DIR]) fs.mkdirSync(d, { recursive: true });

  const config = new Config();
  config.load();
  if (process.env.BOOTH_CAMERA) config.setRuntime({ camera: { driver: process.env.BOOTH_CAMERA } });
  if (process.env.BOOTH_PRINTER) config.setRuntime({ printer: { driver: process.env.BOOTH_PRINTER } });

  const store = new Store();
  const templates = new Templates();
  const themes = new Themes();

  // Pilotes choisis d'après la config (ou détectés en mode auto), remplaçables à chaud.
  let booth = null;
  const devices = new Devices({ config, printerBusy: () => booth?.printing() ?? false });
  await devices.start();

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
  };

  booth = new Booth({ config, store, templates, themes, camera: devices.camera, printer: devices.printer, broadcast, port });
  // Port réellement ouvert (utile quand PORT=0 en test) pour l'URL de partage.
  server.on('listening', () => { booth.port = server.address().port; });

  // Bascule de matériel : la borne recharge son bootstrap (mode caméra, imprimante disponible).
  devices.on('camera', (cam) => { booth.setCamera(cam); broadcast({ type: 'config' }); });
  devices.on('printer', (p) => { booth.setPrinter(p); broadcast({ type: 'config' }); });
  devices.on('network', () => broadcast({ type: 'config' })); // Wi-Fi apparu ou perdu : QR codes affichés ou non
  // Miniatures des cadres manquantes (templates copiés à la main, nouvelle version) : la borne les reprend ensuite
  buildAllPreviews(templates).then((n) => { if (n) broadcast({ type: 'config' }); });

  // Stream Deck : la borne décrit son écran ('ui'), un appui lui est renvoyé ('deck'), à elle seule.
  let boothSocket = null;
  const toBooth = (msg) => { if (boothSocket?.readyState === 1) boothSocket.send(JSON.stringify(msg)); };
  const deck = new StreamDeckRemote({
    config,
    onPress: (id) => toBooth({ type: 'deck', id }),
    onInfo: (info) => toBooth({ type: 'deckInfo', ...info })
  });
  wss.on('connection', (ws, req) => {
    const local = isLocalRequest(req); // seule la borne décrit son écran au Stream Deck
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg?.type === 'ui' && local) {
        if (boothSocket !== ws) { boothSocket = ws; toBooth({ type: 'deckInfo', ...deck.galleryInfo() }); }
        boothScreen = typeof msg.screen === 'string' ? msg.screen : null;
        deck.setUi(msg);
      }
    });
    ws.on('close', () => { if (boothSocket === ws) boothScreen = null; });
  });
  // Écran affiché sur la borne (envoyé en continu pour le Stream Deck) : « admin… » quand l'admin l'a remplacé
  let boothScreen = null;
  const kioskScreen = () => (boothSocket?.readyState === 1 ? boothScreen : null);
  if (process.env.BOOTH_STREAMDECK !== 'off') await deck.start();

  config.on('change', () => {
    broadcast({ type: 'config' });
    devices.refresh().catch((e) => console.warn(`[devices] ${e.message}`));
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  // Favicon = le logo défini dans Apparence (toutes les pages, y compris celles des téléphones)
  // L'écran de la borne est réservé à la machine de la borne : un téléphone qui ouvrait l'accueil devenait une
  // deuxième borne (Stream Deck repris, live view réveillé, séances en parallèle) et la faisait planter.
  app.get(['/', '/index.html'], (req, res, next) => {
    if (isLocalRequest(req)) return next();
    res.redirect(302, '/galerie'); // autre appareil : la galerie de la soirée (ou sa page « fermée » si désactivée)
  });
  app.get('/favicon.ico', (req, res) => res.redirect(302, themes.resolve(config.get()).logo || DEFAULT_LOGO));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  app.use('/output', express.static(OUTPUT_DIR, { maxAge: '1h' }));
  app.use('/templates', express.static(TEMPLATES_DIR, { maxAge: '1h' }));
  app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1h' }));
  app.use('/samples', express.static(SAMPLES_DIR, { maxAge: '1h' }));
  // Détourage IA de l'aperçu : MediaPipe (script + wasm) servi en local, la borne est hors ligne.
  app.use('/vendor/mediapipe', express.static(path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision'), { maxAge: '1d' }));

  // Arrêt ou redémarrage demandé depuis l'admin : la réponse part d'abord, puis caméra, Stream Deck et
  // serveur se ferment proprement avant que le lanceur quitte (et se relance).
  let stopping = false;
  const stopThen = (then, what) => then && (() => {
    if (stopping) return;
    stopping = true;
    console.log(`[booth] ${what} demandé depuis l'admin`);
    setTimeout(async () => {
      try { await close(); } catch (e) { console.error(`[booth] ${what} : ${e.message}`); }
      await then();
    }, 300);
  });
  const shutdown = stopThen(onShutdown, 'arrêt');
  const restart = stopThen(onRestart, 'redémarrage');

  app.use('/api/admin', adminRouter({ booth, config, store, templates, themes, devices, deck, shutdown, restart, kioskScreen, remoteScreen }));
  // Écran déporté (iPad…) : l'écran de la borne et son toucher, avec le code admin (voir electron/remote-screen.js)
  app.get('/remote', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'remote.html')));
  // API de l'écran de la borne : seulement depuis la borne (les téléphones n'ont besoin que de ping et de la galerie)
  const PHONE_API = [/^\/ping$/, /^\/gallery$/];
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/admin') || isLocalRequest(req) || (req.method === 'GET' && PHONE_API.some((re) => re.test(req.path)))) return next();
    res.status(403).json({ error: 'BOOTH_ONLY', message: 'Réservé à l\'écran de la borne' });
  });
  app.use('/api', apiRouter({ booth }));

  // Page d'une photo (tous les QR codes y mènent). Galerie téléphone ouverte : navigation entre les photos.
  app.get('/g/:id', (req, res) => {
    const cfg = config.get();
    const session = booth.view(booth.load(req.params.id));
    const items = cfg.gallery.web ? booth.gallery() : [];
    const index = items.findIndex((it) => it.id === session.id);
    const nav = index < 0 ? null : { index, total: items.length, prev: items[index - 1], next: items[index + 1] };
    res.type('html').send(galleryHtml({ session, theme: themes.resolve(cfg), boothName: cfg.booth.name, texts: cfg.texts, nav }));
  });

  // Grille de l'événement pour les téléphones (réglage gallery.web) ; chaque photo s'ouvre sur /g/:id.
  app.get('/galerie', (req, res) => {
    const cfg = config.get();
    res.status(cfg.gallery.web ? 200 : 404).type('html')
      .send(eventGalleryHtml({ theme: themes.resolve(cfg), boothName: cfg.booth.name, texts: cfg.texts, items: cfg.gallery.web ? booth.gallery() : null }));
  });
  app.get('/galerie/:id', (req, res) => res.redirect(301, `/g/${encodeURIComponent(req.params.id)}`)); // anciens liens

  app.get('/admin', (req, res) => res.redirect('/admin.html'));

  // Gestion d'erreurs : JSON propre pour l'API, page simple ailleurs.
  app.use((err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : (err.status || 500);
    if (status >= 500) console.error(err);
    const body = { error: err.code || 'ERROR', message: err.message || 'Erreur interne' };
    if (req.path.startsWith('/api') || req.accepts(['html', 'json']) === 'json') res.status(status).json(body);
    else res.status(status).type('text').send(`${status} · ${body.message}`);
  });

  const close = async () => {
    await devices.stop();
    await deck.stop();
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  };

  return { app, server, wss, booth, config, store, templates, themes, devices, deck, port, close };
}
