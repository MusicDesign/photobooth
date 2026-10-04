/* Interface tactile de la borne. Vanilla JS, aucune dépendance. */
import { renderTemplate, loadAssets } from './template-render.js';
import { createCutter, preloadAi } from './cutout-live.js';
import { FILTERS } from './filters.js';
import { deviceNotice } from './device-toasts.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  boot: null,
  session: null,
  template: null,
  assets: new Map(),
  currentShot: 0,
  shotImages: {},
  live: null,
  liveStarting: null,
  rafId: 0,
  lastFrameAt: 0,
  previewScale: 1,
  screen: 'idle',
  timers: {},
  copies: 1,
  maxCopies: 1,
  gallery: { items: [], index: 0, page: 0, copies: 1, printingId: null, qr: new Map() },
  templatePage: 0, // page des cadres quand le Stream Deck pilote l'écran
  deck: null, // Stream Deck branché : { connected, gallery: { perPage, cols } | null } (message 'deckInfo')
  pendingConfigReload: false
};

// ---------- Utilitaires ----------

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* pas de JSON */ }
  if (!res.ok) {
    const err = new Error(data?.message || `Erreur ${res.status}`);
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function clearTimer(name) {
  if (state.timers[name]) {
    clearTimeout(state.timers[name]);
    delete state.timers[name];
  }
}
function setTimer(name, fn, ms) {
  clearTimer(name);
  state.timers[name] = setTimeout(fn, ms);
}
function clearAllTimers() {
  for (const k of Object.keys(state.timers)) clearTimer(k);
}

// Minuterie à part : clearAllTimers (retour à l'accueil) ne doit pas l'annuler, sinon le message reste affiché
let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- Thème, logo, textes ----------

async function renderLogo(url) {
  const slots = $$('.logo-slot');
  if (/\.svg(\?|$)/i.test(url)) { // logo Cheeesy coloré par le serveur (/logo.svg?c=…) ou SVG importé
    try {
      const svg = await (await fetch(url)).text();
      for (const s of slots) s.innerHTML = svg; // un SVG importé en currentColor hérite de la couleur secondaire
      return;
    } catch { /* on retombe sur <img> */ }
  }
  for (const s of slots) s.innerHTML = `<img src="${url}" alt="">`;
}

/** Contraste WCAG entre deux couleurs hex. */
function contrast(hexA, hexB) {
  const lum = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 0.5;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [l1, l2] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** Parmi les candidats, la couleur la plus lisible sur un fond donné. */
const readableOn = (bg, ...candidates) => candidates.reduce((best, c) => (contrast(bg, c) > contrast(bg, best) ? c : best));

function applyBoot() {
  const { theme, texts, booth } = state.boot;
  const root = document.documentElement;
  const map = { primary: '--primary', secondary: '--secondary', background: '--bg', surface: '--surface', text: '--text', onPrimary: '--on-primary' };
  for (const [k, v] of Object.entries(theme.colors || {})) if (map[k]) root.style.setProperty(map[k], v);
  const c = theme.colors;
  // Texte lisible quelle que soit la combinaison choisie dans l'admin.
  root.style.setProperty('--on-secondary', readableOn(c.secondary, c.background, c.text, c.onPrimary, '#ffffff', '#000000'));
  root.style.setProperty('--on-surface', readableOn(c.surface, c.text, c.background, c.secondary, '#ffffff', '#000000'));
  // Couleur principale réservée aux boutons d'action (--primary). Ailleurs (décompte, contours, compteurs,
  // barres…) : --accent, la couleur principale sur un thème clair, du blanc sur un thème sombre.
  const dark = contrast(c.background, '#000000') < contrast(c.background, '#ffffff');
  root.style.setProperty('--accent', dark ? '#ffffff' : c.primary);
  root.style.setProperty('--on-accent', dark ? c.background : c.onPrimary); // ce qui s'écrit sur l'accent (coche du filtre choisi)
  document.body.dataset.font = theme.font || 'system';
  document.body.dataset.cursor = ['idle', 'hide'].includes(booth.cursor) ? booth.cursor : 'show';
  nudgeCursor();
  document.body.style.backgroundImage = theme.backgroundImage ? `url("${theme.backgroundImage}")` : '';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme.colors.background);
  document.title = booth.name;
  renderLogo(theme.logo);
  $('#favicon')?.setAttribute('href', theme.logo); // l'onglet suit le logo, même changé en direct
  const shownName = booth.showName === false ? '' : booth.name;
  $('#boothName').textContent = shownName;
  state.primaryColor = getComputedStyle(root).getPropertyValue('--accent').trim() || theme.colors.primary; // liseré de l'aperçu

  const t = (id, key) => { const el = $(id); if (el) el.textContent = texts[key] || ''; };
  state.touch = touchMode(); // réglage de l'admin (Parcours invité) ou détection
  showWelcome(); renderPaperBadge();
  $('#flashBadge').classList.toggle('hidden', !state.boot.camera?.flashStray); t('#txtChooseTemplate', 'chooseTemplate'); t('#txtGetReady', 'getReady');
  t('#btnStart', 'start'); t('#txtReview', 'review'); t('#btnRetake', 'retake'); t('#btnKeep', 'keep');
  t('#txtCopies', 'copies'); t('#btnPrint', 'print'); t('#btnNoPrint', 'noPrint'); t('#txtPrinting', 'printing');
  t('#txtThanks', 'thanks'); t('#btnFinish', 'finish');
  t('#txtGallery', 'gallery'); t('#txtGalleryTitle', 'galleryTitle'); t('#txtGalleryEmpty', 'galleryEmpty'); t('#btnReprint', 'reprint'); t('#txtGalleryQr', 'galleryQr'); t('#txtWifiQr', 'wifiQr');
  renderWifiQr();
  renderIdleGallery();
  applyDeckUi();
}

/** Bouton Galerie de l'accueil : les 3 dernières photos de l'événement en éventail et leur nombre. Caché sans photo. */
async function renderIdleGallery() {
  const btn = $('#btnGallery');
  let items = [];
  if (state.boot?.gallery?.enabled) {
    try { items = (await api('/api/gallery')).items; } catch { /* galerie fermée : bouton caché */ }
  }
  btn.classList.toggle('hidden', !items.length);
  if (!items.length) return;
  const latest = items.slice(0, 3).reverse(); // la plus récente au-dessus de la pile
  const stack = btn.querySelector('.gal-stack');
  stack.style.setProperty('--n', latest.length);
  stack.innerHTML = latest.map((it) => `<img src="${it.thumbUrl}" alt="" decoding="async">`).join('');
  $('#galleryCount').textContent = `${items.length} photo${items.length > 1 ? 's' : ''} ›`;
  delete btn.dataset.deckThumb;
}

/** Curseur « masqué quand la souris ne bouge pas » : il réapparaît au mouvement, disparaît 3 s après. */
function nudgeCursor() {
  document.body.classList.remove('cursor-idle');
  clearTimeout(nudgeCursor.t);
  if (document.body.dataset.cursor === 'idle') nudgeCursor.t = setTimeout(() => document.body.classList.add('cursor-idle'), 3000);
}
window.addEventListener('mousemove', nudgeCursor, { passive: true });

/**
 * Écran tactile ? Ce que le navigateur annonce au chargement, corrigé par le premier vrai toucher
 * (certains écrans tactiles se déclarent comme une souris). Sert à ne pas inviter à toucher un écran
 * qui ne réagit pas. Le réglage de l'admin (booth.touch : touch | buttons) l'emporte sur cette détection.
 */
state.touchSeen = navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches;
state.touch = state.touchSeen;
/** Mode en vigueur : forcé par l'admin, sinon ce qui a été détecté. */
function touchMode() {
  const mode = state.boot?.booth?.touch;
  return mode === 'touch' ? true : mode === 'buttons' ? false : state.touchSeen;
}
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || state.touchSeen) return;
  state.touchSeen = true;
  if (state.touch === touchMode()) return; // mode forcé : le toucher ne change rien
  state.touch = touchMode();
  showWelcome();
  applyDeckUi();
}, true);

/**
 * Écran non tactile piloté par le Stream Deck : les boutons disparaissent de l'écran (body.deck-ui), tout se
 * fait sur les touches. Ils restent dans la page, seulement invisibles : le Stream Deck les reprend (libellés,
 * couleurs, appuis). Option de l'admin pour les garder (booth.streamDeck.showButtons).
 */
function applyDeckUi() {
  const on = !state.touch && !!state.deck?.connected && !state.boot?.booth?.streamDeck?.showButtons;
  if (document.body.classList.contains('deck-ui') === on) return;
  document.body.classList.toggle('deck-ui', on);
  if (state.screen === 'capture') fitCanvas(); // la colonne des boutons change de largeur
  sizeTemplateCards();
}

/** QR code Wi-Fi en bas à droite, sur tous les écrans (body.wifi-on : la pastille papier remonte au-dessus). */
async function renderWifiQr() {
  let wifi = null;
  try { wifi = (await api('/api/wifi')).wifi; } catch { /* serveur ancien ou injoignable : pas de QR */ }
  document.body.classList.toggle('wifi-on', !!wifi);
  $('#wifiQr').classList.toggle('hidden', !wifi);
  if (!wifi) return;
  $('#wifiQrImg').src = wifi.dataUrl;
  $('#wifiSsid').textContent = wifi.ssid;
}

/** Pastille discrète pour l'opérateur, en bas à droite, quand le papier est bas (seuil de l'admin) ou épuisé. */
function renderPaperBadge() {
  const c = state.boot?.counters;
  const el = $('#paperBadge');
  el.classList.toggle('hidden', !c?.lowPaper || state.boot.printer?.available === false); // sans imprimante, le papier n'importe pas
  el.classList.toggle('empty', !!c?.paperEmpty);
  if (c?.lowPaper) el.textContent = c.paperEmpty ? 'Plus de papier' : `Papier : ${c.paperRemaining}`;
}

function showWelcome() {
  const texts = state.boot?.texts || {};
  $('#txtWelcome').textContent = (state.touch ? texts.welcome : texts.welcomeNoTouch || texts.welcome) || '';
  // Sans tactile : une flèche vers le Stream Deck remplace le cercle qui invite à toucher
  const pos = state.boot?.booth?.streamDeck?.position;
  const hint = $('#buttonHint');
  hint.dataset.pos = ['top', 'bottom', 'left', 'right'].includes(pos) ? pos : 'bottom';
  hint.classList.toggle('hidden', state.touch);
  $('#screen-idle .pulse').classList.toggle('hidden', !state.touch);
}

