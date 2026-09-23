/* Interface tactile de la borne. Vanilla JS, aucune dépendance. */
import { renderTemplate, loadAssets } from './template-render.js';

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

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimer('toast', () => t.classList.add('hidden'), ms);
}

// ---------- Thème, logo, textes ----------

async function renderLogo(url) {
  const slots = $$('.logo-slot');
  if (url.endsWith('.svg')) {
    try {
      const svg = await (await fetch(url)).text();
      for (const s of slots) s.innerHTML = svg; // hérite de currentColor = couleur secondaire
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
  document.body.dataset.font = theme.font || 'system';
  document.body.style.backgroundImage = theme.backgroundImage ? `url("${theme.backgroundImage}")` : '';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme.colors.background);
  document.title = booth.name;
  renderLogo(theme.logo);
  const shownName = booth.showName === false ? '' : booth.name;
  $('#boothName').textContent = shownName;
  state.primaryColor = theme.colors.primary;

  const t = (id, key) => { const el = $(id); if (el) el.textContent = texts[key] || ''; };
  t('#txtWelcome', 'welcome'); t('#txtChooseTemplate', 'chooseTemplate'); t('#txtGetReady', 'getReady');
  t('#btnStart', 'start'); t('#txtReview', 'review'); t('#btnRetake', 'retake'); t('#btnKeep', 'keep');
  t('#txtCopies', 'copies'); t('#btnPrint', 'print'); t('#btnNoPrint', 'noPrint'); t('#txtPrinting', 'printing');
  t('#txtThanks', 'thanks'); t('#btnFinish', 'finish');
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
  clearTimer('idleReturn');
  clearTimer('reviewTimeout');
  clearTimer('autoNext');
  clearTimer('arm');
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
  // Sécurité : un écran laissé sans interaction revient à l'accueil.
  if (['template', 'copies'].includes(name)) setTimer('idleReturn', goIdle, 120000);
}

function goIdle() {
  clearAllTimers();
  state.session = null;
  state.template = null;
  state.shotImages = {};
  state.assets = new Map();
  showScreen('idle');
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
  const maxW = wrap.clientWidth || 800;
  const maxH = wrap.clientHeight || 600;
  const cssScale = Math.min(maxW / t.width, maxH / t.height);
  const cssW = Math.floor(t.width * cssScale);
  const cssH = Math.floor(t.height * cssScale);
  // Arrondi CSS du canvas (18 px) ramené en unités du template : le liseré et le flux suivent la même courbe.
  state.frameRadius = 18 / cssScale;
  // Résolution interne plafonnée : confortable pour un Raspberry Pi.
  const internalW = Math.min(Math.round(cssW * Math.min(window.devicePixelRatio || 1, 2)), 1400);
  state.previewScale = internalW / t.width;
  c.width = internalW;
  c.height = Math.round(t.height * state.previewScale);
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
}

function renderPreview() {
  const c = $('#preview');
  const t = state.template;
  if (!t) return;
  const live = liveSize();
  const shutter = state.live ? shutterValue() : 0;
  renderTemplate(c.getContext('2d'), t, {
    scale: state.previewScale,
    photos: state.shotImages,
    live: state.live ? { el: state.live.el, w: live?.w || 0, h: live?.h || 0, shot: state.currentShot, shutter } : null,
    mirror: !!state.boot.booth.mirrorPreview,
    assets: state.assets,
    placeholder: true,
    highlightShot: state.currentShot,
    highlightColor: state.primaryColor,
    frameRadius: state.frameRadius || 0
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

function renderTemplateGrid() {
  const grid = $('#templateGrid');
  grid.innerHTML = '';
  for (const t of state.boot.templates.items) {
    const card = document.createElement('button');
    card.className = 'template-card';
    const cv = document.createElement('canvas');
    const scale = 300 / Math.max(t.width, t.height);
    cv.width = Math.round(t.width * scale);
    cv.height = Math.round(t.height * scale);
    const ctx = cv.getContext('2d');
    renderTemplate(ctx, t, { scale, placeholder: true });
    loadAssets(t).then((assets) => renderTemplate(ctx, t, { scale, assets, placeholder: true }));
    const label = document.createElement('div');
    label.className = 'template-name';
    label.textContent = t.name;
    card.append(cv, label);
    card.addEventListener('click', () => startSession(t.id));
    grid.appendChild(card);
  }
}

function onIdleTap() {
  const { items, guestCanChoose, default: def } = state.boot.templates;
  if (!items.length) return toast('Aucun template activé, voir l\'admin');
  startLive(); // réveille le live view du boîtier pendant que l'invité choisit son cadre
  if (guestCanChoose && items.length > 1) showScreen('template');
  else startSession(items.some((t) => t.id === def) ? def : items[0].id);
}

// ---------- Prise de vue ----------

async function startSession(templateId) {
  try {
    const session = await api('/api/session', { method: 'POST', body: { templateId } });
    state.session = session;
    state.template = state.boot.templates.items.find((t) => t.id === session.templateId);
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
  hideCountdown();
  resetShutter(); // chaque photo commence obturateur fermé, qui s'ouvre sur le flux
  const total = state.template.shots;
  $('#shotLabel').textContent = total > 1 ? `Photo ${index + 1} / ${total}` : '';
  if (manual) {
    $('#btnStart').classList.remove('hidden');
    $('#txtGetReady').classList.remove('hidden');
    // Personne ne lance la photo : retour à l'accueil (et obturateur refermé).
    const idleSec = state.boot.limits.captureTimeoutSec ?? 30;
    if (idleSec > 0) setTimer('idleReturn', goIdle, idleSec * 1000);
  } else {
    $('#btnStart').classList.add('hidden');
    $('#txtGetReady').classList.add('hidden');
    setTimer('autoNext', () => runCountdown(index), 1500);
  }
}

async function runCountdown(index) {
  clearTimer('idleReturn');
  $('#btnStart').classList.add('hidden');
  $('#txtGetReady').classList.add('hidden');
  await waitLive(); // le boîtier peut mettre une à deux secondes à rouvrir l'obturateur
  if (state.screen !== 'capture') return;
  const cd = $('#countdown');
  cd.classList.remove('hidden');
  const total = state.boot.limits.countdownSec;
  // Pré-armement du boîtier (live coupé, miroir baissé) juste avant la fin du décompte, avec l'avance
  // que demande le pilote (pause de stabilisation + marge) : le déclenchement part pile à « 0 ».
  const lead = state.boot.camera.armLeadMs || 0;
  const fireAt = performance.now() + total * 1000; // instant du « 0 »
  if (lead > 0) {
    const sessionId = state.session.id;
    setTimer('arm', () => {
      state.liveHeld = true; // le live va se couper : on garde la dernière image à l'écran, obturateur ouvert
      state.armedSession = sessionId;
      const fireInMs = Math.max(0, Math.round(fireAt - performance.now()));
      api(`/api/session/${sessionId}/arm`, { method: 'POST', body: { index, fireInMs } }).catch(() => {});
    }, Math.max(0, total * 1000 - lead));
  }
  for (let n = total; n > 0; n--) {
    cd.textContent = n;
    cd.classList.remove('pop');
    void cd.offsetWidth;
    cd.classList.add('pop');
    await sleep(1000);
    if (state.screen !== 'capture') return; // annulé
  }
  // « 0 » : la photo part, mais le boîtier met encore une à trois secondes (liaison, mise au point,
  // transfert). On demande de garder la pose jusqu'à l'arrivée de l'image.
  cd.textContent = state.boot.texts.holdPose || 'Gardez la pose !';
  cd.classList.add('msg');
  cd.classList.remove('pop');
  void cd.offsetWidth;
  cd.classList.add('pop');
  await takeShot(index);
}

function hideCountdown() {
  const cd = $('#countdown');
  cd.classList.add('hidden');
  cd.classList.remove('msg', 'pop');
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
    hideCountdown(); // la photo est là, l'invité peut bouger
    const next = state.session.shots.findIndex((s) => !s);
    if (next >= 0) prepareShot(next, false);
    else await finishShots();
  } catch (e) {
    toast(e.message, 5000);
    prepareShot(index, true);
  }
}

async function finishShots() {
  $('#shotLabel').textContent = 'Montage…';
  try {
    state.session = await api(`/api/session/${state.session.id}/compose`, { method: 'POST' });
    showReview();
  } catch (e) {
    toast(e.message, 5000);
    prepareShot(0, true);
  }
}

// ---------- Relecture ----------

function showReview() {
  const s = state.session;
  $('#finalImg').src = `${s.final.url}?t=${Date.now()}`;
  $('#btnRetake').classList.toggle('hidden', s.retakesLeft !== null && s.retakesLeft <= 0); // null = reprises illimitées
  $('#retakeChooser').classList.add('hidden');
  showScreen('review');

  const total = (state.boot.limits.reviewTimeoutSec || 0) * 1000;
  const fill = $('#timeoutFill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  if (total > 0) {
    requestAnimationFrame(() => {
      fill.style.transition = `width ${total}ms linear`;
      fill.style.width = '0%';
    });
    setTimer('reviewTimeout', keepPhoto, total);
  }
}

function onRetakeClick() {
  const s = state.session;
  if (s.shotsExpected === 1) return retakeShot(0);
  const ch = $('#retakeChooser');
  ch.innerHTML = '';
  s.shots.forEach((sh, i) => {
    const b = document.createElement('button');
    b.className = 'retake-thumb';
    const img = document.createElement('img');
    img.src = `${sh.url}?t=${Date.now()}`;
    const lbl = document.createElement('span');
    lbl.textContent = `Refaire la ${i + 1}`;
    b.append(img, lbl);
    b.addEventListener('click', () => retakeShot(i));
    ch.appendChild(b);
  });
  ch.classList.remove('hidden');
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
  const { texts, limits, counters, printer } = state.boot;
  state.maxCopies = s.maxCopies;
  if (!s.unlocked && counters.quotaRemaining !== null) state.maxCopies = Math.min(state.maxCopies, counters.quotaRemaining);
  $('#finalThumb').src = s.final.thumbUrl;

  const quotaReached = state.maxCopies <= 0;
  const printerOff = printer?.available === false; // imprimante absente (auto-détection) : QR code seulement
  const noPrint = quotaReached || printerOff;
  $('#stepper').classList.toggle('hidden', noPrint);
  $('#btnPrint').classList.toggle('hidden', noPrint);
  if (noPrint) {
    $('#copiesHint').textContent = printerOff ? texts.printerUnavailable : texts.quotaReached;
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
}

function renderCopies() {
  $('#copiesValue').textContent = state.copies;
  $('#btnMinus').disabled = state.copies <= 1;
  $('#btnPlus').disabled = state.copies >= state.maxCopies;
}

async function doPrint(copies) {
  try {
    showScreen('printing');
    $('#printStatus').textContent = copies ? `${copies} tirage${copies > 1 ? 's' : ''}` : '';
    state.session = await api(`/api/session/${state.session.id}/print`, { method: 'POST', body: { copies } });
    if (state.session.status === 'done') showDone();
    else pollPrint();
  } catch (e) {
    toast(e.message, 5000);
    if (e.code === 'QUOTA_REACHED' || e.code === 'PRINTER_UNAVAILABLE') {
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
  try {
    const q = await api(`/api/session/${state.session.id}/qr`);
    $('#qrImg').src = q.dataUrl;
    $('#shareUrl').textContent = q.url;
  } catch { /* QR facultatif */ }
  showScreen('done');
  setTimer('idleReturn', goIdle, (state.boot.booth.idleReturnSec || 20) * 1000);
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
  const pin = await askPin('Code admin');
  if (pin === null) return;
  try {
    await api('/api/admin/login', { method: 'POST', body: { pin } });
    location.href = '/admin.html';
  } catch (e) {
    toast(e.message);
  }
}

// ---------- WebSocket : config, compteurs, impression ----------

// ---------- Stream Deck : les boutons de l'écran en cours, reproduits sur les touches ----------
// La borne décrit ses actions visibles au serveur (qui les dessine), et exécute les appuis reçus
// comme des clics. Même chemin que le tactile : aucune logique propre au Stream Deck.

function deckKind(el) {
  if (el.classList.contains('template-card') || el.classList.contains('retake-thumb')) return 'choice';
  if (el.classList.contains('btn-primary') || el.classList.contains('key-ok')) return 'primary';
  if (el.classList.contains('btn-secondary')) return 'secondary';
  return 'ghost';
}

// Pictogramme par bouton, dessiné par le serveur sur la touche.
const DECK_ICONS = {
  btnStart: 'camera', btnCancel: 'x', pinCancel: 'x', btnTemplateBack: 'back', btnKeep: 'check', btnRetake: 'retake',
  btnPrint: 'printer', btnNoPrint: 'qr', btnFinish: 'home', btnMinus: 'minus', btnPlus: 'plus'
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
  try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); el.dataset.deckThumb = c.toDataURL('image/jpeg', 0.75); } catch { return null; }
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
function deckStyle(el) {
  const page = solid(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || getComputedStyle(document.body).backgroundColor, '#000');
  const cs = getComputedStyle(el);
  const bg = solid(cs.backgroundColor, page);
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

function visible(el) {
  return !!el && !el.classList.contains('hidden') && el.offsetParent !== null;
}

/** Actions de l'écran en cours, dans l'ordre d'affichage. */
function deckItems() {
  const dlg = $('#pinDialog');
  const root = dlg.open ? dlg : $('.screen.active');
  if (!root) return [];
  if (root.id === 'screen-idle') return [{ id: 'start', label: 'Commencer', kind: 'primary', icon: 'camera', style: deckStyle($('#btnStart')) }];
  const items = [];
  const cd = $('#countdown');
  if (root.id === 'screen-capture' && visible(cd) && cd.textContent) {
    const page = deckStyle(document.body).page;
    items.push({ id: 'countdown', label: cd.textContent, kind: 'display', display: true, style: { bg: page, fg: solid(getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(), page), border: null } });
  }
  let n = 0;
  for (const el of root.querySelectorAll('button, #copiesValue')) {
    if (!visible(el) || el.classList.contains('link')) continue;
    if (el.id === 'copiesValue') {
      const st = deckStyle(el);
      items.push({ id: 'copies', label: el.textContent, kind: 'display', display: true, style: { bg: st.page, fg: st.fg, border: null } });
      continue;
    }
    if (!el.dataset.deck) el.dataset.deck = el.id || `deck-${Date.now().toString(36)}-${n++}`;
    const glyph = { minus: '−', plus: '+' }[el.dataset.icon]; // boutons dont l'icône est dessinée en CSS
    const label = glyph || (el.querySelector('.template-name, span')?.textContent || el.textContent || el.getAttribute('aria-label') || '').trim();
    const image = el.classList.contains('template-card') || el.classList.contains('retake-thumb') ? deckThumb(el) : null;
    const icon = DECK_ICONS[el.id] || { del: 'delete', ok: 'check' }[el.dataset.k] || null; // pavé du code : ⌫ et OK en pictogrammes
    items.push({ id: el.dataset.deck, label: label || '•', kind: deckKind(el), disabled: el.disabled, icon, image, style: deckStyle(el) });
  }
  return items;
}

function startDeckSync() {
  let last = '';
  setInterval(() => {
    const ws = state.ws;
    if (!ws || ws.readyState !== 1 || !state.boot) return;
    const ui = { type: 'ui', screen: $('#pinDialog').open ? 'pin' : state.screen, items: deckItems(), colors: state.boot.theme.colors, page: deckStyle(document.body).page };
    const sig = JSON.stringify(ui);
    if (sig === last && !state.deckResend) return;
    last = sig;
    state.deckResend = false;
    ws.send(sig);
  }, 250);
}

function onDeckPress(id) {
  if (id === 'start') { if (state.screen === 'idle') onIdleTap(); return; }
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
    if (msg.type === 'config') {
      if (state.screen === 'idle') reloadBoot().catch(() => {});
      else state.pendingConfigReload = true;
    } else if (msg.type === 'counters') {
      if (state.boot) state.boot.counters = msg.counters;
    } else if (msg.type === 'live') {
      state.liveStreaming = !!msg.streaming; // ouvre ou referme l'obturateur dessiné sur l'aperçu
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
  $('#btnTemplateBack').addEventListener('click', goIdle);
  $('#btnStart').addEventListener('click', () => runCountdown(state.currentShot));
  $('#btnCancel').addEventListener('click', goIdle);
  $('#btnRetake').addEventListener('click', onRetakeClick);
  $('#btnKeep').addEventListener('click', keepPhoto);
  $('#btnMinus').addEventListener('click', () => { state.copies = Math.max(1, state.copies - 1); renderCopies(); });
  $('#btnPlus').addEventListener('click', () => { state.copies = Math.min(state.maxCopies, state.copies + 1); renderCopies(); });
  $('#btnPrint').addEventListener('click', () => doPrint(state.copies));
  $('#btnNoPrint').addEventListener('click', () => doPrint(0));
  $('#btnOperator').addEventListener('click', operatorUnlock);
  $('#btnFinish').addEventListener('click', goIdle);

  // Zone invisible en haut à droite : 5 appuis en 3 s ouvrent l'admin.
  let taps = [];
  $('#adminHotspot').addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 3000);
    taps.push(now);
    if (taps.length >= 5) { taps = []; adminAccess(); }
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', () => { if (state.screen === 'capture') fitCanvas(); });
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
