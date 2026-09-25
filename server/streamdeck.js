import sharp from 'sharp';

/**
 * Stream Deck (Elgato) comme télécommande de la borne, pour une utilisation sans écran tactile.
 *
 * La borne décrit à chaque changement les actions de l'écran en cours (message WebSocket 'ui') ;
 * ce module les dessine sur les touches, dans l'ordre, et renvoie chaque appui à la borne
 * (message 'deck') qui l'exécute comme un clic. Le Stream Deck ne décide donc rien : il reflète
 * toujours exactement l'écran.
 *
 * Branchement à chaud : recherche toutes les 3 s tant qu'aucun Stream Deck n'est ouvert.
 * Sur Mac, l'application Stream Deck d'Elgato doit être quittée (elle réserve l'appareil).
 * Sous Linux, une règle udev donne l'accès sans sudo (voir TUTORIEL.md).
 */
export class StreamDeckRemote {
  constructor({ config, onPress, onInfo = () => {} }) {
    this.config = config;
    this.onPress = onPress;
    this.onInfo = onInfo; // branchement / débranchement : la borne adapte sa galerie (voir galleryInfo)
    this.deck = null;
    this.model = null;
    this.error = null;
    this.ui = null;          // dernière description envoyée par la borne
    this.page = 0;
    this.keyMap = new Map(); // index de touche → id d'action
    this.timer = null;
    this.opening = false;
    this.lib = null;
    this.drawSeq = 0;
  }

  cfg() {
    return { enabled: true, brightness: 70, ...(this.config.get().booth.streamDeck || {}) };
  }

  async start() {
    try {
      this.lib = await import('@elgato-stream-deck/node');
    } catch (e) {
      this.error = `bibliothèque Stream Deck indisponible : ${e.message}`;
      return;
    }
    this.scan();
    this.timer = setInterval(() => this.scan(), 3000);
    this.timer.unref();
    this.config.on('change', () => this.applyConfig());
  }

  async stop() {
    clearInterval(this.timer);
    await this.close();
  }

  status() {
    const c = this.cfg();
    return {
      enabled: c.enabled, connected: !!this.deck, model: this.model, error: this.error, keys: this.buttons().length,
      screen: this.ui?.screen || null, items: (this.ui?.items || []).map((i) => i.icon || (i.image ? 'image' : i.label)),
      layout: this.drawnLayout || null, // touche → action, ligne par ligne (diagnostic)
      drawnAt: this.drawnAt || null, drawError: this.drawError || null
    };
  }

  async applyConfig() {
    const c = this.cfg();
    if (!c.enabled) return this.close();
    if (this.deck) {
      await this.deck.setBrightness(c.brightness).catch(() => {});
      this.draw();
    }
  }

  async scan() {
    if (this.deck || this.opening || !this.cfg().enabled) return;
    this.opening = true;
    try {
      const list = await this.lib.listStreamDecks();
      if (!list.length) { this.error = null; return; }
      const deck = await this.lib.openStreamDeck(list[0].path, { resetToLogoOnClose: true });
      this.deck = deck;
      this.model = deck.PRODUCT_NAME || list[0].model || 'Stream Deck';
      this.error = null;
      deck.on('down', (control) => this.handleDown(control));
      deck.on('error', (e) => {
        console.warn(`[streamdeck] ${e?.message || e}`);
        this.close();
      });
      await deck.clearPanel();
      await deck.setBrightness(this.cfg().brightness).catch(() => {});
      console.log(`[streamdeck] ${this.model} connecté (${this.buttons().length} touches)`);
      this.onInfo(this.galleryInfo());
      this.draw();
    } catch (e) {
      // Sur Mac, typiquement : l'application Elgato tient l'appareil.
      this.error = /open|access|exclusive|busy|permission/i.test(e.message)
        ? `Stream Deck occupé : quitter l'application Stream Deck d'Elgato (${e.message})`
        : e.message;
      await this.close();
    } finally {
      this.opening = false;
    }
  }

  async close() {
    this.stopAnim();
    this.stopIdle();
    const deck = this.deck;
    this.deck = null;
    this.keyMap.clear();
    if (deck) {
      console.log('[streamdeck] déconnecté');
      await deck.close().catch(() => {});
      this.onInfo(this.galleryInfo());
    }
  }

