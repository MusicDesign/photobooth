/**
 * App de bureau de la borne : le serveur tourne dans ce processus, la borne s'affiche
 * dans une fenêtre plein écran (kiosque). « Quitter la borne » dans l'admin ferme l'app, « Éteindre » l'ordinateur.
 *
 * Raccourci de secours au clavier : Ctrl+Maj+Q quitte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, WebContentsView, dialog, session } from 'electron';
import { createRemoteScreen } from './remote-screen.js';

if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto'); // Wayland (tactile)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Écran déporté (/remote) : la borne doit continuer à se dessiner et à charger ses images même quand sa fenêtre
// est recouverte (Mac) ou que personne ne regarde l'écran branché ; sinon l'iPad voit des vignettes vides
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Lancée depuis le Finder, l'app hérite d'un PATH minimal (/usr/bin:/bin…) : sans Homebrew, gphoto2 est introuvable.
if (process.platform === 'darwin') {
  const dirs = (process.env.PATH || '').split(':');
  for (const d of ['/usr/local/bin', '/opt/homebrew/bin']) if (!dirs.includes(d)) dirs.unshift(d);
  process.env.PATH = dirs.join(':');
}

// L'app s'est appelée « Photo Booth » puis « Cheesy » : une borne déjà installée garde son dossier de données
// (avant le verrou, qui y vit)
const legacyData = ['Cheesy', 'Photo Booth'].map((n) => path.join(app.getPath('appData'), n)).find((d) => fs.existsSync(d));
if (app.isPackaged && !fs.existsSync(app.getPath('userData')) && legacyData) app.setPath('userData', legacyData);

// Une seule borne : relancer l'icône ramène la fenêtre existante.
if (!app.requestSingleInstanceLock()) app.quit();
else start().catch((e) => {
  win?.destroy();
  dialog.showErrorBox('Cheeesy', `Démarrage impossible : ${e.message}`);
  app.exit(1);
});

/** App empaquetée : son code est en lecture seule, les données vont dans le profil utilisateur. */
function useUserData() {
  const base = app.getPath('userData');
  process.env.BOOTH_DATA_DIR ||= path.join(base, 'data');
  process.env.BOOTH_OUTPUT_DIR ||= path.join(base, 'output');
  const seed = path.join(process.resourcesPath, 'data-seed');
  if (!fs.existsSync(process.env.BOOTH_DATA_DIR) && fs.existsSync(seed)) {
    fs.cpSync(seed, process.env.BOOTH_DATA_DIR, { recursive: true });
  }
}

/**
 * Lancer la borne remet tout à zéro : un autre serveur de borne encore lancé (terminal, instance précédente)
 * est arrêté proprement (SIGINT : il rend caméra et Stream Deck), puis on attend qu'il libère le port.
 * Les commandes gphoto2 restantes et le boîtier sont remis à zéro par le pilote caméra.
 */
