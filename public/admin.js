/* Page d'administration : réglages, thème, templates (éditeur de calques), compteurs, sessions. */
import { renderTemplate, loadAssets, loadImage } from './template-render.js';
import { FILTERS } from './filters.js';
import { deviceNotice, updateNotice, systemNotice } from './device-toasts.js';

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

/** Indicateur d'enregistrement (en haut à droite) : saving → saved (s'efface), ou error. */
function saveState(state) {
  const el = $('#saveState');
  clearTimeout(saveState.t);
  el.className = `save-state ${state}`;
  el.innerHTML = { saving: 'Enregistrement…', saved: `<i class="fa-solid fa-check" aria-hidden="true"></i> Enregistré`, error: 'Non enregistré' }[state];
  if (state === 'saved') saveState.t = setTimeout(() => { el.className = 'save-state'; }, 1800);
}

let quietSave = false; // enregistrement automatique : l'indicateur suffit, pas de message en bas
async function saveConfig(patch, okMsg = 'Enregistré') {
  const quiet = quietSave;
  saveState('saving');
  try {
    const r = await api('/api/admin/config', { method: 'PUT', body: patch });
    S.config = r.config;
    saveState('saved');
    if (!quiet) toast(okMsg);
    await refresh();
  } catch (e) { saveState('error'); toast(e.message, true); }
}

/**
 * Enregistrement automatique d'un formulaire de réglages : à chaque changement (case, liste, couleur, et champ
 * texte quand on le quitte), fn(FormData, form) construit et envoie le patch. Entrée dans un champ : pareil.
 */