async function reloadBoot() {
  state.pendingConfigReload = false;
  const prevMode = state.boot?.camera.mode;
  const prevVersion = state.boot?.clientVersion;
  state.boot = await api('/api/bootstrap');
  // Nouvelle version du code de la borne : on recharge la page (on n'arrive ici qu'à l'accueil).
  if (prevVersion && state.boot.clientVersion && prevVersion !== state.boot.clientVersion) { location.reload(); return; }
  state.liveStreaming = !!state.boot.camera.streaming;
  applyBoot();
  renderTemplateGrid();
  if (prevMode && prevMode !== state.boot.camera.mode) {
    // Bascule de caméra (auto-détection) : on repart sur la bonne source.
    stopAllLive();
    if (state.boot.camera.mode === 'browser') startLive();
  }
}

// ---------- Écrans ----------

function showScreen(name) {
  for (const s of $$('.screen')) s.classList.toggle('active', s.id === `screen-${name}`);
  state.screen = name;
  for (const v of $$('video.final-img')) if (!v.closest(`#screen-${name}`)) v.pause(); // boomerang hors écran : arrêté
  document.body.dataset.screen = name; // styles propres à un écran (ex. bandeau au-dessus de la flèche de l'accueil)
  clearTimer('idleReturn');
  clearTimer('reviewTimeout');
  clearTimer('autoNext');
  clearTimer('arm');
  if (name !== 'copies') { clearTimer('copiesTimeout'); clearInterval(state.copiesTick); }
  if (name !== 'capture' && state.armedSession) {
    // Départ pendant le décompte : on annule le déclenchement programmé côté boîtier.
    api(`/api/session/${state.armedSession}/disarm`, { method: 'POST' }).catch(() => {});
    state.armedSession = null;
  }
  if (name !== 'capture') stopRenderLoop();
  // Aperçu serveur (Canon) : on ne garde le flux ouvert que sur les écrans qui mènent à la photo,
  // le serveur coupe alors le live view et referme l'obturateur du boîtier.
  if (!['template', 'capture'].includes(name)) stopLiveStream();
  if (name === 'idle' && state.pendingConfigReload) reloadBoot().catch(() => {});
  else if (name === 'idle') renderIdleGallery(); // nouvelle photo validée depuis le dernier passage
  // Sécurité : un écran laissé sans interaction revient à l'accueil.
  if (name === 'copies' && !state.boot.limits.copiesTimeoutSec) setTimer('idleReturn', goIdle, 120000); // sinon : startCopiesTimeout
  if (MENU_SCREENS.includes(name)) menuActivity();
}

function goIdle() {
  dropSession();
  showScreen('idle');
}

/** Quitte la session en cours. Pas validée (« Je la garde ») : le serveur la supprime avec ses photos (il vérifie lui-même). */
function dropSession() {
  clearAllTimers();
  state.doneReturnAt = null;
  const s = state.session;
  if (s && ['shooting', 'review'].includes(s.status) && !state.kept) api(`/api/session/${s.id}/abandon`, { method: 'POST' }).catch(() => {});
  state.kept = false;
  state.session = null;
  state.template = null;
  state.shotImages = {};
  state.assets = new Map();
}

/** Aperçu, avant la première photo : l'invité revient au choix du cadre (le live reste ouvert). */
function canChangeTemplate() {
  const { guestCanChoose, items } = state.boot.templates;
  return guestCanChoose && items.length > 1 && !state.session?.shots?.some(Boolean);
}
function backToTemplates() {
  dropSession();
  showScreen('template');
}

// ---------- Flux live ----------

async function startLive() {
  if (state.live) return;
  if (state.liveStarting) return state.liveStarting;
  state.liveStarting = (async () => {
    if (state.boot.camera.mode === 'browser') {
      const video = $('#video');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
          audio: false
        });
        video.srcObject = stream;
        await video.play();
        state.live = { kind: 'video', el: video };
      } catch (e) {
        toast(`Caméra indisponible : ${e.message}`, 6000);
      }
    } else {
      const img = $('#mjpeg');
      img.src = `/api/live.mjpeg?t=${Date.now()}`;
      state.live = { kind: 'img', el: img };
    }
  })();
  await state.liveStarting;
  state.liveStarting = null;
}

// ---------- Obturateur dessiné sur l'aperçu ----------
// Chronologie d'une photo : obturateur fermé → le flux arrive (le serveur annonce sa première image
// par WebSocket, ou la vidéo de la webcam joue) → ouverture en 700 ms → décompte → juste avant « 0 »
// le boîtier se prépare et l'aperçu se fige sur la dernière image (obturateur toujours ouvert) →
// à « 0 », flash et fermeture rapide → la photo prise remplace le flux → photo suivante : fermé, etc.

function liveReady() {
  if (state.boot.camera.mode === 'browser') return !!liveSize();
  return !!state.liveStreaming || !!state.liveHeld; // liveHeld : live coupé par le pré-armement, image figée
}

/** Nouvelle photo : obturateur fermé (1), il s'ouvrira quand le flux enverra des images. */
function resetShutter() {
  state.liveHeld = false;
  state.shutterForce = false;
  state.shutter = { value: 1, from: 1, target: 1, at: performance.now() };
}

function shutterValue() {
  const now = performance.now();
  const sh = state.shutter || (state.shutter = { value: 1, from: 1, target: 1, at: now });
  const target = state.shutterForce || !liveReady() ? 1 : 0;
  if (target !== sh.target) { sh.from = sh.value; sh.target = target; sh.at = now; }
  const dur = target === 0 ? 700 : 220;
  const x = Math.min(1, (now - sh.at) / dur);
  const eased = 1 - (1 - x) ** 3;
  sh.value = sh.from + (sh.target - sh.from) * eased;
  return sh.value;
}

/** Coupe toute source live, webcam comprise (changement de caméra). */
function stopAllLive() {
  if (state.live?.kind === 'video') {
    const el = state.live.el;
    for (const t of el.srcObject?.getTracks?.() || []) t.stop();
    el.srcObject = null;
    state.live = null;
  }
  stopLiveStream();
}

/** Attend que le flux envoie des images (au plus maxMs) pour ne pas lancer le décompte sur un obturateur fermé. */
function waitLive(maxMs = 4000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => (liveReady() || performance.now() - t0 > maxMs || state.screen !== 'capture' ? resolve() : requestAnimationFrame(tick));
    tick();
  });
}

/** Ferme le flux MJPEG (mode serveur). La webcam du navigateur, elle, reste ouverte. */
function stopLiveStream() {
  if (state.live?.kind !== 'img') return;
  const img = state.live.el;
  img.src = '';
  img.removeAttribute('src');
  state.live = null;
}

function liveSize() {
  const el = state.live?.el;
  if (!el) return null;
  const w = el.videoWidth || el.naturalWidth;
  const h = el.videoHeight || el.naturalHeight;
  return w && h ? { w, h } : null;
}

// ---------- Aperçu : live + photos prises dans le template ----------

function fitCanvas() {
  const c = $('#preview');
  const t = state.template;
  if (!t) return;
  const wrap = c.parentElement;
  // Place disponible : la largeur de l'écran moins la colonne des boutons. Le cadre prend ensuite la taille
  // de l'aperçu, pas toute la place : sur un écran très large, aperçu et boutons restent groupés au centre.
  const layout = wrap.parentElement;
  const side = layout.querySelector(':scope > .side');
  const column = getComputedStyle(layout).flexDirection === 'column'; // écran en portrait
  const gap = parseFloat(getComputedStyle(layout).columnGap) || 0;
  const maxW = (column ? layout.clientWidth : layout.clientWidth - (side?.offsetWidth || 0) - gap) || 800;
  const maxH = wrap.clientHeight || 600;
  const cssScale = Math.min(maxW / t.width, maxH / t.height);
  const cssW = Math.floor(t.width * cssScale);
  const cssH = Math.floor(t.height * cssScale);
  wrap.style.setProperty('--fit-w', `${cssW}px`); // largeur du cadre hors décompte (voir booth.css)
  // Arrondi CSS du canvas (18 px) ramené en unités du template : le liseré et le flux suivent la même courbe.
  state.frameRadius = 18 / cssScale;
  // Résolution interne plafonnée : confortable pour un PC modeste.
  const internalW = Math.min(Math.round(cssW * Math.min(window.devicePixelRatio || 1, 2)), 1400);
  state.previewScale = internalW / t.width;
  c.width = internalW;
  c.height = Math.round(t.height * state.previewScale);
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
}

// Calques photo détourés (fond vert / bleu, IA) : voir cutout-live.js
const previewCutter = createCutter(() => state.previewScale);
const usesAi = (t) => t?.layers?.some((l) => l.type === 'photo' && l.cutout === 'ai');
// Template GIF : plusieurs poses dans le même emplacement (tous les calques photo montrent la pose en cours)
const isGif = (t) => t?.kind === 'gif';
// Boomerang : quelques secondes filmées, jouées en avant puis en arrière
const isBoomerang = (t) => t?.kind === 'boomerang';
const isAnimated = (t) => isGif(t) || isBoomerang(t);
const BOOMERANG_FPS = 12.5; // comme le serveur (server/templates.js)
const animTag = (kind) => (kind === 'boomerang' ? 'BOOMERANG' : 'GIF');

function renderPreview() {
  const c = $('#preview');
  const t = state.template;
  if (!t) return;
  const live = liveSize();
  const shutter = shutterValue(); // fermé tant que la caméra n'envoie rien (webcam comprise), puis s'ouvre
  const gif = isAnimated(t); // GIF, boomerang : l'emplacement montre toujours le live
  renderTemplate(c.getContext('2d'), t, {
    scale: state.previewScale,
    photos: gif ? {} : state.shotImages,
    // Toujours un live pour la photo en cours : pas de gris « Photo 1 » pendant que la caméra démarre
    live: { el: state.live?.el || null, w: live?.w || 0, h: live?.h || 0, shot: gif ? 0 : state.currentShot, shutter },
    mirror: state.session ? !!state.session.mirror : !!state.boot.booth.mirrorPreview,
    assets: state.assets,
    placeholder: true,
    highlightShot: gif ? 0 : state.currentShot,
    highlightColor: state.primaryColor,
    frameRadius: state.frameRadius || 0,
    cutter: previewCutter
  });
}

function startRenderLoop() {
  stopRenderLoop();
  const loop = (ts) => {
    if (state.screen !== 'capture') return;
    if (ts - state.lastFrameAt >= 33) { // ~30 i/s max (l'ouverture de l'obturateur est animée dans cette boucle)
      state.lastFrameAt = ts;
      renderPreview();
    }
    state.rafId = requestAnimationFrame(loop);
  };
  state.rafId = requestAnimationFrame(loop);
}
function stopRenderLoop() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
}

