/* Page d'administration : réglages, thème, templates (éditeur de calques), compteurs, sessions. */
import { renderTemplate, loadAssets, loadImage } from './template-render.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = null; // état complet renvoyé par /api/admin/state
let prevSection = null;

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* vide */ }
  if (!res.ok) { const e = new Error(data?.message || `Erreur ${res.status}`); e.status = res.status; e.code = data?.error; throw e; }
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function saveConfig(patch, okMsg = 'Enregistré') {
  try {
    const r = await api('/api/admin/config', { method: 'PUT', body: patch });
    S.config = r.config;
    toast(okMsg);
    await refresh();
  } catch (e) { toast(e.message, true); }
}

async function refresh() {
  S = await api('/api/admin/state');
  render();
}

/** L'icône de l'onglet suit le logo de la borne (changé dans Apparence). */
function syncFavicon() {
  if (S?.theme?.logo) document.getElementById('favicon')?.setAttribute('href', S.theme.logo);
}

// ---------- Photos d'exemple (aperçus, éditeur) ----------

const sampleCache = {};
async function sampleImages() {
  const urls = S.samples || [];
  await Promise.all(urls.map(async (u, i) => { if (!sampleCache[i]) sampleCache[i] = await loadImage(u); }));
  return urls.map((_, i) => sampleCache[i]).filter(Boolean);
}
function photosFromSamples(template, samples) {
  const photos = {};
  if (!samples.length) return photos;
  for (let i = 0; i < template.shots; i++) photos[i] = samples[i % samples.length];
  return photos;
}

// ---------- Sections ----------

function deckState() {
  const d = S.streamDeck || {};
  if (!d.enabled) return '<span class="badge">désactivé</span>';
  if (d.connected) return `<span class="badge ok">${esc(d.model)} connecté</span> <small>${d.keys} touches</small>`;
  return `<span class="badge">aucun Stream Deck</span>${d.error ? ` <small>${esc(d.error)}</small>` : ' <small>recherché toutes les 3 s</small>'}`;
}

/** Le flash est-il parti sur la dernière photo ? (EXIF, le boîtier ne dit rien de fiable avant) */
function flashState() {
  const c = S.camera || {};
  if (c.flashFired == null) return '<span class="badge">inconnu</span> <small>connu après la première photo</small>';
  const at = c.flashFiredAt ? ` <small>photo de ${new Date(c.flashFiredAt).toLocaleTimeString('fr-FR')}</small>` : '';
  return c.flashFired
    ? `<span class="badge warn">parti sur la dernière photo</span>${at}`
    : `<span class="badge">pas parti sur la dernière photo</span>${at}`;
}