  /**
   * Galerie pilotée par le Stream Deck : la borne affiche autant de miniatures qu'il y a de touches
   * au-dessus de la rangée de navigation, sur autant de colonnes. null : pas de Stream Deck (ou trop petit).
   */
  galleryInfo() {
    const keys = this.buttons();
    if (!keys.length) return { connected: false, gallery: null };
    const cols = Math.max(...keys.map((k) => k.column)) + 1;
    const rows = Math.max(...keys.map((k) => k.row)) + 1;
    const ok = rows > 1 && cols >= 3;
    return { connected: true, gallery: ok ? { perPage: cols * (rows - 1), cols } : null };
  }

  /** Touches à écran, dans l'ordre de lecture (ligne par ligne). */
  buttons() {
    if (!this.deck) return [];
    return this.deck.CONTROLS
      .filter((c) => c.type === 'button' && c.feedbackType === 'lcd')
      .sort((a, b) => a.row - b.row || a.column - b.column);
  }

  /** Nouvelle description de l'écran envoyée par la borne. */
  setUi(ui) {
    const changedScreen = this.ui?.screen !== ui?.screen;
    const backToGallery = this.ui?.screen === 'photo' && ui?.screen === 'gallery'; // retour de la visionneuse : même page
    this.ui = ui;
    if (changedScreen && !backToGallery) this.page = 0;
    this.draw();
  }

  handleDown(control) {
    if (control.type !== 'button') return;
    const id = this.keyMap.get(control.index) || this.ui?.anyKey; // anyKey : écran où toute touche agit (fin)
    const run = () => {
      if (!id) return;
      if (id === '__next' || id === '__prev') {
        this.page = Math.max(0, this.page + (id === '__next' ? 1 : -1));
        this.onPress(id); // la borne compte l'appui comme une interaction (retour à l'accueil repoussé)
        return this.draw();
      }
      this.onPress(id);
    };
    // Aucun délai : chaque appui agit tout de suite. Code secret complet : la borne abandonne la session
    // lancée par les premiers appuis (encore sans photo) et ouvre l'admin.
    if (this.secretPress(control.index) === 'done') return this.onPress('__admin');
    run();
  }

  /**
   * Code secret du Stream Deck : haut gauche, haut droite, haut gauche, haut droite (G D G D), chaque appui
   * à moins de SECRET_STEP_MS du précédent, ouvre l'admin (comme 5 appuis en haut à droite de l'écran).
   * Rend 'done' (code complet), 'progress' (appui qui fait avancer le code) ou 'none'.
   */
  secretPress(index) {
    const top = this.buttons().filter((k) => k.row === 0);
    if (top.length < 2) return 'none';
    const side = index === top[0].index ? 'G' : index === top[top.length - 1].index ? 'D' : null;
    const now = Date.now();
    if (now - (this.secretAt || 0) > SECRET_STEP_MS) this.secret = [];
    this.secretAt = now;
    this.secret ||= [];
    if (!side) { this.secret = []; return 'none'; }
    if (SECRET_CODE[this.secret.length] === side) this.secret.push(side);
    else this.secret = side === SECRET_CODE[0] ? [side] : [];
    if (this.secret.length === SECRET_CODE.length) { this.secret = []; return 'done'; }
    return this.secret.length ? 'progress' : 'none';
  }