// ---------- Choix du template ----------

// Photos d'exemple posées dans les emplacements photo des cadres proposés (au lieu du gris « Photo 1 ») :
// template-photo.jpg, -2, -3 (voir server/samples.js). La photo N du cadre prend l'exemple N, en boucle.
const samplePhotos = new Map(); // url → Image
function loadSamplePhotos() {
  (state.boot.samples || []).forEach((url, i) => {
    if (samplePhotos.has(url)) return;
    const img = new Image();
    img.onload = () => renderTemplateGrid();
    img.src = url;
    const cut = state.boot.sampleCutouts?.[i]; // même photo détourée (.png), pour les calques avec détourage
    if (cut) { img.cutout = new Image(); img.cutout.onload = () => renderTemplateGrid(); img.cutout.src = cut; }
    samplePhotos.set(url, img);
  });
}

// Cartes GIF animées avec les photos d'exemple, à la vitesse du template (une minuterie par carte)
let gifCardTimers = [];

function renderTemplateGrid() {
  gifCardTimers.forEach(clearInterval);
  gifCardTimers = [];
  // Miniatures calculées par le serveur à l'enregistrement : rien à dessiner. Sinon (ancien template, miniature
  // pas encore prête) : rendu ici avec les photos d'exemple.
  if (state.boot.templates.items.some((t) => !t.previews?.length)) loadSamplePhotos();
  const ready = (state.boot.samples || []).map((u) => samplePhotos.get(u)).filter((img) => img?.complete && img.naturalWidth);
  const grid = $('#templateGrid');
  grid.innerHTML = '';
  // Stream Deck branché : une page à la fois, autant de cadres que de touches, comme la galerie
  const all = state.boot.templates.items;
  const per = deckPerPage();
  const pages = per ? Math.max(1, Math.ceil(all.length / per)) : 1;
  state.templatePage = Math.max(0, Math.min(pages - 1, state.templatePage));
  const shown = per ? all.slice(state.templatePage * per, (state.templatePage + 1) * per) : all;
  grid.classList.toggle('paged', !!per);
  $('#templateNav').classList.toggle('hidden', pages <= 1);
  $('#templatePage').textContent = `${state.templatePage + 1} / ${pages}`;
  $('#btnTemplatePrev').disabled = state.templatePage === 0;
  $('#btnTemplateNext').disabled = state.templatePage >= pages - 1;
  for (const t of shown) {
    const card = document.createElement('button');
    card.className = 'template-card';
    const cv = t.previews?.length ? previewThumb(t) : drawnThumb(t, ready);
    const label = document.createElement('div');
    label.className = 'template-name';
    label.textContent = t.name;
    card.append(cv, label);
    if (isAnimated(t)) { // pastille sur l'aperçu (div, pas span : le Stream Deck garde le nom du cadre)
      const tag = document.createElement('div');
      tag.className = 'gif-tag';
      tag.textContent = animTag(t.kind);
      card.classList.add('is-gif');
      card.append(tag);
    }
    card.addEventListener('click', () => startSession(t.id));
    grid.appendChild(card);
  }
  sizeTemplateCards();
}

/** Carte : miniature du serveur. GIF, boomerang : ses images défilent (une par photo d'exemple). */
function previewThumb(t) {
  const img = new Image();
  img.className = 'tpl-thumb';
  img.alt = '';
  img.decoding = 'async';
  const scale = 720 / Math.max(t.width, t.height);
  img.dataset.w = Math.round(t.width * scale); // taille connue avant le chargement (sizeTemplateCards)
  img.dataset.h = Math.round(t.height * scale);
  img.src = t.previews[0];
  if (isAnimated(t) && t.previews.length > 1) {
    t.previews.slice(1).forEach((u) => { new Image().src = u; }); // préchargées : pas de trou au changement
    let f = 0;
    gifCardTimers.push(setInterval(() => { if (state.screen === 'template') img.src = t.previews[++f % t.previews.length]; }, t.gif?.frameMs || 500));
  }
  return img;
}

/** Carte sans miniature du serveur : template dessiné ici avec les photos d'exemple. */
function drawnThumb(t, ready) {
  const cv = document.createElement('canvas');
  const scale = 720 / Math.max(t.width, t.height); // net même affiché en grand (voir .template-card canvas)
  cv.width = Math.round(t.width * scale);
  cv.height = Math.round(t.height * scale);
  const ctx = cv.getContext('2d');
  const photos = ready.length ? Object.fromEntries(Array.from({ length: t.shots }, (_, i) => [i, ready[i % ready.length]])) : {};
  const cutoutPhotos = Object.fromEntries(Object.entries(photos).filter(([, img]) => img.cutout?.complete && img.cutout.naturalWidth).map(([k, img]) => [k, img.cutout]));
  renderTemplate(ctx, t, { scale, photos, cutoutPhotos, placeholder: true });
  let cardAssets = null;
  loadAssets(t).then((assets) => { cardAssets = assets; renderTemplate(ctx, t, { scale, photos, cutoutPhotos, assets, placeholder: true }); });
  if (isGif(t) && ready.length > 1) {
    let f = 0;
    gifCardTimers.push(setInterval(() => {
      if (state.screen !== 'template') return;
      const img = ready[++f % ready.length];
      const cut = img.cutout?.complete && img.cutout.naturalWidth ? { 0: img.cutout } : {};
      renderTemplate(ctx, t, { scale, photos: { 0: img }, cutoutPhotos: cut, assets: cardAssets || undefined, placeholder: true });
    }, t.gif.frameMs));
  }
  return cv;
}

/**
 * Cartes des cadres aussi grandes que la place le permet (QR Wi-Fi compris), proportions gardées, 560 px de
 * haut au plus. Toujours à la taille d'une grille complète, rangée depuis la gauche comme la galerie : avec
 * 1 ou 2 cadres, mêmes cartes, aux premières places. Sans Stream Deck : 4 colonnes et 2 rangées visibles
 * en paysage, 2 colonnes et 3 rangées en portrait, puis défilement. Stream Deck : colonnes et rangées de ses touches.
 */
function sizeTemplateCards() {
  const grid = $('#templateGrid');
  const cards = [...grid.querySelectorAll('.template-card')];
  if (!cards.length) return;
  const portrait = innerHeight > innerWidth;
  const deckCols = deckPerPage() ? state.deck.gallery.cols : 0;
  // Grille de référence (taille des cartes) : une page pleine, quel que soit le nombre de cadres affichés
  const cols = deckCols || (portrait ? 2 : 4);
  const rows = deckCols ? Math.max(1, Math.ceil(deckPerPage() / deckCols)) : portrait ? 3 : 2; // rangées visibles
  const GAP = 32, PAD = 36, LABEL = 50; // espacement, marges de la carte, nom sous l'aperçu
  const W = grid.clientWidth - 2 * GRID_PAD, H = grid.clientHeight - 2 * GRID_PAD;
  const boxW = (W - (cols - 1) * GAP) / cols - PAD;
  const boxH = Math.min(560, (H - (rows - 1) * GAP) / rows - PAD - LABEL);
  // Colonnes de largeur fixe (celle de la plus large carte). Avec le Stream Deck, autant de colonnes que de
  // touches, remplies depuis la gauche : chaque carte est en face de sa touche. Sans lui, pas de colonne vide :
  // autant de colonnes que de cadres (au plus la grille de référence), et la grille, centrée, les centre.
  const trackW = Math.floor(Math.max(...cards.map((card) => {
    const el = card.querySelector('canvas, img.tpl-thumb');
    const w = Number(el.dataset.w) || el.width, h = Number(el.dataset.h) || el.height;
    return Math.max(80, w * Math.min(boxW / w, boxH / h)) + PAD;
  })));
  grid.style.gridTemplateColumns = `repeat(${deckCols ? cols : Math.min(cols, cards.length)}, ${trackW}px)`;
  for (const card of cards) {
    const cv = card.querySelector('canvas, img.tpl-thumb');
    const w = Number(cv.dataset.w) || cv.width, h = Number(cv.dataset.h) || cv.height;
    const k = Math.min(boxW / w, boxH / h);
    cv.style.width = `${Math.max(80, Math.floor(w * k))}px`;
    cv.style.height = `${Math.max(60, Math.floor(h * k))}px`;
  }
}

const GRID_PAD = 16; // marge de la grille des cadres (booth.css) : l'ombre des cartes n'est pas rognée

/** Cadres ou photos par page quand le Stream Deck pilote l'écran, sinon 0 (tout, avec défilement). */
function deckPerPage() {
  return state.deck?.connected && state.deck.gallery ? state.deck.gallery.perPage : 0;
}

function templatePageTurn(delta) {
  state.templatePage += delta;
  renderTemplateGrid();
  menuActivity();
}

function onIdleTap() {
  const { items, guestCanChoose, default: def } = state.boot.templates;
  if (!items.length) return toast('Aucun template activé, voir l\'admin');
  startLive(); // réveille le live view du boîtier pendant que l'invité choisit son cadre
  if (items.some(usesAi)) preloadAi();
  if (guestCanChoose && items.length > 1) { state.templatePage = 0; renderTemplateGrid(); showScreen('template'); $('#templateGrid').scrollTop = 0; sizeTemplateCards(); }
  else startSession(items.some((t) => t.id === def) ? def : items[0].id);
}

// ---------- Prise de vue ----------

async function startSession(templateId) {
  state.kept = false;
  try {
    const session = await api('/api/session', { method: 'POST', body: { templateId } });
    state.session = session;
    state.template = state.boot.templates.items.find((t) => t.id === session.templateId);
    if (usesAi(state.template)) preloadAi(); // modèle de détourage chargé pendant que le live démarre
    state.currentShot = 0;
    state.shotImages = {};
    state.assets = new Map();
    loadAssets(state.template, state.assets); // les images du template arrivent en arrière-plan
    showScreen('capture');
    fitCanvas();
    startRenderLoop();
    startLive();
    prepareShot(0, true);
  } catch (e) {
    toast(e.message);
  }
}