function dashboard() {
  const c = S.counters;
  const cfg = S.config;
  const stat = (v, l, cls = '') => `<div class="stat ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  return `
  <h2>Tableau de bord</h2>
  <p class="sub">Événement en cours : <b>${esc(c.eventName)}</b> · <a href="#sessions">changer ou en créer un</a></p>
  <div class="grid">
    ${stat(c.printed, 'tirages imprimés')}
    ${stat(c.quotaRemaining === null ? '∞' : c.quotaRemaining, 'quota restant', c.quotaReached ? 'err' : '')}
    ${stat(c.paperRemaining === null ? '—' : c.paperRemaining, 'feuilles restantes', c.lowPaper ? 'warn' : '')}
    ${stat(c.sessions, 'sessions')}
  </div>
  <div class="grid-2" style="margin-top:22px">
    <div class="card">
      <h3>Matériel</h3>
      <p>Caméra <code>${esc(S.camera.driver)}</code> <span class="badge ${S.camera.ok ? 'ok' : 'err'}">${S.camera.ok ? 'OK' : 'problème'}</span>${S.camera.standby ? ' <small>live view en veille, obturateur fermé</small>' : ''}${S.camera.driver === 'gphoto2' ? `<br><small>Flash : ${flashState()}</small>` : ''}${S.devices.camera.requested === 'auto' ? `<br><small>auto · ${esc(S.devices.camera.reason)}</small>` : ''}${S.camera.lastError ? `<br><small>${esc(S.camera.lastError)}</small>` : ''}${S.camera.lastCaptureError ? `<br><small><b>Dernier échec de photo</b> (${new Date(S.camera.lastCaptureError.at).toLocaleTimeString('fr-FR')}) : ${esc(S.camera.lastCaptureError.message)}</small>` : ''}</p>
      <p>Imprimante <code>${esc(S.printer.driver)}</code> <span class="badge ${S.printer.ok ? 'ok' : 'err'}">${S.printer.ok ? 'OK' : 'problème'}</span>${S.devices.printer.requested === 'auto' ? `<br><small>auto · ${esc(S.devices.printer.reason)}</small>` : ''}<br><small>${esc(S.printer.message)}</small></p>
      ${S.devices.network ? `<p>Wi-Fi <span class="badge ${S.devices.network.wifi ? 'ok' : 'err'}">${S.devices.network.wifi ? 'connecté' : 'absent'}</span><br><small>${S.devices.network.wifi ? `${esc(S.devices.network.iface)} · ${esc(S.devices.network.ip)}` : S.config.share.requireWifi === false ? 'QR codes affichés quand même (réglage <a href="#sharing">Partage</a>)' : 'QR codes des photos masqués'}</small></p>` : ''}
      <p>Stream Deck ${deckState()}</p>
      <p>Partage : <code>${esc(S.shareBaseUrl)}</code></p>
    </div>
    <div class="card">
      <h3>Consommables</h3>
      <label>Feuilles chargées dans l'imprimante
        <div class="row"><input id="paperInput" type="number" min="0" value="${c.paperRemaining ?? ''}" placeholder="non suivi" style="width:140px">
        <button class="btn secondary" id="btnPaper">Mettre à jour</button>
        <button class="btn" id="btnPaperOff">Ne plus suivre</button></div>
      </label>
      <label>Compteur de tirages de l'événement
        <div class="row"><button class="btn danger" id="btnResetPrinted">Remettre à zéro (${c.printed})</button></div>
      </label>
      <label>Sessions de l'événement
        <div class="row"><button class="btn danger" id="btnResetSessions" ${c.sessions ? '' : 'disabled'}>Réinitialiser les sessions (${c.sessions})</button></div>
        <small>Supprime toutes les sessions et leurs photos, remet le compteur à zéro. L'historique des tirages est conservé.</small>
      </label>
      <small>Quota configuré : ${cfg.limits.eventQuota || 'illimité'} · alerte papier sous ${cfg.limits.lowPaperThreshold} feuilles</small>
    </div>
  </div>`;
}

const sel = (name, list, cur) => `<select name="${name}">${list.map((d) => `<option value="${d}" ${cur === d ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
const when = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR') : '—');
const det = (d) => `<div class="detect"><b>${esc(d.driver)}</b> <small>· ${esc(d.reason)} · vérifié à ${when(d.checkedAt)}</small></div>`;

function flow() {
  const l = S.config.limits;
  const b = S.config.booth;
  return `
  <h2>Parcours invité</h2>
  <p class="sub">Le déroulé d'un passage à la borne, de l'accueil à la fin, et la galerie de l'événement.</p>
  <form id="formFlow" class="card">
    <div class="grid-2">
      <div>
        <h3>Séance photo</h3>
        <label>Décompte avant la photo (secondes) <input name="countdownSec" type="number" min="1" max="10" value="${l.countdownSec}"></label>
        <label>Reprises de photo autorisées (0 = aucune)
          <div class="row"><input name="maxRetakesPerSession" type="number" min="0" max="50" value="${Math.max(0, l.maxRetakesPerSession)}" ${l.maxRetakesPerSession < 0 ? 'disabled' : ''} style="width:120px">
          <label class="inline"><input name="retakesUnlimited" type="checkbox" ${l.maxRetakesPerSession < 0 ? 'checked' : ''} onchange="this.form.maxRetakesPerSession.disabled = this.checked"> Illimité</label></div>
        </label>
        <label>Validation automatique de la relecture (secondes, 0 = jamais) <input name="reviewTimeoutSec" type="number" min="0" max="300" value="${l.reviewTimeoutSec}"></label>
        <label class="inline"><input name="mirrorPreview" type="checkbox" ${b.mirrorPreview ? 'checked' : ''}> Aperçu en miroir (plus naturel pour l'invité)</label>
        <small>La photo finale est retournée elle aussi : chacun reste là où il s'est vu par rapport aux éléments du template. Un texte dans la scène (t-shirt, pancarte) sort à l'envers.</small>
      </div>
      <div>
        <h3>Retours automatiques à l'accueil</h3>
        <label>Personne ne lance la photo (secondes, 0 = jamais) <input name="captureTimeoutSec" type="number" min="0" max="600" value="${l.captureTimeoutSec ?? 30}"></label>
        <label>Choix du cadre et galerie sans interaction (secondes, 0 = jamais) <input name="menuIdleSec" type="number" min="0" max="600" value="${b.menuIdleSec ?? 30}"></label>
        <label>Après l'écran final (secondes) <input name="idleReturnSec" type="number" min="5" max="300" value="${b.idleReturnSec}"></label>
        <small>Un toucher, une touche du clavier ou du Stream Deck repousse le retour.</small>
      </div>
    </div>
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>
  ${galleryCard()}`;
}

function printing() {
  const cfg = S.config;
  const l = cfg.limits;
  return `
  <h2>Impression</h2>
  <p class="sub">Sans imprimante détectée, la borne n'affiche rien de l'impression : l'invité termine directement (avec le QR code en Wi-Fi). Les changements s'appliquent sans redémarrage.</p>
  <form id="formPrinter" class="card">
    <h3>Imprimante</h3>
    <div class="grid-2">
      <div>
        <label>Pilote ${sel('printerDriver', S.drivers.printer, cfg.printer.driver)}</label>
        <small><b>auto</b> : la file CUPS ci-contre si l'imprimante répond, sinon le repli. <b>cups</b> : commande <code>lp</code> (Linux + Gutenprint, ou macOS). <b>mock</b> : simulation, écrit le fichier dans <code>output/prints</code>. <b>none</b> : pas d'impression.</small>
        <label>Repli quand l'imprimante est absente ${sel('printerFallback', S.drivers.printerFallbacks, cfg.printer.fallback || 'none')}</label>
        <label>En ce moment ${det(S.devices.printer)}</label>
      </div>
      <div>
        <label>Nom de la file CUPS (obligatoire en auto, pour ne jamais imprimer ailleurs) <input name="cupsName" value="${esc(cfg.printer.cups.name)}" placeholder="DNP_DS-RX1"></label>
        <label>Options lp, une par ligne (passées avec -o) <textarea name="cupsOptions">${esc((cfg.printer.cups.options || []).join('\n'))}</textarea></label>
        <label>Délai simulé de l'imprimante mock (ms) <input name="mockDelayMs" type="number" min="0" value="${cfg.printer.mockDelayMs}"></label>
      </div>
    </div>
    <div class="row">
      <button class="btn primary" type="submit">Enregistrer</button>
      <button class="btn btn-detect" type="button">Détecter maintenant</button>
    </div>
  </form>
  <form id="formPrintLimits" class="card">
    <h3>Limites</h3>
    <div class="grid-2">
      <div>
        <label>Copies maximum par passage <input name="maxCopiesPerSession" type="number" min="1" max="50" value="${l.maxCopiesPerSession}"></label>
        <label>Copies maximum avec le code opérateur <input name="operatorMaxCopies" type="number" min="1" max="100" value="${l.operatorMaxCopies}"></label>
        <label class="inline"><input name="allowZeroCopies" type="checkbox" ${l.allowZeroCopies ? 'checked' : ''}> L'invité peut terminer sans imprimer</label>
        <small>Bouton « ${esc(cfg.texts.noPrint)} » sur l'écran des copies, quand une imprimante est branchée. Décoché : au moins un tirage par passage.</small>
      </div>
      <div>
        <label>Quota de tirages de l'événement (0 = illimité) <input name="eventQuota" type="number" min="0" value="${l.eventQuota}"></label>
        <label>Alerte papier en dessous de (feuilles) <input name="lowPaperThreshold" type="number" min="0" value="${l.lowPaperThreshold}"></label>
        <small>Le stock de papier se met à jour depuis le tableau de bord.</small>
      </div>
    </div>
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>`;
}

function themeSection() {
  const cfg = S.config;
  const custom = cfg.theme.custom;
  const colors = custom.colors;
  const logo = S.theme.logo;
  const bg = S.theme.backgroundImage;
  const options = S.themes.map((t) => `<option value="${esc(t.id)}" ${cfg.theme.active === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  // Nom de la couleur, puis où elle apparaît sur la borne
  const colorField = (k, label, where) => `<label class="swatch"><span>${label}</span><input type="color" name="color_${k}" value="${esc(colors[k])}"><small>${where}</small></label>`;
  const textFields = Object.entries(cfg.texts).map(([k, v]) => `<label>${esc(k)}<input name="text_${k}" value="${esc(v)}"></label>`).join('');
  return `
  <h2>Apparence</h2>
  <p class="sub">Le nom, le logo et l'image de fond s'appliquent quel que soit le thème. Les changements arrivent sur la borne en direct.</p>
  <form id="formTheme" class="card">
    <div class="grid-2">
      <div>
        <h3>Identité de la borne</h3>
        <label>Nom de la borne <input name="boothName" value="${esc(cfg.booth.name)}"></label>
        <label class="inline"><input name="showName" type="checkbox" ${cfg.booth.showName !== false ? 'checked' : ''}> Afficher le nom à côté du logo sur la borne</label>
        <h3 style="margin-top:18px">Couleurs</h3>
        <label>Thème actif <select name="active">${options}<option value="custom" ${cfg.theme.active === 'custom' ? 'selected' : ''}>Personnalisé (couleurs ci-contre)</option></select></label>
      </div>
      <div>
        <h3>Couleurs personnalisées</h3>
        <div class="swatches">
          ${colorField('primary', 'Accent', 'Boutons principaux, décompte, cercle de l\'accueil')}
          ${colorField('onPrimary', 'Texte des boutons', 'Écrit sur la couleur d\'accent')}
          ${colorField('secondary', 'Titres', 'Titres, nom de la borne, logo SVG, nombre de copies')}
          ${colorField('background', 'Fond d\'écran', 'Arrière-plan de tous les écrans')}
          ${colorField('surface', 'Cartes', 'Cadres à choisir, photos de la galerie, pavé du code')}
          ${colorField('text', 'Texte courant', 'Consignes, boutons secondaires')}
        </div>
        <label>Police <select name="font">
          ${['system', 'rounded', 'serif'].map((f) => `<option value="${f}" ${custom.font === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select></label>
        <small>Ces couleurs sont utilisées quand le thème actif est « Personnalisé ».</small>
        <div id="themePreview" class="preview-theme" style="background:${esc(colors.background)};color:${esc(colors.text)}">
          <img class="logo-prev" src="${esc(logo)}" alt="">
          <span style="font-weight:800;color:${esc(colors.secondary)}">${esc(cfg.booth.name)}</span>
          <span class="pbtn" style="background:${esc(colors.primary)};color:${esc(colors.onPrimary)}">Bouton</span>
          <span class="pbtn pbtn-outline" style="border-color:${esc(colors.secondary)};color:${esc(colors.secondary)}">Refaire</span>
          <span id="contrastWarn" class="badge warn hidden">contraste faible</span>
        </div>
      </div>
    </div>
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>
  <div class="grid-2">
    <form id="formLogo" class="card upload-card">
      <h3>Logo (PNG transparent, SVG, JPEG)</h3>
      <div class="upload-current"><img class="logo-prev" src="${esc(logo)}" alt=""><small>Affiché en haut à gauche et sur l'accueil, pour tous les thèmes.</small></div>
      <input type="file" name="logo" accept="image/png,image/svg+xml,image/jpeg,image/webp" required>
      <div class="row"><button class="btn secondary" type="submit">Envoyer</button>
      ${cfg.booth.logo ? '<button class="btn" type="button" id="btnLogoReset">Logo par défaut</button>' : ''}</div>
    </form>
    <form id="formBg" class="card upload-card">
      <h3>Image de fond (optionnelle)</h3>
      <div class="upload-current">${bg ? `<img class="logo-prev" src="${esc(bg)}" alt="">` : ''}<small>Actuelle : <code>${esc(bg || 'aucune')}</code></small></div>
      <input type="file" name="image" accept="image/png,image/jpeg,image/webp" required>
      <div class="row"><button class="btn secondary" type="submit">Envoyer</button>
      ${cfg.booth.backgroundImage ? '<button class="btn" type="button" id="btnBgReset">Retirer</button>' : ''}</div>
    </form>
  </div>
  <form id="formTexts" class="card">
    <h3>Textes des écrans</h3>
    <div class="grid">${textFields}</div>
    <button class="btn primary" type="submit">Enregistrer les textes</button>
  </form>`;
}

function templatesSection() {
  const cfg = S.config.templates;
  const formatOptions = (sel) => Object.entries(S.formats).map(([k, f]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(f.name)} · ${f.width}×${f.height}</option>`).join('');
  const cards = S.templates.map((t) => `
    <div class="card tpl-card">
      <canvas class="tpl-preview" data-tpl="${esc(t.id)}" width="${Math.round(t.width * (160 / Math.max(t.width, t.height)))}" height="${Math.round(t.height * (160 / Math.max(t.width, t.height)))}"></canvas>
      <div class="tpl-meta">
        <strong>${esc(t.name)}</strong> <code>${esc(t.id)}</code><br>
        ${t.format && S.formats[t.format] ? esc(S.formats[t.format].name) : `${t.width} × ${t.height} px`} · ${t.shots} photo${t.shots > 1 ? 's' : ''} · ${t.layers.length} calque${t.layers.length > 1 ? 's' : ''}<br><br>
        <div class="row">
          <a class="btn secondary small" href="#editor=${encodeURIComponent(t.id)}">Modifier</a>
          <label class="inline"><input type="checkbox" data-enable="${esc(t.id)}" ${cfg.enabled.includes(t.id) ? 'checked' : ''}> Activé</label>
          <label class="inline"><input type="radio" name="defaultTpl" value="${esc(t.id)}" ${cfg.default === t.id ? 'checked' : ''}> Par défaut</label>
          <button class="btn danger small" data-del="${esc(t.id)}">Supprimer</button>
        </div>
      </div>
    </div>`).join('');
  return `
  <h2>Templates</h2>
  <p class="sub">Un template est une pile de calques (photos, textes, images, formes) posés sur le tirage. Créez-le avec un nom, puis composez-le dans l'éditeur.</p>
  <form id="formNewTemplate" class="card">
    <h3>Nouveau template</h3>
    <div class="row">
      <label style="flex:1;min-width:220px">Nom <input name="name" required placeholder="Mariage Julie & Marc"></label>
      <label>Format <select name="format">${formatOptions(cfg.defaultFormat || S.defaultFormat)}</select></label>
      <button class="btn primary" type="submit">Créer et ouvrir l'éditeur</button>
    </div>
    <details><summary>Avancé : partir d'un PNG complet (cadre créé dans Canva ou Photoshop)</summary>
      <label>PNG avec transparence, à la taille du format <input type="file" name="overlay" accept="image/png"></label>
    </details>
  </form>
  <div class="card">
    <div class="row">
      <label class="inline"><input id="guestCanChoose" type="checkbox" ${cfg.guestCanChoose ? 'checked' : ''}> L'invité choisit son template (sinon le template par défaut est imposé)</label>
      <span class="sep"></span>
      <label class="inline">Format par défaut <select id="defaultFormat">${formatOptions(cfg.defaultFormat || S.defaultFormat)}</select></label>
    </div>
  </div>
  ${cards || '<p class="sub">Aucun template. Créez-en un ci-dessus.</p>'}`;
}

function hardware() {
  const cfg = S.config;
  const g = cfg.camera.gphoto2;
  return `
  <h2>Matériel</h2>
  <p class="sub">Les changements s'appliquent immédiatement, sans redémarrage. En mode <b>auto</b>, la borne surveille le matériel toutes les 10 secondes et bascule toute seule quand un appareil est branché ou débranché. L'imprimante se règle dans <a href="#printing">Impression</a>.</p>
  <form id="formCamera" class="card">
    <h3>Caméra</h3>
    <div class="grid-2">
      <div>
        <label>Pilote ${sel('cameraDriver', S.drivers.camera, cfg.camera.driver)}</label>
        <small><b>auto</b> : boîtier gphoto2 s'il est branché, sinon le repli ci-dessous. <b>browser</b> : webcam du navigateur (Mac, ou webcam USB sur la borne). <b>mock</b> : photos d'exemple. <b>gphoto2</b> : Canon EOS en USB.</small>
        <label>Repli quand aucun boîtier n'est détecté ${sel('cameraFallback', S.drivers.cameraFallbacks, cfg.camera.fallback || 'browser')}</label>
        <label>En ce moment ${det(S.devices.camera)}</label>
        <label>Position de l'objectif par rapport à l'écran <select name="lensPosition">${[['top', 'Au-dessus'], ['bottom', 'En dessous'], ['left', 'À gauche'], ['right', 'À droite']].map(([v, lb]) => `<option value="${v}" ${(cfg.booth.lensPosition || 'top') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select><small>Oriente la flèche « Regardez l'objectif » affichée juste avant la photo (gauche / droite vues par l'invité)</small></label>
      </div>
      <div>
        ${S.camera.flashControl === false ? `
        <label>Flash intégré ${flashState()}</label>
        <small>Le ${esc(S.camera.model || 'boîtier')} ne lève pas son flash par USB, n'indique pas sa position avant la photo et ne permet pas d'empêcher un flash levé de partir : c'est sa position qui décide, et la borne le constate sur chaque photo. Levé = à chaque photo, rabattu = jamais. Pour l'interdire même levé : menu du boîtier, contrôle du flash, émission de l'éclair désactivée.</small>` : `
        <label>Flash intégré ${sel('flash', ['off', 'on', 'auto'], g.flash || 'off')}</label>
        <div class="row"><label>Seuil du mode auto (luminosité 0-255, flash levé en dessous) <input name="flashAutoThreshold" type="number" min="0" max="255" value="${g.flashAutoThreshold ?? 60}" style="width:120px"></label></div>
        <small><b>off</b> : la borne ne lève jamais le flash. <b>on</b> : levé par USB avant chaque photo. <b>auto</b> : levé si la scène est sombre d'après le live view${S.camera.sceneLuma != null ? ` (luminosité actuelle : ${S.camera.sceneLuma}/255)` : ''}. Une fois levé, le flash intégré ne se rabat qu'à la main. État actuel : ${flashState()}.${S.camera.lastFlashError ? ` <b>Dernière levée refusée par le boîtier : ${esc(S.camera.lastFlashError)}</b>` : ''}</small>`}
        <label>Coupure du live view quand l'aperçu n'est plus affiché (secondes) <input name="liveIdleSec" type="number" min="0" step="1" value="${Math.round((g.liveIdleMs ?? 8000) / 1000)}"></label>
        <small>Hors prise de vue, l'obturateur du boîtier est refermé : capteur et batterie au repos. Le live redémarre dès qu'un invité touche l'écran.</small>
      </div>
    </div>
    <details>
      <summary>Réglages avancés du boîtier (commandes gphoto2)</summary>
      <label class="inline"><input name="liveview" type="checkbox" ${g.liveview ? 'checked' : ''}> Aperçu live via gphoto2</label>
      <label>Commande de live view <input name="liveviewCommand" value="${esc(g.liveviewCommand)}"></label>
      <label>Pause après arrêt du live avant capture (ms) <input name="settleMs" type="number" min="0" value="${g.settleMs}"></label>
      <label>Commande exécutée quand le boîtier est détecté (vide = rien) <input name="setupCommand" value="${esc(g.setupCommand ?? '')}"></label>
      <small>Réglages à pousser au boîtier. Attention : le 2000D accepte <code>autopoweroff=0</code> sans en tenir compte, l'arrêt automatique se désactive dans son menu.</small>
      <label>Décompte : mise au point puis déclenchement programmé, en une commande (<code>{wait}</code> = ms avant le déclenchement, <code>{file}</code> = fichier ; vide = tout se fait à « 0 ») <textarea name="armFireCommand">${esc(g.armFireCommand ?? '')}</textarea></label>
      <small>Index <code>eosremoterelease</code> sur un EOS : 1 demi-pression avec AF · 2 pression complète avec AF · 3 demi-pression sans AF · 4 pression complète sans AF · 5 relâcher à moitié · 6 relâcher complètement.</small>
      <label>Commande de capture sans préparation (<code>{file}</code> = fichier de sortie) <textarea name="captureCommand">${esc(g.captureCommand)}</textarea></label>
    </details>
    <div class="row">
      <button class="btn primary" type="submit">Enregistrer</button>
      <button class="btn btn-detect" type="button">Détecter maintenant</button>
    </div>
  </form>
  <form id="formDeck" class="card">
    <h3>Stream Deck</h3>
    <label class="inline"><input name="deckEnabled" type="checkbox" ${(cfg.booth.streamDeck?.enabled ?? true) ? 'checked' : ''}> Utiliser un Stream Deck Elgato branché en USB comme télécommande</label>
    <div class="grid-2">
      <label>Position du Stream Deck par rapport à l'écran <select name="deckPosition">${[['bottom', 'En dessous'], ['top', 'Au-dessus'], ['left', 'À gauche'], ['right', 'À droite']].map(([v, lb]) => `<option value="${v}" ${(cfg.booth.streamDeck?.position || 'bottom') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select><small>Écran non tactile : l'accueil affiche une flèche vers le Stream Deck (gauche / droite vues par l'invité)</small></label>
      <label>Luminosité des touches (%) <input name="deckBrightness" type="number" min="10" max="100" value="${cfg.booth.streamDeck?.brightness ?? 70}" style="width:120px"></label>
    </div>
    <label>En ce moment ${deckState()}</label>
    <small>Les touches reprennent les boutons de l'écran affiché, aux couleurs du thème, y compris le pavé du code opérateur. Branché, il pilote aussi la galerie de la borne (autant de photos par page que de touches). Sur Mac, quitter l'application Stream Deck d'Elgato, qui réserve l'appareil.</small>
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>`;
}

// Événement affiché dans la section Sessions : #sessions=<id> (par défaut l'événement en cours)
function selectedEventId() {
  const m = location.hash.match(/^#sessions=(.+)$/);
  const id = m ? decodeURIComponent(m[1]) : S.activeEventId;
  return S.events.some((e) => e.id === id) ? id : S.activeEventId;
}

// Sessions d'un autre événement que celui en cours : chargées à la demande
let eventSessions = null; // { id, sessions }
async function loadEventSessions(id) {
  try {
    const r = await api(`/api/admin/events/${encodeURIComponent(id)}/sessions`);
    eventSessions = { id, sessions: r.sessions };
  } catch (e) { toast(e.message, true); eventSessions = { id, sessions: [] }; }
  if (currentSection() === 'sessions' && selectedEventId() === id) render();
}

const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const frDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function sessions() {
  const selId = selectedEventId();
  const ev = S.events.find((e) => e.id === selId);
  let list = null;
  if (selId === S.activeEventId) list = S.sessions;
  else if (eventSessions?.id === selId) list = eventSessions.sessions;
  else loadEventSessions(selId);

  const folders = S.events.map((e) => `
    <a class="folder ${e.id === selId ? 'selected' : ''}" href="#sessions=${encodeURIComponent(e.id)}">
      <span class="folder-name">${esc(e.name)}${e.active ? ' <span class="badge ok">en cours</span>' : ''}</span>
      <small>${esc(frDate(e.date))}</small>
      <small>${plural(e.sessions, 'session')} · ${plural(e.photos, 'photo')} · ${plural(e.printed || 0, 'tirage')}</small>
    </a>`).join('');

  const moveOptions = (s) => S.events.map((e) => `<option value="${esc(e.id)}" ${e.id === s.eventId ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
  const rows = (list || []).map((s) => `
    <tr>
      <td>${s.final ? `<img class="thumb" src="${esc(s.final.thumbUrl)}" alt="">` : '<div class="thumb"></div>'}</td>
      <td><code>${esc(s.id)}</code><br><small>${new Date(s.createdAt).toLocaleString('fr-FR')}</small></td>
      <td>${esc(s.templateName)}</td>
      <td><span class="badge ${s.status === 'done' ? 'ok' : s.status === 'error' ? 'err' : ''}">${esc(s.status)}</span>${s.error ? `<br><small>${esc(s.error)}</small>` : ''}</td>
      <td>${s.copies}</td>
      <td>${S.events.length > 1 ? `<select class="small" data-move="${esc(s.id)}" title="Déplacer vers un autre événement">${moveOptions(s)}</select>` : ''}</td>
      <td class="actions">${s.final ? `<button class="btn small secondary" data-reprint="${esc(s.id)}">Réimprimer</button> <a class="btn small" href="/g/${esc(s.id)}" target="_blank">Galerie</a> ` : ''}<button class="btn small danger" data-del-session="${esc(s.id)}" ${s.status === 'printing' ? 'disabled title="Impression en cours"' : ''}>Supprimer</button></td>
    </tr>`).join('');

  const exp = (content, label, n) => n
    ? `<a class="btn small secondary" href="/api/admin/events/${encodeURIComponent(ev.id)}/export?content=${content}" download>${label}</a>`
    : `<button class="btn small secondary" disabled>${label}</button>`;
  return `
  <h2>Événements &amp; photos</h2>
  <p class="sub">Un dossier par événement. Les nouvelles sessions vont dans l'événement <b>en cours</b>, qui porte aussi le quota et le compteur de tirages du tableau de bord.</p>
  <div class="folders">
    ${folders}
    <button class="folder new" id="btnNewEvent"><span class="folder-name">+ Nouvel événement</span><small>nom, date, et il devient l'événement en cours</small></button>
  </div>
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <h3 style="margin:0">${esc(ev.name)} ${ev.active ? '<span class="badge ok">en cours</span>' : ''}</h3>
        <small>${esc(frDate(ev.date))} · ${plural(ev.sessions, 'session')} · ${plural(ev.photos, 'photo originale', 'photos originales')} · ${plural(ev.finals, 'montage')} · ${plural(ev.printed || 0, 'tirage')}</small>
      </div>
      <div class="row">
        ${ev.active ? '' : `<button class="btn small" id="btnActivateEvent">Définir comme événement en cours</button>`}
        <button class="btn small" id="btnEditEvent">Renommer / changer la date</button>
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <b>Exporter (ZIP)</b>
      ${exp('originals', `Photos originales (${ev.photos})`, ev.photos)}
      ${exp('finals', `Montages avec template (${ev.finals})`, ev.finals)}
      ${exp('both', 'Les deux', ev.photos + ev.finals)}
    </div>
    <table style="margin-top:14px">
      <thead><tr><th></th><th>Session</th><th>Template</th><th>Statut</th><th>Copies</th><th>Événement</th><th></th></tr></thead>
      <tbody>${list === null ? '<tr><td colspan="7">Chargement…</td></tr>' : rows || '<tr><td colspan="7">Aucune session dans cet événement.</td></tr>'}</tbody>
    </table>
    <div class="row" style="margin-top:18px">
      <button class="btn danger" id="btnResetSessions" ${ev.sessions ? '' : 'disabled'}>Vider l'événement (${plural(ev.sessions, 'session')})</button>
      ${ev.active ? '<small>L\'événement en cours ne peut pas être supprimé : activez-en un autre d\'abord.</small>' : `<button class="btn danger" id="btnDeleteEvent">Supprimer l'événement</button>`}
    </div>
  </div>`;
}

/** Vide un événement (en cours par défaut) : sessions, photos et compteur de tirages. */
async function resetSessions(eventId = S.activeEventId) {
  const ev = S.events.find((e) => e.id === eventId);
  const n = ev.sessions;
  if (!confirm(`Supprimer les ${n} session${n > 1 ? 's' : ''} de « ${ev.name} » et leurs photos, et remettre son compteur de tirages à zéro ?\nCette action est irréversible.`)) return;
  try {
    const r = await api('/api/admin/sessions/reset', { method: 'POST', body: { eventId } });
    eventSessions = null;
    toast(`${r.removed} session${r.removed > 1 ? 's' : ''} supprimée${r.removed > 1 ? 's' : ''}`);
    refresh();
  } catch (e) { toast(e.message, true); }
}

function sharing() {
  const cfg = S.config;
  const n = S.devices.network;
  return `
  <h2>Partage</h2>
  <p class="sub">Les invités récupèrent leur photo en scannant un QR code avec leur téléphone.${n ? ` Wi-Fi de la borne : <span class="badge ${n.wifi ? 'ok' : 'err'}">${n.wifi ? `connecté (${esc(n.ip)})` : 'absent'}</span>` : ''}</p>
  <form id="formShare" class="card">
    <div class="grid-2">
      <div>
        <h3>QR code des photos</h3>
        <label class="inline"><input name="qrOnDone" type="checkbox" ${cfg.share.qrOnDone !== false ? 'checked' : ''}> QR code sur l'écran de fin</label>
        <small>Décoché : pas d'écran de fin, la borne revient à l'accueil avec le texte « thanksNoQr » (Apparence) en bandeau.</small>
        <label class="inline"><input name="requireWifi" type="checkbox" ${cfg.share.requireWifi !== false ? 'checked' : ''}> QR codes seulement si la borne est en Wi-Fi</label>
        <small>Décoché : QR codes affichés même sans Wi-Fi (borne en Ethernet sur un réseau que les téléphones joignent).</small>
      </div>
      <div>
        <h3>Adresses</h3>
        <label>URL de base (vide = détection automatique : <code>${esc(S.shareBaseUrl)}</code>) <input name="shareBaseUrl" value="${esc(cfg.share.baseUrl)}" placeholder="http://photobooth.local:3000"></label>
        <small>Borne en hotspot Wi-Fi : mettez ici l'adresse que les invités atteignent.</small>
        <label>Adresse publique (facultative) <input name="publicUrl" value="${esc(cfg.share.publicUrl || '')}" placeholder="https://photobooth.domain.fr"></label>
        <small>Remplie : les QR codes de photo y mènent. Hors du Wi-Fi de la borne, la page distante (<code>npm run remote</code>) invite l'invité à s'y connecter, puis affiche sa photo. Voir TUTORIEL.md, étape 10.8.</small>
      </div>
    </div>
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>
  ${wifiCard()}`;
}

function security() {
  const cfg = S.config;
  return `
  <h2>Sécurité</h2>
  <form id="formCodes" class="card">
    <div class="grid-2">
      <div>
        <label>Code PIN admin <input name="adminPin" value="${esc(cfg.admin.pin)}" placeholder="vide = pas de code"></label>
        ${cfg.admin.pin ? '' : '<div class="alert">Aucun code admin : n\'importe qui peut ouvrir l\'admin. À remettre avant un événement.</div>'}
        <small>Sur la borne : 5 appuis en haut à droite de l'écran, ou sur le Stream Deck les touches du haut gauche, droite, gauche, droite, ouvrent l'admin.</small>
      </div>
      <div>
        <label>Code opérateur <input name="operatorPin" value="${esc(cfg.limits.operatorPin)}" required></label>
        <small>Sur la borne (écran ou Stream Deck) : lève la limite de copies et le quota, et autorise la réimpression depuis la galerie si elle est réglée ainsi.</small>
      </div>
    </div>
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>`;
}

function wifiCard() {
  const w = S.config.share.wifi || {};
  const open = w.security === 'nopass';
  return `
  <form id="formWifi" class="card">
    <h3>Wi-Fi de la borne (QR code permanent)</h3>
    <p class="sub">Un QR code en bas à droite de la borne, sur tous les écrans : le téléphone rejoint le hotspot en un scan (appareil photo d'iPhone et d'Android). Reprenez le nom et le mot de passe du hotspot créé sur la borne.</p>
    <div class="grid-2">
      <div>
        <label class="inline"><input name="enabled" type="checkbox" ${w.enabled ? 'checked' : ''}> Afficher le QR code Wi-Fi</label>
        <label>Nom du réseau (SSID) <input name="ssid" value="${esc(w.ssid)}" placeholder="PhotoBooth" autocomplete="off"></label>
      </div>
      <div>
        <label>Sécurité <select name="security" onchange="this.form.password.disabled = this.value === 'nopass'">
          <option value="WPA" ${open ? '' : 'selected'}>WPA / WPA2 (mot de passe)</option>
          <option value="nopass" ${open ? 'selected' : ''}>Réseau ouvert (sans mot de passe)</option>
        </select></label>
        <label>Mot de passe <input name="password" value="${esc(w.password)}" autocomplete="off" ${open ? 'disabled' : ''}></label>
      </div>
    </div>
    ${w.enabled && (!w.ssid || (!open && !w.password)) ? '<div class="alert">Nom du réseau ou mot de passe manquant : le QR code n\'est pas affiché.</div>' : ''}
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>`;
}

function galleryCard() {
  const g = S.config.gallery;
  const webUrl = `${S.shareBaseUrl}/galerie`;
  const reprint = [
    ['off', 'Désactivée : consultation seulement'],
    ['operator', 'Avec le code opérateur (lève aussi le quota)'],
    ['guest', 'Libre pour les invités (quota, papier et copies max appliqués)']
  ];
  return `
  <form id="formGallery" class="card">
    <h3>Galerie de l'événement</h3>
    <p class="sub">Les photos validées de l'événement en cours (<b>${esc(S.counters.eventName)}</b>), les plus récentes d'abord.</p>
    <div class="grid-2">
      <div>
        <label class="inline"><input name="booth" type="checkbox" ${g.booth ? 'checked' : ''}> Sur la borne : bouton « ${esc(S.config.texts.gallery)} » à l'accueil</label>
        <label>Réimpression depuis la galerie de la borne <select name="reprint">${reprint.map(([v, l]) => `<option value="${v}" ${g.reprint === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="inline"><input name="qr" type="checkbox" ${g.qr !== false ? 'checked' : ''}> QR code sur chaque photo de la galerie de la borne</label>
        <small>Copies par réimpression : ${S.config.limits.maxCopiesPerSession} au plus pour un invité, ${S.config.limits.operatorMaxCopies} avec le code opérateur (<a href="#printing">Impression</a>). Sans imprimante détectée, la réimpression n'apparaît pas.</small>
      </div>
      <div>
        <label class="inline"><input name="web" type="checkbox" ${g.web ? 'checked' : ''}> Sur les téléphones : page galerie et lien depuis la page du QR code</label>
        <small>${g.web ? 'Ouverte sur' : 'Adresse une fois activée :'} <code>${esc(webUrl)}</code>. Toute personne sur le même réseau voit alors toutes les photos de l'événement. Pas de réimpression depuis un téléphone.</small>
      </div>
    </div>
    <button class="btn primary" type="submit">Enregistrer</button>
  </form>`;
}

// ---------- Éditeur de template (calques) ----------

const E = { tpl: null, selected: null, dirty: false, samplesOn: true, scale: 1, dpr: 1, assets: new Map(), samples: [], drag: null, onResize: null };

const LAYER_LABEL = { photo: 'Photo', text: 'Texte', image: 'Image', rect: 'Forme' };
const layerTitle = (l) => l.name || (l.type === 'photo' ? `Photo ${l.shot + 1}` : l.type === 'text' ? `Texte « ${String(l.text || '').split('\n')[0].slice(0, 18)} »` : LAYER_LABEL[l.type]);
const editorId = () => decodeURIComponent(location.hash.replace(/^#editor=/, ''));
const selectedLayer = () => E.tpl?.layers.find((l) => l.id === E.selected) || null;

function editorSection() {
  const id = editorId();
  const t = S.templates.find((x) => x.id === id);
  if (!t) return `<h2>Template introuvable</h2><a class="btn" href="#templates">Retour aux templates</a>`;
  if (!E.tpl || E.tpl.id !== id) {
    E.tpl = structuredClone(t);
    E.selected = null;
    E.dirty = false;
    E.assets = new Map();
  }
  const fmt = t.format && S.formats[t.format] ? S.formats[t.format].name : 'format libre';
  return `
  <div class="editor">
    <div class="editor-top">
      <button class="btn" id="edBack">← Templates</button>
      <input id="edName" class="ed-name" value="${esc(E.tpl.name)}" title="Nom du template">
      <span class="badge">${esc(fmt)} · ${t.width}×${t.height} px</span>
      <label class="inline">Fond <input type="color" id="edBg" value="${esc(E.tpl.background)}"></label>
      <span class="sep"></span>
      <span class="muted">Ajouter</span>
      <button class="btn small" data-add="photo">+ Photo</button>
      <button class="btn small" data-add="text">+ Texte</button>
      <button class="btn small" data-add="rect">+ Forme</button>
      <button class="btn small" data-add="image">+ Image</button>
      <input type="file" id="edImageFile" accept="image/png,image/jpeg,image/webp" hidden>
      <span class="sep"></span>
      <label class="inline"><input type="checkbox" id="edSamples" ${E.samplesOn ? 'checked' : ''}> Photos d'exemple</label>
      <button class="btn primary" id="edSave">Enregistrer</button>
      <span id="edDirty" class="badge warn ${E.dirty ? '' : 'hidden'}">non enregistré</span>
    </div>
    <div class="editor-body">
      <div class="editor-canvas-wrap" id="edWrap"><canvas id="edCanvas" tabindex="0"></canvas></div>
      <aside class="editor-side">
        <h3>Calques <small>(le premier est au-dessus)</small></h3>
        <ul id="edLayers" class="layer-list"></ul>
        <h3>Propriétés</h3>
        <div id="edProps" class="props"><p class="muted">Sélectionnez un calque sur l'aperçu ou dans la liste.</p></div>
      </aside>
    </div>
    <p class="muted small">Glisser = déplacer · tirer un coin = redimensionner (Maj conserve les proportions) · flèches = 1 px (Maj = 10) · Suppr = supprimer · poignée ronde = rotation (Maj = pas de 15°). Les calques restent dans le cadre du tirage.</p>
  </div>`;
}

function markDirty() {
  E.dirty = true;
  $('#edDirty')?.classList.remove('hidden');
}

function fitEditorCanvas() {
  const cv = $('#edCanvas');
  const wrap = $('#edWrap');
  if (!cv || !wrap || !E.tpl) return;
  const maxW = Math.max(200, wrap.clientWidth - 32);
  const maxH = Math.max(200, window.innerHeight - 230);
  E.scale = Math.min(maxW / E.tpl.width, maxH / E.tpl.height);
  E.dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.style.width = `${Math.round(E.tpl.width * E.scale)}px`;
  cv.style.height = `${Math.round(E.tpl.height * E.scale)}px`;
  cv.width = Math.round(E.tpl.width * E.scale * E.dpr);
  cv.height = Math.round(E.tpl.height * E.scale * E.dpr);
}

function renderEditor() {
  const cv = $('#edCanvas');
  if (!cv || !E.tpl) return;
  const ctx = cv.getContext('2d');
  const photos = E.samplesOn ? photosFromSamples({ shots: Math.max(...E.tpl.layers.filter((l) => l.type === 'photo').map((l) => l.shot), -1) + 1 }, E.samples) : {};
  renderTemplate(ctx, E.tpl, { scale: E.scale * E.dpr, photos, assets: E.assets, placeholder: true });
  const l = selectedLayer();
  if (!l) return;
  // Cadre de sélection, poignées d'angle et poignée de rotation, en pixels écran.
  const s = E.scale;
  const c = centerOf(l);
  const w = l.width * s, h = l.height * s;
  ctx.save();
  ctx.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
  ctx.translate(c.x * s, c.y * s);
  ctx.rotate((l.rotation || 0) * DEG);
  ctx.strokeStyle = '#2f80ed';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = '#fff';
  for (const [dx, dy] of Object.values(CORNERS)) {
    const x = (dx * w) / 2, y = (dy * h) / 2;
    ctx.fillRect(x - 5, y - 5, 10, 10);
    ctx.strokeRect(x - 5, y - 5, 10, 10);
  }
  ctx.beginPath();
  ctx.moveTo(0, -h / 2);
  ctx.lineTo(0, -h / 2 - ROT_GAP);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -h / 2 - ROT_GAP, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  if (E.drag?.kind === 'rotate') {
    const hw = rotHandleWorld(l);
    ctx.save();
    ctx.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
    ctx.fillStyle = '#2f80ed';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${l.rotation || 0}°`, hw.x * s, hw.y * s - 12);
    ctx.restore();
  }
}

function renderLayerList() {
  const ul = $('#edLayers');
  if (!ul || !E.tpl) return;
  const layers = [...E.tpl.layers].reverse();
  ul.innerHTML = layers.map((l) => `
    <li class="${l.id === E.selected ? 'selected' : ''} ${l.visible === false ? 'off' : ''}" data-id="${esc(l.id)}">
      <button class="eye" data-vis="${esc(l.id)}" title="Afficher / masquer">${l.visible === false ? '○' : '●'}</button>
      <span class="ltype ${l.type}">${LAYER_LABEL[l.type]}</span>
      <span class="lname">${esc(layerTitle(l))}</span>
      <span class="lbtns">
        <button data-up="${esc(l.id)}" title="Monter">↑</button>
        <button data-down="${esc(l.id)}" title="Descendre">↓</button>
        <button data-dup="${esc(l.id)}" title="Dupliquer">⧉</button>
        <button data-rm="${esc(l.id)}" title="Supprimer">✕</button>
      </span>
    </li>`).join('') || '<li class="muted">Aucun calque</li>';
  ul.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    E.selected = li.dataset.id;
    renderAll();
  }));
  const move = (id, dir) => {
    const i = E.tpl.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= E.tpl.layers.length) return;
    [E.tpl.layers[i], E.tpl.layers[j]] = [E.tpl.layers[j], E.tpl.layers[i]];
    markDirty();
    renderAll();
  };
  ul.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => move(b.dataset.up, +1));
  ul.querySelectorAll('[data-down]').forEach((b) => b.onclick = () => move(b.dataset.down, -1));
  ul.querySelectorAll('[data-vis]').forEach((b) => b.onclick = () => {
    const l = E.tpl.layers.find((x) => x.id === b.dataset.vis);
    l.visible = l.visible === false;
    markDirty();
    renderAll();
  });
  ul.querySelectorAll('[data-dup]').forEach((b) => b.onclick = () => {
    const i = E.tpl.layers.findIndex((x) => x.id === b.dataset.dup);
    const copy = { ...structuredClone(E.tpl.layers[i]), id: newLayerId(), x: E.tpl.layers[i].x + 30, y: E.tpl.layers[i].y + 30 };
    clampLayer(copy);
    E.tpl.layers.splice(i + 1, 0, copy);
    E.selected = copy.id;
    markDirty();
    renderAll();
  });
  ul.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => removeLayer(b.dataset.rm));
}

function removeLayer(id) {
  E.tpl.layers = E.tpl.layers.filter((l) => l.id !== id);
  if (E.selected === id) E.selected = null;
  markDirty();
  renderAll();
}

/** Un calque ne peut pas sortir du template : position bornée, taille plafonnée. */
function clampLayer(l) {
  const W = E.tpl.width, H = E.tpl.height;
  l.width = Math.max(1, Math.min(Math.round(l.width), W));
  l.height = Math.max(1, Math.min(Math.round(l.height), H));
  const a = (l.rotation || 0) * DEG;
  const bw = (Math.abs(l.width * Math.cos(a)) + Math.abs(l.height * Math.sin(a))) / 2;
  const bh = (Math.abs(l.width * Math.sin(a)) + Math.abs(l.height * Math.cos(a))) / 2;
  let cx = l.x + l.width / 2, cy = l.y + l.height / 2;
  cx = bw * 2 > W ? W / 2 : Math.min(W - bw, Math.max(bw, cx));
  cy = bh * 2 > H ? H / 2 : Math.min(H - bh, Math.max(bh, cy));
  l.x = Math.round(cx - l.width / 2);
  l.y = Math.round(cy - l.height / 2);
}

const DEG = Math.PI / 180;
const wrapAngle = (d) => Math.round((((((d + 180) % 360) + 360) % 360) - 180) * 2) / 2;
const centerOf = (l) => ({ x: l.x + l.width / 2, y: l.y + l.height / 2 });
/** Point du template → repère local du calque (sa rotation annulée). */
function toLocal(l, tx, ty) {
  const c = centerOf(l);
  const a = -(l.rotation || 0) * DEG;
  const dx = tx - c.x, dy = ty - c.y;
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
}
/** Décalage depuis le centre dans le repère local → point du template. */
function fromLocal(l, ox, oy) {
  const c = centerOf(l);
  const a = (l.rotation || 0) * DEG;
  return { x: c.x + ox * Math.cos(a) - oy * Math.sin(a), y: c.y + ox * Math.sin(a) + oy * Math.cos(a) };
}
const CORNERS = { nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] };
const cornerWorld = (l, k) => fromLocal(l, (CORNERS[k][0] * l.width) / 2, (CORNERS[k][1] * l.height) / 2);
const ROT_GAP = 28; // distance écran entre le bord haut et la poignée de rotation
const rotHandleWorld = (l) => fromLocal(l, 0, -l.height / 2 - ROT_GAP / E.scale);

const newLayerId = () => `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function renderProps() {
  const box = $('#edProps');
  if (!box) return;
  const l = selectedLayer();
  if (!l) {
    box.innerHTML = '<p class="muted">Sélectionnez un calque sur l\'aperçu ou dans la liste.</p>';
    return;
  }
  const n = (k, label, min = -99999, max = 99999, step = 1) => `<label>${label}<input type="number" data-p="${k}" value="${l[k] ?? ''}" min="${min}" max="${max}" step="${step}"></label>`;
  const shots = Array.from({ length: 6 }, (_, i) => `<option value="${i}" ${l.shot === i ? 'selected' : ''}>Photo ${i + 1}</option>`).join('');
  const fonts = Object.entries(S.fonts).map(([k, name]) => `<option value="${k}" ${l.font === k ? 'selected' : ''}>${esc(name)}</option>`).join('');
  let specific = '';
  if (l.type === 'photo') {
    const cut = l.cutout || 'none';
    const cutOpts = { none: 'Aucun', ai: 'IA (sans fond particulier)', green: 'Fond vert', blue: 'Fond bleu' };
    specific = `<label>Photo affichée <select data-p="shot" data-num>${shots}</select></label>${n('radius', 'Coins arrondis (px)', 0, 2000)}
      <small class="muted">Plusieurs calques peuvent afficher la même photo (bande dupliquée).</small>
      <label>Détourage <select data-p="cutout" id="pCutout">${Object.entries(cutOpts).map(([k, v]) => `<option value="${k}" ${cut === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${cut === 'green' || cut === 'blue' ? `<label>Tolérance <input type="range" data-p="keyTolerance" min="0" max="100" step="1" value="${l.keyTolerance ?? 50}"></label>
      <small class="muted">Plus haut : retire aussi les zones du fond plus sombres (ombres, plis). Trop haut : le sujet s'efface là où il ressemble au fond.</small>` : ''}
      ${cut !== 'none' ? `<small class="muted">Le fond retiré laisse voir les calques placés <b>sous</b> cette photo dans la liste (image, couleur…).${cut === 'ai' ? ' L\'aperçu en direct est un peu moins précis sur les bords que la photo finale.' : ''} L'aperçu de l'éditeur montre la photo sans détourage.</small>` : ''}`;
  } else if (l.type === 'text') {
    specific = `
      <label>Texte <textarea data-p="text" rows="3">${esc(l.text)}</textarea></label>
      <div class="row2">${n('fontSize', 'Taille (px)', 6, 2000)}${n('lineHeight', 'Interligne', 0.7, 3, 0.05)}</div>
      <label>Police <select data-p="font">${fonts}</select></label>
      <div class="row2">
        <label>Alignement <select data-p="align">${['left', 'center', 'right'].map((a) => `<option value="${a}" ${l.align === a ? 'selected' : ''}>${{ left: 'Gauche', center: 'Centre', right: 'Droite' }[a]}</option>`).join('')}</select></label>
        <label>Couleur <input type="color" data-p="color" value="${esc(l.color)}"></label>
      </div>
      <div class="row">
        <label class="inline"><input type="checkbox" data-p="weight" data-bool="bold" ${l.weight === 'bold' ? 'checked' : ''}> Gras</label>
        <label class="inline"><input type="checkbox" data-p="italic" data-bool="true" ${l.italic ? 'checked' : ''}> Italique</label>
      </div>`;
  } else if (l.type === 'rect') {
    specific = `
      <div class="row">
        <label>Remplissage <input type="color" data-p="fill" value="${l.fill === 'none' ? '#000000' : esc(l.fill)}" ${l.fill === 'none' ? 'disabled' : ''}></label>
        <label class="inline"><input type="checkbox" id="pFillNone" ${l.fill === 'none' ? 'checked' : ''}> Sans remplissage</label>
      </div>
      <div class="row">
        <label>Bordure <input type="color" data-p="stroke" value="${l.stroke === 'none' ? '#000000' : esc(l.stroke)}" ${l.stroke === 'none' ? 'disabled' : ''}></label>
        <label class="inline"><input type="checkbox" id="pStrokeNone" ${l.stroke === 'none' ? 'checked' : ''}> Sans bordure</label>
        ${n('strokeWidth', 'Épaisseur', 0, 1000)}
      </div>
      ${n('radius', 'Coins arrondis (px)', 0, 5000)}`;
  } else if (l.type === 'image') {
    const img = E.assets.get(l.src);
    specific = `${n('radius', 'Coins arrondis (px)', 0, 5000)}
      <div class="row"><button class="btn small" id="pImgReplace" type="button">Remplacer l'image</button>
      ${img ? `<button class="btn small" id="pImgRatio" type="button">Rétablir les proportions</button>` : ''}</div>
      <small class="muted">${esc(l.src)}${img ? ` · ${img.naturalWidth}×${img.naturalHeight}` : ''}</small>`;
  }
  box.innerHTML = `
    <div class="props-head"><span class="ltype ${l.type}">${LAYER_LABEL[l.type]}</span><input data-p="name" placeholder="${esc(layerTitle(l))}" value="${esc(l.name)}" title="Nom du calque"></div>
    <div class="row2">${n('x', 'X')}${n('y', 'Y')}</div>
    <div class="row2">${n('width', 'Largeur', 1, 20000)}${n('height', 'Hauteur', 1, 20000)}</div>
    <div class="row2">${n('rotation', 'Rotation (°)', -180, 180, 0.5)}<label>&nbsp;<button type="button" class="btn small" id="pRotReset">Remettre droit</button></label></div>
    <label>Opacité <input type="range" data-p="opacity" min="0" max="1" step="0.05" value="${l.opacity ?? 1}"></label>
    ${specific}`;

  box.querySelectorAll('[data-p]').forEach((el) => {
    const apply = () => {
      const k = el.dataset.p;
      if (el.dataset.bool) { l[k] = el.checked ? (el.dataset.bool === 'true' ? true : el.dataset.bool) : (el.dataset.bool === 'true' ? false : 'normal'); }
      else if (el.type === 'number' || el.type === 'range' || el.dataset.num !== undefined) { const v = Number(el.value); if (Number.isFinite(v)) l[k] = v; }
      else l[k] = el.value;
      if (k === 'rotation') l.rotation = wrapAngle(l.rotation || 0);
      if (['x', 'y', 'width', 'height', 'rotation'].includes(k)) { clampLayer(l); syncPropsNumbers(); }
      markDirty();
      renderEditor();
      if (k === 'name' || k === 'text' || k === 'shot') renderLayerList();
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  $('#pCutout')?.addEventListener('change', () => renderProps()); // affiche / masque la tolérance
  $('#pRotReset')?.addEventListener('click', () => { l.rotation = 0; clampLayer(l); markDirty(); renderProps(); renderEditor(); });
  $('#pFillNone')?.addEventListener('change', (e) => { l.fill = e.target.checked ? 'none' : '#000000'; markDirty(); renderProps(); renderEditor(); });
  $('#pStrokeNone')?.addEventListener('change', (e) => { l.stroke = e.target.checked ? 'none' : '#000000'; if (!e.target.checked && !l.strokeWidth) l.strokeWidth = 8; markDirty(); renderProps(); renderEditor(); });
  $('#pImgReplace')?.addEventListener('click', () => { E.replaceTarget = l.id; $('#edImageFile').click(); });
  $('#pImgRatio')?.addEventListener('click', () => { const img = E.assets.get(l.src); if (img) { l.height = Math.round(l.width * img.naturalHeight / img.naturalWidth); clampLayer(l); markDirty(); renderProps(); renderEditor(); } });
}

/** Met à jour x/y/l/h dans le panneau pendant un glisser sans tout reconstruire. */
function syncPropsNumbers() {
  const l = selectedLayer();
  if (!l) return;
  for (const k of ['x', 'y', 'width', 'height', 'rotation']) {
    const el = $(`#edProps [data-p="${k}"]`);
    if (el) el.value = l[k] ?? 0;
  }
}

function renderAll() {
  renderEditor();
  renderLayerList();
  renderProps();
}

function canvasPos(e) {
  const r = $('#edCanvas').getBoundingClientRect();
  return { tx: (e.clientX - r.left) / E.scale, ty: (e.clientY - r.top) / E.scale };
}
function hitHandle(l, tx, ty) {
  const rh = rotHandleWorld(l);
  if (Math.hypot(tx - rh.x, ty - rh.y) <= 12 / E.scale) return 'rotate';
  const tol = 9 / E.scale;
  for (const k of Object.keys(CORNERS)) {
    const p = cornerWorld(l, k);
    if (Math.abs(tx - p.x) <= tol && Math.abs(ty - p.y) <= tol) return k;
  }
  return null;
}
function hitLayer(tx, ty) {
  for (let i = E.tpl.layers.length - 1; i >= 0; i--) {
    const l = E.tpl.layers[i];
    if (l.visible === false) continue;
    const p = toLocal(l, tx, ty);
    if (p.x >= l.x && p.x <= l.x + l.width && p.y >= l.y && p.y <= l.y + l.height) return l;
  }
  return null;
}

function onPointerDown(e) {
  const cv = $('#edCanvas');
  cv.focus();
  const { tx, ty } = canvasPos(e);
  const sel = selectedLayer();
  let mode = null;
  if (sel) {
    const h = hitHandle(sel, tx, ty);
    if (h === 'rotate') mode = { kind: 'rotate' };
    else if (h) mode = { kind: 'resize', corner: h };
  }
  if (!mode) {
    const l = hitLayer(tx, ty);
    E.selected = l ? l.id : null;
    if (l) mode = { kind: 'move' };
    renderLayerList();
    renderProps();
  }
  if (mode) {
    const l = selectedLayer();
    E.drag = { ...mode, startX: tx, startY: ty, orig: { x: l.x, y: l.y, width: l.width, height: l.height, rotation: l.rotation || 0 } };
    cv.setPointerCapture(e.pointerId);
  }
  renderEditor();
}

function onPointerMove(e) {
  const cv = $('#edCanvas');
  const { tx, ty } = canvasPos(e);
  if (!E.drag) {
    const sel = selectedLayer();
    const h = sel && hitHandle(sel, tx, ty);
    cv.style.cursor = h === 'rotate' ? 'grab' : h ? (h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize') : hitLayer(tx, ty) ? 'move' : 'default';
    return;
  }
  const l = selectedLayer();
  if (!l) return;
  const d = E.drag;
  const o = d.orig;
  const W = E.tpl.width, H = E.tpl.height;
  if (d.kind === 'move') {
    l.x = o.x + Math.round(tx - d.startX);
    l.y = o.y + Math.round(ty - d.startY);
  } else if (d.kind === 'rotate') {
    const c = { x: o.x + o.width / 2, y: o.y + o.height / 2 };
    let deg = Math.atan2(ty - c.y, tx - c.x) / DEG + 90;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    else {
      const near = Math.round(deg / 90) * 90;
      if (Math.abs(deg - near) < 3) deg = near; // aimant léger sur 0, 90, 180, 270
    }
    l.rotation = wrapAngle(deg);
  } else {
    // Redimensionnement : le coin opposé reste fixe, y compris quand le calque est tourné.
    const a = o.rotation * DEG;
    const cos = Math.cos(a), sin = Math.sin(a);
    const rot = (x, y) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
    const unrot = (x, y) => ({ x: x * cos + y * sin, y: -x * sin + y * cos });
    const [dirX, dirY] = CORNERS[d.corner];
    const c = { x: o.x + o.width / 2, y: o.y + o.height / 2 };
    const fOff = rot((-dirX * o.width) / 2, (-dirY * o.height) / 2);
    const F = { x: c.x + fOff.x, y: c.y + fOff.y };
    const mx = Math.max(0, Math.min(W, tx)), my = Math.max(0, Math.min(H, ty)); // la souris ne sort pas du tirage
    const dl = unrot(mx - F.x, my - F.y);
    let w = Math.max(10, dl.x * dirX), h = Math.max(10, dl.y * dirY);
    if (e.shiftKey) {
      const ratio = o.width / o.height;
      if (w / o.width > h / o.height) h = w / ratio; else w = h * ratio;
    }
    const cOff = rot((dirX * w) / 2, (dirY * h) / 2);
    const c2 = { x: F.x + cOff.x, y: F.y + cOff.y };
    l.width = Math.round(w);
    l.height = Math.round(h);
    l.x = Math.round(c2.x - w / 2);
    l.y = Math.round(c2.y - h / 2);
  }
  clampLayer(l);
  markDirty();
  renderEditor();
  syncPropsNumbers();
}

function onPointerUp() {
  if (E.drag) {
    E.drag = null;
    renderProps();
  }
}

function onEditorKey(e) {
  const l = selectedLayer();
  if (!l) return;
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    e.preventDefault();
    l.x += moves[e.key][0];
    l.y += moves[e.key][1];
    clampLayer(l);
    markDirty();
    renderEditor();
    syncPropsNumbers();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeLayer(l.id);
  }
}

function addLayer(type) {
  const W = E.tpl.width, H = E.tpl.height;
  let l;
  if (type === 'image') { E.replaceTarget = null; $('#edImageFile').click(); return; }
  if (type === 'photo') {
    const used = new Set(E.tpl.layers.filter((x) => x.type === 'photo').map((x) => x.shot));
    let shot = 0;
    while (used.has(shot)) shot++;
    const w = Math.round(W * 0.4), h = Math.round(w * 2 / 3);
    l = { type, shot, name: '', x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: w, height: h, radius: 0, opacity: 1, visible: true };
  } else if (type === 'text') {
    const fontSize = Math.round(H / 14), w = Math.round(W * 0.6), h = Math.round(fontSize * 1.6);
    l = { type, text: 'Votre texte', fontSize, font: 'sans', weight: 'bold', italic: false, color: '#1d3557', align: 'center', lineHeight: 1.2, name: '', x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: w, height: h, opacity: 1, visible: true };
  } else {
    const w = Math.round(W * 0.4), h = Math.round(H * 0.2);
    l = { type: 'rect', fill: '#1d3557', stroke: 'none', strokeWidth: 0, radius: 0, name: '', x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: w, height: h, opacity: 1, visible: true };
  }
  l.id = newLayerId();
  clampLayer(l);
  E.tpl.layers.push(l);
  E.selected = l.id;
  markDirty();
  renderAll();
}

async function onImageFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const form = new FormData();
  form.append('image', file);
  try {
    const a = await api(`/api/admin/templates/${encodeURIComponent(E.tpl.id)}/assets`, { method: 'POST', form });
    const img = await loadImage(a.url);
    if (img) E.assets.set(a.src, img);
    const target = E.replaceTarget ? E.tpl.layers.find((l) => l.id === E.replaceTarget) : null;
    if (target) {
      target.src = a.src;
      target.url = a.url;
    } else {
      const maxW = E.tpl.width * 0.5, maxH = E.tpl.height * 0.5;
      const r = Math.min(maxW / a.width, maxH / a.height, 1);
      const w = Math.round(a.width * r), h = Math.round(a.height * r);
      const l = { id: newLayerId(), type: 'image', src: a.src, url: a.url, name: '', x: Math.round((E.tpl.width - w) / 2), y: Math.round((E.tpl.height - h) / 2), width: w, height: h, radius: 0, opacity: 1, visible: true };
      clampLayer(l);
      E.tpl.layers.push(l);
      E.selected = l.id;
    }
    E.replaceTarget = null;
    markDirty();
    renderAll();
  } catch (err) { toast(err.message, true); }
}

async function saveTemplate() {
  try {
    const t = await api(`/api/admin/templates/${encodeURIComponent(E.tpl.id)}`, { method: 'PUT', body: { name: E.tpl.name, background: E.tpl.background, layers: E.tpl.layers } });
    E.tpl = { ...E.tpl, ...t };
    const i = S.templates.findIndex((x) => x.id === t.id);
    if (i >= 0) S.templates[i] = t;
    E.dirty = false;
    $('#edDirty').classList.add('hidden');
    toast('Template enregistré, la borne est à jour');
    renderAll();
  } catch (e) { toast(e.message, true); }
}

function bindEditor() {
  const cv = $('#edCanvas');
  if (!cv) return;
  fitEditorCanvas();
  renderAll();
  loadAssets(E.tpl, E.assets).then(renderEditor);
  sampleImages().then((imgs) => { E.samples = imgs; renderEditor(); });
  E.onResize = () => { fitEditorCanvas(); renderEditor(); };
  window.addEventListener('resize', E.onResize);

  $('#edBack').onclick = () => {
    if (E.dirty && !confirm('Modifications non enregistrées. Quitter quand même ?')) return;
    E.tpl = null;
    location.hash = 'templates';
  };
  $('#edName').oninput = (e) => { E.tpl.name = e.target.value; markDirty(); };
  $('#edBg').oninput = (e) => { E.tpl.background = e.target.value; markDirty(); renderEditor(); };
  $('#edSamples').onchange = (e) => { E.samplesOn = e.target.checked; renderEditor(); };
  document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addLayer(b.dataset.add));
  $('#edImageFile').onchange = onImageFile;
  $('#edSave').onclick = saveTemplate;
  cv.addEventListener('pointerdown', onPointerDown);
  cv.addEventListener('pointermove', onPointerMove);
  cv.addEventListener('pointerup', onPointerUp);
  cv.addEventListener('pointercancel', onPointerUp);
  cv.addEventListener('keydown', onEditorKey);
  cv.addEventListener('dblclick', () => { if (selectedLayer()?.type === 'text') $('#edProps textarea')?.focus(); });
}

function unbindEditor() {
  if (E.onResize) window.removeEventListener('resize', E.onResize);
  E.onResize = null;
  E.drag = null;
}

const SECTIONS = { dashboard, sessions, templates: templatesSection, editor: editorSection, flow, printing, sharing, theme: themeSection, hardware, security };
const OLD_HASHES = { limits: 'printing' }; // anciens liens de l'admin

// ---------- Rendu + événements ----------

function currentSection() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('editor=')) return 'editor';
  if (h.startsWith('sessions=')) return 'sessions';
  if (OLD_HASHES[h]) return OLD_HASHES[h];
  return SECTIONS[h] ? h : 'dashboard';
}

function render() {
  if (!S) return; // pas encore connecté
  syncFavicon();
  const sec = currentSection();
  if (prevSection === 'editor' && sec !== 'editor') unbindEditor();
  prevSection = sec;
  const navKey = sec === 'editor' ? 'templates' : sec;
  document.querySelectorAll('.nav a[href^="#"]').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${navKey}`));
  try {
    $('#main').innerHTML = SECTIONS[sec]();
    $('#main').classList.toggle('wide', sec === 'editor');
    bindSection(sec);
  } catch (e) {
    console.error(e);
    $('#main').innerHTML = `<h2>Cette page n'a pas pu s'afficher</h2>
      <div class="alert">${esc(e.message)}</div>
      <p class="sub">Si le serveur vient d'être mis à jour, redémarrez-le (Ctrl+C puis <code>npm run dev</code>) et rechargez cette page.</p>`;
  }
}

const num = (fd, k) => Number(fd.get(k));

async function renderTemplateCards() {
  const samples = await sampleImages();
  for (const cv of document.querySelectorAll('canvas.tpl-preview')) {
    const t = S.templates.find((x) => x.id === cv.dataset.tpl);
    if (!t) continue;
    const scale = cv.width / t.width;
    const ctx = cv.getContext('2d');
    renderTemplate(ctx, t, { scale, photos: photosFromSamples(t, samples), placeholder: true });
    loadAssets(t).then((assets) => renderTemplate(ctx, t, { scale, photos: photosFromSamples(t, samples), assets, placeholder: true }));
  }
}

function bindSection(sec) {
  if (sec === 'dashboard') {
    $('#btnPaper').onclick = async () => {
      const v = $('#paperInput').value;
      await api('/api/admin/counters', { method: 'POST', body: { paperRemaining: v === '' ? null : Number(v) } });
      toast('Papier mis à jour'); refresh();
    };
    $('#btnPaperOff').onclick = async () => { await api('/api/admin/counters', { method: 'POST', body: { paperRemaining: null } }); refresh(); };
    $('#btnResetPrinted').onclick = async () => {
      if (!confirm('Remettre le compteur de tirages à zéro ?')) return;
      await api('/api/admin/counters', { method: 'POST', body: { reset: true } });
      toast('Compteur remis à zéro'); refresh();
    };
    $('#btnResetSessions').onclick = () => resetSessions(); // sans argument : l'événement en cours (pas l'objet du clic)
  }

  bindSettingsForms();

  if (sec === 'theme') {
    const form = $('#formTheme');
    const updatePreview = () => {
      const fd = new FormData(form);
      const p = $('#themePreview');
      p.style.background = fd.get('color_background');
      p.style.color = fd.get('color_text');
      const title = p.querySelector('span');
      title.style.color = fd.get('color_secondary');
      title.textContent = fd.get('boothName');
      const b = p.querySelector('.pbtn');
      b.style.background = fd.get('color_primary');
      b.style.color = fd.get('color_onPrimary');
      const o = p.querySelector('.pbtn-outline');
      o.style.borderColor = fd.get('color_secondary');
      o.style.color = fd.get('color_secondary');
      const problems = [];
      if (contrast(fd.get('color_background'), fd.get('color_text')) < 4.5) problems.push('texte courant sur fond d\'écran');
      if (contrast(fd.get('color_primary'), fd.get('color_onPrimary')) < 3) problems.push('texte des boutons sur accent');
      if (contrast(fd.get('color_background'), fd.get('color_secondary')) < 3) problems.push('titres sur fond d\'écran');
      if (contrast(fd.get('color_background'), fd.get('color_primary')) < 3) problems.push('accent sur fond d\'écran');
      const warn = $('#contrastWarn');
      warn.textContent = problems.length ? `Contraste faible : ${problems.join(', ')}` : '';
      warn.classList.toggle('hidden', !problems.length);
    };
    form.addEventListener('input', updatePreview);
    updatePreview();
    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      saveConfig({
        booth: { name: fd.get('boothName'), showName: fd.get('showName') === 'on' },
        theme: { active: fd.get('active'), custom: {
          font: fd.get('font'),
          colors: { primary: fd.get('color_primary'), secondary: fd.get('color_secondary'), background: fd.get('color_background'), surface: fd.get('color_surface'), text: fd.get('color_text'), onPrimary: fd.get('color_onPrimary') }
        } }
      }, 'Thème enregistré, la borne est à jour');
    };
    $('#formLogo').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/admin/logo', { method: 'POST', form: new FormData(e.target) }); toast('Logo envoyé, la borne est à jour'); refresh(); } catch (err) { toast(err.message, true); }
    };
    $('#formBg').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/admin/background', { method: 'POST', form: new FormData(e.target) }); toast('Image de fond envoyée'); refresh(); } catch (err) { toast(err.message, true); }
    };
    $('#btnLogoReset')?.addEventListener('click', () => saveConfig({ booth: { logo: '' }, theme: { custom: { logo: '' } } }, 'Logo par défaut rétabli'));
    $('#btnBgReset')?.addEventListener('click', () => saveConfig({ booth: { backgroundImage: '' }, theme: { custom: { backgroundImage: '' } } }, 'Image de fond retirée'));
    $('#formTexts').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const texts = {};
      for (const [k, v] of fd.entries()) if (k.startsWith('text_')) texts[k.slice(5)] = v;
      saveConfig({ texts }, 'Textes enregistrés');
    };
  }

  if (sec === 'templates') {
    renderTemplateCards();
    const saveTemplates = () => {
      const enabled = [...document.querySelectorAll('[data-enable]')].filter((c) => c.checked).map((c) => c.dataset.enable);
      const def = document.querySelector('input[name=defaultTpl]:checked')?.value || enabled[0] || '';
      saveConfig({ templates: { enabled, default: def, guestCanChoose: $('#guestCanChoose').checked, defaultFormat: $('#defaultFormat').value } }, 'Templates enregistrés');
    };
    document.querySelectorAll('[data-enable], input[name=defaultTpl], #guestCanChoose, #defaultFormat').forEach((el) => el.addEventListener('change', saveTemplates));
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Supprimer le template « ${b.dataset.del} » ?`)) return;
      try { await api(`/api/admin/templates/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); toast('Template supprimé'); refresh(); } catch (e) { toast(e.message, true); }
    }));
    $('#formNewTemplate').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('overlay')?.size) fd.delete('overlay');
      try {
        const t = await api('/api/admin/templates', { method: 'POST', form: fd });
        S = await api('/api/admin/state');
        toast(`Template « ${t.name} » créé`);
        location.hash = `editor=${encodeURIComponent(t.id)}`;
      } catch (err) { toast(err.message, true); }
    };
  }

  if (sec === 'editor') bindEditor();

  if (sec === 'sessions') {
    document.querySelectorAll('[data-reprint]').forEach((b) => b.addEventListener('click', async () => {
      const copies = Number(prompt('Nombre de copies à réimprimer ?', '1'));
      if (!copies) return;
      try { await api(`/api/admin/reprint/${b.dataset.reprint}`, { method: 'POST', body: { copies } }); toast('Réimpression lancée'); eventSessions = null; refresh(); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-del-session]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.delSession;
      if (!confirm(`Supprimer la session ${id} et ses photos ?`)) return;
      try { await api(`/api/admin/sessions/${id}`, { method: 'DELETE' }); toast('Session supprimée'); eventSessions = null; refresh(); } catch (e) { toast(e.message, true); }
    }));
    const evId = selectedEventId();
    const ev = S.events.find((e) => e.id === evId);
    const reload = () => { eventSessions = null; refresh(); };
    $('#btnResetSessions').onclick = () => resetSessions(evId);
    document.querySelectorAll('[data-move]').forEach((sel) => sel.addEventListener('change', async () => {
      try { await api(`/api/admin/sessions/${sel.dataset.move}/move`, { method: 'POST', body: { eventId: sel.value } }); toast('Session déplacée'); reload(); } catch (e) { toast(e.message, true); }
    }));
    $('#btnNewEvent').onclick = async () => {
      const name = prompt('Nom de l\'événement ?', '');
      if (!name?.trim()) return;
      const date = prompt('Date (AAAA-MM-JJ) ?', new Date().toISOString().slice(0, 10));
      if (!date) return;
      try {
        const created = await api('/api/admin/events', { method: 'POST', body: { name, date, activate: true } });
        toast(`« ${created.name} » est l'événement en cours`);
        location.hash = `#sessions=${encodeURIComponent(created.id)}`;
        reload();
      } catch (e) { toast(e.message, true); }
    };
    if ($('#btnActivateEvent')) $('#btnActivateEvent').onclick = async () => {
      try { await api(`/api/admin/events/${encodeURIComponent(evId)}/activate`, { method: 'POST' }); toast(`« ${ev.name} » est l'événement en cours`); reload(); } catch (e) { toast(e.message, true); }
    };
    $('#btnEditEvent').onclick = async () => {
      const name = prompt('Nom de l\'événement ?', ev.name);
      if (name === null) return;
      const date = prompt('Date (AAAA-MM-JJ) ?', ev.date);
      if (date === null) return;
      try { await api(`/api/admin/events/${encodeURIComponent(evId)}`, { method: 'PUT', body: { name, date } }); toast('Événement mis à jour'); reload(); } catch (e) { toast(e.message, true); }
    };
    if ($('#btnDeleteEvent')) $('#btnDeleteEvent').onclick = async () => {
      if (!confirm(`Supprimer l'événement « ${ev.name} », ses ${ev.sessions} session(s) et toutes leurs photos ?\nPensez à exporter d'abord. Cette action est irréversible.`)) return;
      try {
        await api(`/api/admin/events/${encodeURIComponent(evId)}`, { method: 'DELETE' });
        toast('Événement supprimé');
        location.hash = '#sessions';
        reload();
      } catch (e) { toast(e.message, true); }
    };
  }

}