  /**
   * Disposition fixe, quelle que soit la taille du Stream Deck :
   *  - rangée principale (celle du milieu) : actions principales, choix (cadres, photos), − nombre +, décompte,
   *    toujours centrées ;
   *  - rangée juste en dessous : actions secondaires (refaire, annuler, retour), centrées ;
   *  - bas à gauche : QR code (« sans impression ») ; bas à droite : imprimer.
   * Si ça ne tient pas (pavé du code, beaucoup de cadres) : remplissage dans l'ordre, par pages.
   */
  layout(items, keys) {
    const cols = Math.max(...keys.map((k) => k.column)) + 1;
    const rows = Math.max(...keys.map((k) => k.row)) + 1;
    const at = (r, c) => keys.find((k) => k.row === r && k.column === c);
    const nav = NAV_ROWS[this.ui?.screen];
    if (nav && rows > 1 && cols >= 3) return this.navLayout(items, keys, nav, { cols, rows, at });
    const mainRow = Math.floor((rows - 1) / 2);
    const belowRow = Math.min(rows - 1, mainRow + 1);
    const bottom = rows - 1;

    if (this.ui?.screen !== 'pin') {
      const slots = new Map();
      const used = new Set();
      let ok = true;
      const put = (it, r, c) => {
        const k = at(r, c);
        if (!k || used.has(k.index)) { ok = false; return; }
        used.add(k.index);
        slots.set(k.index, it);
      };
      const row = (group, r) => {
        if (!group.length) return;
        if (group.length > cols) { ok = false; return; }
        const start = Math.floor((cols - group.length) / 2);
        group.forEach((it, i) => put(it, r, start + i));
      };
      // Coins : retour au choix du cadre en bas à gauche (comme les autres retours), QR / imprimer.
      // Calibrage (admin) : lancer en bas à droite, fermer en bas à gauche
      const corner = { btnCaptureBack: [bottom, 0], btnNoPrint: [bottom, 0], btnPrint: [bottom, cols - 1], coClose: [bottom, 0], coGo: [bottom, cols - 1] };
      const cornered = items.filter((it) => corner[it.id]);
      const rest = items.filter((it) => !corner[it.id]);
      const choices = rest.filter((it) => it.kind === 'choice');
      const stepper = rest.filter((it) => ['btnMinus', 'copies', 'btnPlus'].includes(it.id));
      const display = rest.filter((it) => it.display && !stepper.includes(it));
      const primary = rest.filter((it) => it.kind === 'primary');
      const secondary = rest.filter((it) => !choices.includes(it) && !stepper.includes(it) && !display.includes(it) && !primary.includes(it));

      cornered.forEach((it) => put(it, ...corner[it.id]));
      if (stepper.length) {
        row(stepper, mainRow);
        row([...primary, ...secondary], belowRow);
      } else if (choices.length) {
        row(choices, mainRow);
        row([...primary, ...secondary], belowRow);
      } else {
        row([...display, ...primary], mainRow);
        row(secondary, belowRow);
      }
      if (ok) return slots;
    }

    // Repli : dans l'ordre, par pages avec « ‹ » et « › ».
    const slots = new Map();
    if (items.length <= keys.length) {
      items.forEach((it, i) => slots.set(keys[i].index, it));
      return slots;
    }
    const perPage = keys.length - 2;
    const pages = Math.ceil(items.length / perPage);
    this.page = Math.min(this.page, pages - 1);
    items.slice(this.page * perPage, (this.page + 1) * perPage).forEach((it, i) => slots.set(keys[i].index, it));
    slots.set(keys[keys.length - 2].index, { id: '__prev', label: '‹', kind: 'ghost', disabled: this.page === 0 });
    slots.set(keys[keys.length - 1].index, { id: '__next', label: '›', kind: 'ghost', disabled: this.page >= pages - 1 });
    return slots;
  }