function prepareShot(index, manual) {
  state.currentShot = index;
  resetShutter(); // chaque photo commence obturateur fermé, qui s'ouvre sur le flux
  const total = state.template.shots;
  // GIF lancé : on reste en plein écran d'une pose à l'autre (« Photo 2/3 », décompte…), sans revenir à l'aperçu
  if (isGif(state.template) && !manual) {
    showPoseLabel(index);
    setTimer('autoNext', () => runCountdown(index), POSE_LABEL_MS);
    return;
  }
  hideCountdown();
  $('#shotLabel').textContent = total > 1 ? `${isGif(state.template) ? 'Pose' : 'Photo'} ${index + 1} / ${total}` : '';
  $('#btnCaptureBack').classList.toggle('hidden', !(manual && canChangeTemplate()));
  fitCanvas(); // l'aperçu se redimensionne selon la place que prend ce bouton
  if (manual) {
    $('#btnStart').classList.remove('hidden');
    $('#txtGetReady').classList.remove('hidden');
    // Personne ne lance la photo : retour à l'accueil (et obturateur refermé).
    const idleSec = state.boot.limits.captureTimeoutSec ?? 30;
    if (idleSec > 0) setTimer('idleReturn', goIdle, idleSec * 1000);
  } else {
    $('#btnStart').classList.add('hidden');
    $('#txtGetReady').classList.add('hidden');
    setTimer('autoNext', () => runCountdown(index), isGif(state.template) ? 400 : 1500); // GIF : les poses s'enchaînent
  }
}

/** GIF : « Photo 2/3 » en plein écran, sur le fond du décompte, entre deux poses. */
const POSE_LABEL_MS = 1200;
function showPoseLabel(index) {
  enterLookMode();
  $('#lookUp').classList.add('hidden');
  const cd = $('#countdown');
  cd.textContent = `Photo ${index + 1}/${state.template.shots}`;
  cd.classList.remove('hidden', 'wait', 'pop');
  cd.classList.add('msg');
  void cd.offsetWidth;
  cd.classList.add('pop');
}

async function runCountdown(index) {
  clearTimer('idleReturn');
  $('#btnStart').classList.add('hidden');
  $('#btnCaptureBack').classList.add('hidden'); // décompte lancé : plus de retour au choix du cadre
  $('#txtGetReady').classList.add('hidden');
  if (isGif(state.template) && index === 0) { // lancement du GIF : plein écran dès « Photo 1/3 »
    showPoseLabel(0);
    await sleep(POSE_LABEL_MS);
    if (state.screen !== 'capture') return;
  }
  await waitLive(); // le boîtier peut mettre une à deux secondes à rouvrir l'obturateur
  if (state.screen !== 'capture') return;
  const cd = $('#countdown');
  cd.classList.remove('hidden', 'msg', 'wait');
  if (isGif(state.template)) enterLookMode(); // décompte des poses en plein écran, flèche vers l'objectif
  // GIF : décompte complet pour la première pose, puis celui du template entre deux poses
  const total = isGif(state.template) && index > 0 ? state.template.gif.poseSec : state.boot.limits.countdownSec;
  // Pré-armement du boîtier (live coupé, miroir baissé) juste avant la fin du décompte, avec l'avance
  // que demande le pilote (pause de stabilisation + marge) : le déclenchement part pile à « 0 ».
  // Boomerang : jamais, la vidéo est filmée dans l'aperçu, qui doit continuer.
  const boomerang = isBoomerang(state.template);
  const lead = boomerang ? 0 : state.boot.camera.armLeadMs || 0;
  if (boomerang) {
    // Mise au point pendant le décompte (l'aperçu se coupe un instant) : décompte en plein écran
    state.focusing = api(`/api/session/${state.session.id}/focus`, { method: 'POST' }).catch(() => {});
    enterLookMode();
  }
  const fireAt = performance.now() + total * 1000; // instant du « 0 »
  if (lead > 0) {
    const sessionId = state.session.id;
    setTimer('arm', () => {
      state.liveHeld = true; // le live va se couper : l'aperçu n'a plus d'intérêt, place au décompte plein écran
      enterLookMode();
      state.armedSession = sessionId;
      const fireInMs = Math.max(0, Math.round(fireAt - performance.now()));
      api(`/api/session/${sessionId}/arm`, { method: 'POST', body: { index, fireInMs } }).catch(() => {});
    }, Math.max(0, total * 1000 - lead));
  }
  for (let n = total; n > 0; n--) {
    if (!lead && (n === LOOK_UP_SEC || (n === total && total < LOOK_UP_SEC))) enterLookMode(); // sans pré-armement, le live continue
    cd.textContent = n;
    cd.classList.remove('pop');
    void cd.offsetWidth;
    cd.classList.add('pop');
    await sleep(1000);
    if (state.screen !== 'capture') return; // annulé
  }
  if (boomerang) return recordClip();
  // « 0 » : la photo part, mais le boîtier met encore une à trois secondes (liaison, mise au point,
  // transfert). On demande de garder la pose jusqu'à l'arrivée de l'image.
  cd.textContent = state.boot.texts.holdPose || 'Gardez la pose !';
  cd.classList.add('msg');
  cd.classList.remove('pop');
  void cd.offsetWidth;
  cd.classList.add('pop');
  await takeShot(index);
}

/**
 * Boomerang : « Bougez ! » en plein écran avec une barre qui avance pendant que la borne filme (le serveur
 * enregistre l'aperçu du boîtier ; une webcam est filmée ici), puis « Veuillez patienter » pendant le montage.
 */
async function recordClip() {
  const durationMs = state.template.boomerang.durationSec * 1000;
  enterLookMode();
  const cd = $('#countdown');
  if (state.focusing) {
    // Mise au point pas encore finie : annoncée seulement si elle dure (sinon le texte clignote une fraction de seconde)
    const done = await Promise.race([state.focusing.then(() => true), sleep(400).then(() => false)]);
    if (!done) {
      cd.textContent = state.boot.texts.focusing || 'Mise au point…';
      cd.classList.add('msg');
    }
    await state.focusing;
    state.focusing = null;
    if (state.screen !== 'capture') return;
  }
  cd.textContent = state.boot.texts.boomerangGo || 'Bougez !';
  cd.classList.add('msg');
  cd.classList.remove('pop');
  void cd.offsetWidth;
  cd.classList.add('pop');
  let bar = $('#recBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'recBar';
    bar.className = 'rec-bar';
    bar.innerHTML = '<i></i>';
    $('#screen-capture').appendChild(bar);
  }
  const fill = bar.firstElementChild;
  bar.classList.remove('hidden');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetWidth;
  fill.style.transition = `width ${durationMs}ms linear`;
  fill.style.width = '100%';
  try {
    const url = `/api/session/${state.session.id}/clip`;
    let result;
    if (state.boot.camera.mode === 'browser') {
      const form = new FormData();
      (await grabClip(durationMs)).forEach((b, i) => form.append('frames', b, `f-${i + 1}.jpg`));
      result = await api(url, { method: 'POST', form });
    } else {
      result = await api(url, { method: 'POST' });
    }
    state.session = result.session;
    if (state.screen !== 'capture') return;
    bar.classList.add('hidden');
    showPleaseWait();
    await finishShots();
  } catch (e) {
    toast(e.message, 5000);
    prepareShot(0, true);
  }
}

/** Webcam : images de la vidéo à BOOMERANG_FPS pendant durationMs (960 px au plus). */
async function grabClip(durationMs) {
  const v = $('#video');
  const k = Math.min(1, 960 / (v.videoWidth || 960));
  const c = document.createElement('canvas');
  c.width = Math.round((v.videoWidth || 1280) * k);
  c.height = Math.round((v.videoHeight || 720) * k);
  const ctx = c.getContext('2d');
  const blobs = [];
  const t0 = performance.now();
  for (let i = 0; performance.now() - t0 < durationMs; i++) {
    ctx.drawImage(v, 0, 0, c.width, c.height);
    blobs.push(new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)));
    await sleep(Math.max(0, t0 + (i + 1) * (1000 / BOOMERANG_FPS) - performance.now()));
  }
  return (await Promise.all(blobs)).filter(Boolean);
}

/** Plein écran « Veuillez patienter » (assemblage du GIF), sur le fond du décompte, sans la flèche vers l'objectif. */
function showPleaseWait() {
  enterLookMode();
  $('#lookUp').classList.add('hidden');
  const cd = $('#countdown');
  cd.textContent = state.boot.texts.pleaseWait || 'Veuillez patienter';
  cd.classList.remove('hidden', 'pop');
  cd.classList.add('msg', 'wait');
  $('#shotLabel').textContent = '';
}

function hideCountdown() {
  const cd = $('#countdown');
  cd.classList.add('hidden');
  cd.classList.remove('msg', 'pop', 'wait');
  $('#recBar')?.classList.add('hidden');
  $('#lookUp').classList.add('hidden');
  $('#screen-capture').classList.remove('looking');
}

/** Sans pré-armement (webcam…) : secondes avant le « 0 » où l'on passe au décompte plein écran. */
const LOOK_UP_SEC = 2;

/**
 * Décompte plein écran + « Regardez l'objectif » avec une flèche vers le boîtier, jusqu'à l'arrivée de
 * la photo. Avec gphoto2, dès la coupure du live par le pré-armement : plus d'image figée à l'écran.
 */
function enterLookMode() {
  if (state.screen !== 'capture') return;

  const el = $('#lookUp');
  const pos = ['top', 'bottom', 'left', 'right'].includes(state.boot.booth.lensPosition) ? state.boot.booth.lensPosition : 'top';
  el.dataset.pos = pos;
  $('#screen-capture').dataset.lens = pos; // ordre bandeau / chiffre
  $('#screen-capture').classList.add('looking');
  $('#txtLookUp').textContent = state.boot.texts.lookUp || 'Regardez l\'objectif';
  el.classList.remove('hidden');
}

function flash() {
  const f = $('#flash');
  f.classList.remove('on');
  void f.offsetWidth;
  f.classList.add('on');
}

async function grabFrame() {
  const v = $('#video');
  const c = document.createElement('canvas');
  c.width = v.videoWidth || 1280;
  c.height = v.videoHeight || 720;
  c.getContext('2d').drawImage(v, 0, 0);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
}

async function takeShot(index) {
  state.shutterForce = true; // « clac » : l'obturateur se referme avec le flash, jusqu'à l'arrivée de la photo
  flash();
  $('#shotLabel').textContent = '…';
  try {
    let result;
    const url = `/api/session/${state.session.id}/shot/${index}`;
    if (state.boot.camera.mode === 'browser') {
      const blob = await grabFrame();
      if (!blob) throw new Error('Impossible de capturer l\'image de la caméra');
      const form = new FormData();
      form.append('photo', blob, 'shot.jpg');
      result = await api(url, { method: 'POST', form });
    } else {
      result = await api(url, { method: 'POST' });
    }
    state.session = result.session;
    state.armedSession = null;
    const img = new Image();
    img.src = `${result.shot.url}?t=${Date.now()}`;
    await img.decode();
    state.shotImages[index] = img;
    const next = state.session.shots.findIndex((s) => !s);
    // GIF : plein écran jusqu'au bout (« Photo 2/3 » entre les poses, « Veuillez patienter » pendant l'assemblage)
    if (next < 0 && isAnimated(state.template)) showPleaseWait();
    else if (!isGif(state.template)) hideCountdown(); // la photo est là, l'invité peut bouger
    if (next >= 0) prepareShot(next, false);
    else await finishShots();
  } catch (e) {
    toast(e.message, 5000);
    prepareShot(index, true);
  }
}