/** Formulaires de réglages : chacun enregistre ses propres champs, quelle que soit la section qui l'affiche. */
function bindSettingsForms() {
  const form = (id, fn) => { const f = $(id); if (f) f.onsubmit = (e) => { e.preventDefault(); fn(new FormData(f), f); }; };
  document.querySelectorAll('.btn-detect').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/admin/devices/refresh', { method: 'POST' }); toast('Détection relancée'); refresh(); } catch (e) { toast(e.message, true); }
  }));
  form('#formFlow', (fd) => saveConfig({
    limits: {
      countdownSec: num(fd, 'countdownSec'),
      maxRetakesPerSession: fd.get('retakesUnlimited') === 'on' ? -1 : num(fd, 'maxRetakesPerSession'),
      reviewTimeoutSec: num(fd, 'reviewTimeoutSec'),
      captureTimeoutSec: num(fd, 'captureTimeoutSec')
    },
    booth: { mirrorPreview: fd.get('mirrorPreview') === 'on', idleReturnSec: num(fd, 'idleReturnSec'), menuIdleSec: num(fd, 'menuIdleSec') }
  }));
  form('#formPrintLimits', (fd) => saveConfig({ limits: {
    maxCopiesPerSession: num(fd, 'maxCopiesPerSession'),
    allowZeroCopies: fd.get('allowZeroCopies') === 'on',
    operatorMaxCopies: num(fd, 'operatorMaxCopies'),
    eventQuota: num(fd, 'eventQuota'),
    lowPaperThreshold: num(fd, 'lowPaperThreshold')
  } }));
  form('#formPrinter', (fd) => saveConfig({ printer: {
    driver: fd.get('printerDriver'), fallback: fd.get('printerFallback'), mockDelayMs: num(fd, 'mockDelayMs'),
    cups: { name: fd.get('cupsName').trim(), options: fd.get('cupsOptions').split('\n').map((x) => x.trim()).filter(Boolean) }
  } }));
  form('#formCamera', (fd) => saveConfig({
    camera: { driver: fd.get('cameraDriver'), fallback: fd.get('cameraFallback'), gphoto2: {
      ...(fd.has('flash') ? { flash: fd.get('flash'), flashAutoThreshold: num(fd, 'flashAutoThreshold') } : {}),
      setupCommand: fd.get('setupCommand').trim(), armFireCommand: fd.get('armFireCommand').trim(),
      captureCommand: fd.get('captureCommand'), liveviewCommand: fd.get('liveviewCommand'),
      liveview: fd.get('liveview') === 'on', settleMs: num(fd, 'settleMs'), liveIdleMs: num(fd, 'liveIdleSec') * 1000
    } },
    booth: { lensPosition: fd.get('lensPosition') }
  }));
  form('#formDeck', (fd) => saveConfig({ booth: { streamDeck: { enabled: fd.get('deckEnabled') === 'on', brightness: num(fd, 'deckBrightness'), position: fd.get('deckPosition') } } }));
  form('#formShare', (fd, f) => saveConfig({ share: { baseUrl: fd.get('shareBaseUrl').trim(), publicUrl: fd.get('publicUrl').trim(), qrOnDone: f.qrOnDone.checked, requireWifi: f.requireWifi.checked } }));
  form('#formCodes', (fd) => saveConfig({ admin: { pin: fd.get('adminPin') }, limits: { operatorPin: fd.get('operatorPin') } }));
  form('#formWifi', (fd, f) => saveConfig({ share: { wifi: { enabled: f.enabled.checked, ssid: f.ssid.value.trim(), password: f.password.value, security: f.security.value } } }, 'Wi-Fi enregistré'));
  form('#formGallery', (fd, f) => saveConfig({ gallery: { booth: f.booth.checked, web: f.web.checked, reprint: f.reprint.value, qr: f.qr.checked } }, 'Galerie enregistrée'));
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