async function stopOtherServers(port) {
  const { execFileSync } = await import('node:child_process');
  const pids = () => {
    try { return execFileSync('pgrep', ['-f', 'node .*server/index\\.js']).toString().split('\n').map(Number).filter((p) => p && p !== process.pid); } catch { return []; }
  };
  const found = pids();
  if (!found.length) return;
  console.log(`[app] remise à zéro : arrêt de ${found.length} autre(s) serveur(s) de borne (${found.join(', ')})`);
  for (const pid of found) { try { process.kill(pid, 'SIGINT'); } catch { /* déjà parti */ } }
  for (let i = 0; i < 40 && pids().length; i++) await new Promise((r) => setTimeout(r, 200));
  for (const pid of pids()) { try { process.kill(pid, 'SIGTERM'); } catch { /* déjà parti */ } }
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Écran de lancement, affiché dès le clic : le démarrage prend quelques secondes (remise à zéro du boîtier
 * surtout). C'est une vue posée PAR-DESSUS la fenêtre de la borne, retirée quand elle est prête : une seule
 * fenêtre plein écran. Avec deux (lancement puis borne), macOS renvoyait au bureau en fermant la première, la
 * borne restant ouverte mais inaccessible. step() affiche l'étape en cours et la progression.
 */
let win = null;
let splash = null; // WebContentsView
let splashLoaded = Promise.resolve();
/**
 * Fenêtre de la borne (réglage booth.window de l'admin, Écran & contrôle) : « kiosk », verrouillée pour un
 * événement, ou « fullscreen », plein écran classique où le reste de l'ordinateur reste accessible (Cmd+Tab,
 * Mission Control…), pour les essais sur le Mac.
 */
let windowMode = 'kiosk';
/**
 * Impose le mode voulu une fois la fenêtre affichée : sur macOS, une fenêtre créée cachée (show: false) ignore
 * souvent fullscreen ou kiosk, en particulier après un redémarrage depuis l'admin (relance dans l'espace de
 * l'ancienne fenêtre). Rien à faire si elle y est déjà.
 */
function enforceWindowMode() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (windowMode === 'kiosk') { if (!win.isKiosk()) win.setKiosk(true); }
  else if (!win.isFullScreen()) win.setFullScreen(true);
}
function applyWindowMode(mode) {
  const kiosk = mode !== 'fullscreen';
  if (!win || win.isDestroyed()) return;
  if (kiosk === win.isKiosk() && (kiosk || win.isFullScreen())) return;
  windowMode = kiosk ? 'kiosk' : 'fullscreen';
  // macOS n'enchaîne pas deux changements de plein écran : on quitte d'abord l'état en cours (animation), puis on
  // entre dans le nouveau. Même chemin dans les deux sens.
  const enter = () => {
    if (!win || win.isDestroyed()) return;
    if (kiosk) win.setKiosk(true);
    else if (!win.isFullScreen()) win.setFullScreen(true);
  };
  if (win.isKiosk() || win.isFullScreen()) {
    let done = false;
    const go = () => { if (done) return; done = true; setTimeout(enter, 300); };
    win.once('leave-full-screen', go);
    setTimeout(go, 1500); // si l'événement ne vient pas (Linux)
    if (win.isKiosk()) win.setKiosk(false); else win.setFullScreen(false);
  } else enter();
}
function openWindow() {
  win = new BrowserWindow({
    // kiosk ou fullscreen, jamais les deux ni « fullscreen: false » : sur macOS, un fullscreen explicitement faux
    // retire à la fenêtre la capacité plein écran, et le kiosque retombe en fenêtré
    ...(windowMode === 'fullscreen' ? { fullscreen: true } : { kiosk: true }),
    autoHideMenuBar: true,
    backgroundColor: '#f8f9fa', // fond de l'écran de lancement, le temps qu'il se dessine
    show: false,
    // backgroundThrottling : la borne continue de se dessiner même cachée, pour l'écran déporté (/remote)
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  splash = new WebContentsView({ webPreferences: { sandbox: true } });
  splash.setBackgroundColor('#f8f9fa');
  win.contentView.addChildView(splash);
  const fit = () => {
    if (!splash || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    const b = splash.getBounds();
    if (b.width !== width || b.height !== height) splash.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  for (const ev of ['resize', 'resized', 'show', 'enter-full-screen', 'maximize']) win.on(ev, fit);
  // Linux (Wayland) : le passage en plein écran n'émet pas toujours « resize », et l'écran de lancement resterait
  // à la taille de la fenêtre cachée, en haut à gauche, devant la borne. Revérifié tant qu'il est affiché.
  const refit = setInterval(() => (splash ? fit() : clearInterval(refit)), 200);
  splashLoaded = splash.webContents.loadFile(fileURLToPath(new URL('./splash.html', import.meta.url))).catch(() => {});
  splashLoaded.then(() => { win?.show(); setTimeout(enforceWindowMode, 200); });
}
function closeSplash() {
  if (!splash) return;
  win.contentView.removeChildView(splash);
  splash.webContents.close();
  splash = null;
}
async function step(text, progress = null, detail = '') {
  await splashLoaded;
  splash?.webContents.executeJavaScript(`setStep(${JSON.stringify(text)}, ${progress}, ${JSON.stringify(detail)})`).catch(() => {});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  if (app.isPackaged) useUserData();
  await app.whenReady();
  // Mode de la fenêtre lu directement dans le fichier de config : le serveur n'est pas encore démarré
  const { CONFIG_FILE } = await import('../server/paths.js');
  const { readJson } = await import('../server/util.js');
  windowMode = readJson(CONFIG_FILE)?.booth?.window === 'fullscreen' ? 'fullscreen' : 'kiosk';
  openWindow();
  step('Démarrage…', 0.05);
  await stopOtherServers(Number(process.env.PORT) || 3000);

  // Import après le choix des dossiers : server/paths.js les lit au chargement.
  const { installFileLog } = await import('../server/log.js');
  const { createApp } = await import('../server/app.js');
  const { listenFree } = await import('../server/util.js');
  installFileLog();

  let stopped = false;
  const remoteScreen = createRemoteScreen(); // page /remote : écran et toucher de la borne à distance (iPad…)
  step('Préparation de l\'appareil photo…', 0.25, 'Remise à zéro du boîtier : quelques secondes');
  // Le boîtier se prépare en arrière-plan pendant que le serveur démarre et que la borne se charge
  const { server, port, close, cameraReady, config } = await createApp({
    remoteScreen,
    backgroundCamera: true,
    onShutdown: () => { stopped = true; app.quit(); },
    // Redémarrer : nouvelle instance au départ de celle-ci (même dossier d'app, même environnement)
    // Même port qu'avant s'il est libre : l'admin ouverte sur un téléphone ou une tablette s'y reconnecte.
    onRestart: () => { stopped = true; if (server.listening) process.env.PORT = String(server.address().port); app.relaunch(app.isPackaged ? {} : { args: [app.getAppPath()] }); app.exit(0); }
  });
  try {
    await listenFree(server, port); // port pris par une autre application : le suivant
  } catch (e) {
    // Démarrage raté : on rend la caméra et le Stream Deck avant d'afficher l'erreur, sinon ils restent pris.
    stopped = true;
    await close().catch(() => {});
    throw e;
  }
  const url = `http://localhost:${server.address().port}`;
  console.log(`[app] borne : ${url}`);
  step('Ouverture de la borne…', 0.5, 'Préparation de l\'appareil photo en parallèle');
  cameraReady.then(() => step('Appareil photo prêt', 0.85));

  // Fermeture de la fenêtre ou Ctrl+Maj+Q : arrêt propre du serveur (caméra, Stream Deck) avant de sortir.
  app.on('will-quit', (e) => {
    if (stopped) return;
    e.preventDefault();
    stopped = true;
    close().catch(() => {}).finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());

  // Webcam (mode caméra « navigateur ») accordée sans question : la page vient de ce même processus.
  const allowed = new Set(['media', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed.has(perm));

  remoteScreen.attach(win);
  config.on('change', () => applyWindowMode(config.get().booth.window)); // changé dans l'admin : appliqué à chaud
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'q') app.quit();
  });
  // Liens « nouvel onglet » (galerie d'une session) : petite fenêtre fermable par-dessus la borne.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { parent: win, modal: true, width: 1000, height: 800, autoHideMenuBar: true }
  }));
  // Par-dessus la borne en plein écran, la fenêtre n'a pas toujours de bouton de fermeture : Échap la ferme.
  win.webContents.on('did-create-window', (child) => {
    child.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') child.close(); });
  });
  // Page plantée : on la recharge plutôt que de laisser un écran noir.
  win.webContents.on('render-process-gone', () => setTimeout(() => win.reload(), 1000));

  app.on('second-instance', () => { win.show(); win.focus(); });
  // La borne se charge sous l'écran de lancement (même fenêtre)
  const loaded = win.loadURL(url);
  loaded.catch(() => {}); // erreur de chargement : la borne s'affiche quand même (rechargement ci-dessus)
  const painted = loaded.then(() => sleep(300), () => {}); // page chargée, le temps d'un premier rendu
  // L'écran de lancement s'efface quand la borne est dessinée et que le boîtier est prêt. Boîtier trop long
  // (figé, débranché pendant la détection) : la borne s'affiche quand même, il la rejoindra à chaud.
  await Promise.all([Promise.race([painted, sleep(30000)]), Promise.race([cameraReady, sleep(25000)])]);
  await step('C\'est parti !', 1);
  await sleep(250);
  closeSplash();
  win.show();
  win.focus();
  setTimeout(enforceWindowMode, 300); // et encore une fois, borne affichée (relance après redémarrage)
}