async function finishShots() {
  if (!isAnimated(state.template)) $('#shotLabel').textContent = 'Montage…'; // GIF, boomerang : plein écran « Veuillez patienter »
  try {
    state.session = await api(`/api/session/${state.session.id}/compose`, { method: 'POST' });
    showReview();
  } catch (e) {
    toast(e.message, 5000);
    prepareShot(0, true);
  }
}

// ---------- Relecture ----------

/** Photo ou GIF dans l'image, boomerang (MP4) dans le lecteur vidéo (en boucle, muet) ; l'autre est vidé. */
function showMedia(img, video, url, isVideo) {
  img.classList.toggle('hidden', !!isVideo);
  video.classList.toggle('hidden', !isVideo);
  if (isVideo) {
    img.removeAttribute('src');
    if (video.getAttribute('src') !== url) { video.src = url; video.play().catch(() => {}); }
  } else {
    video.pause();
    video.removeAttribute('src');
    video.load();
    img.src = url;
  }
}

function showReview() {
  const s = state.session;
  const { texts } = state.boot;
  showMedia($('#finalImg'), $('#finalVideo'), `${s.final.url}?t=${Date.now()}`, s.final.video);
  $('#txtReview').textContent = (s.gif && texts.reviewGif) || texts.review || '';
  $('#btnKeep').textContent = (s.gif && texts.keepGif) || texts.keep || '';
  $('#btnRetake').classList.toggle('hidden', s.retakesLeft !== null && s.retakesLeft <= 0); // null = reprises illimitées
  $('#retakeChooser').classList.add('hidden');
  renderFilterBar();
  showScreen('review');
  startReviewTimeout();
}

/** Validation automatique de la relecture : barre qui se vide, puis « Je la garde ». Relancée à chaque filtre choisi. */
function startReviewTimeout() {
  clearTimer('reviewTimeout');
  state.keepAfterFilter = false;
  const total = (state.boot.limits.reviewTimeoutSec || 0) * 1000;
  const fill = $('#timeoutFill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  if (total > 0) {
    // Barre pleine prise en compte avant l'animation : sinon le navigateur saute directement à 0 % (barre vide)
    void fill.offsetWidth;
    fill.style.transition = `width ${total}ms linear`;
    fill.style.width = '0%';
    // Changer de filtre ne relance pas le délai ; s'il expire pendant le montage, la photo est gardée juste après
    setTimer('reviewTimeout', () => { if (state.filtering) state.keepAfterFilter = true; else keepPhoto(); }, total);
  }
}

function onRetakeClick() {
  const s = state.session;
  if (s.gif) return retakeGif();
  if (s.shotsExpected === 1) return retakeShot(0);
  const ch = $('#retakeChooser');
  ch.innerHTML = '';
  s.shots.forEach((sh, i) => {
    const b = document.createElement('button');
    b.className = 'retake-thumb';
    const img = document.createElement('img');
    img.src = `${sh.url}?t=${Date.now()}`;
    if (state.session.mirror) img.style.transform = 'scaleX(-1)'; // comme dans l'aperçu et la photo finale
    const lbl = document.createElement('span');
    lbl.textContent = `Refaire la ${i + 1}`;
    b.append(img, lbl);
    b.addEventListener('click', () => retakeShot(i));
    ch.appendChild(b);
  });
  ch.classList.remove('hidden');
}

/**
 * Filtres sur « On la garde ? » (option de l'admin) : une vignette par filtre (la 1re photo, filtre CSS
 * approché) ; au choix, le serveur refait le montage avec le vrai filtre, sur tout le montage.
 */
function renderFilterBar() {
  const bar = $('#filterBar');
  const f = state.boot.booth.filters || {};
  const list = f.enabled ? FILTERS.filter((x) => (f.available || []).includes(x.id)) : [];
  bar.classList.toggle('hidden', list.length < 2);
  if (list.length < 2) { bar.innerHTML = ''; return; }
  const s = state.session;
  const src = s.shots.find(Boolean)?.url;
  const current = s.filter || 'none';
  bar.innerHTML = list.map((x) => `<button class="filter-chip${x.id === current ? ' active' : ''}" data-filter="${x.id}">
      <img src="${src}" alt="" style="filter:${x.css};${s.mirror ? 'transform:scaleX(-1);' : ''}"><span>${x.name}</span></button>`).join('');
  bar.querySelectorAll('.filter-chip').forEach((b) => b.addEventListener('click', () => chooseFilter(b.dataset.filter)));
}

async function chooseFilter(id) {
  const s = state.session;
  if (state.filtering || (s.filter || 'none') === id) return;
  state.filtering = true;
  $('#screen-review').classList.add('filtering');
  $('#btnKeep').disabled = true;
  $$('.filter-chip').forEach((b) => b.classList.toggle('active', b.dataset.filter === id));
  try {
    state.session = await api(`/api/session/${s.id}/compose`, { method: 'POST', body: { filter: id } });
    showMedia($('#finalImg'), $('#finalVideo'), `${state.session.final.url}?t=${Date.now()}`, state.session.final.video);
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    state.filtering = false;
    $('#screen-review').classList.remove('filtering');
    $('#btnKeep').disabled = false;
    renderFilterBar();
    if (state.keepAfterFilter && state.screen === 'review') keepPhoto();
  }
}

/** GIF : toutes les poses sont reprises. */
async function retakeGif() {
  clearTimer('reviewTimeout');
  try {
    state.session = await api(`/api/session/${state.session.id}/restart`, { method: 'POST' });
  } catch (e) {
    toast(e.message, 5000);
    return;
  }
  state.shotImages = {};
  retakeShot(0);
}

async function retakeShot(index) {
  clearTimer('reviewTimeout');
  delete state.shotImages[index];
  showScreen('capture');
  fitCanvas();
  startRenderLoop();
  startLive();
  prepareShot(index, true);
}

// ---------- Copies & impression ----------

function keepPhoto() {
  clearTimer('reviewTimeout');
  const s = state.session;
  if (!state.kept) {
    state.kept = true; // validée : conservée même si l'invité s'arrête au choix des copies
    api(`/api/session/${s.id}/keep`, { method: 'POST' }).catch(() => {});
  }
  const { texts, limits, counters, printer } = state.boot;
  // Pas d'imprimante détectée, ou GIF (numérique uniquement) : pas d'écran de copies, directement la fin.
  if (printer?.available === false || s.gif) return finishWithoutPrint();
  state.maxCopies = s.maxCopies;
  if (!s.unlocked && counters.quotaRemaining !== null) state.maxCopies = Math.min(state.maxCopies, counters.quotaRemaining);
  if (counters.paperRemaining !== null) state.maxCopies = Math.min(state.maxCopies, counters.paperRemaining); // papier : même déverrouillé
  $('#finalThumb').src = s.final.thumbUrl;

  const noPrint = state.maxCopies <= 0; // quota atteint ou plus de papier
  $('#stepper').classList.toggle('hidden', noPrint);
  $('#btnPrint').classList.toggle('hidden', noPrint);
  if (noPrint) {
    $('#copiesHint').textContent = counters.paperEmpty ? texts.paperEmpty || texts.quotaReached : texts.quotaReached;
    $('#btnNoPrint').textContent = texts.finish;
    $('#btnNoPrint').classList.remove('hidden');
  } else {
    $('#copiesHint').textContent = s.unlocked ? `Maximum ${state.maxCopies} (opérateur)` : `Maximum ${state.maxCopies} par passage`;
    $('#btnNoPrint').textContent = texts.noPrint;
    $('#btnNoPrint').classList.toggle('hidden', !limits.allowZeroCopies);
    state.copies = 1;
    renderCopies();
  }
  showScreen('copies');
  startCopiesTimeout();
}

/**
 * « Combien de tirages ? » laissé sans action : impression du nombre affiché, ou fin sans impression (réglage
 * Impression → Limites). Barre et secondes restantes sous les boutons ; changer le nombre ne relance pas le délai.
 */