// ---------- Connexion ----------

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#shell').classList.add('hidden');
  sendDeckUi();
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/login', { method: 'POST', body: { pin: $('#loginPin').value } });
      await boot();
    } catch (err) { $('#loginError').textContent = err.message; }
  };
}

async function boot() {
  try {
    S = await api('/api/admin/state');
  } catch (e) {
    if (e.status === 401) return showLogin();
    return toast(e.message, true);
  }
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#btnShutdown').classList.toggle('hidden', !S.canShutdown);
  $('#btnRestart').classList.toggle('hidden', !S.canRestart);
  sendDeckUi();
  if (!S.formats || !S.theme || S.templates.some((t) => !t.layers)) {
    $('#main').innerHTML = `<h2>Serveur à redémarrer</h2>
      <div class="alert">Le serveur tourne sur une version plus ancienne que cette page : les templates à calques et le logo global ne sont pas disponibles.</div>
      <p class="sub">Dans le terminal : Ctrl+C puis <code>npm run dev</code> (rechargement automatique), et rechargez cette page.</p>`;
    return;
  }
  render();
}

window.addEventListener('hashchange', render);
window.addEventListener('beforeunload', (e) => { if (currentSection() === 'editor' && E.dirty) { e.preventDefault(); e.returnValue = ''; } });
$('#btnLogout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); };
// Retour à la borne dans la même fenêtre : on se déconnecte, sinon la zone cachée rouvrirait l'admin sans code.
$('#btnBooth').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; };
$('#btnShutdown').onclick = async () => {
  if (!await askConfirm('Éteindre la borne ?\n\nLe logiciel se ferme. Pour le relancer : icône « Photo Booth » sur le bureau.', 'Éteindre')) return;
  try {
    await api('/api/admin/shutdown', { method: 'POST', body: {} });
  } catch (e) {
    if (e.code !== 'PRINTING' || !await askConfirm(`${e.message}\n\nÉteindre quand même ?`, 'Éteindre quand même')) return toast(e.message, true);
    await api('/api/admin/shutdown', { method: 'POST', body: { force: true } });
  }
  // Le lanceur ferme la fenêtre ; ce message ne reste visible que dans un navigateur ordinaire.
  document.body.innerHTML = `<div class="login"><div class="card login-card"><h1>Borne éteinte</h1>
    <p class="sub">Pour la relancer : icône « Photo Booth » sur le bureau.</p></div></div>`;
};
// Redémarrer : le logiciel se ferme proprement (caméra, Stream Deck) et se relance tout seul sur l'accueil.
$('#btnRestart').onclick = async () => {
  if (!await askConfirm('Redémarrer la borne ?\n\nLe logiciel se ferme puis se relance tout seul, en quelques secondes. Utile si la caméra ou le Stream Deck ne répond plus.', 'Redémarrer', 'retake')) return;
  try {
    await api('/api/admin/restart', { method: 'POST', body: {} });
  } catch (e) {
    if (e.code !== 'PRINTING' || !await askConfirm(`${e.message}\n\nRedémarrer quand même ?`, 'Redémarrer quand même', 'retake')) return toast(e.message, true);
    await api('/api/admin/restart', { method: 'POST', body: { force: true } });
  }
  document.body.innerHTML = `<div class="login"><div class="card login-card"><h1>Redémarrage…</h1>
    <p class="sub">La borne revient dans quelques secondes.</p></div></div>`;
};
/** Confirmation dans la page : se valide à la souris, au clavier ou depuis le Stream Deck. */
function askConfirm(text, okLabel, deckIcon = 'power') {
  return new Promise((resolve) => {
    const dlg = $('#confirmDialog');
    $('#confirmText').textContent = text;
    $('#cfOk').textContent = okLabel;
    $('#cfOk').dataset.icon = deckIcon; // pictogramme de la touche « valider » sur le Stream Deck
    const done = (v) => { dlg.close(); $('#cfOk').onclick = $('#cfCancel').onclick = dlg.oncancel = null; sendDeckUi(); resolve(v); };
    $('#cfOk').onclick = () => done(true);
    $('#cfCancel').onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); }; // Échap
    dlg.showModal();
    sendDeckUi();
  });
}