  /**
   * Galerie et visionneuse : rangée du bas fixe, comme à l'écran : retour (← accueil, ← toutes les photos)
   * en bas à gauche, flèches ‹ › côte à côte en bas à droite. Galerie : les flèches tournent les pages de miniatures (rangées du dessus).
   * Visionneuse : elles passent d'une photo à l'autre, la réimpression occupe les rangées du dessus.
   */
  navLayout(items, keys, nav, { cols, rows, at }) {
    const bottom = rows - 1;
    const above = keys.filter((k) => k.row < bottom);
    const byId = new Map(items.map((it) => [it.id, it]));
    const home = byId.get(nav.home);
    const others = items.filter((it) => ![nav.prev, nav.home, nav.next].includes(it.id));
    const slots = new Map();
    let prev, next;
    if (nav.paged && !byId.has(nav.prev)) { // la borne n'a pas (encore) paginé sa galerie : pages côté Stream Deck
      const pages = Math.max(1, Math.ceil(others.length / above.length));
      this.page = Math.min(this.page, pages - 1);
      const page = others.slice(this.page * above.length, (this.page + 1) * above.length);
      if (page.length <= cols) { // une seule rangée : centrée juste au-dessus de la navigation, comme avant
        const start = Math.floor((cols - page.length) / 2);
        page.forEach((it, i) => slots.set(at(bottom - 1, start + i).index, it));
      } else page.forEach((it, i) => slots.set(above[i].index, it));
      prev = { id: '__prev', disabled: this.page === 0 };
      next = { id: '__next', disabled: this.page >= pages - 1 };
    } else {
      prev = byId.get(nav.prev) || { id: nav.prev, disabled: true };
      next = byId.get(nav.next) || { id: nav.next, disabled: true };
      if (nav.paged) others.slice(0, above.length).forEach((it, i) => slots.set(above[i].index, it)); // page affichée par la borne
      else this.placeAbove(others, slots, { cols, bottom, at });
    }
    // Mêmes flèches partout : mêmes pictogrammes, couleurs du bouton retour.
    const arrow = (it, icon) => ({ ...it, label: icon === 'chevronLeft' ? '‹' : '›', kind: 'ghost', icon, style: home?.style || it.style });
    if (home) slots.set(at(bottom, 0).index, home);
    slots.set(at(bottom, cols - 2).index, arrow(prev, 'chevronLeft'));
    slots.set(at(bottom, cols - 1).index, arrow(next, 'chevronRight'));
    return slots;
  }

  /** Visionneuse : − nombre + et « Réimprimer » centrés au-dessus de la rangée de navigation. */
  placeAbove(items, slots, { cols, bottom, at }) {
    if (!items.length || bottom < 1) return;
    const row = (group, r) => {
      const start = Math.floor((cols - group.length) / 2);
      group.forEach((it, i) => { const k = at(r, start + i); if (k) slots.set(k.index, it); });
    };
    const stepper = items.filter((it) => ['btnPhotoMinus', 'copies', 'btnPhotoPlus'].includes(it.id));
    const rest = items.filter((it) => !stepper.includes(it));
    if (items.length <= cols) return row(items, bottom - 1);
    if (bottom >= 2 && stepper.length <= cols && rest.length <= cols) {
      row(stepper, bottom - 2);
      row(rest, bottom - 1);
      return;
    }
    // Une seule rangée libre (Stream Deck Mini) : − Réimprimer +, le nombre reste affiché sur l'écran.
    const [minus, plus] = [stepper.find((it) => it.id === 'btnPhotoMinus'), stepper.find((it) => it.id === 'btnPhotoPlus')];
    row([minus, ...rest, plus].filter(Boolean).slice(0, cols), bottom - 1);
  }

  // ---------- Animation « impression en cours » ----------
  // Écran sans bouton : l'imprimante de la touche centrale sort une feuille en boucle, et trois points
  // s'allument à tour de rôle sur la rangée du dessous (ou de part et d'autre si une seule rangée).

  startAnim() {
    if (this.anim) return;
    this.anim = { frame: 0, busy: false };
    this.anim.timer = setInterval(() => this.animFrame(), 120);
    this.animFrame();
  }

  stopAnim() {
    if (!this.anim) return;
    clearInterval(this.anim.timer);
    this.anim = null;
  }