function startCopiesTimeout() {
  clearTimer('copiesTimeout');
  clearInterval(state.copiesTick);
  const { limits } = state.boot;
  const total = (limits.copiesTimeoutSec || 0) * 1000;
  const box = $('#copiesAuto');
  box.classList.toggle('hidden', !total);
  if (!total || state.screen !== 'copies') return;
  const noPrint = state.maxCopies <= 0;
  const skip = noPrint || (limits.copiesTimeoutAction === 'skip' && limits.allowZeroCopies);
  const fill = $('#copiesTimeoutFill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  void fill.offsetWidth; // barre pleine prise en compte avant l'animation
  fill.style.transition = `width ${total}ms linear`;
  fill.style.width = '0%';
  const end = Date.now() + total;
  const label = () => {
    const sec = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    $('#copiesAutoText').textContent = noPrint ? `Retour à l'accueil dans ${sec} s`
      : skip ? `Fin sans impression dans ${sec} s` : `Impression automatique dans ${sec} s`;
  };
  label();
  state.copiesTick = setInterval(label, 250);
  setTimer('copiesTimeout', () => {
    clearInterval(state.copiesTick);
    if (state.screen !== 'copies') return;
    if ($('#pinDialog').open) { startCopiesTimeout(); return; } // opérateur en train de taper son code
    if (skip) finishWithoutPrint(); else doPrint(state.copies);
  }, total);
}

async function finishWithoutPrint() {
  clearTimer('copiesTimeout');
  clearInterval(state.copiesTick);
  try {
    state.session = await api(`/api/session/${state.session.id}/print`, { method: 'POST', body: { copies: 0 } });
  } catch (e) {
    toast(e.message, 5000);
  }
  showDone();
}

function renderCopies() {
  $('#copiesValue').textContent = state.copies;
  $('#btnMinus').disabled = state.copies <= 1;
  $('#btnPlus').disabled = state.copies >= state.maxCopies;
}

async function doPrint(copies) {
  clearTimer('copiesTimeout');
  clearInterval(state.copiesTick);
  try {
    showScreen('printing');
    $('#printStatus').textContent = copies ? `${copies} tirage${copies > 1 ? 's' : ''}` : '';
    state.session = await api(`/api/session/${state.session.id}/print`, { method: 'POST', body: { copies } });
    if (state.session.status === 'done') showDone();
    else pollPrint();
  } catch (e) {
    toast(e.message, 5000);
    if (e.code === 'QUOTA_REACHED' || e.code === 'PRINTER_UNAVAILABLE' || e.code === 'PAPER_EMPTY') {
      const b = await api('/api/bootstrap');
      state.boot.counters = b.counters;
      state.boot.printer = b.printer;
    }
    keepPhoto();
  }
}

function pollPrint() {
  // Filet de sécurité si le WebSocket rate l'événement de fin.
  setTimer('printPoll', async function poll() {
    try { state.session = await api(`/api/session/${state.session.id}`); } catch { /* réessaie */ }
    if (state.screen !== 'printing') return;
    if (state.session.status === 'done') return showDone();
    if (state.session.status === 'error') {
      $('#printStatus').textContent = state.session.error || 'Erreur imprimante';
      toast('Problème d\'impression, prévenez l\'organisateur', 6000);
      setTimer('printPoll', showDone, 8000);
      return;
    }
    setTimer('printPoll', poll, 2000);
  }, 2000);
}

async function showDone() {
  clearTimer('printPoll');
  // QR code désactivé dans l'admin : rien à scanner, retour direct à l'accueil avec le remerciement en bandeau.
  const { texts } = state.boot;
  const gif = !!state.session?.gif;
  if (state.boot.share?.qrOnDone === false) {
    goIdle();
    // GIF sans QR : il reste à voir dans la galerie de la borne
    toast((gif && state.boot.gallery?.enabled ? texts.gifInGallery : texts.thanksNoQr) || '', 5000);
    return;
  }
  const video = !!state.session?.final?.video;
  $('#txtThanks').textContent = (video ? texts.thanksVideo || texts.thanksGif : gif ? texts.thanksGif : null) || texts.thanks || '';
  try {
    const q = await api(`/api/session/${state.session.id}/qr`);
    $('#qrImg').src = q.dataUrl;
    $('#shareUrl').textContent = q.url;
  } catch { /* QR facultatif */ }
  showScreen('done');
  const ms = (state.boot.booth.idleReturnSec || 20) * 1000;
  state.doneReturnAt = Date.now() + ms; // décompte affiché sur le Stream Deck
  setTimer('idleReturn', goIdle, ms);
}

// ---------- Codes PIN (pavé tactile) ----------

function askPin(title) {
  return new Promise((resolve) => {
    const dlg = $('#pinDialog');
    const display = $('#pinDisplay');
    let value = '';
    $('#pinTitle').textContent = title;
    const render = () => { display.textContent = '•'.repeat(value.length) || ' '; };
    const onKey = (ev) => {
      const k = ev.target.dataset.k;
      if (!k) return;
      if (k === 'del') value = value.slice(0, -1);
      else if (k === 'ok') return finish(value);
      else if (value.length < 8) value += k;
      render();
    };
    const finish = (result) => {
      dlg.querySelector('.keypad').removeEventListener('click', onKey);
      $('#pinCancel').onclick = null;
      dlg.close();
      resolve(result);
    };
    dlg.querySelector('.keypad').addEventListener('click', onKey);
    $('#pinCancel').onclick = () => finish(null);
    render();
    dlg.showModal();
  });
}

async function operatorUnlock() {
  const pin = await askPin('Code opérateur');
  if (pin === null) return;
  try {
    state.session = await api(`/api/session/${state.session.id}/unlock`, { method: 'POST', body: { pin } });
    toast('Limite levée pour cette session');
    keepPhoto();
  } catch (e) {
    toast(e.message);
  }
}

async function adminAccess() {
  if (state.boot.adminOpen) { location.href = '/admin.html'; return; } // code admin vide (tests)
  const pin = await askPin('Code admin');
  if (pin === null) return;
  try {
    await api('/api/admin/login', { method: 'POST', body: { pin } });
    location.href = '/admin.html';
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Galerie : photos de l'événement, navigation, réimpression ----------

const GALLERY_SCREENS = ['gallery', 'photo'];
// Choix du cadre et galerie : retour à l'accueil sans interaction (booth.menuIdleSec, réglable dans l'admin).
const MENU_SCREENS = ['template', ...GALLERY_SCREENS];

/** Un geste (écran, clavier, Stream Deck) sur ces écrans repousse le retour automatique à l'accueil. */
function menuActivity() {
  if (!MENU_SCREENS.includes(state.screen)) return;
  const sec = state.boot?.booth?.menuIdleSec ?? 30;
  if (sec > 0) setTimer('idleReturn', goIdle, sec * 1000);
}

async function openGallery() {
  try {
    state.gallery.items = (await api('/api/gallery')).items;
  } catch (e) {
    toast(e.message);
    return;
  }
  state.gallery.page = 0;
  renderGalleryGrid();
  showScreen('gallery');
  $('#galleryGrid').scrollTop = 0;
}

/** Nombre de miniatures par page quand le Stream Deck pilote la galerie, sinon 0 (toutes, avec défilement). */
const galleryPerPage = deckPerPage;

function renderGalleryGrid() {
  const { items } = state.gallery;
  const grid = $('#galleryGrid');
  grid.innerHTML = '';
  $('#txtGalleryEmpty').classList.toggle('hidden', items.length > 0);
  const per = galleryPerPage();
  const pages = per ? Math.max(1, Math.ceil(items.length / per)) : 1;
  state.gallery.page = Math.max(0, Math.min(pages - 1, state.gallery.page));
  const start = per ? state.gallery.page * per : 0;
  grid.classList.toggle('paged', !!per);
  grid.style.gridTemplateColumns = per ? `repeat(${state.deck.gallery.cols}, minmax(0, 1fr))` : '';
  (per ? items.slice(start, start + per) : items).forEach((it, k) => {
    const b = document.createElement('button');
    b.className = 'gallery-thumb';
    b.innerHTML = `<img src="${it.thumbUrl}" alt="" decoding="async"${per ? '' : ' loading="lazy"'}>${it.gif ? `<div class="gif-tag">${animTag(it.kind)}</div>` : ''}`;
    b.addEventListener('click', () => showPhoto(start + k));
    grid.appendChild(b);
  });
  $('#galleryNav').classList.toggle('hidden', !per || !items.length);
  $('#galleryPage').textContent = `${state.gallery.page + 1} / ${pages}`;
  $('#btnGalleryPrev').disabled = state.gallery.page === 0;
  $('#btnGalleryNext').disabled = state.gallery.page >= pages - 1;
}

function galleryPage(delta) {
  state.gallery.page += delta;
  renderGalleryGrid();
  menuActivity();
}

/** Retour de la visionneuse : la page de la galerie contient la dernière photo regardée. */
function backToGallery() {
  const per = galleryPerPage();
  if (per) state.gallery.page = Math.floor(state.gallery.index / per);
  renderGalleryGrid();
  showScreen('gallery');
}

function showPhoto(index) {
  const { items } = state.gallery;
  if (!items.length) { showScreen('gallery'); return; }
  state.gallery.index = Math.max(0, Math.min(items.length - 1, index));
  state.gallery.copies = 1;
  const it = items[state.gallery.index];
  showMedia($('#photoImg'), $('#photoVideo'), it.url, it.video);
  const { texts } = state.boot; // légende du QR selon ce qu'on récupère
  $('#txtGalleryQr').textContent = (it.video ? texts.galleryQrVideo : it.gif ? texts.galleryQrGif : null) || texts.galleryQr || '';
  $('#photoCount').textContent = `${state.gallery.index + 1} / ${items.length}`;
  $('#btnPhotoPrev').disabled = state.gallery.index === 0;
  $('#btnPhotoNext').disabled = state.gallery.index === items.length - 1;
  renderPhotoQr(it.id);
  renderReprint();
  photoLayout();
  if (state.screen !== 'photo') showScreen('photo');
  else menuActivity();
  requestAnimationFrame(fitPhoto); // mise en page (solo ou non) appliquée ; média déjà en cache compris
}

/**
 * Visionneuse de la galerie : le média au plus grand dans son cadre, en gardant ses proportions. Sans ça, un
 * GIF (480 px) ou un boomerang (960 px) restait à sa taille native, plus petit qu'une photo.
 */
function fitPhoto() {
  const wrap = $('#photoWrap');
  const el = [$('#photoImg'), $('#photoVideo')].find((x) => !x.classList.contains('hidden'));
  const w = el?.naturalWidth || el?.videoWidth, h = el?.naturalHeight || el?.videoHeight;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!w || !h || !W || !H) return;
  const k = Math.min(W / w, H / h);
  el.style.width = `${Math.floor(w * k)}px`;
  el.style.height = `${Math.floor(h * k)}px`;
}
$('#photoImg').addEventListener('load', fitPhoto);
$('#photoVideo').addEventListener('loadedmetadata', fitPhoto);
window.addEventListener('resize', fitPhoto);

/** Ni QR code ni réimpression : la colonne de droite ne sert plus, photo centrée et compteur dessous. */
function photoLayout() {
  const solo = $('.photo-qr').classList.contains('hidden') && $('#photoPrint').classList.contains('hidden');
  $('#screen-photo').classList.toggle('solo', solo);
}

/** QR code vers la page de la photo (/g/:id), pour la récupérer sur un téléphone. Mis en cache par photo. */
async function renderPhotoQr(id) {
  $('.photo-qr').classList.toggle('hidden', state.boot.gallery?.qr === false);
  if (state.boot.gallery?.qr === false) return;
  const img = $('#photoQr');
  const cached = state.gallery.qr.get(id);
  img.classList.toggle('hidden', !cached);
  if (cached) { img.src = cached; return; }
  try {
    const { dataUrl } = await api(`/api/session/${id}/qr`);
    state.gallery.qr.set(id, dataUrl);
    if (state.gallery.items[state.gallery.index]?.id !== id) return; // l'invité est déjà passé à une autre photo
    img.src = dataUrl;
    img.classList.remove('hidden');
  } catch { /* sans QR, la photo reste consultable */ }
}

/** Réimpression selon le réglage de l'admin ; les limites sont rappelées avant l'appui, le serveur tranche. */
function renderReprint() {
  const { boot } = state;
  const mode = boot.gallery?.reprint;
  const box = $('#photoPrint');
  const it = state.gallery.items[state.gallery.index];
  box.classList.toggle('hidden', (mode !== 'operator' && mode !== 'guest') || boot.printer?.available === false || !!it?.gif); // un GIF ne s'imprime pas
  photoLayout();
  if (box.classList.contains('hidden')) return;
  const c = boot.counters;
  const max = mode === 'operator' ? boot.limits.operatorMaxCopies : boot.limits.maxCopiesPerSession;
  state.gallery.copies = Math.max(1, Math.min(max, state.gallery.copies));
  let blocked = '';
  if (boot.printer.available === false) blocked = boot.texts.printerUnavailable;
  else if (c?.paperEmpty) blocked = 'Plus de papier pour le moment';
  else if (mode === 'guest' && c?.quotaReached) blocked = 'Les impressions sont terminées pour ce soir';
  else if (it.printing || state.gallery.printingId === it.id) blocked = 'Impression en cours…';
  $('#photoCopies').textContent = state.gallery.copies;
  $('#btnPhotoMinus').disabled = !!blocked || state.gallery.copies <= 1;
  $('#btnPhotoPlus').disabled = !!blocked || state.gallery.copies >= max;
  $('#btnReprint').disabled = !!blocked;
  $('#reprintHint').textContent = blocked || (mode === 'operator' ? 'Code opérateur demandé' : '');
}

async function galleryReprint() {
  const it = state.gallery.items[state.gallery.index];
  if (!it) return;
  let pin;
  if (state.boot.gallery?.reprint === 'operator') {
    pin = await askPin('Code opérateur');
    if (pin === null) return;
  }
  const copies = state.gallery.copies;
  try {
    await api(`/api/gallery/${it.id}/print`, { method: 'POST', body: { copies, pin } });
    state.gallery.printingId = it.id;
    toast(copies > 1 ? `${copies} tirages lancés` : 'Tirage lancé');
  } catch (e) {
    toast(e.message);
  }
  renderReprint();
}

/** Balayage horizontal sur la photo : précédente / suivante. */
function bindPhotoSwipe() {
  let start = null;
  const wrap = $('#photoWrap');
  wrap.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY }; });
  wrap.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) showPhoto(state.gallery.index + (dx < 0 ? 1 : -1));
  });
  wrap.addEventListener('pointercancel', () => { start = null; });
}

