/**
 * Écran déporté (page /remote, un iPad par exemple) : l'image de la fenêtre de la borne et ses touchers.
 *
 * Image : la fenêtre n'est capturée que si un écran distant la regarde, environ 10 fois par seconde, réduite à
 * 1024 px de large et envoyée en JPEG (une image identique à la précédente n'est pas renvoyée). Capture forcée
 * (capturePage) plutôt qu'à chaque dessin : fenêtre réduite, recouverte ou écran du Mac en veille, le système
 * ne dessine plus la fenêtre et l'écran distant restait figé sur une image à moitié chargée.
 * Toucher : rejoué comme un vrai toucher d'écran tactile (protocole de débogage de Chrome), pas comme
 * un clic de souris : la borne se comporte comme sur un écran tactile (boutons affichés, gestes).
 */
import crypto from 'node:crypto';
import { powerSaveBlocker } from 'electron';

const MAX_WIDTH = 1024;
const FRAME_MS = 100;

export function createRemoteScreen() {
  let win = null;
  const listeners = new Set();
  let timer = null;
  let busy = false;
  let lastHash = null;

  const grab = async () => {
    if (busy || !listeners.size || !win || win.isDestroyed()) return;
    busy = true;
    try {
      let img = await win.webContents.capturePage();
      if (img.isEmpty()) return;
      const { width } = img.getSize();
      if (width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH, quality: 'good' });
      const jpeg = img.toJPEG(65);
      const hash = crypto.createHash('md5').update(jpeg).digest('hex');
      if (hash === lastHash) return; // rien n'a bougé
      lastHash = hash;
      for (const fn of listeners) fn(jpeg);
    } catch { /* fenêtre en cours de fermeture */ } finally {
      busy = false;
    }
  };

  let blocker = null; // écran distant connecté : le Mac ne se met pas en veille (la borne s'arrêterait)
  const start = () => {
    if (timer || !win || win.isDestroyed()) return;
    if (blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    lastHash = null; // une première image tout de suite pour le nouvel écran
    grab();
    timer = setInterval(grab, FRAME_MS);
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
    if (blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  };

  const touchDebugger = () => {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg;
  };

  return {
    attach(w) {
      win = w;
      win.on('closed', () => { stop(); win = null; });
      if (listeners.size) start();
    },
    available: () => !!win && !win.isDestroyed(),
    /** Taille de la fenêtre (pixels CSS) : rapport largeur / hauteur de l'image. */
    size() {
      const [width, height] = win.getContentSize();
      return { width, height };
    },
    /** fn(jpeg) à chaque image ; rend la fonction de désabonnement. Capture coupée sans abonné. */
    subscribe(fn) {
      listeners.add(fn);
      start();
      return () => { listeners.delete(fn); if (!listeners.size) stop(); };
    },
    /** Toucher de l'écran distant : type down / move / up, x et y entre 0 et 1 (fraction de la fenêtre). */
    async input({ type, x, y }) {
      if (!win || win.isDestroyed()) throw new Error('fenêtre de la borne fermée');
      const [w, h] = win.getContentSize();
      const px = Math.max(0, Math.min(w - 1, Number(x) * w));
      const py = Math.max(0, Math.min(h - 1, Number(y) * h));
      const kind = { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[type];
      if (!kind) throw new Error(`toucher inconnu : ${type}`);
      try {
        await touchDebugger().sendCommand('Input.dispatchTouchEvent', { type: kind, touchPoints: kind === 'touchEnd' ? [] : [{ x: px, y: py }] });
      } catch {
        // Débogueur indisponible (outils de développement ouverts) : clic de souris à la place
        const mouse = { down: 'mouseDown', move: 'mouseMove', up: 'mouseUp' }[type];
        win.webContents.sendInputEvent({ type: mouse, x: Math.round(px), y: Math.round(py), button: 'left', clickCount: 1, modifiers: type === 'up' ? [] : ['leftButtonDown'] });
      }
    }
  };
}