  async animFrame() {
    const deck = this.deck;
    const a = this.anim;
    if (!deck || !a || a.busy) return;
    a.busy = true;
    try {
      const keys = this.buttons();
      const cols = Math.max(...keys.map((k) => k.column)) + 1;
      const rows = Math.max(...keys.map((k) => k.row)) + 1;
      const at = (r, c) => keys.find((k) => k.row === r && k.column === c);
      const mainRow = Math.floor((rows - 1) / 2);
      const center = at(mainRow, Math.floor((cols - 1) / 2));
      const accent = /^#[0-9a-f]{6}$/i.test(this.ui?.colors?.primary || '') ? this.ui.colors.primary : '#e63946';
      if (a.frame === 0) this.keyMap.clear();
      if (center) {
        const { width, height } = center.pixelSize;
        await deck.fillKeyBuffer(center.index, await renderPrinter(width, height, (a.frame % 16) / 16, accent), { format: 'rgb' });
      }
      // Points de progression
      const dotRow = rows > 1 ? mainRow + 1 : mainRow;
      const dotKeys = rows > 1
        ? [0, 1, 2].map((i) => at(dotRow, Math.floor((cols - 3) / 2) + i)).filter(Boolean)
        : [at(mainRow, center.column - 1), at(mainRow, center.column + 1)].filter(Boolean);
      const lit = Math.floor(a.frame / 3) % Math.max(1, dotKeys.length);
      for (const [i, k] of dotKeys.entries()) {
        const { width, height } = k.pixelSize;
        await deck.fillKeyBuffer(k.index, await renderDot(width, height, i === lit, accent), { format: 'rgb' });
      }
      if (a.frame === 0) {
        const busyKeys = new Set([center?.index, ...dotKeys.map((k) => k.index)]);
        for (const k of keys) if (!busyKeys.has(k.index)) await deck.clearKey(k.index);
      }
      a.frame += 1;
    } catch (e) {
      this.drawError = e.message;
    } finally {
      if (a) a.busy = false;
    }
  }

  // ---------- Animation d'accueil « touchez l'écran » ----------
  // Un cercle plein grossit et rétrécit sur la touche centrale, des ondes en partent et traversent tout le clavier.
  // N'importe quelle touche lance la session, sauf la touche galerie (en bas à gauche) quand la galerie est
  // activée. Les images sont calculées une fois (couleurs + géométrie), puis la boucle n'envoie que les
  // touches qui changent : supportable par un PC modeste.

  async startIdle(item, gallery) {
    const keys = this.buttons();
    if (!keys.length) return;
    const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
    const accent = hex(item.style?.bg, hex(this.ui?.colors?.primary, '#e63946'));
    // Bas à gauche, comme le bouton « Galerie » de l'accueil à l'écran
    const bottom = Math.max(...keys.map((k) => k.row));
    const galleryKey = gallery && keys.length > 1 ? keys.find((k) => k.row === bottom && k.column === 0) : null;
    const sig = `${this.deck.PRODUCT_NAME}|${accent}|${item.id}|${galleryKey ? JSON.stringify(gallery) : ''}`;
    this.keyMap.clear();
    for (const k of keys) this.keyMap.set(k.index, item.id);
    if (galleryKey) this.keyMap.set(galleryKey.index, gallery.id);
    if (this.idle?.sig === sig) return;
    this.stopIdle();
    const idle = { sig, frame: 0, busy: false, last: new Map(), frames: null };
    this.idle = idle;
    try {
      idle.frames = await renderIdleFrames(keys, accent);
      if (galleryKey) await overlayIcon(idle.frames, galleryKey, gallery); // les ondes passent derrière l'icône
    } catch (e) {
      this.drawError = e.message;
      console.warn(`[streamdeck] animation d'accueil : ${e.message}`);
      return;
    }
    if (this.idle !== idle) return; // écran changé pendant le calcul
    idle.timer = setInterval(() => this.idleFrame(idle), IDLE_FRAME_MS);
    this.idleFrame(idle);
  }

  stopIdle() {
    if (!this.idle) return;
    clearInterval(this.idle.timer);
    this.idle = null;
  }

  async idleFrame(idle) {
    const deck = this.deck;
    if (!deck || this.idle !== idle || idle.busy) return;
    idle.busy = true;
    try {
      const frame = idle.frames[idle.frame % idle.frames.length];
      for (const [index, buf] of frame) {
        if (this.idle !== idle || this.deck !== deck) return;
        if (idle.last.get(index) === buf) continue; // image identique à la précédente : rien à envoyer
        await deck.fillKeyBuffer(index, buf, { format: 'rgb' });
        idle.last.set(index, buf);
      }
      idle.frame += 1;
      this.drawnAt = new Date().toISOString();
    } catch (e) {
      this.drawError = e.message;
    } finally {
      idle.busy = false;
    }
  }