// ---------- WebSocket : config, compteurs, impression ----------

// ---------- Stream Deck : les boutons de l'écran en cours, reproduits sur les touches ----------
// La borne décrit ses actions visibles au serveur (qui les dessine), et exécute les appuis reçus
// comme des clics. Même chemin que le tactile : aucune logique propre au Stream Deck.

const CHOICE_CLASSES = ['template-card', 'retake-thumb', 'gallery-thumb', 'filter-chip'];

function deckKind(el) {
  if (CHOICE_CLASSES.some((c) => el.classList.contains(c))) return 'choice';
  if (el.classList.contains('btn-primary') || el.classList.contains('key-ok')) return 'primary';
  if (el.classList.contains('btn-secondary')) return 'secondary';
  return 'ghost';
}

// Pictogramme par bouton, dessiné par le serveur sur la touche.
const DECK_ICONS = {
  btnStart: 'camera', btnCancel: 'x', pinCancel: 'x', btnTemplateBack: 'back', btnTemplatePrev: 'chevronLeft', btnTemplateNext: 'chevronRight', btnCaptureBack: 'back', btnKeep: 'check', btnRetake: 'retake',
  btnPrint: 'printer', btnNoPrint: 'qr', btnOperator: 'key', btnFinish: 'home', btnMinus: 'minus', btnPlus: 'plus',
  btnGallery: 'gallery', btnGalleryBack: 'back', btnGalleryPrev: 'chevronLeft', btnGalleryNext: 'chevronRight', btnPhotoBack: 'back', btnPhotoPrev: 'chevronLeft', btnPhotoNext: 'chevronRight', btnReprint: 'printer',
  btnPhotoMinus: 'minus', btnPhotoPlus: 'plus'
};

/** Miniature (data URL JPEG, 120 px) d'un canvas ou d'une image de la page, mise en cache sur l'élément. */
function deckThumb(el) {
  const src = el.querySelector('canvas, img');
  if (!src) return null;
  if (el.dataset.deckThumb) return el.dataset.deckThumb;
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  const k = 120 / Math.max(w, h);
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  if (src.style.transform.includes('scaleX(-1)')) { ctx.translate(c.width, 0); ctx.scale(-1, 1); } // photo en miroir
  try { ctx.drawImage(src, 0, 0, c.width, c.height); el.dataset.deckThumb = c.toDataURL('image/jpeg', 0.75); } catch { return null; }
  return el.dataset.deckThumb;
}

// Couleurs réellement affichées par un bouton (thème, mélanges, opacité), rendues opaques sur le fond de page.
const deckCanvas = document.createElement('canvas');
deckCanvas.width = deckCanvas.height = 1;
function solid(color, under) {
  const ctx = deckCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = under || '#000';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = color; // la couleur calculée par le navigateur, quelle que soit sa syntaxe
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function mix(a, b, t) {
  const n = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [n(a), n(b)];
  return `#${x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('')}`;
}
/**
 * Fond réellement situé derrière un élément : le premier parent à fond non transparent (carte, fenêtre du
 * code, panneau), sinon la page. Un bouton semi-transparent se lit sur ce fond-là, pas sur celui de la page.
 */
function backdropOf(el, page) {
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const c = getComputedStyle(p).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)) return solid(c, page);
  }
  return page;
}

function deckStyle(el) {
  const page = solid(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || getComputedStyle(document.body).backgroundColor, '#000');
  const cs = getComputedStyle(el);
  const bg = solid(cs.backgroundColor, backdropOf(el, page));
  let fg = solid(cs.color, bg);
  const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
  let border = hasBorder ? solid(cs.borderTopColor, bg) : null;
  const op = parseFloat(cs.opacity);
  if (op < 1) { // bouton désactivé : même atténuation qu'à l'écran
    fg = mix(fg, page, op);
    if (border) border = mix(border, page, op);
    return { bg: mix(bg, page, op), fg, border, page };
  }
  return { bg, fg, border, page };
}

// Pendant le décompte (.looking), l'écran recolore ses boutons pour le grand fond plein écran : les touches du
// Stream Deck, toujours sur fond noir, gardent les couleurs relevées juste avant.
const deckStyleCache = new Map();
function deckKeyStyle(el, root) {
  if (root.classList.contains('looking') && el.id && deckStyleCache.has(el.id)) return deckStyleCache.get(el.id);
  const st = deckStyle(el);
  if (el.id && !root.classList.contains('looking')) deckStyleCache.set(el.id, st);
  return st;
}

function visible(el) {
  return !!el && !el.classList.contains('hidden') && el.offsetParent !== null;
}

/** Actions de l'écran en cours, dans l'ordre d'affichage. */
function deckItems() {
  const dlg = $('#pinDialog');
  const root = dlg.open ? dlg : $('.screen.active');
  if (!root) return [];
  if (root.id === 'screen-idle') {
    const idle = [{ id: 'start', label: 'Commencer', kind: 'primary', icon: 'camera', style: deckStyle($('#btnStart')) }];
    const g = $('#btnGallery');
    if (visible(g)) { // galerie activée : une touche lui est réservée, les autres lancent la session
      g.dataset.deck = 'btnGallery';
      idle.push({ id: 'btnGallery', label: state.boot.texts.gallery || 'Galerie', kind: 'ghost', icon: 'gallery', style: deckStyle(g) });
    }
    return idle;
  }
  const items = [];
  const cd = $('#countdown');
  if (root.id === 'screen-capture' && visible(cd) && cd.textContent) {
    const page = deckStyle(document.body).page;
    items.push({ id: 'countdown', label: cd.textContent, kind: 'display', display: true, style: { bg: page, fg: solid(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), page), border: null } });
  }
  let n = 0;
  for (const el of root.querySelectorAll('button, #copiesValue, #photoCopies')) {
    if (!visible(el) || (el.classList.contains('link') && el.id !== 'btnOperator')) continue; // code opérateur : aussi sur le Stream Deck
    if (el.id === 'copiesValue' || el.id === 'photoCopies') {
      const st = deckStyle(el);
      items.push({ id: 'copies', label: el.textContent, kind: 'display', display: true, style: { bg: st.page, fg: st.fg, border: null } });
      continue;
    }
    if (el.id === 'btnFinish' && state.doneReturnAt) {
      // Écran de fin : secondes avant le retour automatique à l'accueil, à la place du bouton « Terminer »
      const left = Math.max(0, Math.ceil((state.doneReturnAt - Date.now()) / 1000));
      const page = deckStyle(document.body).page;
      items.push({ id: 'doneCountdown', label: String(left), kind: 'display', display: true, style: { bg: page, fg: solid(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), page), border: null } });
      continue;
    }
    if (!el.dataset.deck) el.dataset.deck = el.id || `deck-${Date.now().toString(36)}-${n++}`;
    const glyph = { minus: '−', plus: '+' }[el.dataset.icon]; // boutons dont l'icône est dessinée en CSS
    const label = glyph || (el.querySelector('.template-name, span')?.textContent || el.textContent || el.getAttribute('aria-label') || '').trim();
    // Miniature sur la touche, sauf pour les cadres : leur nom, plus lisible qu'un cadre réduit à 72 px
    // Cadres et filtres : leur nom sur la touche, plus lisible qu'une vignette réduite à 72 px
    const image = CHOICE_CLASSES.some((c) => el.classList.contains(c)) && !el.classList.contains('template-card') && !el.classList.contains('filter-chip') ? deckThumb(el) : null;
    let icon = DECK_ICONS[el.id] || { del: 'delete', ok: 'check' }[el.dataset.k] || null; // pavé du code : ⌫ et OK en pictogrammes
    // « Sans impression » : QR code seulement s'il s'affichera vraiment (Wi-Fi, option active), sinon retour à l'accueil
    if (el.id === 'btnNoPrint' && state.boot.share?.qrOnDone === false) icon = 'home';
    // Filtre sélectionné : la touche porte une coche, comme la vignette à l'écran
    const active = el.classList.contains('filter-chip') ? el.classList.contains('active') : undefined;
    items.push({ id: el.dataset.deck, label: label || '•', kind: deckKind(el), disabled: el.disabled, icon, image, active, style: deckKeyStyle(el, root) });
  }
  return items;
}

function startDeckSync() {
  let last = '';
  setInterval(() => {
    const ws = state.ws;
    if (!ws || ws.readyState !== 1 || !state.boot) return;
    const ui = { type: 'ui', screen: $('#pinDialog').open ? 'pin' : state.screen, items: deckItems(), colors: state.boot.theme.colors, page: deckStyle(document.body).page };
    if (ui.screen === 'done') ui.anyKey = 'finish'; // écran de fin : toute touche ramène à l'accueil
    const sig = JSON.stringify(ui);
    if (sig === last && !state.deckResend) return;
    last = sig;
    state.deckResend = false;
    ws.send(sig);
  }, 250);
}

