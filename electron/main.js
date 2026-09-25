/**
 * App de bureau de la borne : le serveur tourne dans ce processus, la borne s'affiche
 * dans une fenêtre plein écran (kiosque). « Éteindre la borne » dans l'admin ferme l'app.
 *
 * Raccourci de secours au clavier : Ctrl+Maj+Q quitte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, session } from 'electron';

if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto'); // Wayland (tactile)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Lancée depuis le Finder, l'app hérite d'un PATH minimal (/usr/bin:/bin…) : sans Homebrew, gphoto2 est introuvable.
if (process.platform === 'darwin') {
  const dirs = (process.env.PATH || '').split(':');
  for (const d of ['/usr/local/bin', '/opt/homebrew/bin']) if (!dirs.includes(d)) dirs.unshift(d);
  process.env.PATH = dirs.join(':');
}

// Une seule borne : relancer l'icône ramène la fenêtre existante.
if (!app.requestSingleInstanceLock()) app.quit();
else start().catch((e) => {
  dialog.showErrorBox('Photo Booth', `Démarrage impossible : ${e.message}`);
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

async function start() {
  if (app.isPackaged) useUserData();
  await app.whenReady();
  await stopOtherServers(Number(process.env.PORT) || 3000);

  // Import après le choix des dossiers : server/paths.js les lit au chargement.
  const { installFileLog } = await import('../server/log.js');
  const { createApp } = await import('../server/app.js');
  installFileLog();

  let stopped = false;
  const { server, port, close } = await createApp({
    onShutdown: () => { stopped = true; app.quit(); },
    // Redémarrer : nouvelle instance au départ de celle-ci (même dossier d'app, même environnement)
    onRestart: () => { stopped = true; app.relaunch(app.isPackaged ? {} : { args: [app.getAppPath()] }); app.exit(0); }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`le port ${port} est déjà utilisé (serveur lancé dans un terminal ?)`) : e));
      server.listen(port, resolve);
    });
  } catch (e) {
    // Démarrage raté : on rend la caméra et le Stream Deck avant d'afficher l'erreur, sinon ils restent pris.
    stopped = true;
    await close().catch(() => {});
    throw e;
  }
  const url = `http://localhost:${server.address().port}`;
  console.log(`[app] borne : ${url}`);

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

  const win = new BrowserWindow({
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'q') app.quit();
  });
  // Liens « nouvel onglet » (galerie d'une session) : petite fenêtre fermable par-dessus la borne.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { parent: win, modal: true, width: 1000, height: 800, autoHideMenuBar: true }
  }));
  // Page plantée : on la recharge plutôt que de laisser un écran noir.
  win.webContents.on('render-process-gone', () => setTimeout(() => win.reload(), 1000));

  app.on('second-instance', () => { win.show(); win.focus(); });
  await win.loadURL(url);
}