  async draw() {
    const deck = this.deck;
    if (!deck) return;
    const start = this.ui?.screen === 'idle' ? (this.ui.items || []).find((it) => it.id === 'start') : null;
    if (start) { this.stopAnim(); this.drawSeq++; return this.startIdle(start, this.ui.items.find((it) => it.id === 'btnGallery')); }
    this.stopIdle();
    if (this.ui?.screen === 'printing') { this.startAnim(); return; }
    this.stopAnim();
    const seq = ++this.drawSeq;
    const keys = this.buttons();
    if (!keys.length) return;
    const items = this.ui?.items || [];
    const slots = this.layout(items, keys);
    this.drawnLayout = keys.map((k) => { const it = slots.get(k.index); return it ? `${it.id}${it.icon ? `:${it.icon}` : ''}` : null; });
    const colors = this.ui?.colors || {};
    this.keyMap.clear();
    try {
      for (const k of keys) {
        if (seq !== this.drawSeq || this.deck !== deck) return; // un dessin plus récent a pris le relais
        const it = slots.get(k.index);
        if (!it) { await deck.clearKey(k.index); continue; } // touche sans action : éteinte
        if (!it.disabled && !it.display) this.keyMap.set(k.index, it.id);
        const { width, height } = k.pixelSize;
        const img = await renderKey(it, width, height, colors);
        await deck.fillKeyBuffer(k.index, img, { format: 'rgb' });
      }
      this.drawnAt = new Date().toISOString();
      this.drawError = null;
    } catch (e) {
      this.drawError = e.message;
      console.warn(`[streamdeck] dessin : ${e.message}`);
    }
  }
}

const SECRET_CODE = ['G', 'D', 'G', 'D']; // touches du haut : gauche, droite, gauche, droite → admin
const SECRET_STEP_MS = 1500; // délai maximum entre deux appuis du code

// Rangée de navigation fixe des écrans de galerie (voir navLayout). paged : les flèches tournent les pages.
const NAV_ROWS = {
  template: { prev: '__prev', home: 'btnTemplateBack', next: '__next', paged: true }, // pages côté Stream Deck
  gallery: { prev: 'btnGalleryPrev', home: 'btnGalleryBack', next: 'btnGalleryNext', paged: true },
  photo: { prev: 'btnPhotoPrev', home: 'btnPhotoBack', next: 'btnPhotoNext' }
};

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Coupe un libellé en lignes courtes pour une touche. */
function wrap(label, max) {
  const words = String(label).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

// Pictogrammes 24×24 au trait (style Lucide), dessinés en couleur de texte de la touche.
const ICONS = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  next: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  gallery: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',   // mêmes chevrons que les flèches de la visionneuse à l'écran
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  retake: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  delete: '<path d="M10 5h11v14H10l-7-7z"/><path d="m18 9-6 6M12 9l6 6"/>'
};