// ---------- Clavier (ou télécommande qui se présente comme un clavier) ----------
// Espace = action principale de l'écran, Entrée = valider (idem, ou OK du code), Échap = retour / annuler,
// ← ↓ = « − », ↑ → = « + ». Sur un écran de choix (cadres, photo à refaire), les flèches déplacent la
// sélection et Espace / Entrée la valident. Chiffres et ⌫ tapent dans le code.

const KEY_MINUS = ['ArrowLeft', 'ArrowDown'];
const KEY_PLUS = ['ArrowRight', 'ArrowUp'];

function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const dlg = $('#pinDialog');
  const act = (el) => { if (el && visible(el) && !el.disabled) { el.click(); return true; } return false; };
  let done = false;

  if (dlg.open) {
    if (/^[0-9]$/.test(e.key)) done = act(dlg.querySelector(`[data-k="${e.key}"]`));
    else if (e.key === 'Backspace') done = act(dlg.querySelector('[data-k="del"]'));
    else if (e.key === 'Enter' || e.key === ' ') done = act(dlg.querySelector('[data-k="ok"]'));
    else if (e.key === 'Escape') done = act($('#pinCancel'));
  } else if (!e.repeat || [...KEY_MINUS, ...KEY_PLUS].includes(e.key)) {
    const root = $('.screen.active');
    if (!root) return;
    if (root.id === 'screen-done' && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) {
      goIdle(); // écran de fin : toute touche ramène à l'accueil, sans attendre le décompte
      e.preventDefault();
      return;
    }
    const choices = [...root.querySelectorAll('.template-card, .retake-thumb, .gallery-thumb, .filter-chip')].filter(visible);
    if (e.key === ' ' || e.key === 'Enter') {
      if (root.id === 'screen-idle') { onIdleTap(); done = true; }
      else if (choices.includes(document.activeElement)) done = act(document.activeElement);
      else done = act([...root.querySelectorAll('.btn-primary')].find(visible));
    } else if (e.key === 'Escape') {
      done = act([...root.querySelectorAll('#btnCancel, #btnTemplateBack, #btnGalleryBack, #btnPhotoBack')].find(visible));
    } else if (root.id === 'screen-photo' && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      done = act(e.key === 'ArrowLeft' ? $('#btnPhotoPrev') : $('#btnPhotoNext')); // ← → : photo, ↑ ↓ : copies
    } else if (root.id === 'screen-photo' && (KEY_MINUS.includes(e.key) || KEY_PLUS.includes(e.key))) {
      done = act(KEY_PLUS.includes(e.key) ? $('#btnPhotoPlus') : $('#btnPhotoMinus'));
    } else if (KEY_MINUS.includes(e.key) || KEY_PLUS.includes(e.key)) {
      const plus = KEY_PLUS.includes(e.key);
      if (choices.length) {
        // Sélection : première flèche = premier choix, puis on se déplace (en boucle)
        const i = choices.indexOf(document.activeElement);
        const next = i < 0 ? 0 : (i + (plus ? 1 : -1) + choices.length) % choices.length;
        choices[next].focus();
        done = true;
      } else {
        done = act(root.querySelector(plus ? '#btnPlus' : '#btnMinus'));
      }
    }
  }
  if (done) e.preventDefault(); // sinon Espace / Entrée recliqueraient le bouton qui a le focus
}

function onDeckPress(id) {
  menuActivity();
  if (id === '__admin') { // code secret G D G D du Stream Deck
    if ($('#pinDialog').open) return;
    // Session lancée par les premiers appuis du code (pas encore validée) : abandonnée avant l'admin
    if (state.session && !state.kept && ['shooting', 'review'].includes(state.session.status)) goIdle();
    adminAccess();
    return;
  }
  if (id.startsWith('__')) return; // pages tournées sur le Stream Deck lui-même : juste une interaction
  if (id === 'start') { if (state.screen === 'idle') onIdleTap(); return; }
  if (id === 'finish') { if (state.screen === 'done' && !$('#pinDialog').open) goIdle(); return; }
  const el = document.querySelector(`[data-deck="${CSS.escape(id)}"]`);
  if (el && visible(el) && !el.disabled) el.click();
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.deckResend = true;
    // Reconnexion (serveur redémarré) : vérifier la version du code dès qu'on est à l'accueil.
    if (state.boot) { if (state.screen === 'idle') reloadBoot().catch(() => {}); else state.pendingConfigReload = true; }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'deck') { onDeckPress(msg.id); return; }
    if (msg.type === 'device') { deviceNotice(msg); return; }
    if (msg.type === 'sessions' && state.screen === 'idle') renderIdleGallery(); // photo supprimée depuis l'admin
    if (msg.type === 'flashStray') { if (state.boot) { state.boot.camera.flashStray = msg.stray; $('#flashBadge').classList.toggle('hidden', !msg.stray); } return; }
    if (msg.type === 'deckInfo') { // Stream Deck branché ou débranché : la galerie se met à sa taille
      state.deck = msg;
      applyDeckUi();
      if (state.screen === 'gallery') renderGalleryGrid();
      if (state.screen === 'template') renderTemplateGrid();
      return;
    }
    if (msg.type === 'config') {
      if (state.screen === 'idle') reloadBoot().catch(() => {});
      else state.pendingConfigReload = true;
    } else if (msg.type === 'counters') {
      if (state.boot) state.boot.counters = msg.counters;
      renderPaperBadge();
      if (state.screen === 'photo') renderReprint();
    } else if (msg.type === 'live') {
      state.liveStreaming = !!msg.streaming; // ouvre ou referme l'obturateur dessiné sur l'aperçu
    } else if (msg.type === 'sessions' && GALLERY_SCREENS.includes(state.screen)) {
      // L'admin a supprimé des photos : la galerie se recharge (retour à la grille).
      openGallery();
    } else if (msg.type === 'print' && msg.sessionId === state.gallery.printingId) {
      if (msg.status === 'error') toast(msg.message || 'Erreur imprimante', 5000);
      if (msg.status === 'done' || msg.status === 'error') {
        state.gallery.printingId = null;
        const it = state.gallery.items.find((x) => x.id === msg.sessionId);
        if (it) it.printing = false;
        if (state.screen === 'photo') renderReprint();
      }
    } else if (msg.type === 'sessions' && state.session) {
      // L'admin a supprimé ou réinitialisé des sessions : si la nôtre a disparu, retour à l'accueil.
      api(`/api/session/${state.session.id}`).catch((e) => {
        if (e.code === 'SESSION_NOT_FOUND') { toast('Session annulée par l\'opérateur', 4000); goIdle(); }
      });
    } else if (msg.type === 'print' && state.session && msg.sessionId === state.session.id) {
      if (msg.status === 'printing') $('#printStatus').textContent = 'Impression…';
      if (msg.status === 'error') $('#printStatus').textContent = msg.message || 'Erreur imprimante';
      if (msg.sessionStatus === 'done' && state.screen === 'printing') showDone();
    }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

// ---------- Liaison des événements ----------

function bind() {
  $('#screen-idle').addEventListener('click', onIdleTap);
  document.addEventListener('keydown', onKeyDown, true);
  // Échap natif sur la fenêtre du code : la fermerait sans prévenir askPin(). On passe par « Annuler ».
  $('#pinDialog').addEventListener('cancel', (e) => { e.preventDefault(); $('#pinCancel').click(); });
  $('#btnTemplateBack').addEventListener('click', goIdle);
  $('#btnTemplatePrev').addEventListener('click', () => templatePageTurn(-1));
  $('#btnTemplateNext').addEventListener('click', () => templatePageTurn(1));
  $('#btnStart').addEventListener('click', () => runCountdown(state.currentShot));
  $('#btnCancel').addEventListener('click', goIdle);
  $('#btnCaptureBack').addEventListener('click', backToTemplates);
  $('#btnRetake').addEventListener('click', onRetakeClick);
  $('#btnKeep').addEventListener('click', keepPhoto);
  $('#btnMinus').addEventListener('click', () => { state.copies = Math.max(1, state.copies - 1); renderCopies(); });
  $('#btnPlus').addEventListener('click', () => { state.copies = Math.min(state.maxCopies, state.copies + 1); renderCopies(); });
  $('#btnPrint').addEventListener('click', () => doPrint(state.copies));
  $('#btnNoPrint').addEventListener('click', () => doPrint(0));
  $('#btnOperator').addEventListener('click', operatorUnlock);
  $('#btnFinish').addEventListener('click', goIdle);
  $('#btnGallery').addEventListener('click', (e) => { e.stopPropagation(); openGallery(); }); // pas de départ de session
  $('#btnGalleryBack').addEventListener('click', goIdle);
  $('#btnPhotoBack').addEventListener('click', backToGallery);
  $('#btnGalleryPrev').addEventListener('click', () => galleryPage(-1));
  $('#btnGalleryNext').addEventListener('click', () => galleryPage(1));
  $('#btnPhotoPrev').addEventListener('click', () => showPhoto(state.gallery.index - 1));
  $('#btnPhotoNext').addEventListener('click', () => showPhoto(state.gallery.index + 1));
  $('#btnPhotoMinus').addEventListener('click', () => { state.gallery.copies -= 1; renderReprint(); });
  $('#btnPhotoPlus').addEventListener('click', () => { state.gallery.copies += 1; renderReprint(); });
  $('#btnReprint').addEventListener('click', galleryReprint);
  bindPhotoSwipe();
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, menuActivity, true);

  // Zone invisible en haut à droite : 5 appuis en 3 s ouvrent l'admin.
  let taps = [];
  $('#adminHotspot').addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 3000);
    taps.push(now);
    if (taps.length >= 5) { taps = []; adminAccess(); }
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', () => { if (state.screen === 'capture') fitCanvas(); sizeTemplateCards(); });
}

async function init() {
  try {
    state.boot = await api('/api/bootstrap');
  } catch (e) {
    document.body.innerHTML = `<p style="padding:40px;font-size:24px">Serveur injoignable : ${e.message}</p>`;
    return;
  }
  state.liveStreaming = !!state.boot.camera.streaming;
  applyBoot();
  renderTemplateGrid();
  bind();
  connectWs();
  startDeckSync();
  showScreen('idle');
  // Webcam du navigateur : demander l'accès dès l'accueil pour que la première session démarre vite.
  // Avec le Canon, le live view ne démarre qu'au premier appui (obturateur fermé au repos).
  if (state.boot.camera.mode === 'browser') startLive();
}

init();
