/**
 * Écran déporté (page /remote, un iPad par exemple) : l'image de la fenêtre de la borne et ses touchers.
 *
 * Image : la fenêtre n'est capturée que si un écran distant la regarde, à chaque changement à l'écran,
 * 12 images par seconde au plus, réduite à 1024 px de large et envoyée en JPEG.
 * Toucher : rejoué comme un vrai toucher d'écran tactile (protocole de débogage de Chrome), pas comme
 * un clic de souris : la borne se comporte comme sur un écran tactile (boutons affichés, gestes).
 */
const MAX_WIDTH = 1024;
const FRAME_MS = 80;

export function createRemoteScreen() {
  let win = null;
  const listeners = new Set();
  let latest = null; // dernière image peinte, pas encore envoyée
  let timer = null;
  let subscribed = false;

  const encode = () => {
    if (!latest || !listeners.size) return;
    let img = latest;
    latest = null;
    const { width } = img.getSize();
    if (width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH, quality: 'good' });
    const jpeg = img.toJPEG(65);
    for (const fn of listeners) fn(jpeg);
  };

  const start = () => {
    if (subscribed || !win || win.isDestroyed()) return;
    subscribed = true;
    win.webContents.beginFrameSubscription(false, (image) => { latest = image; });
    win.webContents.invalidate(); // une première image tout de suite, même si rien ne bouge
    timer = setInterval(encode, FRAME_MS);
  };
  const stop = () => {
    if (!subscribed) return;
    subscribed = false;
    clearInterval(timer);
    latest = null;
    try { win.webContents.endFrameSubscription(); } catch { /* fenêtre fermée */ }
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