/** Dessine une touche : fond aux couleurs du thème, pictogramme ou miniature, libellé. Retourne du RVB brut. */
async function renderKey(it, w, h, colors) {
  const primary = colors.primary || '#e63946';
  const onPrimary = colors.onPrimary || '#ffffff';
  // Les touches sont toujours sur fond sombre : texte blanc, quelle que soit la couleur de texte du thème.
  let bg = '#262626', fg = '#ffffff', border = 'none';
  if (it.kind === 'primary') { bg = primary; fg = onPrimary; }
  else if (it.kind === 'secondary') { bg = '#000000'; fg = primary; border = primary; }
  else if (it.kind === 'display') { bg = '#000000'; fg = '#ffffff'; }
  if (it.disabled) { fg = '#4a4a4a'; bg = '#141414'; border = 'none'; }
  // Couleurs relevées sur le bouton affiché par la borne : elles priment (thème, texte lisible, désactivé…).
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
  // Seules les touches actives prennent les couleurs du thème. Le reste (affichage du nombre, décompte,
  // bouton désactivé) reste sur fond noir, pour ne pas allumer des carrés de couleur sans action.
  const pageBg = '#000000';
  const active = !it.disabled && !it.display;
  if (it.style && active) {
    bg = hex(it.style.bg) || bg;
    fg = hex(it.style.fg) || fg;
    border = hex(it.style.border) || 'none';
  } else if (it.style && it.display) {
    bg = '#000000';
    fg = hex(it.style.fg) || '#ffffff';
    border = 'none';
  } else if (it.disabled) {
    bg = '#000000'; fg = '#3a3a3a'; border = 'none';
  }

  // Choix sans miniature (nom d'un cadre) : blanc sur noir, liseré du thème, lisible sur le petit écran LCD.
  const nameKey = it.kind === 'choice' && !it.image && !it.disabled;
  if (nameKey) { bg = '#000000'; fg = '#ffffff'; border = primary; }

  const stroke0 = border !== 'none' ? `stroke="${border}" stroke-width="${Math.max(2, w * 0.05)}"` : '';
  const frame = `<rect width="${w}" height="${h}" fill="${pageBg}"/><rect x="${w * 0.04}" y="${h * 0.04}" width="${w * 0.92}" height="${h * 0.92}" rx="${w * 0.16}" fill="${bg}" ${stroke0}/>`;

  // Miniature (template, photo à refaire) : image plein cadre, libellé sur un bandeau en bas.
  if (it.image && /^data:image\/(jpeg|png);base64,/.test(it.image)) {
    const img = await sharp(Buffer.from(it.image.split(',')[1], 'base64')).resize(Math.round(w * 0.92), Math.round(h * 0.92), { fit: 'cover' }).png().toBuffer();
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * 0.92)}" height="${Math.round(h * 0.92)}"><rect width="100%" height="100%" rx="${w * 0.16}" fill="#fff"/></svg>`;
    const rounded = await sharp(img).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${frame}</svg>`))
      .composite([{ input: rounded, left: Math.round(w * 0.04), top: Math.round(h * 0.04) }])
      .removeAlpha().raw().toBuffer();
  }

  // Pictogramme seul, centré : pas de texte sur les touches d'action.
  if (it.icon && ICONS[it.icon]) {
    const isz = w * 0.52;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${frame}
      <g transform="translate(${(w - isz) / 2} ${(h - isz) / 2}) scale(${isz / 24})" fill="none" stroke="${fg}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[it.icon]}</g></svg>`;
    return sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
  }

  const short = String(it.label).length <= 2;
  const lines = short ? [String(it.label)] : wrap(it.label, nameKey ? 8 : 9);
  // Taille ajustée à la ligne la plus longue : un mot comme « impression » tient toujours dans la touche.
  const longest = Math.max(...lines.map((l) => l.length));
  const fit = nameKey ? (w * 0.8) / (longest * 0.56) : (w * 0.84) / (longest * 0.62); // nom de cadre : chasse réelle d'Helvetica gras
  // Nom de cadre : aussi grand que la touche le permet (largeur et hauteur), plafonné à 40 % de la hauteur.
  const size = short ? Math.round(h * 0.55)
    : nameKey ? Math.round(Math.min(fit, (h * 0.74) / (lines.length * 1.12), h * 0.4))
    : Math.round(Math.min(h * (lines.length > 2 ? 0.17 : 0.21), fit));
  const lh = size * 1.12;
  const y0 = h / 2 - ((lines.length - 1) * lh) / 2;
  const tspans = lines.map((l, i) => `<text x="${w / 2}" y="${y0 + i * lh}" dominant-baseline="central" text-anchor="middle">${escXml(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    ${frame}
    <g fill="${fg}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${size}">${tspans}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
}

/**
 * Pose un pictogramme par-dessus l'animation d'accueil sur une touche, image par image : les ondes
 * passent derrière. Les images identiques restent partagées (la boucle n'envoie que ce qui change).
 */
async function overlayIcon(frames, key, it) {
  const { width: w, height: h } = key.pixelSize;
  const fg = '#ffffff'; // sur le fond noir de l'animation, quelle que soit la couleur du bouton à l'écran
  const isz = w * 0.52;
  const icon = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <g transform="translate(${(w - isz) / 2} ${(h - isz) / 2}) scale(${isz / 24})" fill="none" stroke="${fg}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[it.icon] || ''}</g></svg>`);
  const done = new Map(); // image de fond → image avec l'icône
  for (const f of frames) {
    const bg = f.get(key.index);
    if (!done.has(bg)) {
      done.set(bg, await sharp(bg, { raw: { width: w, height: h, channels: 3 } }).composite([{ input: icon }]).removeAlpha().raw().toBuffer());
    }
    f.set(key.index, done.get(bg));
  }
}

