import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Config } from './config.js';
import { Store } from './store.js';
import { Templates } from './templates.js';
import { buildAllPreviews } from './template-previews.js';
import { Themes, DEFAULT_LOGO, defaultLogoSvg, patternSvg } from './themes.js';
import { Booth } from './booth.js';
import { Devices } from './devices.js';
import { DeviceWatch, deviceSources } from './device-watch.js';
import { StreamDeckRemote } from './streamdeck.js';
import { Lights } from './lights/index.js';
import { Screen } from './screen.js';
import { setFlashBlocker } from './camera/control.js';
import { Setup } from './setup.js';
import { Updater } from './update.js';
import { Usb } from './usb.js';
import { setCutoutAuto, measurePrecise, restoreCutoutPerf, onCutoutPerf } from './cutout-ai.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { galleryHtml, missingHtml, eventGalleryHtml } from './gallery.js';
import { HttpError, isLocalRequest } from './util.js';
import { pruneUploads, missingUploadRefs } from './uploads.js';
import { ROOT, OUTPUT_DIR, PUBLIC_DIR, SESSIONS_DIR, PRINTS_DIR, TEMPLATES_DIR, UPLOADS_DIR, SAMPLES_DIR } from './paths.js';

/**
 * Assemble l'application. Les variables d'environnement BOOTH_CAMERA et
 * BOOTH_PRINTER forcent un pilote sans toucher au fichier de config (tests).
 * onShutdown : appelé quand l'admin quitte la borne, après fermeture du serveur
 * (le lanceur quitte alors le processus, l'app Electron ferme sa fenêtre).
 * « Éteindre » et « Redémarrer l'ordinateur » arrêtent en plus la machine (Linux, si la session en a le droit sans
 * mot de passe).
 * onRestart : pareil pour « Redémarrer » ; seul un lanceur capable de se relancer le fournit (app Electron).
 */