function autoSave(f, fn) {
  if (!f) return;
  // Champ hors de ses bornes (min, max), obligatoire laissé vide, format attendu : rien n'est envoyé, le navigateur le signale
  const valid = (el) => {
    if (el.checkValidity()) return true;
    el.reportValidity();
    saveState('error');
    return false;
  };
  const run = () => { quietSave = true; try { fn(new FormData(f), f); } finally { quietSave = false; } };
  f.onsubmit = (e) => { e.preventDefault(); if (valid(f.contains(document.activeElement) && document.activeElement.checkValidity ? document.activeElement : f)) run(); };
  f.addEventListener('change', (e) => {
    if (e.target.type === 'file' || e.target.closest('[data-nosave]')) return;
    if (!valid(e.target)) return;
    clearTimeout(f.saveTimer);
    f.saveTimer = setTimeout(run, 250); // plusieurs changements d'affilée (flèches d'un nombre) : un seul envoi
  });
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
  const cuts = S.sampleCutouts || [];
  await Promise.all(urls.map(async (u, i) => {
    if (!sampleCache[i]) sampleCache[i] = await loadImage(u);
    if (sampleCache[i] && cuts[i] && !sampleCache[i].cutout) sampleCache[i].cutout = await loadImage(cuts[i]).catch(() => null); // version détourée
  }));
  return urls.map((_, i) => sampleCache[i]).filter(Boolean);
}
/** Photos détourées correspondantes (même photo N), pour les calques avec « Détourage ». */
function cutoutsFromSamples(photos) {
  return Object.fromEntries(Object.entries(photos).filter(([, img]) => img?.cutout).map(([k, img]) => [k, img.cutout]));
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
/** Ce qui s'est passé sur la dernière photo (lu dans son EXIF) : avec ou sans flash. */
function flashState() {
  const c = S.camera || {};
  if (c.flashFired == null) return 'pas encore de photo depuis le branchement du boîtier';
  const at = c.flashFiredAt ? ` (${new Date(c.flashFiredAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})` : '';
  return `dernière photo${at} <span class="badge ${c.flashFired ? 'warn' : ''}">${c.flashFired ? 'prise avec le flash' : 'prise sans flash'}</span>`;
}

/** Section Installation : ce qui est installé sur la machine et ce qui manque, avec de quoi l'installer. */
// ---------- Sauvegarde : export et import de la configuration ----------

let importPreview = null;     // contenu du fichier lu, en attente du choix : { id, sections, templates, secrets… }
let importBackup;             // dernière sauvegarde d'avant import ({ name, at } ou null), undefined = pas encore lue

function backupSection() {
  const im = importPreview;
  const check = (name, value, label, on = true, extra = '') => `<label class="inline"><input type="checkbox" name="${name}" value="${esc(value)}" ${on ? 'checked' : ''}> ${label}${extra}</label>`;
  const tag = (exists) => (exists ? ' <span class="badge warn">remplace</span>' : ' <span class="badge ok">nouveau</span>');
  const importCard = !im ? `
    <form id="formImportRead" class="row">
      <input type="file" name="file" accept=".zip,application/zip" required>
      <button class="btn" type="submit">Lire le fichier</button>
    </form>` : `
    <form id="formImportApply">
      <p class="sub">${esc(im.boothName || 'Borne')}${im.exportedAt ? ` · exporté le ${new Date(im.exportedAt).toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}${im.appVersion ? ` · version ${esc(im.appVersion)}` : ''}</p>
      ${im.sections.length ? `<h4>Réglages</h4><div class="col">${im.sections.map((s) => check('section', s.key, esc(s.label))).join('')}</div>` : ''}
      ${im.templates.length ? `<h4>Templates</h4><div class="col">${im.templates.map((t) => check('template', t.id, esc(t.name), true, tag(t.exists))).join('')}</div>` : ''}
      ${im.secrets ? `<h4>Secrets</h4>${check('secrets', '1', 'Appliquer aussi les codes et mots de passe du fichier', false)}` : ''}
      <div class="row">
        <button class="btn primary" type="submit">Appliquer</button>
        <button class="btn ghost" type="button" id="btnImportCancel">Annuler</button>
      </div>
    </form>`;
  const rev = importBackup ? `
  <div class="card">
    <h3>Dernier import</h3>
    <p class="sub">État d'avant sauvegardé le ${new Date(importBackup.at).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.</p>
    <button class="btn" type="button" id="btnImportRevert">Annuler le dernier import</button>
  </div>` : '';
  return `
  <h2>Sauvegarde</h2>
  <div class="card">
    <h3>Exporter</h3>
    <form id="formExport">
      <div class="col">
        <label class="inline"><input type="checkbox" name="settings" checked> Réglages</label>
        <label class="inline"><input type="checkbox" name="templates" checked> Templates (cadres photo)</label>
        <label class="inline"><input type="checkbox" name="secrets"> Codes et mots de passe (opérateur, admin, Wi-Fi, pont Hue)</label>
      </div>
      <button class="btn primary" type="submit">Télécharger</button>
    </form>
  </div>
  <div class="card">
    <h3>Importer</h3>
    ${importCard}
  </div>
  ${rev}`;
}

function bindBackup() {
  $('#formExport')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const on = (k) => (fd.get(k) ? '1' : '0');
    if (on('settings') === '0' && on('templates') === '0') { toast('Coche au moins un contenu', true); return; }
    location.href = `/api/admin/config/export?settings=${on('settings')}&templates=${on('templates')}&secrets=${on('secrets')}`;
  });
  $('#formImportRead')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Lecture…';
    try {
      importPreview = (await api('/api/admin/config/import/preview', { method: 'POST', form: new FormData(e.target) })).import;
      render();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Lire le fichier'; }
  });
  $('#btnImportCancel')?.addEventListener('click', () => { importPreview = null; render(); });
  $('#formImportApply')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { id: importPreview.id, sections: fd.getAll('section'), templates: fd.getAll('template'), secrets: !!fd.get('secrets') };
    if (!body.sections.length && !body.templates.length) { toast('Rien de coché', true); return; }
    if (!await askConfirm('Appliquer l\'import ? L\'état actuel est sauvegardé avant.', 'Appliquer')) return;
    try {
      await api('/api/admin/config/import/apply', { method: 'POST', body });
      importPreview = null; importBackup = undefined;
      toast('Configuration importée');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });
  $('#btnImportRevert')?.addEventListener('click', async () => {
    if (!await askConfirm('Revenir à l\'état d\'avant le dernier import ?', 'Revenir', 'delete')) return;
    try { await api('/api/admin/config/import/revert', { method: 'POST' }); toast('État d\'avant rétabli'); await refresh(); } catch (err) { toast(err.message, true); }
  });
  if (importBackup === undefined) {
    importBackup = null;
    api('/api/admin/config/import/backup').then((d) => { importBackup = d.backup; if (currentSection() === 'backup' && importBackup) render(); }).catch(() => {});
  }
}

function installSection() {
  const su = S.setup;
  const pm = { brew: 'Homebrew', apt: 'apt (Debian, Ubuntu)', dnf: 'dnf (Fedora)' }[su?.pkg] || null;
  const os = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[su?.platform] || su?.platform || '';
  return `
  <h2>Installation</h2>
  <p class="sub">${esc(os)}${pm ? ` · ${esc(pm)}` : ''}</p>
  ${updateCard()}
  ${setupCard()}`;
}

/** Mise à jour en attente sur GitHub : pastille sur « Installation » dans le menu, bandeau du tableau de bord. */
const updatePending = () => !!(S?.update?.available && S.update.behind && !S.update.updating && !S.update.needRestart);
const pendingVersion = () => (S.update.remoteVersion && S.update.remoteVersion !== S.update.version ? S.update.remoteVersion : '');
function syncUpdateNav() {
  const a = document.querySelector('#nav a[href="#install"]');
  let b = a?.querySelector('.nav-badge');
  if (!updatePending()) { b?.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; a.append(b); }
  b.textContent = pendingVersion() || 'MAJ';
}

async function installUpdate() {
  const u = S.update || {};
  const target = pendingVersion();
  // Nouveautés : un commit par version (« 0.8.28 : … »), le numéro en gras
  const list = (u.incoming || []).filter((x) => !/^Merge /.test(x)).map((x) => { const m = x.match(/^(\d+\.\d+\.\d+)\s*:\s*(.*)$/); return m ? `<b>${esc(m[1])}</b> ${esc(m[2])}` : esc(x); });
  const title = target ? `Mettre à jour vers la ${target} ?` : 'Mettre à jour la borne ?';
  const text = `Version installée : ${u.version || '?'}. ${u.canRestart ? 'La borne redémarre toute seule à la fin.' : 'La borne devra ensuite redémarrer.'}`;
  if (!await askConfirm(text, 'Mettre à jour', 'retake', { title, list, tone: 'primary' })) return;
  try { S.update = (await api('/api/admin/update/install', { method: 'POST' })).update; } catch (err) { toast(err.message, true); return; }
  if (currentSection() === 'install') render(); else location.hash = 'install'; // progression sur la page Installation
  pollUpdate();
}

/** Version en cours et mise à jour depuis GitHub (dépôt git). */
function updateCard() {
  const u = S.update;
  if (!u) return '';
  const when = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const version = u.version || u.commit || '?';
  const badge = !u.available ? '' : u.updating ? '<span class="badge warn">mise à jour en cours…</span>'
    : u.needRestart ? '<span class="badge warn">redémarrage nécessaire</span>'
    : u.behind ? `<span class="badge warn">${u.remoteVersion && u.remoteVersion !== u.version ? `${esc(u.remoteVersion)} disponible` : 'correctifs disponibles'}</span>`
    : u.behind === 0 ? '<span class="badge ok">à jour</span>' : '';
  return `
  <div class="card">
    <div class="inst-head">
      <div>
        <div class="inst-kicker">Version</div>
        <div class="inst-version">${esc(version)} ${/^0\./.test(u.version || '') ? '<span class="badge">Bêta</span> ' : ''}${badge}</div>
        ${u.available ? `<div class="cell-sub">${when(u.date)} · <code>${esc(u.commit || '?')}</code>${u.branch && u.branch !== 'main' ? ` · branche ${esc(u.branch)}` : ''}${u.checkedAt ? ` · vérifié ${when(u.checkedAt)}` : ''}</div>` : ''}
      </div>
      ${u.available ? `<div class="cell-actions">
        ${u.needRestart && u.canRestart ? '<button class="btn small secondary" id="btnUpdateRestart">Relancer le logiciel</button>' : ''}
        ${u.behind && !u.updating ? '<button class="btn small primary" id="btnUpdateInstall">Mettre à jour</button>' : ''}
        <button class="btn small" id="btnUpdateCheck" ${u.updating ? 'disabled' : ''}>Rechercher une mise à jour</button>
      </div>` : ''}
    </div>
    ${u.incoming?.length && !u.updating ? `<ul class="update-list">${u.incoming.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${u.updating ? updateProgress(u.step) : ''}
    ${u.error ? `<div class="alert" style="margin:12px 0 0">${esc(u.error)}</div>` : ''}
  </div>`;
}

/** Barre de progression de la mise à jour, par étape (la relance qui suit a son propre écran). */
const UPDATE_STEPS = [['pull', 'Téléchargement'], ['deps', 'Dépendances'], ['modules', 'Modules']];
function updateProgress(step) {
  const i = Math.max(0, UPDATE_STEPS.findIndex(([id]) => id === step));
  const pct = Math.round(((i + 0.5) / UPDATE_STEPS.length) * 100);
  return `<div class="update-progress">
      <div class="update-bar"><span style="width:${pct}%"></span></div>
      <div class="cell-sub">Étape ${i + 1} / ${UPDATE_STEPS.length} · ${UPDATE_STEPS[i][1]}</div>
    </div>`;
}

function pollUpdate() {
  clearTimeout(pollUpdate.t);
  pollUpdate.t = setTimeout(async () => {
    // Serveur injoignable en pleine mise à jour : il est en train de se relancer.
    try { S.update = (await api('/api/admin/update')).update; } catch { if (S.update?.updating || S.update?.restarting) waitRelaunch(); return; }
    if (S.update?.restarting) return waitRelaunch();
    if (currentSection() === 'install') render(); else syncUpdateNav();
    if (S.update?.updating) pollUpdate();
  }, 1500);
}

/** Carte d'état de l'installation (page Installation). */
function setupCard() {
  const su = S.setup;
  if (!su) return '<div class="card"><p class="sub">État de l\'installation indisponible : serveur à redémarrer.</p></div>';
  const missing = su.items.filter((it) => it.state !== 'ok');
  const pending = missing.filter((it) => it.auto);
  const badge = su.installing ? '<span class="badge warn">installation en cours…</span>'
    : missing.length ? `<span class="badge ${missing.some((it) => it.required) ? 'err' : 'warn'}">${plural(missing.length, 'manquant', 'manquants')}</span>`
    : '<span class="badge ok">tout est installé</span>';
  const at = su.at ? new Date(su.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  const state = (it) => (it.state === 'ok' ? '<span class="hw-dot ok"></span>' : `<span class="hw-dot ${it.required ? 'err' : 'warn'}"></span>`);
  const rows = su.items.map((it) => `
      <tr class="${it.state === 'ok' ? '' : it.required ? 'row-err' : 'row-warn'}">
        <td class="inst-dot">${state(it)}</td>
        <td><div class="cell-title">${esc(it.label)}${it.required ? ' <span class="badge">indispensable</span>' : ''}</div></td>
        <td class="cell-sub">${esc(it.detail)}</td>
        <td class="inst-fix">${it.state !== 'ok' && it.fix ? `<code>${esc(it.fix)}</code>` : ''}</td>
      </tr>`).join('');
  return `
  <div class="card">
    <div class="inst-head">
      <div>
        <div class="inst-kicker">Modules</div>
        <div class="inst-version">${su.items.length - missing.length} / ${su.items.length} ${badge}</div>
        <div class="cell-sub">vérifié à ${at}</div>
      </div>
      <div class="cell-actions">
        ${pending.length ? `<button class="btn small primary" type="button" id="btnSetupInstall" ${su.installing ? 'disabled' : ''}>Installer ce qui manque (${pending.length})</button>` : ''}
        <button class="btn small" type="button" id="btnSetupCheck">Revérifier</button>
      </div>
    </div>
    <table class="data-table inst-table">
      <thead><tr><th></th><th>Module</th><th>État</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${su.log?.length ? `<pre class="setup-log">${esc(su.log.slice(-12).join('\n'))}</pre>` : ''}
    ${su.error ? `<div class="alert" style="margin:12px 0 0">Dernière installation : ${esc(su.error)}</div>` : ''}
  </div>`;
}

/** Installation en cours : l'état est relu toutes les 2 s jusqu'à la fin. */
function pollSetup() {
  clearTimeout(pollSetup.t);
  pollSetup.t = setTimeout(async () => {
    try { S.setup = (await api('/api/admin/setup')).setup; } catch { return; }
    if (['dashboard', 'install'].includes(currentSection())) render();
    if (S.setup?.installing) pollSetup();
  }, 2000);
}

/** Tableau de bord : les réglages qui font la soirée, une ligne par sujet, chacune menant à sa section. */
function settingsSummary() {
  const cfg = S.config;
  const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
  const chip = (t, cls = '') => `<span class="sum-chip ${cls}">${t}</span>`;
  const on = (ok, yes, no) => chip(ok ? yes : no, ok ? 'on' : 'off');
  // Tuile : titre, grand chiffre (ou nom), précision, puces ; alerte en rouge ; toute la tuile mène à sa section
  const tile = ({ title, big, sub = '', chips = [], alert = '', href, extra = '' }) => `
    <a class="sum-tile ${alert ? 'alert' : ''}" href="${href}">
      <span class="sum-title">${title}<span class="hw-go" aria-hidden="true"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span></span>
      <span class="sum-big">${big}</span>
      ${sub ? `<span class="sum-sub">${sub}</span>` : ''}
      ${extra}
      ${chips.length ? `<span class="sum-chips">${chips.filter(Boolean).join('')}</span>` : ''}
      ${alert ? `<span class="sum-alert">${alert}</span>` : ''}
    </a>`;

  // Cadres
  const tc = cfg.templates;
  const enabled = S.templates.filter((t) => tc.enabled.includes(t.id));
  const animated = enabled.filter((t) => t.kind === 'gif' || t.kind === 'boomerang');
  const def = S.templates.find((t) => t.id === tc.default);
  const defOk = !!def && tc.enabled.includes(def.id);
  const effDefault = defOk ? def : enabled[0];
  const shownNames = enabled.slice(0, 4).map((t) => chip(esc(t.name))).join('') + (enabled.length > 4 ? chip(`+${enabled.length - 4}`) : '');
  const cadres = tile({
    title: 'Cadres', href: '#templates',
    big: `${enabled.length}<small> / ${S.templates.length}</small>`,
    sub: effDefault ? `par défaut : ${esc(effDefault.name)}` : '',
    chips: [shownNames, enabled.length > 1 ? on(tc.guestCanChoose, 'choix de l\'invité', 'pas de choix') : '', animated.length ? on(tc.gifEnabled, 'GIF proposés', 'GIF masqués') : ''],
    alert: !enabled.length ? 'Aucun cadre activé' : !defOk ? `« ${esc(def?.name || tc.default)} » (défaut) est désactivé` : ''
  });

  // Filtres
  const f = cfg.booth.filters || {};
  const fname = (id) => FILTERS.find((x) => x.id === id)?.name || id;
  const avail = (f.available || []).filter((id) => FILTERS.some((x) => x.id === id));
  const filtres = tile({
    title: 'Filtres', href: '#flow',
    big: f.enabled ? `${avail.length}<small> proposés</small>` : '<small>désactivés</small>',
    sub: `par défaut : ${esc(fname(f.default || 'none'))}`,
    chips: f.enabled ? avail.map((id) => chip(esc(fname(id)))) : []
  });

  // Apparence : nom du thème et ses couleurs
  const theme = cfg.theme.active === 'custom' ? 'Personnalisé' : (S.themes.find((t) => t.id === cfg.theme.active)?.name || cfg.theme.active);
  const c = S.theme.colors || {};
  const swatches = `<span class="sum-swatches">${['background', 'primary', 'secondary', 'surface'].map((k) => `<i style="background:${esc(c[k] || '#ccc')}"></i>`).join('')}</span>`;
  const apparence = tile({
    title: 'Apparence', href: '#theme',
    big: esc(theme), extra: swatches,
    chips: [chip(S.theme.defaultLogo ? 'logo Cheeesy' : 'logo importé'), on(!!S.theme.backgroundImage, S.theme.backgroundImage.startsWith('/pattern.svg') ? 'motif de fond' : 'image de fond', 'sans image de fond')]
  });

  // Tirages : quota avec jauge
  const l = cfg.limits;
  const fmt = S.formats?.[tc.defaultFormat]?.name || tc.defaultFormat;
  const quota = l.eventQuota > 0 ? l.eventQuota : null;
  const used = quota ? quota - (S.counters.quotaRemaining ?? quota) : 0;
  const gauge = quota ? `<span class="sum-gauge"><i style="width:${Math.min(100, Math.round((used / quota) * 100))}%"></i></span><span class="sum-sub">${used} / ${quota} tirages du quota</span>` : '';
  const tirages = tile({
    title: 'Tirages', href: '#printing',
    big: `${l.maxCopiesPerSession}<small> max par passage</small>`,
    extra: gauge,
    chips: [chip(esc(fmt)), on(l.allowZeroCopies, 'sans impression possible', 'impression obligatoire'), quota ? '' : chip('quota illimité')],
    alert: S.counters.quotaReached ? 'Quota atteint' : ''
  });

  // Parcours
  const parcours = tile({
    title: 'Parcours', href: '#flow',
    big: `${l.countdownSec} s<small> de décompte</small>`,
    chips: [chip(l.maxRetakesPerSession < 0 ? 'reprises illimitées' : plural(l.maxRetakesPerSession, 'reprise')), on(cfg.booth.mirrorPreview, 'miroir', 'sans miroir'), chip(`accueil après ${cfg.booth.idleReturnSec} s`)]
  });

  // Partage
  const sh = cfg.share || {}, g = cfg.gallery || {};
  const wifi = !!S.devices?.network?.wifi;
  const qrOn = sh.qrOnDone !== false;
  const qrShown = qrOn && (wifi || sh.requireWifi === false);
  const partage = tile({
    title: 'Partage', href: '#sharing',
    big: qrOn ? (qrShown ? '<small>QR code affiché</small>' : '<small>QR code masqué</small>') : '<small>QR code désactivé</small>',
    chips: [on(!!sh.wifi?.enabled, `Wi-Fi « ${esc(sh.wifi?.ssid || '')} »`, 'pas de QR Wi-Fi'), on(!!g.booth, 'galerie borne', 'galerie borne fermée'), on(!!g.web, 'galerie téléphone', 'galerie téléphone fermée')],
    alert: qrOn && !qrShown ? 'Pas de Wi-Fi : les invités ne peuvent pas récupérer leur photo' : ''
  });

  return `
  <div class="card">
    <h3>Réglages de la soirée</h3>
    <div class="sum-grid">${cadres}${filtres}${apparence}${tirages}${parcours}${partage}</div>
  </div>`;
}

/** Luminosité de ring light retenue par le calibrage (mode auto), pour les résumés. */
const autoLight = () => { const p = S.config.camera.control?.mode === 'auto' ? S.config.camera.control.auto?.profile : null; return p?.light?.brightness ? ` · ${p.light.brightness} %${p.light.kelvin ? `, ${p.light.kelvin} K` : ''}` : ''; };

/** Tableau de bord : le réglage de la borne, puis la dernière photo, et un conseil si les deux ne collent pas. */
function flashSummary() {
  const c = S.camera || {};
  if (S.lights?.ringLight) return `jamais, ring light branchée${autoLight()}`;
  const manual = c.flashControl === false;
  const autoProfile = S.config.camera.control?.mode === 'auto' ? S.config.camera.control.auto?.profile : undefined;
  const mode = manual ? 'manuel : levé à la main, il part à chaque photo'
    : autoProfile !== undefined ? `mode Auto : ${autoProfile?.flash ? 'la borne le lève (réglage du calibrage)' : 'sans flash (réglage du calibrage)'}`
    : { off: 'la borne ne le lève jamais', on: 'la borne le lève avant chaque photo', auto: 'la borne le lève si la scène est sombre' }[c.flash] || 'la borne ne le lève jamais';
  const stray = c.flashStray || (!manual && c.flash === 'off' && c.flashFired === true && c.control !== 'auto')
    ? ' · <span class="badge err">levé : à rabattre à la main</span> <small>il part à chaque photo, même quand la borne ne le demande pas</small>' : '';
  return `${mode} · ${flashState()}${stray}`;
}

// ---------- Tableau de bord : liste du matériel ----------

const HW_ICONS = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  printer: '<path d="M7 9V4h10v5M7 17H4v-8h16v8h-3"/><path d="M7 14h10v6H7z"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
  deck: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7.5 10h2M11 10h2M14.5 10h2M7.5 14h2M11 14h2M14.5 14h2"/>',
  lights: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  setup: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
  usb: '<path d="M9 3h6v6H9z"/><path d="M7 9h10v9a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3z"/><path d="M11 5h.01M13 5h.01"/>',
  disk: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14h18M7 16.5h.01M11 16.5h.01"/>'
};
const go = (n) => `${(n / 1e9).toFixed(n < 10e9 ? 1 : 0).replace('.', ',')} Go`;
/** Barre de remplissage (couleur de l'état : ok, warn, err). */
const hwBar = (part, whole, state) => `<span class="hw-bar ${state}"><span style="width:${Math.min(100, Math.max(0, whole ? (part / whole) * 100 : 0)).toFixed(1)}%"></span></span>`;
/** Place disque : utilisé sur le total, barre de remplissage, place libre. */
const usage = (free, total, state) => (total ? { status: `${go(total - free)} utilisés sur ${go(total)}`, detail: `${hwBar(total - free, total, state)}${gb(free)}` } : { status: gb(free), detail: '' });

/** Place libre pour les photos : alerte sous 5 Go, erreur sous 1 Go. */
function diskRow() {
  const d = S.disk;
  if (!d) return '';
  const state = d.free < 1e9 ? 'err' : d.low ? 'warn' : 'ok';
  const u = usage(d.free, d.total, state);
  return hwRow('disk', 'Stockage', state, u.status, u.detail, '#events');
}
/** Clé USB au tableau de bord : seulement quand une clé est branchée ou qu'une copie tourne. */
function usbRow() {
  const u = S.usb;
  if (!u?.available || (!u.volume && !u.exporting)) return '';
  const x = u.exporting;
  if (x) return hwRow('usb', 'Clé USB', 'warn', `copie ${x.done} / ${x.total}`, `${hwBar(x.done, x.total, 'ok')}${esc(x.eventName)}`, '#events');
  const v = u.volume;
  const full = v.total ? usage(v.free, v.total, v.free < 0.1 * v.total ? 'warn' : 'ok') : { status: gb(v.free), detail: '' };
  return hwRow('usb', 'Clé USB', u.error ? 'err' : 'ok', `${esc(v.name)} · ${full.status}`, u.error ? `<b class="hw-err">${esc(u.error)}</b>` : full.detail, '#events');
}

/** Une ligne d'appareil : icône, pastille d'état (ok, warn, err, off), nom, état, détail, lien vers ses réglages. */
function hwRow(icon, title, state, status, detail, href) {
  return `<a class="hw-row" href="${href}">
    <svg class="hw-icon" viewBox="0 0 24 24" aria-hidden="true">${HW_ICONS[icon]}</svg>
    <span class="hw-main"><span class="hw-head"><b>${title}</b><span class="hw-dot ${state}"></span><span class="hw-status">${status}</span></span>${detail ? `<span class="hw-detail">${detail}</span>` : ''}</span>
    <span class="hw-go" aria-hidden="true"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span></a>`;
}

function hardwareList() {
  const cam = S.camera || {};
  const camDev = S.devices.camera || {};
  const camName = cam.driver === 'gphoto2'
    ? esc((camDev.reason || '').replace(/ détecté en USB.*$/, '') || cam.model || 'Boîtier')
    : { browser: 'Webcam du navigateur', mock: 'Simulation (photos d\'exemple)', starting: 'En préparation…' }[cam.driver] || esc(cam.driver);
  const camState = !cam.ok ? 'err' : cam.driver === 'gphoto2' ? 'ok' : 'warn';
  const camErr = cam.lastCaptureError ? `<b class="hw-err">Dernier échec (${new Date(cam.lastCaptureError.at).toLocaleTimeString('fr-FR')}) : ${esc(cam.lastCaptureError.message)}</b>` : cam.lastError ? `<b class="hw-err">${esc(cam.lastError)}</b>` : '';
  const camDetail = [cam.driver === 'gphoto2' ? (cam.liveview ? 'aperçu en cours' : cam.standby ? 'aperçu en veille, obturateur fermé' : '') : '', cam.driver === 'gphoto2' ? `flash : ${flashSummary()}` : '', camErr].filter(Boolean).join('<br>');

  const pr = S.printer || {};
  const noPrinter = pr.driver === 'none';
  const prName = noPrinter ? 'Aucune' : pr.driver === 'mock' ? 'Simulation' : esc(S.config.printer.cups?.name || pr.driver);
  const prState = noPrinter ? 'off' : !pr.ok ? 'err' : pr.driver === 'mock' ? 'warn' : 'ok';
  const prDetail = noPrinter ? 'impression désactivée, QR code seulement' : esc(pr.message || '');

  const n = S.devices.network;
  const wifi = n ? hwRow('wifi', 'Wi-Fi', n.wifi ? 'ok' : 'err', n.wifi ? `connecté · ${esc(n.ip)}` : 'absent',
    n.wifi ? `QR codes vers <code>${esc(S.shareBaseUrl)}</code>` : S.config.share.requireWifi === false ? 'QR codes affichés quand même' : 'QR codes des photos masqués', '#sharing') : '';

  const d = S.streamDeck || {};
  const deck = hwRow('deck', 'Stream Deck', !d.enabled ? 'off' : d.connected ? 'ok' : 'off',
    !d.enabled ? 'désactivé' : d.connected ? `${esc(d.model)} · ${d.keys} touches` : 'non branché',
    d.enabled && !d.connected ? (d.error ? esc(d.error) : 'recherché toutes les 3 s') : '', '#control');

  const L = S.lights;
  let lights = '';
  if (L?.available) {
    const on = L.devices.filter((x) => x.online).length;
    const state = !L.enabled ? 'off' : !L.devices.length ? 'warn' : on === L.devices.length ? 'ok' : on ? 'warn' : 'err';
    const scene = { idle: 'accueil', shooting: 'prise de vue' }[L.scene];
    const status = !L.enabled ? 'désactivées' : !L.devices.length ? 'aucune trouvée' : `${on} / ${L.devices.length} en ligne${scene ? ` · scène ${scene}` : ''}`;
    const chips = L.enabled && L.devices.length ? `<span class="hw-chips">${L.devices.map((x) => `<span class="hw-chip ${x.online ? '' : 'off'}" title="${esc(`${x.sku} · ${x.ip}`)}"><span class="hw-dot ${x.online ? 'ok' : 'err'}"></span>${esc(x.name || `${x.type[0].toUpperCase()}${x.type.slice(1)} ${x.ip.split('.').pop()}`)}</span>`).join('')}</span>` : '';
    lights = hwRow('lights', 'Lumières', state, status, (L.error ? `<b class="hw-err">${esc(L.error)}</b>` : '') + chips, '#lights');
  }
  // Écran de la borne en DDC/CI (luminosité, volume), voir screenSection()
  const sc = S.screen;
  let screen = '';
  if (sc && !sc.off) {
    const name = sc.display ? esc(sc.display.name || 'Écran externe') : sc.available ? 'Aucun écran pilotable' : 'Non disponible';
    const state = !sc.available ? 'err' : !sc.display ? 'off' : sc.error ? 'warn' : 'ok';
    const values = sc.display ? [sc.brightness != null ? `luminosité ${sc.brightness} %` : '', sc.volumeOk && sc.volume != null ? `volume ${sc.volume} %` : ''].filter(Boolean).join(' · ') : '';
    const how = sc.display ? `DDC/CI (${esc(sc.tool)}), ${sc.managed ? 'réglé par la borne' : 'réglages de l\'écran laissés tels quels'}` : sc.available && !sc.error ? `${esc(sc.tool)} prêt : aucun écran externe ne répond en DDC/CI` : '';
    screen = hwRow('screen', 'Écran', state, values ? `${name} · ${values}` : name, [sc.error ? `<b class="hw-err">${esc(sc.error)}</b>` : '', how].filter(Boolean).join('<br>'), '#control');
  }
  // Installation : résumé, le détail est sur sa page
  const su = S.setup;
  let install = '';
  if (su) {
    const missing = su.items.filter((it) => it.state !== 'ok');
    const state = su.installing ? 'warn' : !missing.length ? 'ok' : missing.some((it) => it.required) ? 'err' : 'warn';
    const status = su.installing ? 'installation en cours…' : missing.length ? plural(missing.length, 'élément manquant', 'éléments manquants') : 'tout est installé';
    install = hwRow('setup', 'Installation', state, status, missing.length ? esc(missing.map((it) => it.label).join(', ')) : `${su.items.length} éléments vérifiés`, '#install');
  }
  return `<div class="hw-list">
    ${hwRow('camera', 'Appareil photo', camState, camName, camDetail, '#camera')}
    ${hwRow('printer', 'Imprimante', prState, prName, prDetail, '#printing')}
    ${screen}${wifi}${deck}${lights}${usbRow()}${diskRow()}${install}
  </div>`;
}

function dashboard() {
  const c = S.counters;
  const cfg = S.config;
  const stat = (v, l, cls = '') => `<div class="stat ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  return `
  <h2>Tableau de bord</h2>
  ${(S.dataWarnings || []).map((w) => `<div class="alert">${esc(w)}</div>`).join('')}
  ${updatePending() ? `<div class="update-banner"><span><b>Mise à jour disponible</b>${pendingVersion() ? ` · ${esc(pendingVersion())}` : ''}</span><button class="btn small primary" id="btnDashUpdate">Mettre à jour</button></div>` : ''}
  <p class="sub">Événement en cours : <b>${esc(c.eventName)}</b> · <a href="#events">changer ou en créer un</a></p>
  <div class="grid stats4">
    ${stat(c.printed, 'tirages imprimés')}
    ${stat(c.quotaRemaining === null ? '<i class="fa-solid fa-infinity" aria-hidden="true"></i>' : c.quotaRemaining, 'quota restant', c.quotaReached ? 'err' : '')}
    ${stat(c.paperRemaining === null ? '—' : c.paperRemaining, 'feuilles restantes', c.lowPaper ? 'warn' : '')}
    ${stat(c.sessions, 'sessions')}
  </div>
  <div class="grid-2" style="margin-top:22px">
    <div class="card">
      <h3>Matériel</h3>
      ${hardwareList()}
    </div>
    <div class="card">
      <h3>Consommables</h3>
      <div class="cons-list">
        <div class="sum-tile cons-tile ${c.lowPaper ? 'alert' : ''}">
          <span class="sum-title">Papier</span>
          <span class="sum-big">${c.paperRemaining ?? '—'}<small> ${c.paperRemaining === null ? 'non suivi' : 'feuilles'}</small></span>
          <span class="sum-sub">alerte sous ${cfg.limits.lowPaperThreshold} feuilles</span>
          <div class="cons-actions">
            <input id="paperInput" type="number" min="0" value="${c.paperRemaining ?? ''}" placeholder="feuilles chargées">
            <button class="btn small primary" id="btnPaper">Mettre à jour</button>
            ${c.paperRemaining === null ? '' : '<button class="btn small link-danger" id="btnPaperOff">Ne plus suivre</button>'}
          </div>
        </div>
        <div class="sum-tile cons-tile ${c.quotaReached ? 'alert' : ''}">
          <span class="sum-title">Tirages de l'événement</span>
          <span class="sum-big">${c.printed}<small>${cfg.limits.eventQuota ? ` / ${cfg.limits.eventQuota}` : ''}</small></span>
          ${cfg.limits.eventQuota ? `<span class="sum-gauge"><i style="width:${Math.min(100, Math.round((c.printed / cfg.limits.eventQuota) * 100))}%"></i></span>` : '<span class="sum-sub">quota illimité</span>'}
          <div class="cons-actions"><button class="btn small link-danger" id="btnResetPrinted" ${c.printed ? '' : 'disabled'}>Remettre à zéro</button></div>
        </div>
        <div class="sum-tile cons-tile">
          <span class="sum-title">Sessions de l'événement</span>
          <span class="sum-big">${c.sessions}<small> ${c.sessions > 1 ? 'sessions' : 'session'}</small></span>
          <div class="cons-actions"><a class="btn small" href="#sessions">Photos</a><button class="btn small link-danger" id="btnResetSessions" ${c.sessions ? '' : 'disabled'}>Vider l'événement</button></div>
        </div>
      </div>
    </div>
  </div>
  ${settingsSummary()}`;
}

const sel = (name, list, cur) => `<select name="${name}">${list.map((d) => `<option value="${d}" ${cur === d ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
const when = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR') : '—');
const det = (d) => `<div class="detect"><b>${esc(d.driver)}</b> <small>· ${esc(d.reason)} · vérifié à ${when(d.checkedAt)}</small></div>`;

function flow() {
  const l = S.config.limits;
  const b = S.config.booth;
  return `
  <h2>Parcours invité</h2>
  <p class="sub">Le déroulé d'un passage à la borne, de l'accueil à la fin. Chaque changement est enregistré tout de suite.</p>
  <form id="formFlow">
    <div class="card">
      <h3>Séance photo</h3>
      <div class="grid-2">
        <div>
          <label>Décompte avant la photo (secondes) <input name="countdownSec" type="number" min="1" max="10" value="${l.countdownSec}"></label>
          <label>Reprises de photo autorisées (0 = aucune)
            <div class="row"><input name="maxRetakesPerSession" type="number" min="0" max="50" value="${Math.max(0, l.maxRetakesPerSession)}" ${l.maxRetakesPerSession < 0 ? 'disabled' : ''} style="width:120px">
            <label class="inline"><input name="retakesUnlimited" type="checkbox" ${l.maxRetakesPerSession < 0 ? 'checked' : ''} onchange="this.form.maxRetakesPerSession.disabled = this.checked"> Illimité</label></div>
          </label>
        </div>
        <div>
          <label class="inline"><input name="mirrorPreview" type="checkbox" ${b.mirrorPreview ? 'checked' : ''}> Aperçu en miroir (plus naturel pour l'invité)</label>
          <small>La photo finale est retournée elle aussi : chacun reste là où il s'est vu par rapport aux éléments du template. Un texte dans la scène (t-shirt, pancarte) sort à l'envers.</small>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>Filtres</h3>
      <label class="inline"><input name="filtersEnabled" type="checkbox" ${b.filters?.enabled ? 'checked' : ''}> Proposer des filtres à l'invité</label>
      <small>Sur « On la garde ? » : l'invité choisit un filtre sous sa photo avant de la garder ou de l'imprimer. Il s'applique à tout le montage : photos, cadre, textes et logo (le grain des filtres argentiques : photos seulement). GIF et boomerangs compris.</small>
      <table class="filter-table">
        <thead><tr><th>Filtre</th><th>Proposé</th><th>Par défaut</th></tr></thead>
        <tbody>${FILTERS.map((f) => {
          const avail = b.filters?.available || FILTERS.map((x) => x.id);
          const def = b.filters?.default || 'none';
          return `<tr><td>${esc(f.name)}</td>
            <td><input type="checkbox" name="filter_${f.id}" ${avail.includes(f.id) ? 'checked' : ''} aria-label="Proposer ${esc(f.name)}"></td>
            <td><input type="radio" name="filterDefault" value="${f.id}" ${def === f.id ? 'checked' : ''} aria-label="${esc(f.name)} par défaut"></td></tr>`;
        }).join('')}</tbody>
      </table>
      <small>Le filtre par défaut est appliqué d'emblée à la photo ; l'invité peut en choisir un autre parmi ceux proposés (le défaut l'est d'office). Sans choix proposé à l'invité, le filtre par défaut s'applique à toutes les photos.</small>
    </div>
    <div class="card">
      <h3>Délais</h3>
      <p class="sub">En secondes, 0 = jamais. Un toucher, une touche du clavier ou du Stream Deck repousse les retours à l'accueil ; changer de filtre ou de nombre de tirages ne relance pas les délais des écrans « ${esc(S.config.texts.review)} » et « ${esc(S.config.texts.copies)} ».</p>
      <div class="grid-2">
        <div>
          <label>« ${esc(S.config.texts.review)} » : photo gardée toute seule après <input name="reviewTimeoutSec" type="number" min="0" max="300" value="${l.reviewTimeoutSec}"></label>
          <label>« ${esc(S.config.texts.copies)} » sans action, après <input name="copiesTimeoutSec" type="number" min="0" max="600" value="${l.copiesTimeoutSec ?? 30}"></label>
          <label>… la borne <select name="copiesTimeoutAction">${[['print', 'imprime le nombre affiché'], ['skip', 'termine sans impression']].map(([v, lb]) => `<option value="${v}" ${(l.copiesTimeoutAction || 'print') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select></label>
          <small>« termine sans impression » seulement si l'invité a le droit de ne pas imprimer (<a href="#printing">Impression</a>), sinon la borne imprime.</small>
        </div>
        <div>
          <label>Personne ne lance la photo : retour à l'accueil après <input name="captureTimeoutSec" type="number" min="0" max="600" value="${l.captureTimeoutSec ?? 30}"></label>
          <label>Choix du cadre et galerie sans interaction : retour après <input name="menuIdleSec" type="number" min="0" max="600" value="${b.menuIdleSec ?? 30}"></label>
          <label>Écran de fin : retour à l'accueil après <input name="idleReturnSec" type="number" min="5" max="300" value="${b.idleReturnSec}"></label>
        </div>
      </div>
    </div>
  </form>`;
}

function printing() {
  const cfg = S.config;
  const l = cfg.limits;
  return `
  <h2>Impression</h2>
  <p class="sub">Sans imprimante détectée, la borne n'affiche rien de l'impression : l'invité termine directement (avec le QR code en Wi-Fi). Chaque changement est enregistré et appliqué tout de suite.</p>
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
        <small>Ce qui se passe si l'invité ne choisit rien : <a href="#flow">Parcours invité <i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Délais</a>.</small>
      </div>
      <div>
        <label>Quota de tirages de l'événement (0 = illimité) <input name="eventQuota" type="number" min="0" value="${l.eventQuota}"></label>
        <label>Alerte papier en dessous de (feuilles) <input name="lowPaperThreshold" type="number" min="0" value="${l.lowPaperThreshold}"></label>
        <small>Le stock de papier se met à jour depuis le <a href="#dashboard">tableau de bord</a>.</small>
      </div>
    </div>
  </form>`;
}

/** Polices de la borne (booth.css, body[data-font]) pour les aperçus de l'admin. */
const TP_FONTS = { system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', rounded: '"Arial Rounded MT Bold", "Nunito", "Quicksand", -apple-system, sans-serif', serif: 'Georgia, "Times New Roman", serif' };
/** Variables CSS (--tp-*) d'un aperçu de la borne, pour un jeu de couleurs, une police et une image de fond. */
function tpVars(colors, font, bgImage = '') {
  const c = colors;
  // Texte des cartes : la couleur la plus lisible sur « Cartes », même règle que la borne (booth.js, readableOn)
  const onSurface = [c.text, c.background, c.secondary, '#ffffff', '#000000'].reduce((best, x) => (contrast(c.surface, x) > contrast(c.surface, best) ? x : best));
  return `${['primary', 'secondary', 'background', 'surface', 'text', 'onPrimary'].map((k) => `--tp-${k}:${c[k]}`).join(';')};--tp-on-surface:${onSurface};--tp-font:${TP_FONTS[font] || TP_FONTS.system}${bgImage ? `;--tp-bg-image:url('${bgImage}')` : ''}`;
}
/** Image de fond d'un aperçu : celle importée pour la borne passe avant celle du thème (themes.js, resolve). */
const tpBgImage = (theme) => S.config.booth.backgroundImage || S.config.theme.custom.backgroundImage || theme?.backgroundImage || '';
/** Thème personnalisé : son motif de fond, à la couleur des titres (même URL que themes.js, patternUrl). */
const customPattern = (id, colors) => ({ backgroundImage: S.patterns.some((p) => p.id === id) ? `/pattern.svg?p=${id}&c=${String(colors.secondary).replace('#', '')}&o=8` : '' });
/** Logo pour un jeu de couleurs : le logo Cheeesy par défaut suit l'accent et le texte des boutons, un logo importé reste tel quel. */
const logoFor = (colors) => (S.theme.defaultLogo ? `/logo.svg?c=${String(colors.primary).replace('#', '')}&t=${String(colors.onPrimary).replace('#', '')}` : S.theme.logo);
/** Accueil de la borne en miniature : carte d'un thème, et premier écran de l'aperçu. */
function tpIdleScreen(t, logo, sample) {
  return `<div class="tp-screen tp-idle">
    <img class="tp-logo" src="${esc(logo)}" alt="">
    <div class="tp-headline">${esc(t.welcome)}</div>
    <div class="tp-gal"><span class="tp-stack">${[0, 1, 2].map(() => `<i${sample ? ` style="background-image:url('${esc(sample)}')"` : ''}></i>`).join('')}</span><span><b>${esc(t.gallery)}</b><small>24 photos <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></small></span></div>
  </div>`;
}

function themeSection() {
  const cfg = S.config;
  const custom = cfg.theme.custom;
  const colors = custom.colors;
  const logo = S.theme.logo;
  const bg = S.theme.backgroundImage;
  // Nom de la couleur, puis où elle apparaît sur la borne
  const colorField = (k, label, where) => `<label class="swatch"><span>${label}</span><input type="color" name="color_${k}" value="${esc(colors[k])}"><small>${where}</small></label>`;
  const isCustom = cfg.theme.active === 'custom';
  const t = cfg.texts;
  const sample = S.samples?.[0];
  // Une carte par thème livré, puis « Personnalisé » : l'accueil de la borne dans les couleurs du thème
  const themeCard = (id, name, style, checked, cardLogo) => `<label class="theme-pick"${id === 'custom' ? ' id="themePickCustom"' : ''} style="${esc(style)}">
      <input type="radio" name="active" value="${esc(id)}" ${checked ? 'checked' : ''}>${tpIdleScreen(t, cardLogo, sample)}<span class="theme-name">${esc(name)}</span></label>`;
  const cards = S.themes.map((th) => themeCard(th.id, th.name, tpVars(th.colors, th.font, tpBgImage(th)), cfg.theme.active === th.id, logoFor(th.colors))).join('')
    + themeCard('custom', 'Personnalisé : mes couleurs', tpVars(colors, custom.font, tpBgImage(customPattern(custom.pattern, colors))), isCustom, logoFor(colors));
  return `
  <h2>Apparence</h2>
  <p class="sub">Le nom, le logo et l'image de fond s'appliquent quel que soit le thème. Chaque changement arrive sur la borne en direct. Les textes affichés à l'invité sont dans <a href="#texts">Textes des écrans</a>.</p>
  <form id="formTheme">
    <div class="card">
      <h3>Identité de la borne</h3>
      <label>Nom de la borne <input name="boothName" value="${esc(cfg.booth.name)}"></label>
      <label class="inline"><input name="showName" type="checkbox" ${cfg.booth.showName !== false ? 'checked' : ''}> Afficher le nom à côté du logo sur la borne</label>
    </div>
    <div class="card">
      <h3>Thème</h3>
      <div class="theme-grid">${cards}</div>
      <div id="customTheme" class="${isCustom ? '' : 'hidden'}">
        <div class="swatches">
          ${colorField('primary', 'Accent', 'Boutons principaux, décompte, cercle de l\'accueil, aplat du logo Cheeesy')}
          ${colorField('onPrimary', 'Texte des boutons', 'Écrit sur la couleur d\'accent, lettres du logo Cheeesy')}
          ${colorField('secondary', 'Titres', 'Titres, nom de la borne, nombre de copies, logo SVG importé')}
          ${colorField('background', 'Fond d\'écran', 'Arrière-plan de tous les écrans')}
          ${colorField('surface', 'Cartes', 'Cadres à choisir, photos de la galerie, pavé du code')}
          ${colorField('text', 'Texte courant', 'Consignes, boutons secondaires')}
        </div>
        <label>Police <select name="font">${[['system', 'Standard'], ['rounded', 'Arrondie'], ['serif', 'Avec empattements']].map(([v, l]) => `<option value="${v}" ${custom.font === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Motif de fond <select name="pattern">${[{ id: '', name: 'Aucun' }, ...S.patterns].map((p) => `<option value="${esc(p.id)}" ${(custom.pattern || '') === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      </div>
      <div id="contrastWarn" class="alert hidden"></div>
      <h3 class="h3-gap">Aperçu sur la borne</h3>
      <div id="themePreview" class="tp">
        <figure>${tpIdleScreen(t, logo, sample)}<figcaption>Accueil</figcaption></figure>
        <figure><div class="tp-screen">
          <div class="tp-title">${esc(t.chooseTemplate)}</div>
          <div class="tp-cards">${['Classique', 'Bandelette'].map((n) => `<div class="tp-card"><div class="tp-ph"${sample ? ` style="background-image:url('${esc(sample)}')"` : ''}></div><span>${n}</span></div>`).join('')}</div>
        </div><figcaption>Choix du cadre</figcaption></figure>
        <figure><div class="tp-screen">
          <div class="tp-title">${esc(t.review)}</div>
          <div class="tp-photo"${sample ? ` style="background-image:url('${esc(sample)}')"` : ''}></div>
          <div class="tp-btns"><span class="tp-ghost">${esc(t.retake)}</span><span class="tp-primary">${esc(t.keep)}</span></div>
        </div><figcaption>Relecture</figcaption></figure>
      </div>
    </div>
  </form>
  <div class="grid-2">
    <form id="formLogo" class="card upload-card">
      <h3>Logo (PNG transparent, SVG, JPEG)</h3>
      <div class="upload-current"><img class="logo-prev" src="${esc(logo)}" alt=""><small>Affiché en haut à gauche et sur l'accueil, pour tous les thèmes.</small></div>
      <label class="file-pick btn secondary">Choisir un logo…<input type="file" name="logo" accept="image/png,image/svg+xml,image/jpeg,image/webp"></label>
      ${cfg.booth.logo ? '<button class="btn" type="button" id="btnLogoReset">Logo par défaut</button>' : ''}
    </form>
    <form id="formBg" class="card upload-card">
      <h3>Image de fond (optionnelle)</h3>
      <div class="upload-current">${bg ? `<img class="logo-prev" src="${esc(bg)}" alt="">` : ''}<small>Actuelle : ${bg.startsWith('/pattern.svg') ? 'motif du thème, remplacé par l\'image choisie' : `<code>${esc(bg || 'aucune')}</code>`}</small></div>
      <label class="file-pick btn secondary">Choisir une image…<input type="file" name="image" accept="image/png,image/jpeg,image/webp"></label>
      ${cfg.booth.backgroundImage ? '<button class="btn" type="button" id="btnBgReset">Retirer</button>' : ''}
    </form>
  </div>`;
}

// Textes des écrans, groupés dans l'ordre du passage d'un invité ; libellé = où le texte apparaît
const TEXT_GROUPS = [
  ['Accueil', [['welcome', 'Accueil, écran tactile'], ['welcomeNoTouch', 'Accueil, écran non tactile (Stream Deck)'], ['gallery', 'Bouton de la galerie'], ['cameraUnavailable', 'Appareil photo indisponible']]],
  ['Séance photo', [['chooseTemplate', 'Choix du cadre'], ['getReady', 'Avant le décompte'], ['start', 'Bouton de départ'], ['lookUp', 'Bandeau « regardez l\'objectif »'], ['holdPose', 'Entre le « 0 » et la photo'], ['pleaseWait', 'Pendant le montage (GIF, boomerang)'], ['boomerangGo', 'Boomerang : pendant le film'], ['focusing', 'Boomerang : mise au point en cours']]],
  ['Relecture', [['review', 'Titre, photo'], ['reviewGif', 'Titre, GIF'], ['retake', 'Bouton refaire'], ['keep', 'Bouton garder, photo'], ['keepGif', 'Bouton garder, GIF']]],
  ['Impression', [['copies', 'Choix du nombre de tirages'], ['print', 'Bouton imprimer'], ['noPrint', 'Bouton sans impression'], ['printing', 'Impression en cours'], ['quotaReached', 'Quota de l\'événement atteint'], ['paperEmpty', 'Plus de papier'], ['printerUnavailable', 'Imprimante indisponible']]],
  ['Fin', [['thanks', 'Merci, photo (avec QR code)'], ['thanksGif', 'Merci, GIF'], ['thanksVideo', 'Merci, boomerang'], ['thanksNoQr', 'Merci, sans QR code'], ['gifInGallery', 'GIF sans QR code (pas de Wi-Fi)'], ['finish', 'Bouton terminer']]],
  ['Galerie', [['galleryTitle', 'Titre'], ['galleryEmpty', 'Galerie vide'], ['galleryQr', 'QR code d\'une photo'], ['galleryQrGif', 'QR code d\'un GIF'], ['galleryQrVideo', 'QR code d\'un boomerang'], ['reprint', 'Bouton réimprimer']]],
  ['Partage', [['wifiQr', 'Légende du QR code Wi-Fi'], ['remoteTitle', 'Page distante : titre'], ['remoteHint', 'Page distante : consigne']]]
];

function textsSection() {
  const texts = S.config.texts;
  const listed = new Set(TEXT_GROUPS.flatMap(([, f]) => f.map(([k]) => k)));
  const others = Object.keys(texts).filter((k) => !listed.has(k)).map((k) => [k, k]); // ajoutés plus tard
  const field = ([k, label]) => (k in texts ? `<label>${esc(label)}<input name="text_${k}" value="${esc(texts[k])}"></label>` : '');
  return `
  <h2>Textes des écrans</h2>
  <p class="sub">Tout ce que lit l'invité sur la borne, dans l'ordre de son passage. Chaque changement est enregistré et arrive sur la borne en direct.</p>
  <form id="formTexts">
    ${[...TEXT_GROUPS, ...(others.length ? [['Autres', others]] : [])].map(([title, fields]) => `
    <div class="card"><h3>${esc(title)}</h3><div class="grid-2">${fields.map(field).join('')}</div></div>`).join('')}
  </form>`;
}

function templatesSection() {
  const cfg = S.config.templates;
  const formatOptions = (sel) => Object.entries(S.formats).map(([k, f]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(f.name)} · ${f.width}×${f.height}</option>`).join('');
  const cards = S.templates.map((t) => `
    <div class="card tpl-card" data-tpl-card="${esc(t.id)}">
      <button type="button" class="tpl-handle" title="Glisser pour changer l'ordre sur la borne" aria-label="Déplacer ${esc(t.name)}"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></button>
      <div class="tpl-thumb-box"><canvas class="tpl-preview" data-tpl="${esc(t.id)}" width="${Math.round(t.width * (160 / Math.max(t.width, t.height)))}" height="${Math.round(t.height * (160 / Math.max(t.width, t.height)))}"></canvas></div>
      <div class="tpl-meta">
        <div class="tpl-name">${esc(t.name)}${KIND_LABEL[t.kind] ? ` <span class="badge">${KIND_LABEL[t.kind]}</span>` : ''}${KIND_LABEL[t.kind] && !cfg.gifEnabled ? ' <span class="badge warn">masqué</span>' : ''}</div>
        <div class="tpl-info">${t.format && S.formats[t.format] ? esc(S.formats[t.format].name) : `${t.width} × ${t.height} px`} · ${t.kind === 'gif' ? `${t.shots} poses` : t.kind === 'boomerang' ? `${String(t.boomerang.durationSec).replace('.', ',')} s filmées` : `${t.shots} photo${t.shots > 1 ? 's' : ''}`} · ${t.layers.length} calque${t.layers.length > 1 ? 's' : ''}</div>
        <div class="tpl-actions">
          <a class="btn primary small" href="#editor=${encodeURIComponent(t.id)}">Modifier</a>
          <label class="inline"><input type="checkbox" data-enable="${esc(t.id)}" ${cfg.enabled.includes(t.id) ? 'checked' : ''}> Activé</label>
          <label class="inline"><input type="radio" name="defaultTpl" value="${esc(t.id)}" ${cfg.default === t.id ? 'checked' : ''}> Par défaut</label>
          ${moreMenu([`<a class="menu-item" href="/api/admin/templates/${encodeURIComponent(t.id)}/export" download>Exporter</a>`, `<button class="menu-item danger" data-del="${esc(t.id)}">Supprimer</button>`])}
        </div>
      </div>
    </div>`).join('');
  return `
  <div class="ev-page-head">
    <h2>Templates</h2>
    <div class="row">
      <button class="btn" type="button" id="btnImportTemplate">Importer</button>
      <input type="file" id="importTemplateFile" accept=".zip,application/zip" hidden>
      <button class="btn primary" type="button" id="btnNewTemplate">+ Nouveau template</button>
    </div>
  </div>
  <dialog id="dlgNewTemplate" class="form-dialog">
    <form id="formNewTemplate">
      <h3>Nouveau template</h3>
      <label>Nom <input name="name" required placeholder="Mariage Julie & Marc" autocomplete="off"></label>
      <div class="grid-2">
        <label>Type <select name="kind"><option value="photo">Photo (tirage)</option><option value="gif">GIF animé (numérique)</option><option value="boomerang">Boomerang (numérique)</option></select></label>
        <label>Format <select name="format">${formatOptions(cfg.defaultFormat || S.defaultFormat)}</select></label>
      </div>
      <label>Cadre PNG (facultatif) <input type="file" name="overlay" accept="image/png"></label>
      <div class="row dlg-actions">
        <button class="btn" type="button" id="btnNewTemplateCancel">Annuler</button>
        <button class="btn primary" type="submit">Créer et ouvrir l'éditeur</button>
      </div>
    </form>
  </dialog>
  <div class="card">
    <h3>Options</h3>
    <div class="opt-grid">
      <label class="inline"><input id="guestCanChoose" type="checkbox" ${cfg.guestCanChoose ? 'checked' : ''}> L'invité choisit son template</label>
      <label class="inline"><input id="gifEnabled" type="checkbox" ${cfg.gifEnabled ? 'checked' : ''}> GIF et boomerangs proposés</label>
      <label class="inline">Format par défaut <select id="defaultFormat" class="small">${formatOptions(cfg.defaultFormat || S.defaultFormat)}</select></label>
    </div>
    <div class="opt-line"><b>Détourage précis</b> ${S.subjectModel?.installed ? `<span class="badge ok">installé</span> ${perfNotice()}` : modelNotice()}</div>
  </div>
  ${cards ? `<div id="tplList" class="tpl-list">${cards}</div>` : '<p class="sub">Aucun template.</p>'}`;
}

/**
 * Import de templates (fichier exporté depuis le menu « … » d'un template, ou une sauvegarde) : seuls les templates
 * du fichier sont importés, jamais les réglages. Déjà présent (même nom ou identifiant) : copie « Nom (1) » ou écrasement.
 */
async function importTemplates(input) {
  const file = input.files?.[0];
  input.value = ''; // le même fichier pourra être rechoisi
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const pv = (await api('/api/admin/config/import/preview', { method: 'POST', form })).import;
    if (!pv.templates.length) { toast('Aucun template dans ce fichier', true); return; }
    const one = pv.templates.length === 1;
    const dup = pv.templates.filter((t) => t.exists || t.sameName);
    let mode = 'copy';
    if (dup.length) { // déjà présent : copie à côté ou remplacement
      const title = one ? `« ${pv.templates[0].name} » existe déjà` : `${dup.length} template${dup.length > 1 ? 's' : ''} sur ${pv.templates.length} existe${dup.length > 1 ? 'nt' : ''} déjà`;
      const choice = await askConfirm('', 'Ajouter une copie', 'retake', { title, list: one ? [] : dup.map((t) => esc(t.name)), tone: 'primary', alt: 'Écraser' });
      if (!choice) return;
      mode = choice === 'alt' ? 'replace' : 'copy';
    } else if (!await askConfirm('', 'Importer', 'retake', { title: one ? `Importer « ${pv.templates[0].name} » ?` : `Importer ${pv.templates.length} templates ?`, list: one ? [] : pv.templates.map((t) => esc(t.name)), tone: 'primary' })) return;
    const r = await api('/api/admin/config/import/apply', { method: 'POST', body: { id: pv.id, templates: pv.templates.map((t) => t.id), mode } });
    toast(r.done.templates > 1 ? `${r.done.templates} templates importés` : 'Template importé');
    refresh();
  } catch (err) { toast(err.message, true); }
}

function camera() {
  const cfg = S.config;
  const g = cfg.camera.gphoto2;
  return `
  <h2>Appareil photo</h2>
  <p class="sub">Chaque changement s'applique tout de suite, sans redémarrage. En mode <b>auto</b>, la borne surveille le boîtier toutes les 10 secondes et bascule toute seule quand il est branché ou débranché.</p>
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
        <small>Le ${esc(S.camera.model || 'boîtier')}${S.camera.firmware ? ` (firmware ${esc(S.camera.firmware)})` : ''} ne lève pas son flash par USB${/1500D|2000D|Rebel T7|Kiss X90/i.test(S.camera.model || '') ? ' (possible à partir du firmware 1.2.1, à installer depuis le site de Canon)' : ''}, n'indique pas sa position avant la photo et ne permet pas d'empêcher un flash levé de partir : c'est sa position qui décide, et la borne le constate sur chaque photo. Levé = à chaque photo, rabattu = jamais. Pour l'interdire même levé : menu du boîtier, contrôle du flash, émission de l'éclair désactivée.</small>` : `
        <label>Flash intégré ${sel('flash', ['off', 'on', 'auto'], g.flash || 'off')}${cfg.camera.control?.mode === 'auto' ? '<small>Sans effet en mode Auto (bloc Boîtier ci-dessous) : c\'est le calibrage qui décide du flash.</small>' : ''}</label>
        <div class="row"><label>Seuil du mode auto (luminosité 0-255, flash levé en dessous) <input name="flashAutoThreshold" type="number" min="0" max="255" value="${g.flashAutoThreshold ?? 60}" style="width:120px"></label></div>
        <small><b>off</b> : la borne ne lève jamais le flash. <b>on</b> : levé par USB avant chaque photo. <b>auto</b> : levé si la scène est sombre d'après le live view${S.camera.sceneLuma != null ? ` (luminosité actuelle : ${S.camera.sceneLuma}/255)` : ''}. Une fois levé, le flash intégré ne se rabat qu'à la main. En ce moment : ${flashState()}.${S.camera.lastFlashError ? ` <b>Dernière levée refusée par le boîtier : ${esc(S.camera.lastFlashError)}</b>` : ''}</small>`}
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
      <button class="btn btn-detect" type="button">Détecter maintenant</button>
    </div>
  </form>
  ${S.camera.driver === 'gphoto2' ? cameraControlCard() : ''}`;
}

function controlSection() {
  const cfg = S.config;
  const b = cfg.booth;
  const t = cfg.texts;
  return `
  <h2>Écran &amp; contrôle</h2>
  ${screenSection()}
  <form id="formControl" class="card">
    <h3>Tactile et souris</h3>
    <div class="grid-2">
      <div>
        <label>Écran tactile <select name="touchMode">${[['auto', 'Détection automatique'], ['touch', 'Toujours tactile'], ['buttons', 'Jamais tactile : Stream Deck ou clavier']].map(([v, lb]) => `<option value="${v}" ${(b.touch || 'auto') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select></label>
      </div>
      <div>
        <label>Curseur de la souris <select name="cursor">${[['show', 'Toujours visible'], ['idle', 'Masqué quand la souris ne bouge pas (3 s)'], ['hide', 'Toujours masqué']].map(([v, lb]) => `<option value="${v}" ${(b.cursor || 'show') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select></label>
      </div>
    </div>
    <label>Fenêtre de la borne (app Cheeesy) <select name="windowMode">${[['kiosk', 'Kiosque : la borne occupe tout l\'écran, rien d\'autre n\'est accessible'], ['fullscreen', 'Plein écran : le reste de l\'ordinateur reste utilisable à côté (tests)']].map(([v, lb]) => `<option value="${v}" ${(b.window || 'kiosk') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select></label>
  </form>
  <form id="formDeck" class="card">
    <h3>Stream Deck</h3>
    <label class="inline"><input name="deckEnabled" type="checkbox" ${(cfg.booth.streamDeck?.enabled ?? true) ? 'checked' : ''}> Utiliser un Stream Deck Elgato branché en USB comme télécommande</label>
    <div class="grid-2">
      <label>Position du Stream Deck par rapport à l'écran <select name="deckPosition">${[['bottom', 'En dessous'], ['top', 'Au-dessus'], ['left', 'À gauche'], ['right', 'À droite']].map(([v, lb]) => `<option value="${v}" ${(cfg.booth.streamDeck?.position || 'bottom') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select><small>Écran non tactile : l'accueil affiche une flèche vers le Stream Deck (gauche / droite vues par l'invité)</small></label>
      <label>Luminosité des touches (%) <input name="deckBrightness" type="number" min="10" max="100" value="${cfg.booth.streamDeck?.brightness ?? 70}" style="width:120px"></label>
    </div>
    <label class="inline"><input name="deckShowButtons" type="checkbox" ${cfg.booth.streamDeck?.showButtons ? 'checked' : ''}> Toujours afficher les boutons à l'écran</label>
    <small>Décoché : quand l'écran n'est pas tactile et que le Stream Deck est branché, les boutons disparaissent de l'écran (retour, flèches, valider…) ; tout se fait sur les touches. Un écran tactile garde toujours ses boutons.</small>
    <label>En ce moment ${deckState()}</label>
    <small>Les touches reprennent les boutons de l'écran affiché, aux couleurs du thème, y compris le pavé du code opérateur. Branché, il pilote aussi la galerie de la borne (autant de photos par page que de touches). Sur Mac, quitter l'application Stream Deck d'Elgato, qui réserve l'appareil.</small>
  </form>`;
}

function lightsPage() {
  return `
  <h2>Lumières</h2>
  ${lightsSection()}`;
}

// ---------- Écran de la borne : luminosité et volume en DDC/CI (section Écran & contrôle) ----------

function screenSection() {
  const sc = S.screen;
  const cfg = S.config.screen || {};
  if (!sc || sc.off) return '<div class="card"><h3>Écran</h3><p class="sub">Non piloté pour cette borne (BOOTH_SCREEN=off).</p></div>';
  const managed = cfg.brightness != null || cfg.volume != null;
  const at = sc.checkedAt ? `, lu à ${new Date(sc.checkedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : '';
  const head = !sc.available ? `<div class="alert">${esc(sc.error || 'Outil DDC/CI absent')}</div>`
    : !sc.display ? `<p class="sub">Aucun écran externe ne répond en DDC/CI${sc.error ? ` (${esc(sc.error)})` : ''}${at}.</p>`
    : `<p class="sub">Écran <b>${esc(sc.display.name || 'externe')}</b> piloté en DDC/CI par ${esc(sc.tool)}${at}.${sc.error ? ` <b class="hw-err">${esc(sc.error)}</b>` : ''}</p>`;
  const b = cfg.brightness ?? sc.brightness ?? 100;
  const v = cfg.volume ?? sc.volume ?? 0;
  return `
  <form id="formScreen" class="card">
    <h3>Écran</h3>
    ${head}
    ${sc.display ? `
    <label class="inline"><input name="screenManaged" type="checkbox" ${managed ? 'checked' : ''}> Régler l'écran depuis la borne</label>
    <div class="grid-2">
      <label>Luminosité <output id="screenBrightnessOut" class="kelvin-out">${b} %</output>
        <input name="screenBrightness" class="kelvin-range plain" type="range" min="0" max="100" step="1" value="${b}" ${managed ? '' : 'disabled'}></label>
      ${sc.volumeOk ? `<label>Volume des haut-parleurs <output id="screenVolumeOut" class="kelvin-out">${v} %</output>
        <input name="screenVolume" class="kelvin-range plain" type="range" min="0" max="100" step="1" value="${v}" ${managed ? '' : 'disabled'}></label>`
    : '<small>Cet écran ne répond pas au réglage du volume : pas de haut-parleurs, ou DDC/CI partiel.</small>'}
    </div>` : ''}
    <div class="row"><button class="btn" type="button" id="btnScreenRefresh">Relire l'écran</button></div>
  </form>`;
}

function bindScreen() {
  const f = $('#formScreen');
  if (!f) return;
  const live = (name, outId) => { const el = f.elements[name]; el?.addEventListener('input', () => { $(`#${outId}`).textContent = `${el.value} %`; }); };
  live('screenBrightness', 'screenBrightnessOut');
  live('screenVolume', 'screenVolumeOut');
  // Enregistré puis envoyé à l'écran au relâchement du curseur (le DDC/CI est lent : pas pendant le glissement)
  const send = async () => {
    const managed = f.elements.screenManaged?.checked;
    const body = {
      brightness: managed ? Number(f.elements.screenBrightness.value) : null,
      volume: managed && f.elements.screenVolume ? Number(f.elements.screenVolume.value) : null
    };
    saveState('saving');
    try { await api('/api/admin/screen', { method: 'POST', body }); saveState('saved'); await refresh(); } catch (e) { saveState('error'); toast(e.message, true); }
  };
  f.addEventListener('change', (e) => {
    if (e.target.name === 'screenManaged') f.querySelectorAll('input[type=range]').forEach((r) => { r.disabled = !e.target.checked; });
    clearTimeout(f.saveTimer);
    f.saveTimer = setTimeout(send, 250);
  });
  $('#btnScreenRefresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { S.screen = (await api('/api/admin/screen/refresh', { method: 'POST' })).screen; render(); } catch (err) { toast(err.message, true); btn.disabled = false; }
  });
}

// ---------- Lumières Govee, Elgato et Philips Hue du réseau local (section Stream Deck & lumières) ----------

const LIGHT_COLOR_SOURCES = [['custom', 'Personnalisée'], ['primary', 'Accent du thème'], ['secondary', 'Titre du thème'], ['background', 'Fond du thème']];
const LIGHT_EFFECTS = [['cycle', 'Cycle de couleurs'], ['breathe', 'Respiration'], ['fixed', 'Couleur fixe']];
const LIGHT_MODES = [['ambiance', 'Ambiance', 'Les lumières animent l\'accueil (effet ci-dessous).'], ['keep', 'Laisser telles quelles', 'Elles gardent l\'état qu\'elles avaient avant la borne.'], ['off', 'Éteintes', 'Éteintes à l\'accueil, allumées pour la prise de vue.']];

function lightState(d) {
  return d.online ? '<span class="badge ok">en ligne</span>' : '<span class="badge">hors ligne</span>';
}

const openLightBlocks = new Set(); // blocs repliables ouverts : gardés d'un enregistrement (donc d'un rendu) à l'autre
const WHITE_EFFECTS = [['fixed', 'Fixe'], ['breathe', 'Respiration'], ['cycle', 'Cycle chaud → froid']];

/**
 * Réglages d'une famille de lumières. fam : rgb (cfg.idle…) ou wh (cfg.whiteLights).
 * data-when="champ=valeur|valeur;autre" : le bloc n'est visible que si les conditions sont remplies (voir bindLights).
 */
function lightsFamily(fam, title) {
  const cfg = S.config.lights || {};
  const src = fam === 'wh' ? cfg.whiteLights || {} : cfg;
  const idle = src.idle || {}, shoot = src.shooting || {}, sd = src.shutdown || {};
  const n = (k) => `${fam}_${k}`;
  const white = fam === 'wh';
  const sel = (name, opts, cur, when = '') => `<label ${when ? `data-when="${when}"` : ''}>${name[1]} <select name="${n(name[0])}">${opts.map(([v, lb]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${lb}</option>`).join('')}</select></label>`;
  const kelvin = (name, v, label = 'Température', when = '') => `<label ${when ? `data-when="${when}"` : ''}>${label} <output id="${n(name)}Out" class="kelvin-out">${v} K</output>
            <input name="${n(name)}" class="kelvin-range" type="range" min="2000" max="9000" step="100" value="${v}"></label>`;
  const pct = (name, label, v, when = '') => `<label ${when ? `data-when="${when}"` : ''}>${label} <input name="${n(name)}" type="number" min="1" max="100" value="${v}" style="width:90px"></label>`;
  // Ring light seule en lumière blanche de prise de vue, calibrage en auto : c'est lui qui règle sa photo
  const shootWhite = (S.lights?.devices || []).filter((d) => d.shooting && ['ring light', 'panneau', 'ampoule Hue blanche'].includes(d.type));
  const byCalibration = white && S.config.camera?.control?.mode === 'auto' && shootWhite.length > 0 && shootWhite.every((d) => d.type === 'ring light');
  const effect = idle.effect || (white ? 'fixed' : 'cycle');
  const amb = `${n('mode')}=ambiance`;
  const rate = `${n('effect')}=cycle|breathe`;
  return `<div class="card">
      <h3>${title}</h3>
      <div class="grid-2">
        ${sel(['mode', 'À l\'accueil'], LIGHT_MODES.map(([v, t]) => [v, t]), idle.mode || 'ambiance')}
        ${sel(['effect', 'Effet'], white ? WHITE_EFFECTS : LIGHT_EFFECTS, effect, amb)}
        ${white ? kelvin('idleKelvin', idle.kelvin ?? 4000, 'Température', `${amb};${n('effect')}=fixed|breathe`) : `${sel(['colorSource', 'Couleur'], LIGHT_COLOR_SOURCES, idle.colorSource === 'theme' ? 'primary' : idle.colorSource || 'custom', `${amb};${n('effect')}=fixed|breathe`)}
        <label data-when="${amb};${n('effect')}=fixed|breathe;rgb_colorSource=custom">Couleur choisie <input name="rgb_color" type="color" value="${esc(idle.color || '#ff7a1a')}"></label>
        ${sel(['cyclePalette', 'Couleurs'], [['rainbow', 'Toutes les couleurs'], ['theme', 'Accent, titre et fond du thème']], idle.cyclePalette || 'rainbow', `${amb};${n('effect')}=cycle`)}
        ${['primary', 'secondary', 'background'].map((k) => `<div class="light-theme-color" data-when="${amb};${n('effect')}=fixed|breathe;rgb_colorSource=${k}"><span class="light-swatch" style="background:${esc(S.theme?.colors?.[k] || '#ffffff')}"></span> Couleur du thème actif</div>`).join('')}
        <label class="inline" data-when="${amb};${n('effect')}=fixed|breathe"><input name="rgb_white" type="checkbox" ${idle.white ? 'checked' : ''}> Blanc plutôt qu'une couleur</label>
        ${kelvin('idleKelvin', idle.kelvin ?? 2700, 'Température', `${amb};${n('effect')}=fixed|breathe;rgb_white`)}`}
        ${white ? `<label data-when="${amb};${n('effect')}=cycle">Du blanc chaud (K) <input name="wh_kelvinMin" type="number" min="2000" max="9000" step="100" value="${idle.kelvinMin ?? 2900}" style="width:100px"></label>
        <label data-when="${amb};${n('effect')}=cycle">au blanc froid (K) <input name="wh_kelvinMax" type="number" min="2000" max="9000" step="100" value="${idle.kelvinMax ?? 7000}" style="width:100px"></label>` : ''}
        ${pct('brightness', 'Luminosité (%)', idle.brightness ?? 60, amb)}
        <label data-when="${amb};${rate}">Durée d'un tour (s) <input name="${n('period')}" type="number" min="2" max="600" value="${idle.periodSec ?? 20}" style="width:90px"></label>
        <label class="inline" data-when="${amb};${rate}"><input name="${n('sync')}" type="checkbox" ${idle.sync ? 'checked' : ''}> Lumières synchronisées</label>
      </div>
      <details class="fam-more" data-k="${n('shoot')}" ${openLightBlocks.has(n('shoot')) ? 'open' : ''}><summary>Prise de vue</summary>
        <div class="grid-2">
          ${byCalibration ? `<p class="sub">Luminosité et température de la photo : décidées par le calibrage du boîtier${autoLight() || ' (pas encore fait)'}.</p>
          <input type="hidden" name="${n('shootKelvin')}" value="${shoot.kelvin ?? 5000}"><input type="hidden" name="${n('shootBrightness')}" value="${shoot.brightness ?? 70}">`
            : `${kelvin('shootKelvin', shoot.kelvin ?? 5000)}
          ${pct('shootBrightness', 'Luminosité de la photo (%)', shoot.brightness ?? 100)}`}
          ${pct('waitBrightness', 'Avant le décompte (%)', shoot.waitBrightness ?? 30)}
        </div>
      </details>
      <details class="fam-more" data-k="${n('off')}" ${openLightBlocks.has(n('off')) ? 'open' : ''}><summary>À l'arrêt de la borne</summary>
        <div class="grid-2">
          ${sel(['offMode', 'Lumières'], [['white', 'Blanc chaud doux'], ['off', 'Éteintes'], ['keep', 'Comme avant la borne']], sd.mode || 'white')}
          ${kelvin('offKelvin', sd.kelvin ?? 2700, 'Température', `${n('offMode')}=white`)}
          ${pct('offBrightness', 'Luminosité (%)', sd.brightness ?? 20, `${n('offMode')}=white`)}
        </div>
      </details>
    </div>`;
}

function lightsSection() {
  const L = S.lights;
  const cfg = S.config.lights || {};
  if (!L?.available) {
    return '<div class="card"><p class="sub">Désactivées pour cette borne (BOOTH_LIGHTS=off).</p></div>';
  }
  const rows = L.devices.map((d) => `
      <tr data-light="${esc(d.id)}">
        <td><input name="name_${esc(d.id)}" value="${esc(d.name)}" placeholder="${esc(d.type[0].toUpperCase() + d.type.slice(1))} ${esc(d.ip.split('.').pop() || '')}"></td>
        <td>${esc(d.type)}<br><small>${esc(d.sku)} · ${esc(d.ip)}</small></td>
        <td>${lightState(d)}</td>
        <td class="c" data-label="Ambiance"><input type="checkbox" name="amb_${esc(d.id)}" ${d.ambiance ? 'checked' : ''} aria-label="Ambiance"></td>
        <td class="c" data-label="Prise de vue"><input type="checkbox" name="shoot_${esc(d.id)}" ${d.shooting ? 'checked' : ''} aria-label="Prise de vue"></td>
        <td class="nowrap"><button class="btn small" type="button" data-light-identify="${esc(d.id)}" ${d.online && L.running ? '' : 'disabled'}>Identifier</button>
          <button class="btn ghost small" type="button" data-light-forget="${esc(d.id)}">Oublier</button></td>
      </tr>`).join('');
  return `
  <p class="sub">Lumières Govee, Elgato et Philips Hue du réseau local, pilotées directement par la borne (sans internet ni compte) : allumées à son démarrage, ambiance à l'accueil, blanc neutre pour les photos, blanc chaud doux (réglable) quand on éteint la borne. Govee : activer <b>LAN Control</b> dans l'app Govee Home (appareil <i class="fa-solid fa-arrow-right" aria-hidden="true"></i> réglages). Elgato (Ring Light, Key Light) : rien à activer, la lumière doit seulement être sur le Wi-Fi (app Elgato Control Center). Toutes doivent être sur le même réseau que la borne.</p>
  ${hueCard(L)}
  <form id="formLights">
    <div class="card">
      <label class="inline"><input name="lightsEnabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> Piloter les lumières</label>
      <small>${L.running ? [L.network && `Réseau de la borne : ${esc(L.network)}`, L.error && `<b>${esc(L.error)}</b>`].filter(Boolean).join(' · ') : 'Coupé : la borne ne touche à aucune lumière. En le coupant, chaque lumière retrouve son état d\'avant.'}</small>
      <h3>Lumières</h3>
      ${L.devices.length ? `<table class="light-table"><thead><tr><th>Nom</th><th>Type</th><th>État</th><th class="c">Ambiance</th><th class="c">Prise de vue</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="sub">${L.running ? 'Aucune lumière trouvée pour l\'instant.' : 'Activez le pilotage puis lancez une recherche.'}</p>`}
      <div class="row">
        <button class="btn" type="button" id="btnLightsScan" ${L.running ? '' : 'disabled'}>Rechercher</button>
        <button class="btn" type="button" id="btnLightsTry" ${L.running && L.devices.some((d) => d.online && d.shooting) ? '' : 'disabled'}>Essayer la prise de vue (8 s)</button>
      </div>
      <small>Recherche automatique chaque minute : une lumière rallumée au mur reprend sa place. « Identifier » la fait clignoter (en bleu, en blanc pour une Elgato). Les lumières blanches (Elgato, ampoules Hue blanches) ont leurs propres réglages, séparés de ceux des lumières RGB.</small>
    </div>
    ${lightsFamily('rgb', 'Lumières RGB (Govee, Hue couleur)')}
    ${lightsFamily('wh', 'Lumières blanches (Elgato, Hue blanches)')}
  </form>`;
}

/** Philips Hue : pont associé, ou recherche et association (bouton du pont). */
let hueBridges = null; // ponts trouvés par la dernière recherche
let hueSearching = false;
async function searchHueBridges() {
  if (hueSearching) return;
  hueSearching = true;
  if (currentSection() === 'lights') render();
  try { hueBridges = (await api('/api/admin/lights/hue/discover', { method: 'POST' })).bridges; } catch (e) { toast(e.message, true); hueBridges = []; }
  hueSearching = false;
  if (currentSection() === 'lights') render();
}
let huePairing = null; // adresse du pont en cours d'association
function hueCard(L) {
  const h = L.hue;
  const bulbs = L.devices.filter((d) => /^Hue /i.test(d.sku));
  const body = h
    ? `<div class="row"><span class="badge ok">associé</span> <b>${esc(h.name || 'Pont Hue')}</b> <small>${esc(h.ip)} · ${plural(bulbs.length, 'ampoule')}</small>
        <button class="btn small link-danger" type="button" id="btnHueForget">Dissocier</button></div>`
    : huePairing ? `<div class="row"><span class="badge warn">en attente</span> <b>Appuyez sur le bouton du pont Hue</b> <small>${esc(huePairing)}, 30 s</small></div>`
    : `<div class="row"><span class="badge">${hueSearching ? 'recherche du pont…' : 'aucun pont associé'}</span>
        <button class="btn small" type="button" id="btnHueDiscover" ${L.running && !hueSearching ? '' : 'disabled'}>Rechercher un pont</button></div>
      ${hueBridges ? (hueBridges.length ? `<div class="hue-bridges">${hueBridges.map((b) => `<div class="row"><b>${esc(b.name)}</b> <small>${esc(b.ip)}</small> <button class="btn small primary" type="button" data-hue-pair="${esc(b.ip)}" data-hue-name="${esc(b.name)}">Associer</button></div>`).join('')}</div>` : '<small>Aucun pont Hue trouvé sur le réseau.</small>') : ''}`;
  return `<div class="card"><h3>Philips Hue</h3>${body}</div>`;
}

function bindLights() {
  const f = $('#formLights');
  if (!f) return;
  autoSave(f, (fd) => {
    const devices = Object.fromEntries((S.lights?.devices || []).map((d) => [d.id, {
      name: String(fd.get(`name_${d.id}`) || '').trim(), ambiance: fd.get(`amb_${d.id}`) === 'on', shooting: fd.get(`shoot_${d.id}`) === 'on'
    }]));
    const family = (f) => {
      const k = (x) => `${f}_${x}`;
      return {
        idle: { mode: fd.get(k('mode')) || 'ambiance', effect: fd.get(k('effect')), kelvin: num(fd, k('idleKelvin')), brightness: num(fd, k('brightness')), periodSec: num(fd, k('period')), sync: fd.get(k('sync')) === 'on' },
        shooting: { kelvin: num(fd, k('shootKelvin')), brightness: num(fd, k('shootBrightness')), waitBrightness: num(fd, k('waitBrightness')) },
        shutdown: { mode: fd.get(k('offMode')) || 'white', kelvin: num(fd, k('offKelvin')), brightness: num(fd, k('offBrightness')) }
      };
    };
    const rgb = family('rgb'), wh = family('wh');
    Object.assign(rgb.idle, { color: fd.get('rgb_color'), colorSource: fd.get('rgb_colorSource') || 'custom', cyclePalette: fd.get('rgb_cyclePalette') || 'rainbow', white: fd.get('rgb_white') === 'on' });
    Object.assign(wh.idle, { kelvinMin: num(fd, 'wh_kelvinMin'), kelvinMax: num(fd, 'wh_kelvinMax') });
    saveConfig({ lights: { enabled: fd.get('lightsEnabled') === 'on', devices, ...rgb, whiteLights: wh } }, 'Lumières enregistrées');
  });
  const showWhen = () => f.querySelectorAll('[data-when]').forEach((el) => {
    el.hidden = !el.dataset.when.split(';').every((c) => {
      const [name, vals] = c.split('=');
      const field = f.querySelector(`[name="${name}"]:checked`) || f.querySelector(`[name="${name}"]`);
      if (vals === undefined) return !!field?.checked;
      return vals.split('|').includes(field?.value);
    });
  });
  showWhen();
  f.querySelectorAll('details[data-k]').forEach((d) => d.addEventListener('toggle', () => (d.open ? openLightBlocks.add(d.dataset.k) : openLightBlocks.delete(d.dataset.k))));
  f.addEventListener('change', showWhen);
  for (const fam of ['rgb', 'wh']) for (const name of ['idleKelvin', 'shootKelvin', 'offKelvin']) {
    const el = f.querySelector(`[name=${fam}_${name}]`);
    el?.addEventListener('input', () => { $(`#${fam}_${name}Out`).textContent = `${el.value} K`; });
  }
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; } };
  $('#btnHueDiscover')?.addEventListener('click', () => searchHueBridges());
  if (S.lights?.running && !S.lights.hue && hueBridges === null && !hueSearching) searchHueBridges(); // en arrivant sur la page
  document.querySelectorAll('[data-hue-pair]').forEach((b) => b.addEventListener('click', async () => {
    huePairing = b.dataset.huePair;
    render();
    try {
      await api('/api/admin/lights/hue/pair', { method: 'POST', body: { ip: b.dataset.huePair, name: b.dataset.hueName } });
      hueBridges = null;
      toast('Pont Hue associé');
    } catch (err) { toast(err.message, true); }
    huePairing = null;
    await refresh();
  }));
  $('#btnHueForget')?.addEventListener('click', async () => {
    if (!await askConfirm('Dissocier le pont Hue ?', 'Dissocier', 'delete')) return;
    try { await api('/api/admin/lights/hue/forget', { method: 'POST' }); await refresh(); } catch (err) { toast(err.message, true); }
  });
  $('#btnLightsScan')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!S.lights?.hue) searchHueBridges(); // aucun pont associé : il est cherché aussi
    const r = await api('/api/admin/lights/discover', { method: 'POST' });
    toast(`${r.lights.devices.filter((d) => d.online).length} lumière(s) en ligne`);
    await refresh();
  }));
  $('#btnLightsTry')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api('/api/admin/lights/try-shooting', { method: 'POST' });
    toast('Prise de vue pendant 8 s');
  }));
  document.querySelectorAll('[data-light-identify]').forEach((b) => b.addEventListener('click', () => busy(b, () => api('/api/admin/lights/identify', { method: 'POST', body: { id: b.dataset.lightIdentify } }))));
  document.querySelectorAll('[data-light-forget]').forEach((b) => b.addEventListener('click', async () => {
    if (!await askConfirm('Oublier cette lumière ?', 'Oublier', 'delete')) return;
    busy(b, async () => {
    await api(`/api/admin/lights/${encodeURIComponent(b.dataset.lightForget)}`, { method: 'DELETE' });
    await refresh();
    });
  }));
}

// ---------- Boîtier : réglages de prise de vue (mode boîtier / manuel / auto avec calibrage) ----------

// Valeurs gphoto2 (anglais) affichées en français quand on les connaît
const CAM_FR = {
  Manual: 'Manuel (M)', P: 'Programme (P)', AV: 'Priorité ouverture (Av)', TV: 'Priorité vitesse (Tv)', Auto: 'Automatique',
  'One Shot': 'Un coup', 'AI Focus': 'AI Focus', 'AI Servo': 'AI Servo (continu)', Single: 'Unique', Continuous: 'Rafale',
  'Timer 10 sec': 'Retardateur 10 s', 'Timer 2 sec': 'Retardateur 2 s', 'Continuous timer': 'Retardateur en rafale',
  Standard: 'Standard', Portrait: 'Portrait', Landscape: 'Paysage', Neutral: 'Neutre', Faithful: 'Fidèle', Monochrome: 'Noir et blanc',
  'AWB White': 'Auto (priorité blanc)', Daylight: 'Lumière du jour', Shadow: 'Ombre', Cloudy: 'Nuageux', Tungsten: 'Tungstène',
  Fluorescent: 'Fluorescent', Flash: 'Flash', Evaluative: 'Évaluative', Partial: 'Partielle', 'Center-weighted average': 'Moyenne pondérée centrale',
  L: 'Grande · fine', cL: 'Grande · normale', M: 'Moyenne · fine', cM: 'Moyenne · normale', S1: 'Petite 1 · fine', cS1: 'Petite 1 · normale',
  S2: 'Petite 2', S3: 'Petite 3', 'RAW + L': 'RAW + Grande fine', RAW: 'RAW seul (pas de JPEG : à éviter)', None: 'Aucun',
  '2 seconds': '2 s', '4 seconds': '4 s', '8 seconds': '8 s', Hold: 'Maintenu', Live: 'Live', LiveFace: 'Visages', Quick: 'Rapide',
  'Standard (disabled in manual exposure)': 'Standard (sans effet en M)'
};
const camFr = (v) => CAM_FR[v] || v;
const CTL = { settings: null, loading: false, calibration: null, poll: null }; // gardé entre deux rafraîchissements

function cameraControlCard() {
  const ctl = S.config.camera.control || { mode: 'camera' };
  const opt = (v, title, desc) => `<label class="inline ctl-mode"><input type="radio" name="ctlMode" value="${v}" ${ctl.mode === v ? 'checked' : ''}> <span><b>${title}</b><small>${desc}</small></span></label>`;
  return `
  <div class="card" id="cameraControl">
    <h3>Boîtier : réglages de prise de vue</h3>
    <div class="ctl-modes">
      ${opt('camera', 'Réglages du boîtier', 'La borne ne touche pas à l\'exposition : molette et menus de l\'appareil décident.')}
      ${opt('manual', 'Manuel', 'Tu choisis chaque réglage ici ; ils sont poussés au boîtier à chaque branchement.')}
      ${opt('auto', 'Auto : la borne gère tout', 'Base éprouvée et exposition trouvée par un calibrage sur place.')}
    </div>
    <div id="ctlBody"></div>
  </div>`;
}

function renderCtlBody() {
  const box = $('#ctlBody');
  if (!box) return;
  const mode = document.querySelector('input[name=ctlMode]:checked')?.value || 'camera';
  const ctl = S.config.camera.control || {};
  if (mode === 'camera') {
    box.innerHTML = '<p class="sub">Rien n\'est imposé : ce que tu règles sur l\'appareil est ce qui sert pour les photos.</p>';
  } else if (mode === 'manual') {
    if (!CTL.settings) {
      box.innerHTML = `<p class="sub">${CTL.loading ? 'Lecture des réglages du boîtier…' : 'Réglages lus directement sur le boîtier, avec les choix qu\'il propose.'}</p>${CTL.loading ? '' : '<button class="btn secondary" type="button" id="ctlRead">Lire les réglages du boîtier</button>'}`;
      $('#ctlRead')?.addEventListener('click', loadCameraSettings);
      if (!CTL.loading) loadCameraSettings();
      return;
    }
    const saved = ctl.manual || {};
    const fields = S.cameraSettings.map(([key, label]) => {
      const s = CTL.settings[key];
      if (!s) return '';
      const cur = saved[key] ?? s.current;
      const choices = s.choices.length ? s.choices : [s.current];
      return `<label>${esc(label)}<select name="${esc(key)}" ${s.readonly ? 'disabled' : ''}>${choices.map((c) => `<option value="${esc(c)}" ${c === cur ? 'selected' : ''}>${esc(camFr(c))}</option>`).join('')}</select>${s.current !== cur ? `<small>sur le boîtier en ce moment : ${esc(camFr(s.current))}</small>` : ''}</label>`;
    }).join('');
    box.innerHTML = `<form id="formManualCam"><div class="grid-2 ctl-grid">${fields}</div>
      <small>Vitesse et ouverture comptent en M ; la correction d'exposition en P, Av et Tv. Le mode choisi ici prime sur la molette du boîtier.</small>
      <div class="row"><button class="btn primary" type="submit">Enregistrer et appliquer</button><button class="btn" type="button" id="ctlReload">Relire le boîtier</button></div></form>`;
    $('#ctlReload').onclick = () => { CTL.settings = null; loadCameraSettings(); };
    $('#formManualCam').onsubmit = (e) => {
      e.preventDefault();
      const manual = Object.fromEntries([...new FormData(e.target).entries()]);
      CTL.settings = null; // relu après application
      saveConfig({ camera: { control: { mode: 'manual', manual } } }, 'Réglages enregistrés, appliqués au boîtier dès qu\'il est libre');
    };
  } else {
    box.innerHTML = autoPanel(ctl);
    bindAutoPanel();
  }
}

async function loadCameraSettings() {
  CTL.loading = true;
  renderCtlBody();
  try { CTL.settings = (await api('/api/admin/camera/settings')).settings; } catch (e) { toast(e.message, true); }
  CTL.loading = false;
  renderCtlBody();
}

function profileLine(p) {
  if (!p) return '';
  const s = p.settings || {};
  return `${esc(s.shutterspeed)} s · f/${esc(s.aperture)} · ISO ${esc(camFr(s.iso))} · ${p.flash ? 'avec flash' : 'sans flash'}`;
}

function autoPanel(ctl) {
  const a = ctl.auto || {};
  const current = a.profile
    ? `<p>Réglage en place : <b>${profileLine(a.profile)}</b><br><small>Calibré le ${new Date(a.calibratedAt).toLocaleString('fr-FR')} · ${esc(a.reason || '')}</small></p>`
    : '<p class="sub">Pas encore de calibrage : la borne utilise 1/125 s · f/5.6 · ISO automatique, sans flash.</p>';
  return `${current}
    <p class="sub">Le calibrage s'ouvre en plein écran : cadrage avec l'aperçu, décompte pour se placer, puis une série sans flash et une série avec flash (${MAX_CALIB_SHOTS} photos, 25 s environ). La borne note chaque photo et garde la meilleure. Les photos de test n'apparaissent pas dans la galerie et sont effacées dès qu'on quitte l'écran du calibrage (réglage gardé, fermeture ou nouvel essai).</p>
    <div class="row"><button class="btn ${a.profile ? '' : 'primary'}" type="button" id="calibStart">${a.profile ? 'Recalibrer' : 'Lancer le calibrage'}</button>
    ${a.profile && ctl.mode !== 'auto' ? '<button class="btn primary" type="button" id="ctlUseAuto">Utiliser ce réglage</button>' : ''}</div>`;
}

function bindAutoPanel() {
  $('#calibStart')?.addEventListener('click', () => openCalibration('preview'));
  $('#ctlUseAuto')?.addEventListener('click', () => saveConfig({ camera: { control: { mode: 'auto' } } }, 'Mode auto activé'));
}

// ---------- Calibrage plein écran : cadrage → décompte → photos → résultats ----------

const MAX_CALIB_SHOTS = 6; // toujours 2 sans flash + 4 avec (server/camera/control.js)
const CAL = { stage: null, countdown: 10, timer: null };
const CALIB_DELAYS = [3, 5, 10, 15, 20]; // secondes de décompte proposées avant les photos

/** Délai du décompte, depuis la liste de l'écran ou les touches − / + du Stream Deck. */
function setCalibDelay(sec) {
  CAL.countdown = sec;
  document.querySelectorAll('[data-delay]').forEach((b) => { const on = Number(b.dataset.delay) === sec; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  sendDeckUi();
}

function openCalibration(stage) {
  let ov = $('#calibOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'calibOverlay';
    ov.className = 'calib-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'Calibrage du boîtier');
    document.body.appendChild(ov);
    document.addEventListener('keydown', calibKeys);
  }
  CAL.stage = stage;
  renderCalibration();
}

/** Écran du calibrage quitté (réglage gardé, fermé, recommencé) : le serveur efface les photos de test. */
function discardCalibration() {
  CTL.calibration = null;
  api('/api/admin/camera/calibration/discard', { method: 'POST' }).catch(() => {});
}

function closeCalibration() {
  if (['running', 'results', 'error'].includes(CAL.stage)) discardCalibration();
  clearInterval(CAL.timer);
  // Aperçu rendu tout de suite : sans ça, la connexion peut rester ouverte et le live view du boîtier continuer
  const live = $('#coLive');
  if (live) { live.src = ''; live.removeAttribute('src'); }
  $('#calibOverlay')?.remove();
  document.removeEventListener('keydown', calibKeys);
  CAL.stage = null;
  sendDeckUi();
  if (currentSection() === 'camera') renderCtlBody();
}

function calibKeys(e) {
  if (e.key !== 'Escape') return;
  if ($('#calibLightbox')) { $('#calibLightbox').remove(); return; }
  if (CAL.stage === 'preview' || CAL.stage === 'results' || CAL.stage === 'error') closeCalibration();
  else if (CAL.stage === 'countdown') { clearInterval(CAL.timer); CAL.stage = 'preview'; renderCalibration(); }
}

function renderCalibration() {
  const ov = $('#calibOverlay');
  if (!ov) return;
  const c = CTL.calibration;
  const head = (title, sub = '') => `<header class="co-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>
    ${['preview', 'results', 'error'].includes(CAL.stage) ? '<button class="btn ghost" type="button" id="coClose">Fermer</button>' : ''}</header>`;
  const live = `<div class="co-live"><img id="coLive" src="/api/live.mjpeg?calib=1&t=${Date.now()}" alt="Aperçu du boîtier"></div>`;

  if (CAL.stage === 'preview') {
    ov.innerHTML = `${head('Calibrage du boîtier', 'Cadre la photo comme pour l\'événement, puis lance : un décompte laisse le temps de se placer.')}
      <div class="co-main">${live}
        <aside class="co-side">
          <ol>
            <li>Place l'appareil à sa position définitive et règle le cadrage.</li>
            <li>Allume l'éclairage de l'événement.</li>
            ${S.lights?.ringLight ? '<li><b>Rabats le flash</b> : seule la ring light éclaire.</li>' : '<li><b>Rabats le flash</b> : la borne le lève elle-même pour sa série.</li>'}
            <li>Au lancement, place-toi où se tiendront les invités et ne bouge plus.</li>
          </ol>
          ${S.camera.flashFired || S.camera.flashStray ? '<div class="alert">La dernière photo a été prise avec le flash : il est sûrement levé. <b>Rabats-le avant de lancer</b>, sinon il partira sur toutes les photos de test (la borne le relèvera elle-même s\'il en faut).</div>' : ''}
          <div class="co-actions">
            <div class="co-delay-label">Décompte avant les photos</div>
            <div class="co-delays" role="group" aria-label="Décompte avant les photos">${CALIB_DELAYS.map((n) => `<button type="button" class="co-delay ${n === CAL.countdown ? 'on' : ''}" data-delay="${n}" aria-pressed="${n === CAL.countdown}">${n} s</button>`).join('')}</div>
            <p class="co-note">${S.lights?.ringLight ? `${MAX_CALIB_SHOTS} photos, 30 s environ : 3 luminosités, puis 3 couleurs.` : `${MAX_CALIB_SHOTS} photos, 25 s environ : 2 sans flash, puis 4 avec flash.`}</p>
            <button class="btn primary co-go" type="button" id="coGo">Lancer le calibrage</button>
          </div>
        </aside>
      </div>`;
    ov.querySelectorAll('[data-delay]').forEach((b) => { b.onclick = () => setCalibDelay(Number(b.dataset.delay)); });
    $('#coGo').onclick = startCalibCountdown;
  } else if (CAL.stage === 'countdown') {
    ov.innerHTML = `${head('Placez-vous')}
      <div class="co-main co-center">${live}<div class="co-count" id="coCount">${CAL.left}</div>
        <p class="co-note">Les photos commencent à zéro. <button class="btn ghost small" type="button" id="coCancel">Annuler</button></p></div>`;
    $('#coCancel').onclick = () => { clearInterval(CAL.timer); CAL.stage = 'preview'; renderCalibration(); };
  } else if (CAL.stage === 'running') {
    const done = c?.shots?.length || 0;
    const pct = Math.min(100, Math.round((Math.max(done, (c?.step || 1) - 0.5) / Math.max(MAX_CALIB_SHOTS, c?.step || 1)) * 100));
    ov.innerHTML = `${head('Ne bougez pas', 'Photos de test en cours : la borne cherche le bon réglage pour ce lieu.')}
      <div class="co-main co-center">
        <div class="co-progress"><div style="width:${pct}%"></div></div>
        <p class="co-step">Photo ${c?.step || 1} sur ${Math.max(MAX_CALIB_SHOTS, c?.step || 1)} · ${esc(c?.label || 'préparation')}<br><small>ne bouge pas jusqu'à la fin de la série${(c?.step || 0) > MAX_CALIB_SHOTS ? ' (une photo refaite : le flash n\'était pas parti)' : ''}</small></p>
        <div class="co-strip">${(c?.shots || []).map((sh) => `<img src="${esc(sh.thumb)}" alt="">`).join('')}</div>
      </div>`;
  } else if (CAL.stage === 'results') {
    const pick = c?.profile;
    const isPick = (sh) => sh.best ?? (pick && sh.flash === !!pick.flash && ['shutterspeed', 'aperture', 'iso'].every((k) => sh.settings?.[k] === pick.settings?.[k]));
    const cards = (c?.shots || []).map((sh) => `
      <figure class="co-shot ${isPick(sh) ? 'picked' : ''}">
        <button type="button" class="co-thumb" data-open="${esc(sh.url)}" aria-label="Agrandir la photo ${sh.n}"><img src="${esc(sh.thumb)}" alt=""></button>
        ${isPick(sh) ? '<span class="co-ribbon">Choix de la borne</span>' : ''}
        <figcaption><b>${esc(sh.label)}</b><span>${esc(sh.summary)}</span>
          <span>luminosité ${sh.mean}/255${sh.clipped > 2 ? ` · ${sh.clipped} % brûlé` : ''} · <span class="badge ${sh.ok ? 'ok' : ''}">${sh.ok ? 'dans la cible' : 'hors cible'}</span>${sh.score != null ? ` · note ${sh.score}` : ''}</span>
          ${isPick(sh) ? '' : `<button class="btn small" type="button" id="coPick-${sh.n}" data-pick="${sh.n}">Choisir ce réglage</button>`}
        </figcaption>
      </figure>`).join('');
    ov.innerHTML = `${head('Résultat du calibrage', `${esc(c?.reason || '')}<br><small>Note : écart à la luminosité idéale, zones brûlées et bruit (ISO) ; plus elle est basse, mieux c'est.</small>`)}
      ${c.lights ? '<div class="co-info">Calibré lumières de prise de vue allumées (Lumières) : elles se rallument de la même façon pour chaque séance.</div>' : ''}
      ${flashAdvice(c, pick)}
      <div class="co-shots">${cards || '<p>Aucune photo.</p>'}</div>
      <footer class="co-foot">
        ${pick ? '<button class="btn primary" type="button" id="coKeep">Garder le choix de la borne</button>' : ''}
        <button class="btn" type="button" id="coAgain">Recommencer</button>
      </footer>`;
    ov.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openLightbox(b.dataset.open)));
    ov.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const sh = c.shots.find((x) => String(x.n) === b.dataset.pick);
      if (!sh.flash && (c.flashRaised || c.shots.some((x) => x.flash))) toast('Réglage sans flash : rabats le flash à la main, sinon il part à chaque photo', true);
      keepCalibration({ flash: sh.flash, settings: { ...sh.settings }, ...(sh.light ? { light: { ...sh.light } } : {}) }, `Choisi à la main : ${sh.label} (${sh.summary}, luminosité ${sh.mean}/255).`);
    }));
    $('#coKeep')?.addEventListener('click', () => keepCalibration(pick, c.reason));
    $('#coAgain').onclick = () => { discardCalibration(); openCalibration('preview'); };
  } else if (CAL.stage === 'error') {
    ov.innerHTML = `${head('Calibrage interrompu')}<div class="co-main co-center"><div class="alert">${esc(c?.error || 'Erreur inconnue')}</div>
      <button class="btn primary" type="button" id="coAgain">Recommencer</button></div>`;
    $('#coAgain').onclick = () => { discardCalibration(); openCalibration('preview'); };
  }
  $('#coClose')?.addEventListener('click', closeCalibration);
  // Touches du Stream Deck : tout de suite, puis quand les miniatures des résultats sont chargées
  sendDeckUi();
  ov.querySelectorAll('.co-shot img').forEach((img) => { if (!img.complete) img.addEventListener('load', sendDeckUi, { once: true }); });
}

/** Que faire du flash après le calibrage : il ne se rabat qu'à la main, et levé il part à chaque photo. */
function flashAdvice(c, pick) {
  const raised = c?.flashRaised || (c?.shots || []).some((sh) => sh.flash);
  if (!raised) return '';
  if (pick && !pick.flash) return '<div class="alert"><b>Rabats le flash maintenant.</b> Ce réglage est sans flash, mais levé il part à chaque photo.</div>';
  return '<div class="co-info">Le flash reste levé : c\'est voulu, ce réglage l\'utilise. Si tu choisis une photo sans flash, rabats-le à la main.</div>';
}

function startCalibCountdown() {
  CAL.left = CAL.countdown;
  CAL.stage = 'countdown';
  renderCalibration();
  clearInterval(CAL.timer);
  CAL.timer = setInterval(async () => {
    CAL.left -= 1;
    if (CAL.left > 0) { $('#coCount').textContent = CAL.left; sendDeckUi(); return; }
    clearInterval(CAL.timer);
    // Zéro : on libère l'aperçu (le boîtier ne sert qu'à une chose à la fois), puis on lance
    const img = $('#coLive');
    if (img) img.src = '';
    CAL.stage = 'running';
    CTL.calibration = { state: 'running', step: 0, shots: [] };
    renderCalibration();
    try {
      CTL.calibration = (await api('/api/admin/camera/calibrate', { method: 'POST', body: {} })).calibration;
      pollCalibration();
    } catch (e) {
      CTL.calibration = { state: 'error', error: e.message };
      CAL.stage = 'error';
      renderCalibration();
    }
  }, 1000);
}

/** Photo en grand par-dessus l'admin (calibrage, sessions). Pas de nouvelle fenêtre : sur la borne en plein écran, elle ne se fermerait pas. */
// list : [{ url, alt }] pour passer d'une photo à l'autre (flèches à l'écran ou ← →), index = celle ouverte.
function openLightbox(url, alt = 'Photo de test', list = null, index = 0) {
  const items = list?.length ? list : [{ url, alt }];
  let i = Math.max(0, Math.min(items.length - 1, index));
  const lb = document.createElement('div');
  lb.id = 'calibLightbox';
  lb.className = 'co-lightbox';
  const nav = items.length > 1;
  lb.innerHTML = `<img alt=""><video class="hidden" autoplay loop muted playsinline></video>
    ${nav ? '<button class="lb-arrow prev" type="button" aria-label="Photo précédente"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><button class="lb-arrow next" type="button" aria-label="Photo suivante"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>' : ''}
    <div class="lb-bar">${nav ? '<span class="lb-count"></span>' : ''}<button class="btn" type="button">Fermer</button></div>`;
  const img = lb.querySelector('img');
  const video = lb.querySelector('video');
  const show = () => {
    const isVideo = /\.mp4(\?|$)/i.test(items[i].url); // boomerang
    img.classList.toggle('hidden', isVideo);
    video.classList.toggle('hidden', !isVideo);
    if (isVideo) { img.removeAttribute('src'); video.src = items[i].url; } else { video.removeAttribute('src'); img.src = items[i].url; }
    img.alt = items[i].alt || '';
    if (!nav) return;
    lb.querySelector('.lb-count').textContent = `${i + 1} / ${items.length}`;
    lb.querySelector('.prev').disabled = i === 0;
    lb.querySelector('.next').disabled = i === items.length - 1;
  };
  const go = (d) => { i = Math.max(0, Math.min(items.length - 1, i + d)); show(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (nav && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); go(e.key === 'ArrowLeft' ? -1 : 1); }
  };
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey, true); };
  lb.addEventListener('click', (e) => {
    const arrow = e.target.closest('.lb-arrow');
    if (arrow) { if (!arrow.disabled) go(arrow.classList.contains('prev') ? -1 : 1); return; }
    close(); // clic ailleurs (ou Échap) : fermé
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(lb);
  show();
}

function keepCalibration(profile, reason) {
  closeCalibration();
  saveConfig({ camera: { control: { mode: 'auto', auto: { profile, calibratedAt: new Date().toISOString(), reason } } } }, 'Réglage gardé, appliqué au boîtier');
}

function pollCalibration() {
  clearTimeout(CTL.poll);
  CTL.poll = setTimeout(async () => {
    try { CTL.calibration = (await api('/api/admin/camera/calibration')).calibration; } catch { /* réessaie */ }
    const st = CTL.calibration?.state;
    if (CAL.stage) {
      CAL.stage = st === 'done' ? 'results' : st === 'error' ? 'error' : 'running';
      renderCalibration();
    } else if (currentSection() === 'camera') renderCtlBody();
    if (st === 'running') pollCalibration();
  }, 800);
}

function bindCameraControl() {
  if (!$('#cameraControl')) return;
  document.querySelectorAll('input[name=ctlMode]').forEach((r) => r.addEventListener('change', () => {
    const ctl = S.config.camera.control || {};
    if (r.value === 'camera') saveConfig({ camera: { control: { mode: 'camera' } } }, 'Le boîtier décide de ses réglages');
    else if (r.value === 'auto' && ctl.auto?.profile) saveConfig({ camera: { control: { mode: 'auto' } } }, 'Mode auto activé');
    else renderCtlBody(); // manuel : on enregistre avec le formulaire ; auto sans calibrage : on calibre d'abord
  }));
  renderCtlBody();
  if (CTL.calibration?.state === 'running') { if (!CAL.stage) openCalibration('running'); pollCalibration(); }
  else if (!CTL.calibration) { // dernier calibrage (ou celui en cours) : affiché même après un rechargement
    api('/api/admin/camera/calibration').then((r) => {
      if (!r.calibration || CTL.calibration) return;
      CTL.calibration = r.calibration;
      renderCtlBody();
      if (r.calibration.state === 'running') { openCalibration('running'); pollCalibration(); }
    }).catch(() => {});
  }
}

// Événement affiché dans la section Sessions : #sessions=<id> (par défaut l'événement en cours)
function selectedEventId() {
  const m = location.hash.match(/^#sessions=(.+)$/);
  const id = m ? decodeURIComponent(m[1]) : S.activeEventId;
  return S.events.some((e) => e.id === id) ? id : S.activeEventId;
}

// Sessions d'un événement, par page : la première de l'événement en cours arrive avec l'état, les autres à la demande
let eventSessions = null; // { id, page, pages, total, sessions }
let sessionsPage = { id: null, page: 1 };
const pageOf = (id) => (sessionsPage.id === id ? sessionsPage.page : 1);
async function loadEventSessions(id, page = pageOf(id)) {
  try {
    const r = await api(`/api/admin/events/${encodeURIComponent(id)}/sessions?page=${page}`);
    eventSessions = { id, page: r.page, pages: r.pages, total: r.total, sessions: r.sessions };
    sessionsPage = { id, page: r.page };
  } catch (e) { toast(e.message, true); eventSessions = { id, page, pages: 1, total: 0, sessions: [] }; }
  if (currentSection() === 'sessions' && selectedEventId() === id) render();
}

const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const frDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function sessions() {
  const selId = selectedEventId();
  const ev = S.events.find((e) => e.id === selId);
  const page = pageOf(selId);
  const per = S.sessionsPerPage || 48;
  let list = null;
  if (selId === S.activeEventId && page === 1) list = S.sessions;
  else if (eventSessions?.id === selId && eventSessions.page === page) list = eventSessions.sessions;
  else loadEventSessions(selId, page);
  const pages = Math.max(1, Math.ceil((ev?.sessions || 0) / per));
  const pager = pages > 1 ? `<div class="row pager">
      <button class="btn small" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Page précédente"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
      <span>${(page - 1) * per + 1}–${Math.min(page * per, ev.sessions)} sur ${ev.sessions}</span>
      <button class="btn small" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Page suivante"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
    </div>` : '';

  const STATUS = { shooting: ['en cours', ''], review: ['relecture', ''], copies: ['choix des tirages', ''], printing: ['impression…', 'warn'], done: ['terminée', 'ok'], error: ['erreur', 'err'] };
  const hour = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const day = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const canPrint = S.printer?.available !== false;
  const others = S.events.filter((e) => e.id !== selId);
  // Menu « … » d'une session : déplacer vers un autre événement, supprimer
  const menu = (s) => moreMenu([
    others.length ? `<button class="menu-item" data-move-to="${esc(s.id)}">Déplacer vers un autre événement…</button>` : '',
    `<button class="menu-item danger" data-del-session="${esc(s.id)}" ${s.status === 'printing' ? 'disabled' : ''}>Supprimer</button>`
  ]);
  const view = (s) => {
    const [label, cls] = STATUS[s.status] || [s.status, ''];
    return {
      label, cls,
      tag: s.kind === 'boomerang' ? 'BOOMERANG' : s.gif ? 'GIF' : '',
      when: `${hour(s.createdAt)}${s.createdAt.slice(0, 10) === ev.date ? '' : ` <small>${day(s.createdAt)}</small>`}`,
      prints: s.gif ? 'numérique' : s.copies ? plural(s.copies, 'tirage') : 'sans tirage',
      thumb: s.final ? `<button type="button" class="sess-thumb" data-view="${esc(s.final.url)}" data-alt="${esc(s.templateName)} · ${hour(s.createdAt)}"><img src="${esc(s.final.thumbUrl)}" alt="" loading="lazy"></button>` : '<div class="sess-thumb empty">pas de montage</div>',
      reprint: s.final && !s.gif && canPrint ? `<button class="btn small secondary" data-reprint="${esc(s.id)}">Réimprimer</button>` : ''
    };
  };
  const mosaic = photosView === 'grid';
  const cards = (list || []).map((s) => {
    const v = view(s);
    return mosaic ? `
    <div class="sess-card" title="Session ${esc(s.id)}">
      ${v.thumb}
      ${v.tag ? `<span class="sess-tag">${v.tag}</span>` : ''}
      <div class="sess-meta"><b>${v.when}</b><span class="badge ${v.cls}">${v.label}</span></div>
      <div class="sess-sub">${esc(s.templateName)} · ${v.prints}</div>
      ${s.error ? `<small class="hw-err">${esc(s.error)}</small>` : ''}
      <div class="sess-actions">${v.reprint}${menu(s)}</div>
    </div>` : `
    <tr title="Session ${esc(s.id)}">
      <td class="sess-td-thumb">${v.thumb}</td>
      <td><b>${v.when}</b></td>
      <td>${esc(s.templateName)}${v.tag ? ` <span class="badge">${v.tag}</span>` : ''}</td>
      <td><span class="badge ${v.cls}">${v.label}</span>${s.error ? `<br><small class="hw-err">${esc(s.error)}</small>` : ''}</td>
      <td>${v.prints}</td>
      <td class="actions"><div class="cell-actions">${v.reprint}${menu(s)}</div></td>
    </tr>`;
  }).join('');
  const body = mosaic ? `<div class="sess-grid">${cards}</div>`
    : `<table class="data-table sess-table"><thead><tr><th></th><th>Heure</th><th>Cadre</th><th>Statut</th><th>Tirages</th><th></th></tr></thead><tbody>${cards}</tbody></table>`;
  const evOptions = S.events.map((e) => `<option value="${esc(e.id)}" ${e.id === selId ? 'selected' : ''}>${esc(e.name)}${e.active ? ' (en cours)' : ''} · ${esc(frDate(e.date))}</option>`).join('');
  return `
  <h2>Photos</h2>
  <div class="card">
    <div class="ev-head">
      <div class="row">
        <select id="photosEvent" class="ev-select">${evOptions}</select>
        <small>${plural(ev.sessions, 'session')} · ${plural(ev.finals, 'montage')} · ${plural(ev.printed || 0, 'tirage')}</small>
      </div>
      <div class="row">
        ${pager}
        <div class="seg" role="group" aria-label="Affichage">
          <button class="${mosaic ? '' : 'on'}" data-photos-view="list">Liste</button>
          <button class="${mosaic ? 'on' : ''}" data-photos-view="grid">Mosaïque</button>
        </div>
      </div>
    </div>
    ${list === null ? '<p class="sub">Chargement…</p>' : cards ? body : '<p class="sub">Aucune photo dans cet événement.</p>'}
    ${pages > 1 ? `<div class="ev-foot">${pager}</div>` : ''}
  </div>`;
}

/** Choix d'un événement (déplacer une session) : petite fenêtre avec la liste, rend l'id choisi ou null. */
function pickEvent(exceptId) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm-dialog';
    dlg.innerHTML = `<p>Déplacer vers :</p><select class="pick-ev">${S.events.filter((e) => e.id !== exceptId).map((e) => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(frDate(e.date))}</option>`).join('')}</select>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" value="">Annuler</button><button class="btn primary" value="ok">Déplacer</button></div>`;
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => done(b.value ? dlg.querySelector('select').value : null)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

/** Menu « … » : actions secondaires d'une ligne (les éléments vides sont ignorés). */
function moreMenu(items) {
  const html = items.filter(Boolean).join('');
  return html ? `<details class="more"><summary class="btn small more-btn" aria-label="Plus d'actions" title="Plus d'actions"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></summary><div class="menu">${html}</div></details>` : '';
}
/** Un seul menu ouvert à la fois ; un clic ailleurs ou sur une action le ferme. */
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.more[open]')) if (!d.contains(e.target) || e.target.closest('.menu-item')) d.open = false;
});
document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details.more') && e.target.open) for (const d of document.querySelectorAll('details.more[open]')) if (d !== e.target) d.open = false;
}, true);

let photosView = (() => { try { return localStorage.getItem('photosView') || 'grid'; } catch { return 'grid'; } })();

// ---------- Événements : liste paginée, actions par événement ----------
/** Poids sur le disque : Ko, Mo ou Go, une décimale sous 10. */
const weight = (b = 0) => {
  if (!b) return '—';
  const [v, u] = b >= 1e9 ? [b / 1e9, 'Go'] : b >= 1e6 ? [b / 1e6, 'Mo'] : [b / 1e3, 'Ko'];
  return `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')} ${u}`;
};
const EVENTS_PER_PAGE = 12;
let eventsPage = 1;
function eventsSection() {
  const all = S.events; // les plus récents d'abord
  const pages = Math.max(1, Math.ceil(all.length / EVENTS_PER_PAGE));
  eventsPage = Math.min(Math.max(1, eventsPage), pages);
  const shown = all.slice((eventsPage - 1) * EVENTS_PER_PAGE, eventsPage * EVENTS_PER_PAGE);
  const pager = pages > 1 ? `<div class="row pager">
      <button class="btn small" data-ev-page="${eventsPage - 1}" ${eventsPage <= 1 ? 'disabled' : ''} aria-label="Page précédente"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
      <span>${(eventsPage - 1) * EVENTS_PER_PAGE + 1}–${Math.min(eventsPage * EVENTS_PER_PAGE, all.length)} sur ${all.length}</span>
      <button class="btn small" data-ev-page="${eventsPage + 1}" ${eventsPage >= pages ? 'disabled' : ''} aria-label="Page suivante"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
    </div>` : '';
  const key = S.usb?.volume && !S.usb?.exporting;
  const zip = (e, content, label, n) => (n ? `<a class="menu-item" href="/api/admin/events/${encodeURIComponent(e.id)}/export?content=${content}" download>${label}</a>` : '');
  const rows = shown.map((e) => `
    <tr class="${e.active ? 'ev-active' : ''}">
      <td><div class="cell-title">${esc(e.name)} ${e.active ? '<span class="badge ok">en cours</span>' : ''}</div><div class="cell-sub">${esc(frDate(e.date))}</div></td>
      <td class="num">${e.sessions}</td>
      <td class="num">${e.photos}</td>
      <td class="num">${e.finals}</td>
      <td class="num">${e.printed || 0}</td>
      <td class="num">${weight(e.bytes)}</td>
      <td class="actions"><div class="cell-actions">
        <a class="btn small" href="#sessions=${encodeURIComponent(e.id)}">Photos</a>
        ${moreMenu([
          e.active ? '' : `<button class="menu-item" data-ev-activate="${esc(e.id)}">Définir en cours</button>`,
          `<button class="menu-item" data-ev-rename="${esc(e.id)}">Renommer</button>`,
          zip(e, 'finals', 'Télécharger les montages (ZIP)', e.finals),
          zip(e, 'originals', 'Télécharger les originaux (ZIP)', e.photos),
          zip(e, 'both', 'Télécharger tout (ZIP)', e.photos + e.finals),
          key && e.sessions ? `<button class="menu-item" data-usb-copy="${esc(e.id)}">Copier sur la clé</button>` : '',
          e.sessions ? `<button class="menu-item danger" data-ev-empty="${esc(e.id)}">Vider</button>` : '',
          e.active ? '' : `<button class="menu-item danger" data-ev-delete="${esc(e.id)}">Supprimer</button>`
        ])}
      </div></td>
    </tr>`).join('');
  return `
  <div class="ev-page-head">
    <h2>Événements</h2>
    <button class="btn primary" id="btnNewEvent">+ Nouvel événement</button>
  </div>
  ${usbCard()}
  <div class="card">
    ${pager ? `<div class="ev-foot ev-top">${pager}</div>` : ''}
    <table class="data-table ev-table">
      <thead><tr><th>Événement</th><th class="num">Sessions</th><th class="num">Originaux</th><th class="num">Montages</th><th class="num">Tirages</th><th class="num">Poids</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${pager ? `<div class="ev-foot">${pager}</div>` : ''}
  </div>`;
}

/** Clé USB (page Événements & photos) : état, copie de l'événement affiché, éjection, copie automatique. */
const gb = (n) => (n == null ? '' : `${(n / 1e9).toFixed(n < 10e9 ? 1 : 0).replace('.', ',')} Go libres`);
function usbCard() {
  const u = S.usb;
  if (!u?.available) return '';
  const cfg = S.config.usb || {};
  const x = u.exporting;
  const last = u.lastExport;
  const state = x ? `<span class="badge warn">copie ${x.done} / ${x.total}</span> <small>${esc(x.eventName)}</small>`
    : u.volume ? `<span class="badge ok">${esc(u.volume.name)}</span> <small>${gb(u.volume.free)}</small>`
    : '<span class="badge">aucune clé</span>';
  const lastLine = last && !x ? `<small>Dernière copie ${new Date(last.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} : ${last.ok ? `${plural(last.copied, 'fichier copié', 'fichiers copiés')}${last.skipped ? `, ${last.skipped} déjà là` : ''}` : esc(last.error)} · <code>${esc(last.dest.split(/[\\/]/).slice(-2).join('/'))}</code></small>` : '';
  return `
    <div class="card usb-card">
      <div class="row"><b>Clé USB</b> ${state}
        <button class="btn small" id="btnUsbEject" ${u.volume && !x ? '' : 'disabled'}>Éjecter</button>
      </div>
      <form id="formUsb" class="row">
        <label class="inline"><input name="usbAuto" type="checkbox" ${cfg.autoExport !== false ? 'checked' : ''}> Copie auto de l'événement en cours au branchement</label>
        <select name="usbContent" class="small usb-content">${[['both', 'Originaux et montages'], ['finals', 'Montages'], ['originals', 'Originaux']].map(([v, lb]) => `<option value="${v}" ${(cfg.content || 'both') === v ? 'selected' : ''}>${lb}</option>`).join('')}</select>
      </form>
      ${u.error && !x ? `<small class="hw-err">${esc(u.error)}</small>` : lastLine}
    </div>`;
}

/** Copie en cours : l'état de la clé est relu chaque seconde jusqu'à la fin. */
function pollUsb() {
  clearTimeout(pollUsb.t);
  pollUsb.t = setTimeout(async () => {
    try { S.usb = (await api('/api/admin/usb')).usb; } catch { return; }
    if (['events', 'dashboard'].includes(currentSection())) render();
    if (S.usb?.exporting) pollUsb();
  }, 1000);
}

function bindUsb() {
  if (!$('#formUsb')) return;
  autoSave($('#formUsb'), (fd) => saveConfig({ usb: { autoExport: fd.get('usbAuto') === 'on', content: fd.get('usbContent') || 'both' } }));
  document.querySelectorAll('[data-usb-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { S.usb = (await api('/api/admin/usb/export', { method: 'POST', body: { eventId: b.dataset.usbCopy } })).usb; render(); pollUsb(); } catch (e) { toast(e.message, true); }
  }));
  $('#btnUsbEject')?.addEventListener('click', async () => {
    const b = $('#btnUsbEject');
    b.disabled = true;
    b.textContent = 'Éjection…';
    try { S.usb = (await api('/api/admin/usb/eject', { method: 'POST' })).usb; toast('Clé éjectée, vous pouvez la retirer'); } catch (e) { toast(e.message, true); }
    render();
  });
  if (S.usb?.exporting) pollUsb();
}

/** Vide un événement (en cours par défaut) : sessions, photos et compteur de tirages. */
async function resetSessions(eventId = S.activeEventId) {
  const ev = S.events.find((e) => e.id === eventId);
  const n = ev.sessions;
  if (!await askConfirm(`Vider « ${ev.name} » ?\n\n${n} session${n > 1 ? 's' : ''} et leurs photos seront supprimées, compteur de tirages remis à zéro.`, 'Vider', 'delete')) return;
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
  <h2>Galerie &amp; partage</h2>
  <p class="sub">Les invités récupèrent leur photo en scannant un QR code avec leur téléphone, et retrouvent celles de la soirée dans la galerie.${n ? ` Wi-Fi de la borne : <span class="badge ${n.wifi ? 'ok' : 'err'}">${n.wifi ? `connecté (${esc(n.ip)})` : 'absent'}</span>` : ''}</p>
  ${galleryCard()}
  <form id="formShare" class="card">
    <div class="grid-2">
      <div>
        <h3>QR code des photos</h3>
        <label class="inline"><input name="qrOnDone" type="checkbox" ${cfg.share.qrOnDone !== false ? 'checked' : ''}> QR code sur l'écran de fin</label>
        <small>Décoché : pas d'écran de fin, la borne revient à l'accueil avec le texte « ${esc(cfg.texts.thanksNoQr)} » en bandeau (<a href="#texts">Textes des écrans</a>).</small>
        <label class="inline"><input name="requireWifi" type="checkbox" ${cfg.share.requireWifi !== false ? 'checked' : ''}> QR codes seulement si la borne est en Wi-Fi</label>
        <small>Décoché : QR codes affichés même sans Wi-Fi (borne en Ethernet sur un réseau que les téléphones joignent).</small>
      </div>
      <div>
        <h3>Adresses</h3>
        <label>URL de base (vide = détection automatique) <input name="shareBaseUrl" value="${esc(cfg.share.baseUrl)}" placeholder="http://photobooth.local:3000"></label>
        <small>Adresse des QR codes : <code>${esc(S.shareBaseUrl)}</code>. Borne en hotspot Wi-Fi : mettez ici l'adresse que les invités atteignent. Sans http:// ni port, la borne les ajoute.</small>
        <label>Adresse publique (facultative) <input name="publicUrl" value="${esc(cfg.share.publicUrl || '')}" placeholder="https://photobooth.domain.fr"></label>
        <small>Remplie : les QR codes de photo y mènent. Hors du Wi-Fi de la borne, la page distante (<code>npm run remote</code>) invite l'invité à s'y connecter, puis affiche sa photo. Voir TUTORIEL.md, étape 10.8.</small>
      </div>
    </div>
  </form>
  ${wifiCard()}`;
}

function security() {
  const cfg = S.config;
  return `
  <h2>Sécurité</h2>
  <p class="sub">Codes enregistrés dès que vous quittez le champ.</p>
  <form id="formCodes" class="card">
    <div class="grid-2">
      <div>
        <label>Code PIN admin <input name="adminPin" value="${esc(cfg.admin.pin)}" placeholder="vide = pas de code" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" title="4 à 8 chiffres"></label>
        ${cfg.admin.pin ? '' : '<div class="alert">Aucun code admin : n\'importe qui peut ouvrir l\'admin. À remettre avant un événement.</div>'}
        ${cfg.admin.pin && !/^\d{4,8}$/.test(cfg.admin.pin) ? '<div class="alert">Code admin impossible à saisir sur le pavé de la borne : 4 à 8 chiffres.</div>' : ''}
        <small>Sur la borne : 5 appuis en haut à droite de l'écran, ou sur le Stream Deck les touches du haut gauche, droite, gauche, droite, ouvrent l'admin.</small>
      </div>
      <div>
        <label>Code opérateur <input name="operatorPin" value="${esc(cfg.limits.operatorPin)}" required inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" title="4 à 8 chiffres"></label>
        <small>Sur la borne (écran ou Stream Deck) : lève la limite de copies et le quota, et autorise la réimpression depuis la galerie si elle est réglée ainsi.</small>
      </div>
    </div>
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
        <label>Mot de passe <span class="pw-row"><input name="password" type="password" value="${esc(w.password)}" autocomplete="off" ${open ? 'disabled' : ''}><button type="button" class="btn small" data-pw-toggle>Afficher</button></span></label>
      </div>
    </div>
    ${w.enabled && (!w.ssid || (!open && !w.password)) ? '<div class="alert">Nom du réseau ou mot de passe manquant : le QR code n\'est pas affiché.</div>' : ''}
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
  </form>`;
}

// ---------- Éditeur de template (calques) ----------

const E = { tpl: null, selected: null, dirty: false, samplesOn: true, scale: 1, dpr: 1, assets: new Map(), samples: [], drag: null, onResize: null, gifFrame: 0, gifTimer: 0 };
const editingGif = () => E.tpl?.kind === 'gif';
const editingBoomerang = () => E.tpl?.kind === 'boomerang';
const editingAnimated = () => editingGif() || editingBoomerang(); // calques photo : tous montrent la même image
const KIND_LABEL = { gif: 'GIF animé', boomerang: 'Boomerang' };

const LAYER_LABEL = { photo: 'Photo', text: 'Texte', image: 'Image', rect: 'Forme' };
const layerTitle = (l) => l.name || (l.type === 'photo' ? (editingGif() ? 'Photo (pose en cours)' : editingBoomerang() ? 'Vidéo' : `Photo ${l.shot + 1}`) : l.type === 'text' ? `Texte « ${String(l.text || '').split('\n')[0].slice(0, 18)} »` : LAYER_LABEL[l.type]);
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
    <p class="editor-mobile-note">Le concepteur se manipule mieux sur un grand écran (ordinateur, ou tablette en paysage) : placer et redimensionner les calques au doigt reste possible, mais peu précis.</p>
    <div class="editor-top">
      <button class="btn" id="edBack"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Templates</button>
      <input id="edName" class="ed-name" value="${esc(E.tpl.name)}" title="Nom du template">
      <span class="badge">${KIND_LABEL[t.kind] ? `${KIND_LABEL[t.kind]} · ` : ''}${esc(fmt)} · ${t.width}×${t.height} px</span>
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
        ${t.kind === 'gif' ? gifFields() : t.kind === 'boomerang' ? boomerangFields() : ''}
        <h3>Calques <small>(le premier est au-dessus)</small></h3>
        <ul id="edLayers" class="layer-list"></ul>
        <h3>Propriétés</h3>
        <div id="edProps" class="props"><p class="muted">Sélectionnez un calque sur l'aperçu ou dans la liste.</p></div>
      </aside>
    </div>
    <p class="muted small">Glisser = déplacer · tirer un coin = redimensionner (Maj conserve les proportions) · flèches = 1 px (Maj = 10) · Suppr = supprimer · poignée ronde = rotation (Maj = pas de 15°). Les calques peuvent dépasser du tirage ; ils se collent aux bords et au centre (Alt maintenu : sans aimant).</p>
  </div>`;
}

/** Réglages d'un template GIF : poses, vitesse, aller-retour, décompte entre les poses. */
function gifFields() {
  const g = E.tpl.gif;
  return `
        <h3>Animation</h3>
        <div class="props gif-props">
          <div class="row2">
            <label>Poses <input type="number" data-g="frames" min="2" max="10" value="${g.frames}"></label>
            <label>Vitesse (ms par image) <input type="number" data-g="frameMs" min="100" max="2000" step="50" value="${g.frameMs}"></label>
          </div>
          <label>Décompte entre deux poses (s) <input type="number" data-g="poseSec" min="1" max="10" value="${g.poseSec}"></label>
          <label class="inline"><input type="checkbox" data-g="boomerang" ${g.boomerang ? 'checked' : ''}> Aller-retour (1 2 3 2…)</label>
          <small class="muted">Chaque pose s'affiche dans les calques photo ; le reste (cadre, textes, logo) est identique sur toutes les images. La première pose garde le décompte normal. Un GIF n'est jamais imprimé.</small>
        </div>`;
}

/** Réglages d'un boomerang : durée filmée. */
function boomerangFields() {
  const d = E.tpl.boomerang.durationSec;
  const sp = E.tpl.boomerang.speed ?? 2;
  const speeds = { 1: 'Normale (×1)', 1.5: 'Rapide (×1,5)', 2: 'Accélérée (×2)', 3: 'Très accélérée (×3)' };
  return `
        <h3>Boomerang</h3>
        <div class="props gif-props">
          <div class="row2">
            <label>Durée filmée <select data-bm="durationSec">${[1, 1.5, 2, 2.5, 3, 3.5, 4].map((v) => `<option value="${v}" ${v === d ? 'selected' : ''}>${String(v).replace('.', ',')} s</option>`).join('')}</select></label>
            <label>Vitesse de lecture <select data-bm="speed">${Object.entries(speeds).map(([v, l]) => `<option value="${v}" ${Number(v) === sp ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
          <small class="muted">Filmé dans l'aperçu du boîtier (environ 960×640, sans flash), puis joué en avant et en arrière, en boucle, à la vitesse choisie (×2 : effet vidéo accélérée). La borne fait la mise au point pendant le décompte. Les calques photo montrent la vidéo ; le reste est identique sur toutes les images. Pas de détourage IA (trop d'images), fond vert ou bleu possible. Jamais imprimé.</small>
        </div>`;
}

/** Aperçu animé de l'éditeur : les photos d'exemple défilent à la vitesse du GIF. */
function startGifPreview() {
  clearInterval(E.gifTimer);
  E.gifTimer = 0;
  if (!editingGif()) return;
  E.gifTimer = setInterval(() => { E.gifFrame++; if (E.samplesOn && !E.drag) renderEditor(); }, E.tpl.gif.frameMs);
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
  let photos = E.samplesOn ? photosFromSamples({ shots: Math.max(...E.tpl.layers.filter((l) => l.type === 'photo').map((l) => l.shot), -1) + 1 }, E.samples) : {};
  if (editingGif() && E.samplesOn && E.samples.length) photos = { 0: E.samples[E.gifFrame % E.samples.length] }; // pose après pose
  renderTemplate(ctx, E.tpl, { scale: E.scale * E.dpr, photos, cutoutPhotos: cutoutsFromSamples(photos), assets: E.assets, placeholder: true });
  // Repères du magnétisme (bord ou centre du tirage atteint)
  if (E.guides?.length) {
    ctx.save();
    ctx.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
    ctx.strokeStyle = '#e0218a';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    for (const g of E.guides) {
      ctx.beginPath();
      if (g.axis === 'x') { ctx.moveTo(g.pos * E.scale, 0); ctx.lineTo(g.pos * E.scale, E.tpl.height * E.scale); }
      else { ctx.moveTo(0, g.pos * E.scale); ctx.lineTo(E.tpl.width * E.scale, g.pos * E.scale); }
      ctx.stroke();
    }
    ctx.restore();
  }
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
      <button class="eye" data-vis="${esc(l.id)}" title="Afficher / masquer">${l.visible === false ? '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>' : '<i class="fa-solid fa-eye" aria-hidden="true"></i>'}</button>
      <span class="ltype ${l.type}">${LAYER_LABEL[l.type]}</span>
      <span class="lname">${esc(layerTitle(l))}</span>
      <span class="lbtns">
        <button data-up="${esc(l.id)}" title="Monter"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
        <button data-down="${esc(l.id)}" title="Descendre"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
        <button data-dup="${esc(l.id)}" title="Dupliquer"><i class="fa-solid fa-clone" aria-hidden="true"></i></button>
        <button data-rm="${esc(l.id)}" title="Supprimer"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
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
  ul.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => { if (await askConfirm('Supprimer ce calque ?', 'Supprimer', 'delete')) removeLayer(b.dataset.rm); });
}

function removeLayer(id) {
  E.tpl.layers = E.tpl.layers.filter((l) => l.id !== id);
  if (E.selected === id) E.selected = null;
  markDirty();
  renderAll();
}

/** Un calque ne peut pas sortir du template : position bornée, taille plafonnée. */
/** Valeurs entières et taille minimale. Un calque peut dépasser du tirage (la partie hors cadre n'est pas imprimée). */
function clampLayer(l) {
  l.width = Math.max(1, Math.round(l.width));
  l.height = Math.max(1, Math.round(l.height));
  l.x = Math.round(l.x);
  l.y = Math.round(l.y);
}

// ---------- Magnétisme : bords et centres du tirage (Alt maintenu : désactivé) ----------

const SNAP_PX = 8; // distance d'attraction, en pixels écran
/** Demi-largeur / demi-hauteur de l'encombrement d'un calque, rotation comprise. */
function halfBox(l) {
  const a = (l.rotation || 0) * DEG;
  return { hw: (Math.abs(l.width * Math.cos(a)) + Math.abs(l.height * Math.sin(a))) / 2, hh: (Math.abs(l.width * Math.sin(a)) + Math.abs(l.height * Math.cos(a))) / 2 };
}
/** Colle un calque déplacé aux bords et centres du tirage ; renvoie les lignes de repère à afficher. */
function snapMove(l) {
  const W = E.tpl.width, H = E.tpl.height, tol = SNAP_PX / E.scale;
  const { hw, hh } = halfBox(l);
  const guides = [];
  const axis = (center, half, size, key) => {
    let best = null;
    for (const target of [0, size / 2, size]) {
      for (const [edge, offset] of [[center - half, -half], [center, 0], [center + half, half]]) {
        const d = target - edge;
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, target };
      }
    }
    if (!best) return center;
    guides.push({ axis: key, pos: best.target });
    return center + best.d;
  };
  const cx = axis(l.x + l.width / 2, hw, W, 'x');
  const cy = axis(l.y + l.height / 2, hh, H, 'y');
  l.x = Math.round(cx - l.width / 2);
  l.y = Math.round(cy - l.height / 2);
  return guides;
}
/** Colle le coin tiré (redimensionnement) aux bords et centres du tirage. */
function snapPoint(x, y, guides) {
  const W = E.tpl.width, H = E.tpl.height, tol = SNAP_PX / E.scale;
  const near = (v, size, key) => {
    for (const t of [0, size / 2, size]) if (Math.abs(v - t) <= tol) { guides.push({ axis: key, pos: t }); return t; }
    return v;
  };
  return { x: near(x, W, 'x'), y: near(y, H, 'y') };
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
    if (editingBoomerang()) delete cutOpts.ai; // trop d'images pour le détourage IA
    specific = `${editingGif() ? '<small class="muted">GIF : ce calque montre la pose en cours.</small>' : editingBoomerang() ? '<small class="muted">Boomerang : ce calque montre la vidéo.</small>' : `<label>Photo affichée <select data-p="shot" data-num>${shots}</select></label>`}${n('radius', 'Coins arrondis (px)', 0, 2000)}
      <small class="muted">Plusieurs calques peuvent afficher la même photo (bande dupliquée).</small>
      <label>Détourage <select data-p="cutout" id="pCutout">${Object.entries(cutOpts).map(([k, v]) => `<option value="${k}" ${cut === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${cut === 'ai' ? `
      <label>Seuil <input type="range" data-p="aiThreshold" min="0" max="100" step="1" value="${l.aiThreshold ?? 50}"><small>Plus haut : retire plus de fond. Plus bas : garde plus de la personne (bras, cheveux).</small></label>
      <label>Douceur des bords <input type="range" data-p="aiSoftness" min="0" max="100" step="1" value="${l.aiSoftness ?? 50}"><small>À gauche : découpe nette. À droite : bord fondu.</small></label>
      <label>Contour (px) <input type="number" data-p="aiContour" min="-10" max="10" step="1" value="${l.aiContour ?? 0}"><small>Négatif : resserre la découpe (enlève un halo du fond). Positif : l'élargit.</small></label>
      <label>Modèle de la photo finale <select data-p="aiPrecision" id="pAiModel"><option value="precise" ${l.aiPrecision !== 'fast' ? 'selected' : ''}>Précis : tout sujet, bords propres (calculé pendant la séance)</option><option value="fast" ${l.aiPrecision === 'fast' ? 'selected' : ''}>Rapide : personnes seulement</option></select><small>Précis : ~5 s par photo, calculé pendant la séance ; rapide : ~0,5 s. Les boomerangs utilisent toujours le rapide (une vingtaine d'images).</small></label>
      ${l.aiPrecision !== 'fast' ? modelNotice() : ''}
      <div class="row"><button class="btn small secondary" type="button" id="pCutTestLast">Tester sur la dernière photo</button><button class="btn small" type="button" id="pCutTestSample">Tester sur la photo d'exemple</button></div>
      <small class="muted">Le test fait le vrai montage de la photo finale avec les réglages affichés, même non enregistrés.</small>` : ''}
      ${cut === 'green' || cut === 'blue' ? `<label>Tolérance <input type="range" data-p="keyTolerance" min="0" max="100" step="1" value="${l.keyTolerance ?? 50}"></label>
      <small class="muted">Plus haut : retire aussi les zones du fond plus sombres (ombres, plis). Trop haut : le sujet s'efface là où il ressemble au fond.</small>` : ''}
      ${cut !== 'none' ? `<small class="muted">Le fond retiré laisse voir les calques placés <b>sous</b> cette photo dans la liste (image, couleur…).${cut === 'ai' ? ' L\'aperçu en direct est un peu moins précis sur les bords que la photo finale.' : ''} L'aperçu de l'éditeur utilise la photo d'exemple déjà détourée (template-photo.png, s'il existe).</small>` : ''}`;
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
      <small class="muted">${esc(l.src)}${img ? ` · ${img.naturalWidth}×${img.naturalHeight}` : ''}</small>
      ${imageBgFields(l)}`;
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
  $('#pAiModel')?.addEventListener('change', () => renderProps()); // message du modèle précis
  bindImageBg(box, l);
  const cutTest = async (source, btn) => {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Montage en cours…';
    try {
      const r = await api('/api/admin/templates/test-cutout', { method: 'POST', body: { id: E.tpl.id, source, template: { width: E.tpl.width, height: E.tpl.height, background: E.tpl.background, layers: E.tpl.layers } } });
      openLightbox(r.url);
      toast(`Essai sur la ${r.source} (${(r.ms / 1000).toFixed(1)} s)`);
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = label;
  };
  $('#pCutTestLast')?.addEventListener('click', (e) => cutTest('last', e.target));
  $('#pCutTestSample')?.addEventListener('click', (e) => cutTest('sample', e.target));
  $('#pRotReset')?.addEventListener('click', () => { l.rotation = 0; clampLayer(l); markDirty(); renderProps(); renderEditor(); });
  $('#pFillNone')?.addEventListener('change', (e) => { l.fill = e.target.checked ? 'none' : '#000000'; markDirty(); renderProps(); renderEditor(); });
  $('#pStrokeNone')?.addEventListener('change', (e) => { l.stroke = e.target.checked ? 'none' : '#000000'; if (!e.target.checked && !l.strokeWidth) l.strokeWidth = 8; markDirty(); renderProps(); renderEditor(); });
  $('#pImgReplace')?.addEventListener('click', () => { E.replaceTarget = l.id; $('#edImageFile').click(); });
  $('#pImgRatio')?.addEventListener('click', () => { const img = E.assets.get(l.src); if (img) { l.height = Math.round(l.width * img.naturalHeight / img.naturalWidth); clampLayer(l); markDirty(); renderProps(); renderEditor(); } });
}

// ---------- Calque image : retirer le fond (version transparente calculée par le serveur) ----------

function imageBgFields(l) {
  const mode = l.bgRemove || 'none';
  if (mode === 'none') {
    return `<div class="row"><button class="btn small primary" type="button" id="pBgAuto">Retirer le fond</button></div>
      <small class="muted">La borne choisit la méthode selon l'image : un fond uni (logo, dessin) est retiré à la couleur près, sinon le sujet est détouré par IA.</small>
      <div id="pBgNotice"></div>`;
  }
  const opts = { color: 'Fond uni (logo, dessin…)', ai: 'Sujet détouré par IA' };
  let fields = '';
  if (mode === 'color') {
    fields = `
      <div class="row"><label>Couleur du fond <input type="color" data-bgp="bgColor" value="${esc(l.bgColor || '#ffffff')}"></label>
      <button class="btn small" type="button" id="pBgCorner">Couleur des coins</button></div>
      <label>Tolérance <input type="range" data-bgp="bgTolerance" min="0" max="100" step="1" value="${l.bgTolerance ?? 30}"><small>Plus haut : retire aussi les nuances proches (ombres, dégradés).</small></label>
      <label class="inline"><input type="checkbox" data-bgp="bgContiguous" ${l.bgContiguous !== false ? 'checked' : ''}> Seulement le fond autour (garde cette couleur à l'intérieur)</label>`;
  } else if (mode === 'ai') {
    fields = `
      <label>Seuil <input type="range" data-bgp="aiThreshold" min="0" max="100" step="1" value="${l.aiThreshold ?? 50}"></label>
      <label>Douceur des bords <input type="range" data-bgp="aiSoftness" min="0" max="100" step="1" value="${l.aiSoftness ?? 50}"></label>
      <label>Contour (px) <input type="number" data-bgp="aiContour" min="-10" max="10" step="1" value="${l.aiContour ?? 0}"></label>
      <small class="muted">Détoure le sujet principal (personne, objet, figurine). Pour un logo ou du texte sur fond uni, « Fond uni » est plus net.</small>
      ${modelNotice()}`;
  }
  return `<div class="row"><small class="muted" id="pBgStatus">${esc(l.cutSrc ? l.bgReason || 'Fond retiré, visible dans l\'aperçu.' : 'Calcul…')}</small>
      <button class="btn small" type="button" id="pBgUndo">Remettre le fond</button></div>
    <details class="bg-adjust" ${E.bgAdjust ? 'open' : ''}><summary>Ajuster</summary>
      <label>Méthode <select data-bgp="bgRemove" id="pBgMode">${Object.entries(opts).map(([k, v]) => `<option value="${k}" ${mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${fields}
    </details>`;
}

/** Modèle de détourage précis absent : message et bouton d'installation (vide s'il est installé). */
/** Vitesse du détourage précis sur cette machine, et repli automatique sur le modèle rapide. */
function perfNotice() {
  const p = S.cutoutPerf || {};
  const sec = (v) => `${String(v).replace('.', ',')} s`;
  const measured = p.preciseSec == null ? '<span class="badge">vitesse non mesurée</span>'
    : `<span class="badge ${p.slow ? 'warn' : 'ok'}">${sec(p.preciseSec)} par photo${p.slow ? ', trop lent' : ''}</span>`;
  return `${measured}
    <label class="inline"><input id="cutoutAuto" type="checkbox" ${S.config.templates.cutoutAuto !== false ? 'checked' : ''}> Modèle rapide si la machine est trop lente</label>`;
}

function modelNotice() {
  const m = S.subjectModel;
  if (!m || m.installed) return '';
  const pct = m.downloading ? ` ${Math.round((m.received / m.size) * 100)} %` : '';
  return `<div class="alert model-notice">Modèle précis non installé : détourage de secours (personnes seulement, bords moins propres).
    <button class="btn small" type="button" data-model-dl ${m.downloading ? 'disabled' : ''}>${m.downloading ? `Téléchargement…${pct}` : `Installer (${Math.round(m.size / 1e6)} Mo, une fois)`}</button>
    ${m.error ? `<br><small>Échec : ${esc(m.error)}</small>` : ''}</div>`;
}

/** Téléchargement du modèle précis (borne connectée à internet), suivi jusqu'à la fin. */
async function downloadSubjectModel() {
  try { S.subjectModel = await api('/api/admin/models/subject/download', { method: 'POST' }); } catch (e) { toast(e.message, true); return; }
  const refreshNotices = () => { document.querySelectorAll('.model-notice').forEach((el) => { el.outerHTML = modelNotice(); }); bindModelButtons(); if (currentSection() === 'templates') render(); };
  refreshNotices();
  const poll = async () => {
    try { S.subjectModel = await api('/api/admin/models/subject'); } catch { /* réessaie */ }
    if (S.subjectModel.downloading) { document.querySelectorAll('[data-model-dl]').forEach((b) => { b.textContent = `Téléchargement… ${Math.round((S.subjectModel.received / S.subjectModel.size) * 100)} %`; }); setTimeout(poll, 1000); return; }
    if (S.subjectModel.installed) toast('Modèle de détourage précis installé');
    else toast(`Échec du téléchargement : ${S.subjectModel.error || 'inconnu'}`, true);
    refreshNotices();
    if (currentSection() === 'editor') renderProps();
  };
  setTimeout(poll, 1000);
}
function bindModelButtons() {
  document.querySelectorAll('[data-model-dl]').forEach((b) => { b.onclick = downloadSubjectModel; });
}

/** Calcule (serveur) la version sans fond du calque image avec ses réglages, puis met l'aperçu à jour. */
let bgTimer = null;
function scheduleImageCutout(l) {
  clearTimeout(bgTimer);
  if (!l.bgRemove || l.bgRemove === 'none') { markDirty(); renderEditor(); return; }
  bgTimer = setTimeout(async () => {
    const status = $('#pBgStatus');
    if (status) status.textContent = 'Calcul…';
    try {
      const r = await api(`/api/admin/templates/${encodeURIComponent(E.tpl.id)}/assets/cutout`, { method: 'POST', body: {
        src: l.src, mode: l.bgRemove, bgColor: l.bgColor, bgTolerance: l.bgTolerance, bgContiguous: l.bgContiguous !== false,
        aiThreshold: l.aiThreshold, aiSoftness: l.aiSoftness, aiContour: l.aiContour, aiPrecision: l.aiPrecision
      } });
      const img = await loadImage(r.url);
      if (img) E.assets.set(r.cutSrc, img);
      l.cutSrc = r.cutSrc;
      markDirty();
      renderEditor();
      const st = $('#pBgStatus');
      if (st && selectedLayer() === l) st.textContent = 'Fond retiré, visible dans l\'aperçu.';
    } catch (e) {
      toast(e.message, true);
      const st = $('#pBgStatus');
      if (st) st.textContent = `Échec : ${e.message}`;
    }
  }, 350);
}

function bindImageBg(box, l) {
  bindModelButtons();
  if (l.type !== 'image') return;
  box.querySelector('.bg-adjust')?.addEventListener('toggle', (e) => { E.bgAdjust = e.target.open; });
  $('#pBgAuto')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = 'Analyse de l\'image…';
    try {
      const r = await api(`/api/admin/templates/${encodeURIComponent(E.tpl.id)}/assets/auto-cutout`, { method: 'POST', body: { src: l.src } });
      if (r.mode === 'none') { toast(r.reason); b.disabled = false; b.textContent = 'Retirer le fond'; return; }
      for (const k of ['bgRemove', 'bgColor', 'bgTolerance', 'bgContiguous', 'aiThreshold', 'aiSoftness', 'aiContour', 'aiPrecision']) if (r[k] !== undefined) l[k] = r[k];
      const img = await loadImage(r.url);
      if (img) E.assets.set(r.cutSrc, img);
      l.cutSrc = r.cutSrc;
      l.bgReason = r.reason; // affiché sous le calque (pas enregistré)
      markDirty();
      renderProps();
      renderEditor();
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Retirer le fond';
      if (err.code === 'MODEL_MISSING') { $('#pBgNotice').innerHTML = modelNotice(); bindModelButtons(); }
      toast(err.message, true);
    }
  });
  $('#pBgUndo')?.addEventListener('click', () => {
    l.bgRemove = 'none';
    l.cutSrc = null;
    delete l.bgReason;
    renderProps();
    scheduleImageCutout(l);
  });
  box.querySelectorAll('[data-bgp]').forEach((el) => el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
    const k = el.dataset.bgp;
    l[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
    if (k === 'bgRemove') { l.cutSrc = null; delete l.bgReason; renderProps(); }
    else delete l.bgReason; // réglé à la main
    scheduleImageCutout(l);
  }));
  $('#pBgCorner')?.addEventListener('click', async () => {
    try {
      l.bgColor = (await api(`/api/admin/templates/${encodeURIComponent(E.tpl.id)}/assets/corner-color`, { method: 'POST', body: { src: l.src } })).color;
      const input = box.querySelector('[data-bgp=bgColor]');
      if (input) input.value = l.bgColor;
      scheduleImageCutout(l);
    } catch (e) { toast(e.message, true); }
  });
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
  E.guides = [];
  if (d.kind === 'move') {
    l.x = o.x + Math.round(tx - d.startX);
    l.y = o.y + Math.round(ty - d.startY);
    if (!e.altKey) E.guides = snapMove(l);
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
    const snapped = e.altKey || o.rotation ? { x: tx, y: ty } : snapPoint(tx, ty, E.guides); // calque droit : coin aimanté
    const mx = snapped.x, my = snapped.y;
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
    E.guides = [];
    renderEditor();
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
    while (used.has(shot) && !editingAnimated()) shot++; // GIF : tous les calques photo montrent la pose en cours
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
      target.cutSrc = null; // nouvelle image : fond à retirer de nouveau
      if (target.bgRemove && target.bgRemove !== 'none') scheduleImageCutout(target);
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
    const t = await api(`/api/admin/templates/${encodeURIComponent(E.tpl.id)}`, { method: 'PUT', body: { name: E.tpl.name, background: E.tpl.background, layers: E.tpl.layers, gif: E.tpl.gif || undefined, boomerang: E.tpl.boomerang || undefined } });
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
  document.querySelectorAll('[data-g]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.g;
    E.tpl.gif[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
    markDirty();
    if (k === 'frameMs') startGifPreview();
  }));
  document.querySelectorAll('[data-bm]').forEach((el) => el.addEventListener('change', () => {
    E.tpl.boomerang[el.dataset.bm] = Number(el.value);
    markDirty();
  }));
  startGifPreview();
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
  clearInterval(E.gifTimer);
  E.gifTimer = 0;
  E.drag = null;
}

// ---------- Journal en direct : lignes du serveur et appels à l'API, par module ----------

const LOG_MAX = 3000; // événements gardés à l'écran
const LOG_MAX_CALLS = 1000; // appels HTTP, comptés à part (comme sur le serveur)
const logIsCall = (e) => e.cat === 'api' || e.cat === 'apiAdmin';
const LOG = { items: [], cats: [], source: null, cat: 'all', level: 'all', q: '', paused: false, pending: 0 };
const LOG_LEVELS = [['all', 'Tout'], ['WARN', 'Avertissements'], ['ERROR', 'Erreurs']];

function logsSection() {
  return `
  <h2>Journal</h2>
  <div class="card log-card">
    <div class="log-cats" id="logCats"></div>
    <div class="log-bar">
      <div class="seg" id="logLevels">${LOG_LEVELS.map(([k, l]) => `<button type="button" data-level="${k}" class="${LOG.level === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input type="search" id="logSearch" placeholder="Rechercher" value="${esc(LOG.q)}">
      <span class="log-state" id="logState"></span>
      <div class="cell-actions">
        <button type="button" class="btn small" id="logPause">${LOG.paused ? 'Reprendre' : 'Pause'}</button>
        <a class="btn small" href="/api/admin/logs/run" download>Télécharger</a>
      </div>
    </div>
    <div class="log-list" id="logList"></div>
  </div>`;
}

const logMatch = (e) => (LOG.cat === 'all' || e.cat === LOG.cat)
  && (LOG.level === 'all' || e.level === LOG.level || (LOG.level === 'WARN' && e.level === 'ERROR'))
  && (!LOG.q || `${e.module} ${e.msg}`.toLowerCase().includes(LOG.q.toLowerCase()));

function logRow(e) {
  const d = new Date(e.t);
  const time = `${d.toLocaleTimeString('fr-FR')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  const cat = LOG.cats.find(([k]) => k === e.cat)?.[1] || e.cat;
  return `<div class="log-row lv-${e.level.toLowerCase()}" data-id="${e.id}"><span class="log-t">${time}</span><span class="log-cat c-${e.cat}">${esc(cat)}</span><span class="log-mod">${esc(e.module)}</span><span class="log-msg">${esc(e.msg)}</span></div>`;
}

function renderLogCats() {
  const box = $('#logCats');
  if (!box) return;
  const count = (k) => LOG.items.filter((e) => k === 'all' || e.cat === k).length;
  box.innerHTML = [['all', 'Vue générale'], ...LOG.cats].map(([k, l]) => `<button type="button" data-cat="${k}" class="log-chip${LOG.cat === k ? ' on' : ''}${k !== 'all' && !count(k) ? ' empty' : ''}">${esc(l)}<b>${count(k)}</b></button>`).join('');
}

function renderLogList() {
  const list = $('#logList');
  if (!list) return;
  const rows = LOG.items.filter(logMatch);
  list.innerHTML = rows.length ? rows.map(logRow).join('') : '<div class="log-empty">Aucune ligne</div>';
  list.scrollTop = list.scrollHeight;
  renderLogCats();
}

function logState() {
  const el = $('#logState');
  if (el) el.textContent = LOG.paused ? (LOG.pending ? `en pause · ${LOG.pending} nouvelle${LOG.pending > 1 ? 's' : ''}` : 'en pause') : (LOG.source ? 'en direct' : 'connexion…');
}

function addLog(e) {
  LOG.items.push(e);
  const call = logIsCall(e);
  if (LOG.items.filter((x) => logIsCall(x) === call).length > (call ? LOG_MAX_CALLS : LOG_MAX)) {
    const [old] = LOG.items.splice(LOG.items.findIndex((x) => logIsCall(x) === call), 1); // la plus ancienne du même genre
    $('#logList')?.querySelector(`[data-id="${old.id}"]`)?.remove();
  }
  if (LOG.paused) { LOG.pending++; logState(); return; }
  const list = $('#logList');
  if (!list) return;
  if (logMatch(e)) {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40; // on lisait plus haut : pas de saut
    list.querySelector('.log-empty')?.remove();
    list.insertAdjacentHTML('beforeend', logRow(e));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  clearTimeout(addLog.t);
  addLog.t = setTimeout(renderLogCats, 300); // compteurs des modules
}

function openLogStream() {
  if (LOG.source) return;
  const src = new EventSource('/api/admin/logs/live');
  LOG.source = src;
  src.addEventListener('init', (ev) => {
    const d = JSON.parse(ev.data);
    LOG.cats = d.categories;
    LOG.items = d.entries;
    LOG.pending = 0;
    renderLogList();
    logState();
  });
  src.addEventListener('log', (ev) => addLog(JSON.parse(ev.data)));
  src.onerror = () => logState(); // EventSource se reconnecte seul (serveur relancé)
}

function closeLogStream() {
  LOG.source?.close();
  LOG.source = null;
}

function bindLogs() {
  openLogStream();
  renderLogList();
  logState();
  $('#logCats').onclick = (ev) => { const b = ev.target.closest('[data-cat]'); if (b) { LOG.cat = b.dataset.cat; renderLogList(); } };
  $('#logLevels').onclick = (ev) => {
    const b = ev.target.closest('[data-level]');
    if (!b) return;
    LOG.level = b.dataset.level;
    document.querySelectorAll('#logLevels button').forEach((x) => x.classList.toggle('on', x === b));
    renderLogList();
  };
  $('#logSearch').oninput = (ev) => { LOG.q = ev.target.value.trim(); renderLogList(); };
  $('#logPause').onclick = (ev) => {
    LOG.paused = !LOG.paused;
    ev.target.textContent = LOG.paused ? 'Reprendre' : 'Pause';
    if (!LOG.paused) { LOG.pending = 0; renderLogList(); }
    logState();
  };
}

const SECTIONS = { dashboard, events: eventsSection, sessions, templates: templatesSection, editor: editorSection, flow, printing, sharing, theme: themeSection, texts: textsSection, camera, control: controlSection, lights: lightsPage, security, backup: backupSection, install: installSection, logs: logsSection };
const OLD_HASHES = { limits: 'printing', hardware: 'camera', devices: 'control' }; // anciens liens de l'admin

// ---------- Rendu + événements ----------

function currentSection() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('editor=')) return 'editor';
  if (h.startsWith('sessions=')) return 'sessions';
  if (OLD_HASHES[h]) return OLD_HASHES[h];
  return SECTIONS[h] ? h : 'dashboard';
}

/** Téléphone : menu en tiroir par-dessus la page. */
function setNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  $('#navToggle')?.setAttribute('aria-expanded', String(open));
}

function render() {
  if (!S) return; // pas encore connecté
  syncFavicon();
  syncUpdateNav();
  const sec = currentSection();
  if (prevSection === 'editor' && sec !== 'editor') unbindEditor();
  if (sec !== 'logs') closeLogStream(); // journal en direct : connexion fermée en quittant la page
  prevSection = sec;
  const sameSection = render.last === location.hash;
  render.last = location.hash;
  const navKey = sec === 'editor' ? 'templates' : sec;
  document.querySelectorAll('.nav a[href^="#"]').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${navKey}`));
  $('#topTitle').textContent = document.querySelector(`.nav a[href="#${navKey}"]`)?.textContent || '';
  setNavOpen(false);
  // Même section redessinée (après un enregistrement) : défilement, champ actif et ce qu'on y tapait sont gardés
  const ae = document.activeElement;
  const typing = sameSection && ae && $('#main').contains(ae) && ae.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select')
    ? { form: ae.form?.id, key: ae.id ? `#${CSS.escape(ae.id)}` : ae.name ? `[name="${CSS.escape(ae.name)}"]` : null, value: ae.value, start: ae.selectionStart, end: ae.selectionEnd } : null;
  const y = window.scrollY;
  try {
    $('#main').innerHTML = SECTIONS[sec]();
    $('#main').classList.toggle('wide', sec === 'editor');
    bindSection(sec);
    if (sameSection) window.scrollTo(0, y); else window.scrollTo(0, 0);
    const back = typing?.key && $('#main').querySelector(`${typing.form ? `#${CSS.escape(typing.form)} ` : ''}${typing.key}`);
    if (back) {
      back.value = typing.value;
      back.focus({ preventScroll: true });
      try { back.setSelectionRange(typing.start, typing.end); } catch { /* nombre, liste */ }
    }
  } catch (e) {
    console.error(e);
    $('#main').innerHTML = `<h2>Cette page n'a pas pu s'afficher</h2>
      <div class="alert">${esc(e.message)}</div>
      <p class="sub">Si le serveur vient d'être mis à jour, redémarrez-le (Ctrl+C puis <code>npm run dev</code>) et rechargez cette page.</p>`;
  }
}

/** Champ numérique : undefined s'il est vide (le réglage n'est pas envoyé, il reste tel quel) plutôt que 0. */
const num = (fd, k) => { const v = fd.get(k); return v === null || String(v).trim() === '' ? undefined : Number(v); };

/**
 * Ordre des templates : glisser une carte par sa poignée (souris ou doigt ; le glisser-déposer natif ne marche
 * pas au toucher). La carte suit le pointeur, les autres s'écartent ; au lâcher, onDrop enregistre l'ordre.
 */
function bindTemplateSort(onDrop) {
  const list = $('#tplList');
  if (!list) return;
  list.querySelectorAll('.tpl-handle').forEach((h) => h.addEventListener('pointerdown', (e) => {
    const card = h.closest('[data-tpl-card]');
    e.preventDefault();
    // Écoute sur la fenêtre : déplacer la carte dans la liste ferait perdre la capture du pointeur (lâcher jamais reçu)
    const before = [...list.children].map((c) => c.dataset.tplCard).join();
    const startY = e.clientY;
    const top0 = card.getBoundingClientRect().top;
    card.classList.add('dragging');
    let ty = 0; // décalage appliqué à la carte pour qu'elle reste sous le pointeur
    const move = (ev) => {
      // La carte se place avant la première carte dont le milieu est sous le pointeur
      const others = [...list.children].filter((c) => c !== card);
      const next = others.find((c) => { const r = c.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      if (next) { if (card.nextElementSibling !== next) list.insertBefore(card, next); } else if (list.lastElementChild !== card) list.appendChild(card);
      const naturalTop = card.getBoundingClientRect().top - ty; // sa place dans la liste, sans le décalage
      ty = ev.clientY - startY - (naturalTop - top0);
      card.style.transform = `translateY(${ty}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      card.classList.remove('dragging');
      card.style.transform = '';
      if ([...list.children].map((c) => c.dataset.tplCard).join() !== before) onDrop();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }));
}

async function renderTemplateCards() {
  const samples = await sampleImages();
  for (const cv of document.querySelectorAll('canvas.tpl-preview')) {
    const t = S.templates.find((x) => x.id === cv.dataset.tpl);
    if (!t) continue;
    const scale = cv.width / t.width;
    const ctx = cv.getContext('2d');
    if (t.previews?.length) { // miniature calculée à l'enregistrement
      const img = await loadImage(t.previews[0]).catch(() => null);
      if (img) { ctx.drawImage(img, 0, 0, cv.width, cv.height); continue; }
    }
    const photos = photosFromSamples(t, samples);
    renderTemplate(ctx, t, { scale, photos, cutoutPhotos: cutoutsFromSamples(photos), placeholder: true });
    loadAssets(t).then((assets) => renderTemplate(ctx, t, { scale, photos, cutoutPhotos: cutoutsFromSamples(photos), assets, placeholder: true }));
  }
}

function bindSection(sec) {
  if (sec === 'logs') return bindLogs();
  if (sec === 'dashboard') {
    $('#btnDashUpdate')?.addEventListener('click', installUpdate);
    $('#btnPaper').onclick = async () => {
      const v = $('#paperInput').value;
      await api('/api/admin/counters', { method: 'POST', body: { paperRemaining: v === '' ? null : Number(v) } });
      toast('Papier mis à jour'); refresh();
    };
    if ($('#btnPaperOff')) $('#btnPaperOff').onclick = async () => { await api('/api/admin/counters', { method: 'POST', body: { paperRemaining: null } }); refresh(); };
    $('#btnResetPrinted').onclick = async () => {
      if (!await askConfirm('Remettre le compteur de tirages à zéro ?', 'Remettre à zéro', 'delete')) return;
      await api('/api/admin/counters', { method: 'POST', body: { reset: true } });
      toast('Compteur remis à zéro'); refresh();
    };
    $('#btnResetSessions').onclick = () => resetSessions(); // sans argument : l'événement en cours (pas l'objet du clic)
  }

  if (sec === 'install') {
    const check = async (btn) => {
      if (btn) btn.disabled = true;
      try { S.update = (await api('/api/admin/update/check', { method: 'POST' })).update; } catch (err) { if (btn) toast(err.message, true); }
      if (currentSection() === 'install') render();
    };
    if (S.update?.available && !S.update.checkedAt && !check.done) { check.done = true; check(); } // une fois en arrivant sur la page
    $('#btnUpdateCheck')?.addEventListener('click', (e) => check(e.currentTarget));
    $('#btnUpdateInstall')?.addEventListener('click', installUpdate);
    $('#btnUpdateRestart')?.addEventListener('click', () => $('#btnRestart')?.click());
    if (S.update?.updating) pollUpdate();
    // Revérifier, installer ce qui manque (suivi tant que ça tourne)
    $('#btnSetupCheck')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { S.setup = (await api('/api/admin/setup')).setup; render(); } catch (err) { toast(err.message, true); }
    });
    $('#btnSetupInstall')?.addEventListener('click', async () => {
      try { S.setup = (await api('/api/admin/setup/install', { method: 'POST' })).setup; render(); pollSetup(); } catch (err) { toast(err.message, true); }
    });
    if (S.setup?.installing) pollSetup();
  }

  if (sec === 'backup') bindBackup();
  bindSettingsForms();
  bindLights();
  bindScreen();
  // Mots de passe masqués : un bouton pour les afficher le temps de les vérifier
  document.querySelectorAll('[data-pw-toggle]').forEach((b) => b.addEventListener('click', () => {
    const input = b.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
    b.textContent = input.type === 'password' ? 'Afficher' : 'Masquer';
  }));

  if (sec === 'theme') {
    const form = $('#formTheme');
    // L'aperçu et la carte « Personnalisé » suivent le thème coché et les couleurs choisies, sans attendre l'enregistrement
    const updatePreview = () => {
      const fd = new FormData(form);
      const active = fd.get('active');
      const isCustom = active === 'custom';
      $('#customTheme').classList.toggle('hidden', !isCustom);
      const customColors = Object.fromEntries(['primary', 'secondary', 'background', 'surface', 'text', 'onPrimary'].map((k) => [k, fd.get(`color_${k}`)]));
      const theme = isCustom ? { colors: customColors, font: fd.get('font'), ...customPattern(fd.get('pattern'), customColors) } : S.themes.find((x) => x.id === active) || S.themes[0];
      $('#themePreview').style.cssText = tpVars(theme.colors, theme.font, tpBgImage(theme));
      $('#themePickCustom').style.cssText = tpVars(customColors, fd.get('font'), tpBgImage(customPattern(fd.get('pattern'), customColors)));
      // Logo Cheeesy aux couleurs du thème coché (et de la carte « Personnalisé ») ; URL inchangée : pas de rechargement
      const setLogo = (img, url) => { if (img && img.getAttribute('src') !== url) img.src = url; };
      setLogo($('#themePreview .tp-logo'), logoFor(theme.colors));
      setLogo($('#themePickCustom .tp-logo'), logoFor(customColors));
      const c = theme.colors;
      const problems = [];
      if (contrast(c.background, c.text) < 4.5) problems.push('texte courant sur fond d\'écran');
      if (contrast(c.primary, c.onPrimary) < 3) problems.push('texte des boutons sur accent');
      if (contrast(c.background, c.secondary) < 3) problems.push('titres sur fond d\'écran');
      if (contrast(c.background, c.primary) < 3) problems.push('accent sur fond d\'écran');
      const warn = $('#contrastWarn');
      warn.textContent = problems.length ? `Contraste faible, difficile à lire sur la borne : ${problems.join(', ')}.` : '';
      warn.classList.toggle('hidden', !problems.length);
    };
    form.addEventListener('input', updatePreview);
    updatePreview();
    autoSave(form, (fd) => {
      saveConfig({
        booth: { name: fd.get('boothName'), showName: fd.get('showName') === 'on' },
        theme: { active: fd.get('active'), custom: {
          font: fd.get('font'),
          pattern: fd.get('pattern') || '',
          colors: { primary: fd.get('color_primary'), secondary: fd.get('color_secondary'), background: fd.get('color_background'), surface: fd.get('color_surface'), text: fd.get('color_text'), onPrimary: fd.get('color_onPrimary') }
        } }
      }, 'Thème enregistré, la borne est à jour');
    });
    const upload = (formEl, url, msg) => formEl.querySelector('input[type=file]').addEventListener('change', async (e) => {
      if (!e.target.files.length) return;
      saveState('saving');
      try { await api(url, { method: 'POST', form: new FormData(formEl) }); saveState('saved'); toast(msg); refresh(); } catch (err) { saveState('error'); toast(err.message, true); }
    });
    upload($('#formLogo'), '/api/admin/logo', 'Logo envoyé, la borne est à jour');
    upload($('#formBg'), '/api/admin/background', 'Image de fond envoyée');
    $('#btnLogoReset')?.addEventListener('click', async () => await askConfirm('Revenir au logo par défaut ?', 'Logo par défaut', 'delete') && saveConfig({ booth: { logo: '' }, theme: { custom: { logo: '' } } }, 'Logo par défaut rétabli'));
    $('#btnBgReset')?.addEventListener('click', async () => await askConfirm('Retirer l\'image de fond ?', 'Retirer', 'delete') && saveConfig({ booth: { backgroundImage: '' }, theme: { custom: { backgroundImage: '' } } }, 'Image de fond retirée'));
  }

  if (sec === 'templates') {
    renderTemplateCards();
    bindModelButtons();
    const saveTemplates = (msg = 'Templates enregistrés') => {
      const enabled = [...document.querySelectorAll('[data-enable]')].filter((c) => c.checked).map((c) => c.dataset.enable);
      const def = document.querySelector('input[name=defaultTpl]:checked')?.value || enabled[0] || '';
      const order = [...document.querySelectorAll('[data-tpl-card]')].map((c) => c.dataset.tplCard); // ordre affiché = ordre sur la borne
      saveConfig({ templates: { enabled, order, default: def, guestCanChoose: $('#guestCanChoose').checked, defaultFormat: $('#defaultFormat').value, gifEnabled: $('#gifEnabled').checked } }, msg);
    };
    bindTemplateSort(() => saveTemplates('Ordre enregistré, la borne est à jour'));
    document.querySelectorAll('[data-enable], input[name=defaultTpl], #guestCanChoose, #defaultFormat, #gifEnabled').forEach((el) => el.addEventListener('change', () => saveTemplates()));
    $('#cutoutAuto')?.addEventListener('change', (e) => saveConfig({ templates: { cutoutAuto: e.target.checked } }));
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!await askConfirm(`Supprimer le template « ${b.dataset.del} » ?`, 'Supprimer', 'delete')) return;
      try { await api(`/api/admin/templates/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); toast('Template supprimé'); refresh(); } catch (e) { toast(e.message, true); }
    }));
    const dlg = $('#dlgNewTemplate');
    $('#btnNewTemplate').onclick = () => { dlg.showModal(); dlg.querySelector('input[name=name]').focus(); };
    $('#btnImportTemplate').onclick = () => $('#importTemplateFile').click();
    $('#importTemplateFile').onchange = (e) => importTemplates(e.target);
    $('#btnNewTemplateCancel').onclick = () => { dlg.close(); $('#formNewTemplate').reset(); };
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic hors de la fenêtre
    $('#formNewTemplate').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('overlay')?.size) fd.delete('overlay');
      try {
        const t = await api('/api/admin/templates', { method: 'POST', form: fd });
        S = await api('/api/admin/state');
        dlg.close();
        toast(`Template « ${t.name} » créé`);
        location.hash = `editor=${encodeURIComponent(t.id)}`;
      } catch (err) { toast(err.message, true); }
    };
  }

  if (sec === 'editor') bindEditor();

  if (sec === 'sessions') {
    const views = [...document.querySelectorAll('[data-view]')]; // les photos de la liste, dans l'ordre affiché
    const viewList = views.map((b) => ({ url: b.dataset.view, alt: b.dataset.alt }));
    views.forEach((b, k) => b.addEventListener('click', () => openLightbox(null, null, viewList, k)));
    const reload = () => { eventSessions = null; refresh(); };
    document.querySelectorAll('[data-reprint]').forEach((b) => b.addEventListener('click', async () => {
      const copies = Number(prompt('Nombre de copies à réimprimer ?', '1'));
      if (!copies) return;
      try { await api(`/api/admin/reprint/${b.dataset.reprint}`, { method: 'POST', body: { copies } }); toast('Réimpression lancée'); reload(); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-del-session]').forEach((b) => b.addEventListener('click', async () => {
      if (!await askConfirm('Supprimer cette session et ses photos ?', 'Supprimer', 'delete')) return;
      try { await api(`/api/admin/sessions/${b.dataset.delSession}`, { method: 'DELETE' }); toast('Session supprimée'); reload(); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-move-to]').forEach((b) => b.addEventListener('click', async () => {
      const sid = b.dataset.moveTo;
      const eventId = await pickEvent(selectedEventId());
      if (!eventId) return;
      try { await api(`/api/admin/sessions/${sid}/move`, { method: 'POST', body: { eventId } }); toast('Session déplacée'); reload(); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-photos-view]').forEach((b) => b.addEventListener('click', () => {
      photosView = b.dataset.photosView;
      try { localStorage.setItem('photosView', photosView); } catch { /* navigation privée */ }
      render();
    }));
    const evId = selectedEventId();
    document.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
      sessionsPage = { id: evId, page: Number(b.dataset.page) };
      render();
      window.scrollTo(0, 0);
    }));
    $('#photosEvent')?.addEventListener('change', (e) => { location.hash = `#sessions=${encodeURIComponent(e.target.value)}`; });
  }

  if (sec === 'events') {
    const evOf = (id) => S.events.find((e) => e.id === id);
    const reload = () => { eventSessions = null; refresh(); };
    bindUsb();
    document.querySelectorAll('[data-ev-page]').forEach((b) => b.addEventListener('click', () => { eventsPage = Number(b.dataset.evPage); render(); window.scrollTo(0, 0); }));
    $('#btnNewEvent').onclick = async () => {
      const name = prompt('Nom de l\'événement ?', '');
      if (!name?.trim()) return;
      const now = new Date();
      const date = prompt('Date (AAAA-MM-JJ) ?', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
      if (!date) return;
      try {
        const created = await api('/api/admin/events', { method: 'POST', body: { name, date, activate: true } });
        toast(`« ${created.name} » est l'événement en cours`);
        eventsPage = 1;
        reload();
      } catch (e) { toast(e.message, true); }
    };
    document.querySelectorAll('[data-ev-activate]').forEach((b) => b.addEventListener('click', async () => {
      const ev = evOf(b.dataset.evActivate);
      try { await api(`/api/admin/events/${encodeURIComponent(ev.id)}/activate`, { method: 'POST' }); toast(`« ${ev.name} » est l'événement en cours`); reload(); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-ev-rename]').forEach((b) => b.addEventListener('click', async () => {
      const ev = evOf(b.dataset.evRename);
      const name = prompt('Nom de l\'événement ?', ev.name);
      if (name === null) return;
      const date = prompt('Date (AAAA-MM-JJ) ?', ev.date);
      if (date === null) return;
      try { await api(`/api/admin/events/${encodeURIComponent(ev.id)}`, { method: 'PUT', body: { name, date } }); toast('Événement mis à jour'); reload(); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-ev-empty]').forEach((b) => b.addEventListener('click', () => resetSessions(b.dataset.evEmpty)));
    document.querySelectorAll('[data-ev-delete]').forEach((b) => b.addEventListener('click', async () => {
      const ev = evOf(b.dataset.evDelete);
      if (!await askConfirm(`Supprimer « ${ev.name} » ?\n\n${ev.sessions} session(s) et toutes leurs photos seront supprimées.`, 'Supprimer', 'delete')) return;
      try { await api(`/api/admin/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' }); toast('Événement supprimé'); reload(); } catch (e) { toast(e.message, true); }
    }));
  }

}

/** Formulaires de réglages : chacun enregistre ses propres champs, quelle que soit la section qui l'affiche. */
function bindSettingsForms() {
  bindCameraControl();
  const form = (id, fn) => autoSave($(id), fn);
  document.querySelectorAll('.btn-detect').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/admin/devices/refresh', { method: 'POST' }); toast('Détection relancée'); refresh(); } catch (e) { toast(e.message, true); }
  }));
  form('#formFlow', (fd) => saveConfig({
    limits: {
      countdownSec: num(fd, 'countdownSec'),
      maxRetakesPerSession: fd.get('retakesUnlimited') === 'on' ? -1 : num(fd, 'maxRetakesPerSession'),
      reviewTimeoutSec: num(fd, 'reviewTimeoutSec'),
      captureTimeoutSec: num(fd, 'captureTimeoutSec'),
      copiesTimeoutSec: num(fd, 'copiesTimeoutSec'),
      copiesTimeoutAction: fd.get('copiesTimeoutAction')
    },
    booth: {
      mirrorPreview: fd.get('mirrorPreview') === 'on', idleReturnSec: num(fd, 'idleReturnSec'), menuIdleSec: num(fd, 'menuIdleSec'),
      // Le filtre par défaut est forcément proposé
      filters: (() => {
        const def = fd.get('filterDefault') || 'none';
        const available = FILTERS.filter((f) => f.id === def || fd.get(`filter_${f.id}`) === 'on').map((f) => f.id);
        return { enabled: fd.get('filtersEnabled') === 'on', available, default: def };
      })()
    }
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
      liveview: fd.get('liveview') === 'on', settleMs: num(fd, 'settleMs'), liveIdleMs: num(fd, 'liveIdleSec') === undefined ? undefined : num(fd, 'liveIdleSec') * 1000
    } },
    booth: { lensPosition: fd.get('lensPosition') }
  }));
  form('#formControl', (fd) => saveConfig({ booth: { touch: fd.get('touchMode') || 'auto', cursor: fd.get('cursor') || 'show', window: fd.get('windowMode') || 'kiosk' } }));
  form('#formDeck', (fd) => saveConfig({ booth: { streamDeck: { enabled: fd.get('deckEnabled') === 'on', brightness: num(fd, 'deckBrightness'), position: fd.get('deckPosition'), showButtons: fd.get('deckShowButtons') === 'on' } } }));
  form('#formShare', (fd, f) => saveConfig({ share: { baseUrl: fd.get('shareBaseUrl').trim(), publicUrl: fd.get('publicUrl').trim(), qrOnDone: f.qrOnDone.checked, requireWifi: f.requireWifi.checked } }));
  form('#formCodes', (fd, f) => saveConfig({ ...(f.adminPin.checkValidity() ? { admin: { pin: fd.get('adminPin') } } : {}), ...(f.operatorPin.checkValidity() ? { limits: { operatorPin: fd.get('operatorPin') } } : {}) }));
  form('#formWifi', (fd, f) => saveConfig({ share: { wifi: { enabled: f.enabled.checked, ssid: f.ssid.value.trim(), password: f.password.value, security: f.security.value } } }, 'Wi-Fi enregistré'));
  form('#formGallery', (fd, f) => saveConfig({ gallery: { booth: f.booth.checked, web: f.web.checked, reprint: f.reprint.value, qr: f.qr.checked } }, 'Galerie enregistrée'));
  form('#formTexts', (fd) => {
    const texts = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('text_')) texts[k.slice(5)] = v;
    saveConfig({ texts }, 'Textes enregistrés');
  });
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
  // Sur la borne, le code se tape sur son pavé (5 appuis en haut à droite) : pas de page de connexion ici
  if (ON_BOOTH) { location.replace('/'); return; }
  $('#login').classList.remove('hidden');
  $('#shell').classList.add('hidden');
  sendDeckUi();
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/login', { method: 'POST', body: { pin: $('#loginPin').value } });
      await boot();
    } catch (err) { $('#loginError').textContent = err.message; $('#loginPin').value = ''; } // nouvelle saisie (clavier ou Stream Deck)
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
  updatePowerButtons();
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
$('#navToggle').addEventListener('click', () => setNavOpen(!document.body.classList.contains('nav-open')));
$('#navBackdrop').addEventListener('click', () => setNavOpen(false));
document.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', () => setNavOpen(false))); // même section : le hash ne change pas
window.addEventListener('beforeunload', (e) => { if (currentSection() === 'editor' && E.dirty) { e.preventDefault(); e.returnValue = ''; } });
// Déconnexion : accueil de la borne sur la borne, page de connexion ailleurs (téléphone : « / » mène à la galerie)
$('#btnLogout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); if (ON_BOOTH) location.href = '/'; else location.reload(); };
// Retour à la borne : connexion gardée 2 min, la zone cachée rouvre l'admin sans code pendant ce délai
$('#btnBooth').onclick = async () => { await api('/api/admin/leave', { method: 'POST' }).catch(() => {}); location.href = '/'; };
// ---------- Arrêt : relancer ou quitter le logiciel, redémarrer ou éteindre l'ordinateur ----------
// Un bouton « Arrêt » ouvre la fenêtre des choix (elle tient lieu de confirmation) ; seuls les choix permis
// sur cette machine y figurent.
const POWER = [['btnRestart', 'canRestart'], ['btnQuit', 'canShutdown'], ['btnReboot', 'canReboot'], ['btnShutdown', 'canPowerOff']];
function updatePowerButtons() {
  for (const [id, can] of POWER) $(`#${id}`).classList.toggle('hidden', !S[can]);
  $('#btnPower').classList.toggle('hidden', !POWER.some(([, can]) => S[can]));
}
$('#btnPower').onclick = () => { $('#powerDialog').showModal(); sendDeckUi(); };
$('#pwCancel').onclick = () => $('#powerDialog').close();
$('#powerDialog').addEventListener('close', () => sendDeckUi());

/** Envoie l'ordre (impression en cours : confirmée à part), puis affiche l'écran d'attente. */
async function powerAction(url, ok, title, sub) {
  $('#powerDialog').close();
  try {
    await api(url, { method: 'POST', body: {} });
  } catch (e) {
    if (e.code !== 'PRINTING' || !await askConfirm(`${e.message}\n\n${ok} quand même ?`, `${ok} quand même`)) { toast(e.message, true); return false; }
    await api(url, { method: 'POST', body: { force: true } });
  }
  // Le lanceur ferme la fenêtre ; ce message ne reste visible que dans un navigateur ordinaire.
  document.body.innerHTML = `<div class="login"><div class="card login-card"><h1>${title}</h1><p class="sub">${sub}</p></div></div>`;
  return true;
}
$('#btnQuit').onclick = () => powerAction('/api/admin/shutdown', 'Quitter', 'Borne fermée', 'Pour la relancer : icône « Cheeesy » sur le bureau.');
$('#btnReboot').onclick = () => powerAction('/api/admin/reboot', 'Redémarrer', 'Redémarrage…', 'L\'ordinateur redémarre.');
$('#btnShutdown').onclick = () => powerAction('/api/admin/poweroff', 'Éteindre', 'Extinction…', 'L\'ordinateur s\'éteint.');
// Relancer : le logiciel se ferme proprement (caméra, Stream Deck) et se relance tout seul sur l'accueil.
$('#btnRestart').onclick = async () => {
  if (await powerAction('/api/admin/restart', 'Relancer', 'Relance…', 'La borne revient dans quelques secondes.')) waitRelaunch();
};
/** Logiciel en train de se relancer (bouton Relancer, fin de mise à jour) : écran d'attente, puis retour à l'accueil. */
async function waitRelaunch() {
  if (waitRelaunch.on) return;
  waitRelaunch.on = true;
  document.body.innerHTML = `<div class="login"><div class="card login-card"><h1>Relance…</h1><p class="sub">La borne revient dans quelques secondes.</p></div></div>`;
  // Lanceur Chromium : la fenêtre reste ouverte, on revient à l'accueil dès que le serveur relancé répond
  // (l'app Electron, elle, se relance entièrement).
  let down = false;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const up = await fetch('/', { cache: 'no-store' }).then((r) => r.ok, () => false);
    if (!up) down = true;
    else if (down || i >= 30) { location.href = '/'; return; }
  }
}
/** Confirmation dans la page : se valide à la souris, au clavier ou depuis le Stream Deck. */
/**
 * opts.title : titre au-dessus du texte ; opts.list : lignes sous le texte ; opts.tone : 'danger' (rouge, par défaut)
 * ou 'primary' (noir) ; opts.alt : libellé d'un second choix, entre Annuler et le bouton principal (résultat 'alt').
 */
function askConfirm(text, okLabel, deckIcon = 'power', { title = '', list = [], tone = 'danger', alt = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmTitle').classList.toggle('hidden', !title);
    $('#confirmText').textContent = text;
    $('#confirmText').classList.toggle('hidden', !text);
    $('#confirmList').innerHTML = list.map((l) => `<li>${l}</li>`).join('');
    $('#confirmList').classList.toggle('hidden', !list.length);
    $('#cfOk').textContent = okLabel;
    $('#cfOk').className = `btn ${tone}`;
    $('#cfAlt').textContent = alt;
    $('#cfAlt').classList.toggle('hidden', !alt);
    $('#cfOk').dataset.icon = deckIcon; // pictogramme de la touche « valider » sur le Stream Deck
    const done = (v) => { dlg.close(); $('#cfOk').onclick = $('#cfAlt').onclick = $('#cfCancel').onclick = dlg.oncancel = null; sendDeckUi(); resolve(v); };
    $('#cfOk').onclick = () => done(true);
    $('#cfAlt').onclick = () => done('alt');
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

/** Miniature (data URL) d'une image de la page, pour une touche du Stream Deck. */
function deckImage(img) {
  if (!img?.naturalWidth) return null;
  const c = document.createElement('canvas');
  const k = 120 / Math.max(img.naturalWidth, img.naturalHeight);
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  try { c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.75); } catch { return null; }
}

/** Touches de l'écran de calibrage, étape par étape. */
function calibDeckItems() {
  const c = CTL.calibration;
  const accent = { bg: S?.theme?.colors?.primary || '#e63946', fg: '#ffffff', border: null };
  const show = (label) => ({ id: 'coInfo', label: String(label), kind: 'display', display: true });
  switch (CAL.stage) {
    // Délai du décompte : − nombre + (mêmes identifiants que le choix des copies : même disposition des touches)
    case 'preview': return [
      { id: 'btnMinus', label: '−', icon: 'minus', kind: 'ghost', disabled: CAL.countdown <= CALIB_DELAYS[0] },
      { id: 'copies', label: String(CAL.countdown), kind: 'display', display: true },
      { id: 'btnPlus', label: '+', icon: 'plus', kind: 'ghost', disabled: CAL.countdown >= CALIB_DELAYS[CALIB_DELAYS.length - 1] },
      { id: 'coGo', label: 'Lancer', icon: 'play', kind: 'primary', style: accent },
      { id: 'coClose', label: 'Fermer', icon: 'x', kind: 'ghost' }
    ];
    case 'countdown': return [show(CAL.left), { id: 'coCancel', label: 'Annuler', icon: 'x', kind: 'ghost' }];
    case 'running': return [show(`${c?.step || 1}/${MAX_CALIB_SHOTS}`)];
    case 'results': {
      const pick = c?.profile;
      const shots = [...document.querySelectorAll('#calibOverlay .co-shot')].map((fig, i) => {
        const sh = c.shots[i];
        const picked = fig.classList.contains('picked');
        return { id: picked ? 'coKeep' : `coPick-${sh.n}`, label: `Photo ${sh.n}`, kind: 'choice', image: deckImage(fig.querySelector('img')) };
      });
      return [...shots, ...(pick ? [{ id: 'coKeep', label: 'Garder', icon: 'check', kind: 'primary', style: accent }] : []),
        { id: 'coAgain', label: 'Recommencer', icon: 'retake', kind: 'ghost' }, { id: 'coClose', label: 'Fermer', icon: 'x', kind: 'ghost' }];
    }
    default: return [{ id: 'coAgain', label: 'Recommencer', icon: 'retake', kind: 'primary', style: accent }, { id: 'coClose', label: 'Fermer', icon: 'x', kind: 'ghost' }];
  }
}

function sendDeckUi() {
  if (!ON_BOOTH || deckSock?.readyState !== 1) return;
  const dlg = $('#confirmDialog');
  const shell = !$('#shell').classList.contains('hidden');
  if (CAL.stage && !dlg.open) {
    deckSock.send(JSON.stringify({ type: 'ui', screen: `admin-calib-${CAL.stage}`, items: calibDeckItems(), colors: S?.theme?.colors || {} }));
    return;
  }
  // Écran de connexion : pavé du code sur les touches (comme le code opérateur de la borne), puis retour
  if (!shell && !$('#login').classList.contains('hidden')) {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) => (
      k === 'del' ? { id: 'pin-del', label: '⌫', icon: 'delete', kind: 'ghost' }
        : k === 'ok' ? { id: 'pin-ok', label: 'OK', icon: 'check', kind: 'primary' }
          : { id: `pin-${k}`, label: k, kind: 'ghost' }));
    keys.push({ id: 'btnBooth', label: 'Retour à la borne', icon: 'back', kind: 'ghost' });
    deckSock.send(JSON.stringify({ type: 'ui', screen: 'pin', items: keys, colors: S?.theme?.colors || {} }));
    return;
  }
  let items;
  if (!dlg.open && $('#powerDialog').open) {
    // Fenêtre d'arrêt : ses choix sur les touches, dans le même ordre
    const pw = { btnRestart: ['Relancer', 'retake', 'primary'], btnQuit: ['Quitter', 'x', 'ghost'], btnReboot: ['Redémarrer', 'retake', 'ghost'], btnShutdown: ['Éteindre', 'power', 'primary'] };
    items = POWER.filter(([id]) => !$(`#${id}`).classList.contains('hidden'))
      .map(([id]) => ({ id, label: pw[id][0], icon: pw[id][1], kind: pw[id][2], ...(id === 'btnShutdown' ? { style: DECK_DANGER } : {}) }));
    items.push({ id: 'pwCancel', label: 'Annuler', icon: 'x', kind: 'ghost' });
  } else if (dlg.open) {
    items = [{ id: 'cfOk', label: $('#cfOk').textContent, icon: $('#cfOk').dataset.icon || 'power', kind: 'primary', style: $('#cfOk').classList.contains('danger') ? DECK_DANGER : undefined }, ...($('#cfAlt').classList.contains('hidden') ? [] : [{ id: 'cfAlt', label: $('#cfAlt').textContent, icon: 'retake', kind: 'ghost' }]), { id: 'cfCancel', label: 'Annuler', icon: 'x', kind: 'ghost' }];
  } else {
    items = [{ id: 'btnBooth', label: 'Retour à la borne', icon: 'back', kind: 'ghost' }];
    if (shell) items.push({ id: 'btnLogout', label: 'Déconnexion', icon: 'logout', kind: 'ghost' });
    // Calibrage du boîtier lançable depuis le Stream Deck : toujours là, grisé tant qu'aucun boîtier n'est branché
    if (shell) items.push({ id: 'deckCalib', label: 'Calibrer', icon: 'camera', kind: 'ghost', disabled: !calibReady() });
    if (shell && !$('#btnPower').classList.contains('hidden')) items.push({ id: 'btnPower', label: 'Arrêt', icon: 'power', kind: 'primary', style: DECK_DANGER });
  }
  deckSock.send(JSON.stringify({ type: 'ui', screen: dlg.open ? 'admin-confirm' : $('#powerDialog').open ? 'admin-power' : 'admin', items, colors: S?.theme?.colors || {} }));
}

/** Boîtier gphoto2 branché et joignable : le calibrage peut se lancer. */
const calibReady = () => S?.camera?.driver === 'gphoto2' && S.camera.ok !== false;

/**
 * Matériel branché ou débranché : état relu (en mémoire côté serveur, rien n'est envoyé au boîtier), touche du
 * calibrage mise à jour sans recharger. Au message du serveur, et toutes les 5 s (boîtier rebranché sans
 * changement de pilote, par exemple pilote « gphoto2 » imposé).
 */
async function refreshDevices() {
  if (!S) return;
  const before = calibReady();
  try {
    const d = await api('/api/admin/devices');
    S.camera = d.camera;
    S.devices = d.devices;
    if (d.screen) S.screen = d.screen;
  } catch { return; }
  if (calibReady() !== before) sendDeckUi();
}
setInterval(() => { if (document.visibilityState === 'visible') refreshDevices(); }, 5000);

/** Touche du pavé du Stream Deck sur l'écran de connexion : tape dans le champ du code, ⌫ efface, OK valide. */
function deckPinKey(id) {
  const input = $('#loginPin');
  const k = id.slice(4);
  $('#loginError').textContent = '';
  if (k === 'del') input.value = input.value.slice(0, -1);
  else if (k === 'ok') $('#loginForm').requestSubmit();
  else if (input.value.length < 12) input.value += k;
}

function onDeckPress(id) {
  if (id.startsWith('pin-')) { if (!$('#login').classList.contains('hidden')) deckPinKey(id); return; }
  if (id === 'deckCalib') { if (!CAL.stage && calibReady()) openCalibration('preview'); return; }
  if (CAL.stage === 'preview' && (id === 'btnMinus' || id === 'btnPlus')) { // délai du décompte, un cran à la fois
    const i = CALIB_DELAYS.indexOf(CAL.countdown) + (id === 'btnPlus' ? 1 : -1);
    if (i >= 0 && i < CALIB_DELAYS.length) setCalibDelay(CALIB_DELAYS[i]);
    return;
  }
  const el = document.getElementById(id);
  if (el && !el.disabled && (el.offsetParent !== null || el.closest('dialog[open]'))) el.click();
  else if (id === 'btnBooth') location.href = '/'; // page de connexion : retour direct à la borne
}

// Une séance envoie ses messages en rafale (compteurs, sessions, aperçu, impression) : un seul rechargement de
// l'état pour toute la rafale, pas un par message.
let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refresh().catch(() => {});
    // Page de sessions autre que la première de l'événement en cours : relue elle aussi
    if (currentSection() === 'sessions' && eventSessions) loadEventSessions(eventSessions.id, eventSessions.page);
  }, 400);
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
    if (msg?.type === 'update') {
      updateNotice(msg, () => { location.hash = 'install'; }); // page Installation, après le code si déconnecté
      if (S) api('/api/admin/update').then((r) => { S.update = r.update; if (currentSection() === 'dashboard') render(); else syncUpdateNav(); }).catch(() => {});
      return;
    }
    if (msg?.type === 'notice') { systemNotice(msg.text, 5000, { ok: msg.ok }); return; }
    if (msg?.type === 'device') { deviceNotice(msg); if (S && currentSection() !== 'editor') scheduleRefresh(); return; } // la page affichée suit l'état annoncé (lumières, boîtier, Wi-Fi…)
    if (msg?.type === 'config') refreshDevices(); // pilote de caméra changé (boîtier branché / débranché), entre autres
    if (S && ['dashboard', 'sessions', 'events'].includes(currentSection())) scheduleRefresh();
  };
  sock.onclose = () => setTimeout(ws, 3000);
})();
boot();