/** Imprimante vue de face, feuille qui sort par le bas ; t ∈ [0,1[ = avancement de la feuille. */
async function renderPrinter(w, h, t, accent) {
  const sc = w / 24;
  const ease = t < 0.75 ? t / 0.75 : 1;        // la feuille sort, puis marque une pause
  const paperY = 13 + ease * 8;                // bas de la feuille : de la fente (13) à 21
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#000"/>
    <g transform="scale(${sc})" fill="none" stroke="${accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 8V3h12v5"/>
      <rect x="7" y="11" width="10" height="${paperY - 11}" fill="#ffffff" stroke="#ffffff"/>
      <path d="M6 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/>
      <path d="M6 13h12" />
    </g></svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
}

const IDLE_FRAMES = 20;   // boucle de 20 images…
const IDLE_FRAME_MS = 80; // … à 80 ms : une onde toutes les 0,8 s (deux ondes décalées d'une demi-boucle)

/**
 * Images de l'animation d'accueil. Le clavier est dessiné comme une seule grande image (touches + espaces
 * entre elles, pour que les ondes soient continues d'une touche à l'autre), puis découpé touche par touche.
 * Retourne un tableau d'images : Map(index de touche → RVB brut). Deux touches identiques d'une image à
 * l'autre partagent le même Buffer (comparaison par référence dans idleFrame).
 */
async function renderIdleFrames(keys, accent) {
  const { width: w, height: h } = keys[0].pixelSize;
  const gap = Math.round(w * 0.3);
  const cols = Math.max(...keys.map((k) => k.column)) + 1;
  const rows = Math.max(...keys.map((k) => k.row)) + 1;
  const W = cols * w + (cols - 1) * gap;
  const H = rows * h + (rows - 1) * gap;
  const mainRow = Math.floor((rows - 1) / 2);
  const cc = Math.floor((cols - 1) / 2);
  const cx = cc * (w + gap) + w / 2;
  const cy = mainRow * (h + gap) + h / 2;
  const rMin = w * 0.5; // les ondes naissent au bord du cercle central à son plus grand
  const rMax = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) + w * 0.2;

  const frames = [];
  let prev = new Map();
  for (let f = 0; f < IDLE_FRAMES; f++) {
    const t = f / IDLE_FRAMES;
    const rings = [0, 0.5].map((off) => {
      const p = (t + off) % 1;
      const r = rMin + p * (rMax - rMin);
      const op = Math.min(1, p / 0.12) * (1 - p) ** 0.9; // apparition en fondu, puis s'éteint en s'éloignant
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-width="${w * 0.2 * (1 - p * 0.4)}" stroke-opacity="${op.toFixed(3)}"/>`;
    }).join('');
    // Cercle central : rayon de 0,2 à 0,4 × la touche et retour, sur une boucle
    const r = w * (0.2 + 0.2 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t)));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#000"/>${rings}
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${accent}"/>
    </svg>`;
    const raw = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
    const frame = new Map();
    for (const k of keys) {
      const x0 = k.column * (w + gap);
      const y0 = k.row * (h + gap);
      const buf = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) raw.copy(buf, y * w * 3, ((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + w) * 3);
      const before = prev.get(k.index);
      frame.set(k.index, before && before.equals(buf) ? before : buf);
    }
    frames.push(frame);
    prev = frame;
  }
  // Raccord de fin de boucle : réutilise les Buffers de la première image quand ils sont identiques
  for (const [index, buf] of frames[frames.length - 1]) {
    const first = frames[0].get(index);
    if (first.equals(buf)) frames[frames.length - 1].set(index, first);
  }
  return frames;
}

async function renderDot(w, h, on, accent) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#000"/>
    <circle cx="${w / 2}" cy="${h / 2}" r="${w * (on ? 0.16 : 0.1)}" fill="${on ? accent : '#333333'}"/></svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
}

export { renderKey, renderIdleFrames };