// ---------- Stream Deck ----------
// Admin ouverte sur la borne elle-même (et pas depuis un téléphone) : le Stream Deck affiche ses actions
// (retour à la borne, déconnexion, éteindre) et ses appuis arrivent ici, comme sur la borne.
const ON_BOOTH = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const DECK_DANGER = { bg: '#d62839', fg: '#ffffff', border: null };
let deckSock = null;

function sendDeckUi() {
  if (!ON_BOOTH || deckSock?.readyState !== 1) return;
  const dlg = $('#confirmDialog');
  const shell = !$('#shell').classList.contains('hidden');
  let items;
  if (dlg.open) {
    items = [{ id: 'cfOk', label: $('#cfOk').textContent, icon: $('#cfOk').dataset.icon || 'power', kind: 'primary', style: DECK_DANGER }, { id: 'cfCancel', label: 'Annuler', icon: 'x', kind: 'ghost' }];
  } else {
    items = [{ id: 'btnBooth', label: 'Retour à la borne', icon: 'back', kind: 'ghost' }];
    if (shell) items.push({ id: 'btnLogout', label: 'Déconnexion', icon: 'logout', kind: 'ghost' });
    // Redémarrer et éteindre sur la rangée du haut, retour et déconnexion en bas
    if (shell && !$('#btnRestart').classList.contains('hidden')) items.push({ id: 'btnRestart', label: 'Redémarrer', icon: 'retake', kind: 'primary', style: { bg: '#2f6fdd', fg: '#ffffff', border: null } });
    if (shell && !$('#btnShutdown').classList.contains('hidden')) items.push({ id: 'btnShutdown', label: 'Éteindre', icon: 'power', kind: 'primary', style: DECK_DANGER });
  }
  deckSock.send(JSON.stringify({ type: 'ui', screen: dlg.open ? 'admin-confirm' : 'admin', items, colors: S?.theme?.colors || {} }));
}

function onDeckPress(id) {
  const el = document.getElementById(id);
  if (el && !el.disabled && (el.offsetParent !== null || el.closest('dialog[open]'))) el.click();
  else if (id === 'btnBooth') location.href = '/'; // page de connexion : retour direct à la borne
}

// Rafraîchit compteurs et sessions quand la borne travaille ; relaie le Stream Deck (admin ouverte sur la borne).
(function ws() {
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  deckSock = sock;
  sock.onopen = () => sendDeckUi();
  sock.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { /* ignoré */ }
    if (msg?.type === 'deck') return onDeckPress(msg.id);
    if (msg?.type === 'deckInfo') return;
    if (S && ['dashboard', 'sessions'].includes(currentSection())) refresh().catch(() => {});
  };
  sock.onclose = () => setTimeout(ws, 3000);
})();
boot();