export async function createApp({ port = Number(process.env.PORT) || 3000, onShutdown = null, onRestart = null, remoteScreen = null, backgroundCamera = false } = {}) {
  for (const d of [OUTPUT_DIR, SESSIONS_DIR, PRINTS_DIR, TEMPLATES_DIR, UPLOADS_DIR]) fs.mkdirSync(d, { recursive: true });

  const config = new Config();
  config.load();
  pruneUploads(config.get()); // logos et fonds remplacés depuis l'admin : les fichiers orphelins ne s'accumulent pas
  const lost = missingUploadRefs(config.get());
  if (lost) { console.warn('[uploads] logo ou image de fond introuvable sur le disque : réglage remis à vide'); config.update(lost); }
  if (process.env.BOOTH_CAMERA) config.setRuntime({ camera: { driver: process.env.BOOTH_CAMERA } });
  if (process.env.BOOTH_PRINTER) config.setRuntime({ printer: { driver: process.env.BOOTH_PRINTER } });

  const store = new Store();
  const templates = new Templates();
  const themes = new Themes();

  // Pilotes choisis d'après la config (ou détectés en mode auto), remplaçables à chaud.
  let booth = null;
  const devices = new Devices({ config, printerBusy: () => booth?.printing() ?? false });
  // backgroundCamera (app Electron) : le boîtier se prépare pendant que le serveur et la fenêtre démarrent
  await devices.start({ backgroundCamera });

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('error', () => {}); // erreurs du serveur http répétées ici (port pris) : traitées par listenFree
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

  // Lumières du réseau local : ambiance à l'accueil, blanc neutre pour la prise de vue (voir lights/index.js)
  const lights = new Lights({ config, themeColor: (key = 'primary') => themes.resolve(config.get()).colors?.[key] });
  setFlashBlocker(() => lights.hasRingLight()); // ring light branchée : le pilote ne lève plus jamais le flash
  booth.onShotDone = () => lights.shotDone(); // photo prise : lumière douce jusqu'au prochain décompte

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
        lights.setScreen(boothScreen);
        // Décompte affiché (touche « countdown » de l'écran décrit) : montée de la lumière jusqu'au « 0 »
        const cd = Number(msg.items?.find?.((i) => i?.id === 'countdown')?.label);
        if (Number.isFinite(cd)) lights.setCountdown(cd);
      }
    });
    ws.on('close', () => { if (boothSocket === ws) boothScreen = null; });
  });
  // Écran affiché sur la borne (envoyé en continu pour le Stream Deck) : « admin… » quand l'admin l'a remplacé
  let boothScreen = null;
  const kioskScreen = () => (boothSocket?.readyState === 1 ? boothScreen : null);
  if (process.env.BOOTH_STREAMDECK !== 'off') await deck.start();
  // En arrière-plan : la recherche des lumières (quelques secondes) ne retarde pas l'ouverture de la borne
  lights.start().catch((e) => console.warn(`[lights] ${e.message}`));
  // Clé USB : photos de l'événement en cours copiées au branchement (voir usb.js)
  const usb = new Usb({ config, booth, store });
  usb.on('change', () => broadcast({ type: 'usb' }));
  usb.start();
  // Écran de la borne en DDC/CI : luminosité et volume depuis l'admin, renvoyés à chaque démarrage (voir screen.js)
  const screen = new Screen({ config });
  screen.start().catch((e) => console.warn(`[screen] ${e.message}`));
  // Installation : état vérifié au démarrage ; ce qui ne demande pas de mot de passe (Homebrew sur Mac, modèle IA,
  // cadres de démo) s'installe en arrière-plan, le reste est affiché dans le tableau de bord (voir setup.js)
  const setup = new Setup();
  setup.check();
  if (process.env.BOOTH_AUTO_INSTALL !== 'off' && setup.pending().length) {
    console.log(`[setup] manque : ${setup.pending().map((it) => it.label).join(', ')} → installation en arrière-plan`);
    const installTimer = setTimeout(() => setup.install().catch((e) => console.warn(`[setup] ${e.message}`)), 5000); // le boîtier d'abord
    installTimer.unref?.();
  }

  // Détourage précis : trop lent sur cette machine ? Mesuré une seule fois par machine (gardé en base), 20 s après
  // le premier démarrage (le boîtier et la borne d'abord), seulement si un template s'en sert. Relancer la mesure à
  // chaque lancement mettait le processeur à fond plusieurs secondes, souvent pile à l'ouverture de l'admin.
  // Les vrais calculs la remettent à jour ensuite à chaque photo.
  setCutoutAuto(() => config.get().templates.cutoutAuto !== false);
  onCutoutPerf((p) => store.setCutoutPerf(p));
  const usesPrecise = () => templates.all().some((t) => t.layers.some((l) => l.type === 'photo' && l.cutout === 'ai' && l.aiPrecision !== 'fast'));
  if (restoreCutoutPerf(store.cutoutPerf())) {
    console.log(`[cutout] détourage précis : ${store.cutoutPerf().preciseSec} s par photo sur cette machine (mesure gardée)`);
  } else {
    const measureTimer = setTimeout(() => { if (usesPrecise()) measurePrecise().catch((e) => console.warn(`[cutout] ${e.message}`)); }, 20000);
    measureTimer.unref?.();
  }

  config.on('change', () => {
    pruneUploads(config.get());
    broadcast({ type: 'config' });
    devices.refresh().catch((e) => console.warn(`[devices] ${e.message}`));
    screen.apply().catch((e) => console.warn(`[screen] ${e.message}`));
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
  // Logo Cheeesy aux couleurs du thème (themes.js) : c = aplat, t = lettres, en hex sans « # ». Paramètres absents
  // ou invalides : couleurs du thème actif. Avec les deux couleurs dans l'URL, la réponse ne change jamais : cache long.
  app.get('/logo.svg', (req, res) => {
    const active = themes.resolve(config.get()).colors;
    const pick = (v, fallback) => (/^[0-9a-f]{6}$/i.test(String(v || '')) ? `#${v}` : fallback);
    const stable = pick(req.query.c, null) && pick(req.query.t, null);
    res.type('image/svg+xml').set('Cache-Control', stable ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(defaultLogoSvg({ primary: pick(req.query.c, active.primary), onPrimary: pick(req.query.t, active.onPrimary) }));
  });
  // Motif de fond d'un thème (themes.js, patternUrl) : couleur et opacité dans l'URL, chaque variante en cache un jour
  app.get('/pattern.svg', (req, res) => {
    const svg = /^[0-9a-f]{6}$/i.test(String(req.query.c || '')) && Number.isInteger(+req.query.o) && patternSvg(String(req.query.p || ''), `#${req.query.c}`, +req.query.o / 100);
    if (!svg) return res.status(404).end();
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
  });
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
  // Éteindre ou redémarrer l'ordinateur : systemctl poweroff / reboot, permis sans mot de passe à la session ouverte
  // devant l'écran (logind répond « yes »). Vérifié au démarrage : sinon le bouton n'est pas proposé.
  const machineOk = { poweroff: false, reboot: false };
  if (process.platform === 'linux') {
    for (const [verb, method] of [['poweroff', 'CanPowerOff'], ['reboot', 'CanReboot']]) {
      promisify(execFile)('busctl', ['call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method], { timeout: 5000 })
        .then(({ stdout }) => { machineOk[verb] = /"yes"/.test(stdout); }, () => {});
    }
  }
  const machine = (verb, what) => stopThen(async () => {
    try { await promisify(execFile)('systemctl', [verb], { timeout: 10000 }); } catch (e) { console.error(`[booth] ${what} : ${e.message}`); }
    await onShutdown?.();
  }, what);
  const powerOff = machine('poweroff', 'extinction');
  const reboot = machine('reboot', 'redémarrage de l\'ordinateur');
  const restart = stopThen(onRestart, 'redémarrage');
  // Mise à jour depuis l'admin (dépôt git) : version en cours lue au démarrage
  const updater = new Updater({ setup, restart, busy: () => booth.printing() });
  updater.version().catch(() => {});

  app.use('/api/admin', adminRouter({ booth, config, store, templates, themes, devices, deck, lights, screen, setup, updater, usb, shutdown, restart, powerOff, reboot, canMachine: (verb) => machineOk[verb], kioskScreen, remoteScreen }));
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
    // Photo supprimée depuis (ou lien mal recopié) : page aux couleurs de la borne, pas l'erreur brute
    if (!store.getSession(req.params.id)) {
      res.status(404).type('html').send(missingHtml({ theme: themes.resolve(cfg), boothName: cfg.booth.name, texts: cfg.texts, gallery: cfg.gallery.web }));
      return;
    }
    const session = booth.view(booth.load(req.params.id));
    const items = cfg.gallery.web ? booth.gallery() : [];
    const index = items.findIndex((it) => it.id === session.id);
    const nav = index < 0 ? null : { index, total: items.length, prev: items[index - 1], next: items[index + 1] };
    res.type('html').send(galleryHtml({ session, theme: themes.resolve(cfg), boothName: cfg.booth.name, texts: cfg.texts, nav }));
  });

  // Fichier à télécharger (boomerang en MP4) : envoyé comme pièce jointe. Ouverte dans Safari, la vidéo
  // s'affiche dans le lecteur et ne propose pas de l'enregistrer.
  app.get('/g/:id/fichier', (req, res) => {
    const s = booth.load(req.params.id);
    if (!s.final?.file || !fs.existsSync(s.final.file) || booth.isUnvalidated(s)) throw new HttpError(404, 'NOT_FOUND', 'Fichier introuvable');
    const name = `${String(config.get().booth.name || 'photobooth').replace(/[^\w-]+/g, '-')}-${s.id}${path.extname(s.final.file)}`;
    res.download(s.final.file, name);
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

  // Connexions et déconnexions d'appareils : notification en haut à droite de l'admin et de la borne
  const deviceWatch = new DeviceWatch({ sources: deviceSources({ devices, deck, lights, screen }), notify: broadcast });
  deviceWatch.start();

  const close = async () => {
    deviceWatch.stop();
    await devices.stop();
    await deck.stop();
    await lights.stop().catch(() => {}); // borne éteinte : lumières éteintes
    screen.stop();
    usb.stop();
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  };

  // cameraReady : première détection de la caméra finie (le lanceur garde son écran de lancement jusque-là)
  return { app, server, wss, booth, config, store, templates, themes, devices, deck, lights, screen, setup, updater, usb, port, close, cameraReady: devices.cameraReady };
}
