import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { SESSIONS_DIR, PUBLIC_DIR } from './paths.js';
import { HttpError, newId, lanIp } from './util.js';
import { wifiStatus } from './network.js';
import { samplePhotos } from './samples.js';
import { compose, composeGif, thumbnail, normalizeShot } from './compositor.js';

/**
 * Adresse saisie dans l'admin, complétée pour que le QR code ouvre bien une page : sans schéma, le téléphone
 * y voit du texte et lance une recherche. « macbook.local » → « http://macbook.local:3000 » (port de la borne
 * si aucun n'est donné). Une adresse qui commence par http(s):// est gardée telle quelle.
 */
export function completeUrl(raw, { scheme = 'http', port = null } = {}) {
  let s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s); // adresse complète : on la garde telle quelle
  if (bare) s = `${scheme}://${s}`;
  try {
    const u = new URL(s);
    if (bare && port && !/^[^/]*:\d+/.test(s.slice(scheme.length + 3))) u.port = String(port);
    return u.toString().replace(/\/+$/, '');
  } catch { return s; }
}

/** Version du code de la borne (date de modification des fichiers servis) : la page se recharge si elle change. */
function clientVersion() {
  let v = 0;
  for (const f of ['index.html', 'booth.js', 'booth.css', 'template-render.js', 'cutout.js', 'cutout-live.js']) {
    try { v = Math.max(v, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch { /* absent */ }
  }
  return Math.round(v);
}

/**
 * Cœur métier : cycle de vie d'une session invité et application des limites.
 *
 * Statuts d'une session :
 *   shooting  → prise des photos (reprises possibles)
 *   review    → montage final prêt, l'invité valide ou refait
 *   printing  → envoyé à l'imprimante
 *   done      → terminé (imprimé ou sans impression)
 *   error     → échec d'impression
 */
export class Booth {
  constructor({ config, store, templates, themes, camera, printer, broadcast, port }) {
    this.config = config;
    this.store = store;
    this.templates = templates;
    this.themes = themes;
    this.camera = camera;
    this.printer = printer;
    this.broadcast = broadcast || (() => {});
    this.port = port;
    this.jobToSession = new Map();
    this.armed = new Map(); // sessionId → { index, file } : photo programmée pendant le décompte
    this.capturing = new Set(); // sessionId dont une photo est en cours d'arrivée
    // Seules les sessions validées par l'invité (« Je la garde ») sont conservées. La borne supprime les autres
    // en revenant à l'accueil ; ce passage rattrape celles qu'elle n'a pas pu signaler (page rechargée, coupure).
    this.purgeUnvalidatedSessions();
    this.purgeTimer = setInterval(() => this.purgeUnvalidatedSessions(), 5 * 60 * 1000);
    this.purgeTimer.unref?.();
    this.onJob = (job) => this.onPrinterJob(job);
    printer.on('job', this.onJob);
    this.onLive = (streaming) => this.broadcast({ type: 'live', streaming });
    this.onFlashStray = (stray) => this.broadcast({ type: 'flashStray', stray });
    camera.onLive = this.onLive;
    camera.onFlashStray = this.onFlashStray;
  }

  /** Bascule de matériel à chaud (voir devices.js). */
  setCamera(camera) {
    if (this.camera) { this.camera.onLive = null; this.camera.onFlashStray = null; }
    this.camera = camera;
    camera.onLive = this.onLive;
    camera.onFlashStray = this.onFlashStray;
  }

  setPrinter(printer) {
    this.printer?.off('job', this.onJob);
    this.printer = printer;
    printer.on('job', this.onJob);
  }

  printing() {
    return this.jobToSession.size > 0;
  }

  cfg() {
    return this.config.get();
  }

  // ---------- Données envoyées au navigateur au chargement ----------

  bootstrap() {
    const cfg = this.cfg();
    const { operatorPin, ...limits } = cfg.limits;
    const wifi = cfg.share.requireWifi === false || wifiStatus().connected;
    return {
      booth: cfg.booth,
      adminOpen: !String(cfg.admin.pin ?? ''), // code admin vide : accès direct (tests)
      texts: cfg.texts,
      limits,
      camera: { mode: this.camera.mode, driver: this.camera.name, streaming: this.camera.streaming(), armLeadMs: this.camera.armLeadMs(), flashStray: !!this.camera.flashStray },
      printer: { driver: this.printer.name, available: this.printer.available !== false },
      templates: {
        guestCanChoose: cfg.templates.guestCanChoose,
        default: cfg.templates.default,
        items: this.templates.enabled(cfg)
      },
      theme: this.themes.resolve(cfg),
      counters: this.publicCounters(),
      samples: samplePhotos().map((s) => s.url), // photos d'exemple des cadres proposés
      sampleCutouts: samplePhotos().map((s) => s.cutoutUrl || null), // et leur version détourée (.png)
      // QR codes de photo seulement en Wi-Fi (share.requireWifi) : sans lui, aucun téléphone ne peut joindre la borne.
      share: { baseUrl: this.shareBaseUrl(), qrOnDone: cfg.share.qrOnDone !== false && wifi },
      gallery: { enabled: !!cfg.gallery.booth, reprint: cfg.gallery.reprint, qr: cfg.gallery.qr !== false && wifi },
      clientVersion: clientVersion()
    };
  }

  publicCounters() {
    const { eventQuota, lowPaperThreshold } = this.cfg().limits;
    const c = this.store.counters();
    const ev = this.store.activeEvent();
    const printed = ev.printed || 0; // tirages et quota : ceux de l'événement en cours ; le papier reste global
    const quotaRemaining = eventQuota > 0 ? Math.max(0, eventQuota - printed) : null;
    const paperTracked = Number.isFinite(c.paperRemaining);
    return {
      eventId: ev.id,
      eventName: ev.name,
      printed,
      sessions: this.store.sessionsOfEvent(ev.id).length,
      quotaRemaining,
      quotaReached: quotaRemaining === 0,
      paperRemaining: paperTracked ? c.paperRemaining : null,
      lowPaper: paperTracked && c.paperRemaining <= lowPaperThreshold,
      paperEmpty: paperTracked && c.paperRemaining <= 0
    };
  }

  shareBaseUrl() {
    const configured = completeUrl(this.cfg().share.baseUrl, { port: this.port });
    return (configured || `http://${wifiStatus().ip || lanIp()}:${this.port}`).replace(/\/$/, ''); // l'IP Wi-Fi : celle que joignent les téléphones
  }

  // ---------- Sessions ----------

  async createSession(templateId) {
    if (this.camera.calibrating) throw new HttpError(409, 'CAMERA_CALIBRATING', 'Réglage de l\'appareil en cours, un instant…');
    const cfg = this.cfg();
    const enabled = this.templates.enabled(cfg).map((t) => t.id);
    if (!enabled.length) throw new HttpError(409, 'NO_TEMPLATE', 'Aucun template activé');
    let id = templateId;
    if (!id || !enabled.includes(id)) {
      if (templateId) throw new HttpError(400, 'TEMPLATE_DISABLED', 'Ce template n\'est pas disponible');
      id = enabled.includes(cfg.templates.default) ? cfg.templates.default : enabled[0];
    }
    const template = this.templates.get(id);
    const session = {
      id: newId(),
      eventId: this.store.data.activeEventId, // rangée dans l'événement en cours
      createdAt: new Date().toISOString(),
      templateId: template.id,
      status: 'shooting',
      kind: template.kind, // 'gif' : numérique uniquement, jamais imprimé
      shots: Array(template.shots).fill(null),
      retakes: 0,
      copies: 0,
      unlocked: false,
      // Aperçu en miroir : la photo finale l'est aussi (fixé à la création, un changement d'admin ne coupe pas une session)
      mirror: !!cfg.booth.mirrorPreview,
      final: null,
      printJobs: []
    };
    fs.mkdirSync(this.sessionDir(session.id), { recursive: true });
    this.store.saveSession(session);
    return this.view(session);
  }

  sessionDir(id) {
    return path.join(SESSIONS_DIR, id);
  }

  /** Suppression par l'admin : fiche en base + photos sur disque. Refusée pendant une impression. */
  deleteSession(id) {
    const s = this.load(id);
    if (s.status === 'printing') throw new HttpError(409, 'SESSION_PRINTING', 'Impression en cours : réessayez quand elle sera terminée');
    this.store.deleteSession(id);
    fs.rmSync(this.sessionDir(id), { recursive: true, force: true });
    this.forgetJobs([id]);
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
    this.broadcast({ type: 'sessions' });
  }

  /** Session pas encore validée par l'invité (ni « Je la garde », ni impression) et sans photo en route. */
  isUnvalidated(s) {
    return ['shooting', 'review'].includes(s.status) && !s.kept && !this.armed.has(s.id) && !this.capturing.has(s.id);
  }

  /** « Je la garde » : la session est conservée, même si l'invité ne va pas au bout du choix des copies. */
  keepSession(id) {
    const s = this.load(id);
    if (!s.final) throw new HttpError(409, 'NO_FINAL', 'Aucune image finale');
    if (!s.kept) { s.kept = true; this.store.saveSession(s); }
    return this.view(s);
  }

  /** L'invité a quitté la borne sans valider : la session et ses photos disparaissent. */
  async abandonSession(id) {
    if (this.armed.has(id)) await this.disarm(id); // parti pendant le décompte : plus de déclenchement programmé
    const s = this.store.getSession(id);
    if (!s || !this.isUnvalidated(s)) return false;
    this.deleteSession(id);
    return true;
  }

  /** Supprime les sessions non validées de plus de maxAgeMs (la borne a pu ne pas prévenir : page rechargée, coupure). */
  purgeUnvalidatedSessions(maxAgeMs = 15 * 60 * 1000) {
    const now = Date.now();
    const stale = Object.values(this.store.data.sessions)
      .filter((s) => this.isUnvalidated(s) && now - new Date(s.createdAt).getTime() > maxAgeMs);
    for (const s of stale) this.deleteSession(s.id);
    if (stale.length) console.log(`[booth] ${stale.length} session(s) non validée(s) supprimée(s)`);
  }

  /** Réinitialisation par l'admin : les sessions d'un événement (en cours par défaut), leurs photos et son compteur. */
  resetSessions(eventId = this.store.data.activeEventId) {
    const all = this.store.sessionsOfEvent(eventId);
    if (all.some((s) => s.status === 'printing')) throw new HttpError(409, 'SESSION_PRINTING', 'Impression en cours : réessayez quand elle sera terminée');
    this.store.resetEventSessions(eventId);
    for (const s of all) fs.rmSync(this.sessionDir(s.id), { recursive: true, force: true });
    this.forgetJobs(all.map((s) => s.id));
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
    this.broadcast({ type: 'sessions' });
    return all.length;
  }

  // ---------- Événements ----------

  event(id) {
    const ev = this.store.getEvent(id);
    if (!ev) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Événement introuvable');
    return ev;
  }

  /** Événement avec ses chiffres, pour l'admin. */
  eventView(ev) {
    const sessions = this.store.sessionsOfEvent(ev.id);
    return {
      ...ev,
      active: ev.id === this.store.data.activeEventId,
      sessions: sessions.length,
      photos: sessions.reduce((n, s) => n + s.shots.filter(Boolean).length, 0),
      finals: sessions.filter((s) => s.final).length
    };
  }

  createEvent({ name, date, activate }) {
    if (!String(name || '').trim()) throw new HttpError(400, 'EVENT_NAME', 'Nom de l\'événement obligatoire');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'EVENT_DATE', 'Date invalide (AAAA-MM-JJ)');
    const ev = this.store.createEvent({ name, date });
    if (activate) this.activateEvent(ev.id);
    return ev;
  }

  updateEvent(id, { name, date }) {
    this.event(id);
    const patch = {};
    if (name !== undefined) {
      if (!String(name).trim()) throw new HttpError(400, 'EVENT_NAME', 'Nom de l\'événement obligatoire');
      patch.name = String(name).trim();
    }
    if (date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'EVENT_DATE', 'Date invalide (AAAA-MM-JJ)');
      patch.date = date;
    }
    const ev = this.store.updateEvent(id, patch);
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
    return ev;
  }

  /** Les nouvelles sessions iront dans cet événement ; quota et tirages affichés deviennent les siens. */
  activateEvent(id) {
    this.event(id);
    this.store.setActiveEvent(id);
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
  }

  /** Supprime un événement, ses sessions et leurs photos. Jamais l'événement en cours. */
  deleteEvent(id) {
    this.event(id);
    if (id === this.store.data.activeEventId) throw new HttpError(409, 'EVENT_ACTIVE', 'C\'est l\'événement en cours : activez-en un autre avant de le supprimer');
    const removed = this.resetSessions(id);
    this.store.deleteEvent(id);
    return removed;
  }

  /** Change une session de dossier ; ses tirages suivent (compteur des deux événements). */
  moveSession(id, eventId) {
    const s = this.load(id);
    this.event(eventId);
    if (s.eventId === eventId) return this.view(s);
    const printed = s.printJobs.filter((j) => !j.refunded).reduce((n, j) => n + j.copies, 0);
    this.store.addEventPrinted(s.eventId, -printed);
    this.store.addEventPrinted(eventId, printed);
    s.eventId = eventId;
    this.store.saveSession(s);
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
    return this.view(s);
  }

  /**
   * Fichiers à exporter pour un événement : content = 'originals' (photos du boîtier), 'finals' (montages
   * avec le template) ou 'both'. Retourne [{ file, name }] avec name = chemin dans l'archive.
   */
  exportFiles(id, content) {
    const ev = this.event(id);
    if (!['originals', 'finals', 'both'].includes(content)) throw new HttpError(400, 'EXPORT_CONTENT', 'Contenu attendu : originals, finals ou both');
    const files = [];
    for (const s of this.store.sessionsOfEvent(ev.id).reverse()) { // ordre chronologique
      if (content !== 'finals') {
        s.shots.forEach((sh, i) => { if (sh && fs.existsSync(sh.file)) files.push({ file: sh.file, name: `originaux/${s.id}/photo-${i + 1}${path.extname(sh.file)}` }); });
      }
      if (content !== 'originals' && s.final && fs.existsSync(s.final.file)) {
        files.push({ file: s.final.file, name: `montages/${s.id}${path.extname(s.final.file)}` });
      }
    }
    return { event: ev, files };
  }

  forgetJobs(sessionIds) {
    for (const [jobId, sid] of this.jobToSession) if (sessionIds.includes(sid)) this.jobToSession.delete(jobId);
  }

  load(id) {
    const s = this.store.getSession(id);
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session inconnue');
    return s;
  }

  view(s) {
    const cfg = this.cfg();
    const template = this.templates.items.get(s.templateId);
    const urlFor = (file) => (file ? `/output/sessions/${s.id}/${path.basename(file)}` : null);
    return {
      id: s.id,
      eventId: s.eventId,
      createdAt: s.createdAt,
      templateId: s.templateId,
      templateName: template?.name || s.templateId,
      gif: s.kind === 'gif',
      status: s.status,
      shotsExpected: template?.shots ?? s.shots.length,
      shots: s.shots.map((sh, index) => (sh ? { index, url: urlFor(sh.file), takenAt: sh.takenAt } : null)),
      mirror: !!s.mirror,
      retakes: s.retakes,
      retakesLeft: cfg.limits.maxRetakesPerSession < 0 ? null : Math.max(0, cfg.limits.maxRetakesPerSession - s.retakes), // null = illimité
      copies: s.copies,
      unlocked: s.unlocked,
      maxCopies: s.unlocked ? cfg.limits.operatorMaxCopies : cfg.limits.maxCopiesPerSession,
      final: s.final ? { url: urlFor(s.final.file), thumbUrl: urlFor(s.final.thumb), gif: s.kind === 'gif' } : null,
      printJobs: s.printJobs,
      error: s.error || null
    };
  }

  /**
   * Pendant le décompte : la caméra fait la mise au point et programme le déclenchement dans fireInMs.
   * Le fichier cible est réservé maintenant pour que addShot() retrouve la photo.
   */
  arm(id, { index, fireInMs } = {}) {
    const s = this.load(id);
    if (!['shooting', 'review'].includes(s.status) || this.camera.mode !== 'server') return;
    const template = this.templates.get(s.templateId);
    let i = Number.isInteger(index) ? index : s.shots.findIndex((sh) => !sh);
    if (i < 0 || i >= template.shots) i = 0;
    const file = path.join(this.sessionDir(s.id), `shot-${i + 1}-${Date.now()}.jpg`);
    this.armed.set(s.id, { index: i, file });
    console.log(`[booth] session ${s.id} : pré-armement photo ${i + 1}, déclenchement dans ${Math.round(Number(fireInMs) || 0)} ms`);
    this.camera.arm({ fireInMs: Math.max(0, Number(fireInMs) || 0), file })
      .catch((e) => console.warn(`[camera] pré-armement : ${e.message}`));
  }

  /** L'invité a quitté l'écran de prise de vue pendant le décompte. */
  disarm(id) {
    this.armed.delete(id);
    return this.camera.disarm().catch((e) => console.warn(`[camera] annulation : ${e.message}`));
  }

  /**
   * Enregistre la photo n°index. Si elle existe déjà, c'est une reprise, comptée
   * dans la limite. En mode 'browser' la photo arrive dans photoBuffer ; sinon
   * c'est le pilote caméra qui déclenche.
   */
  async addShot(id, index, photoBuffer) {
    const s = this.load(id);
    const cfg = this.cfg();
    const template = this.templates.get(s.templateId);
    if (!Number.isInteger(index) || index < 0 || index >= template.shots) {
      throw new HttpError(400, 'SHOT_INDEX', `Numéro de photo invalide (0 à ${template.shots - 1})`);
    }
    if (!['shooting', 'review'].includes(s.status)) throw new HttpError(409, 'SESSION_CLOSED', 'Cette session est terminée');
    const isRetake = !!s.shots[index];
    if (isRetake && cfg.limits.maxRetakesPerSession >= 0 && s.retakes >= cfg.limits.maxRetakesPerSession) {
      throw new HttpError(409, 'RETAKE_LIMIT', 'Nombre de reprises atteint');
    }

    const armed = this.armed.get(s.id);
    this.armed.delete(s.id);
    console.log(`[booth] session ${s.id} : photo ${index + 1} demandée${isRetake ? ' (reprise)' : ''}${armed ? '' : ' sans pré-armement'}`);
    const file = armed && armed.index === index ? armed.file : path.join(this.sessionDir(s.id), `shot-${index + 1}-${Date.now()}.jpg`);
    this.capturing.add(s.id); // protège la session du nettoyage des sessions vides
    try {
      if (this.camera.mode === 'browser') {
        if (!photoBuffer) throw new HttpError(400, 'PHOTO_REQUIRED', 'Photo manquante (champ "photo")');
        await normalizeShot(photoBuffer, file);
      } else {
        await this.camera.capture(file);
      }
    } finally {
      this.capturing.delete(s.id);
    }

    if (isRetake) {
      s.retakes += 1;
      try { fs.unlinkSync(s.shots[index].file); } catch { /* déjà supprimé */ }
    }
    s.shots[index] = { file, takenAt: new Date().toISOString() };
    s.final = null;
    s.status = 'shooting';
    this.store.saveSession(s);
    const v = this.view(s);
    return { session: v, shot: v.shots[index] };
  }

  /** GIF : « Refaire » reprend toutes les poses (compté comme une reprise). */
  restartShots(id) {
    const s = this.load(id);
    const cfg = this.cfg();
    if (!['shooting', 'review'].includes(s.status)) throw new HttpError(409, 'SESSION_CLOSED', 'Cette session est terminée');
    if (cfg.limits.maxRetakesPerSession >= 0 && s.retakes >= cfg.limits.maxRetakesPerSession) throw new HttpError(409, 'RETAKE_LIMIT', 'Nombre de reprises atteint');
    for (const sh of s.shots) if (sh) { try { fs.unlinkSync(sh.file); } catch { /* déjà supprimé */ } }
    s.shots = s.shots.map(() => null);
    s.retakes += 1;
    s.final = null;
    s.status = 'shooting';
    this.store.saveSession(s);
    return this.view(s);
  }

  async composeSession(id) {
    const s = this.load(id);
    const template = this.templates.get(s.templateId);
    const missing = s.shots.findIndex((sh) => !sh);
    if (missing >= 0) throw new HttpError(409, 'SHOTS_MISSING', `Il manque la photo ${missing + 1}`);
    const dir = this.sessionDir(s.id);
    const gif = s.kind === 'gif' && template.kind === 'gif';
    const finalFile = path.join(dir, gif ? 'final.gif' : 'final.jpg');
    const thumbFile = path.join(dir, 'thumb.jpg');
    if (gif) {
      const poster = path.join(dir, 'poster.jpg');
      await composeGif(template, s.shots.map((sh) => sh.file), finalFile, { mirror: !!s.mirror, posterFile: poster });
      await thumbnail(poster, thumbFile); // miniature fixe : la galerie reste légère
    } else {
      await compose(template, s.shots.map((sh) => sh.file), finalFile, { mirror: !!s.mirror });
      await thumbnail(finalFile, thumbFile);
    }
    s.final = { file: finalFile, thumb: thumbFile, composedAt: new Date().toISOString() };
    s.status = 'review';
    this.store.saveSession(s);
    return this.view(s);
  }

  unlock(id, pin) {
    const s = this.load(id);
    if (String(pin) !== String(this.cfg().limits.operatorPin)) throw new HttpError(403, 'BAD_PIN', 'Code opérateur incorrect');
    s.unlocked = true;
    this.store.saveSession(s);
    return this.view(s);
  }

  /** Feuilles restantes d'après le stock saisi dans l'admin (Infinity = stock non suivi). */
  paperLeft() {
    const p = this.store.counters().paperRemaining;
    return Number.isFinite(p) ? Math.max(0, p) : Infinity;
  }

  quotaRemaining() {
    const { eventQuota } = this.cfg().limits;
    if (!(eventQuota > 0)) return Infinity;
    return Math.max(0, eventQuota - (this.store.activeEvent().printed || 0));
  }

  /** Impression demandée par l'invité : toutes les limites s'appliquent (sauf session déverrouillée). */
  async print(id, copies) {
    const s = this.load(id);
    const cfg = this.cfg();
    if (s.status !== 'review') throw new HttpError(409, 'NOT_REVIEWED', 'Le montage n\'est pas prêt');
    if (!s.final) throw new HttpError(409, 'NO_FINAL', 'Aucune image finale');
    if (s.kind === 'gif') { // numérique uniquement : on termine sans tirage
      if (copies !== 0) throw new HttpError(409, 'GIF_NO_PRINT', 'Un GIF ne s\'imprime pas');
      return this.sendToPrinter(s, 0, 'guest');
    }
    // Quota atteint ou imprimante absente : l'invité doit toujours pouvoir terminer sans imprimer.
    const printerOff = this.printer.available === false;
    const min = cfg.limits.allowZeroCopies || printerOff || this.quotaRemaining() === 0 || this.paperLeft() === 0 ? 0 : 1;
    const max = s.unlocked ? cfg.limits.operatorMaxCopies : cfg.limits.maxCopiesPerSession;
    if (!Number.isInteger(copies) || copies < min || copies > max) {
      throw new HttpError(400, 'COPIES_INVALID', `Nombre de copies invalide (${min} à ${max})`);
    }
    if (copies > 0 && printerOff) throw new HttpError(409, 'PRINTER_UNAVAILABLE', cfg.texts.printerUnavailable);
    // Le papier manque physiquement : même une session déverrouillée par l'opérateur ne peut pas imprimer.
    if (copies > this.paperLeft()) throw new HttpError(409, 'PAPER_EMPTY', cfg.texts.paperEmpty);
    if (copies > 0 && !s.unlocked && copies > this.quotaRemaining()) {
      throw new HttpError(409, 'QUOTA_REACHED', cfg.texts.quotaReached);
    }
    return this.sendToPrinter(s, copies, 'guest');
  }

  /** Réimpression depuis l'admin : pas de limite par session, mais les compteurs bougent. */
  async reprint(id, copies) {
    const s = this.load(id);
    if (!s.final) throw new HttpError(409, 'NO_FINAL', 'Aucune image finale pour cette session');
    if (s.kind === 'gif') throw new HttpError(409, 'GIF_NO_PRINT', 'Un GIF ne s\'imprime pas');
    if (!Number.isInteger(copies) || copies < 1 || copies > 50) throw new HttpError(400, 'COPIES_INVALID', 'Nombre de copies invalide');
    return this.sendToPrinter(s, copies, 'admin');
  }

  // ---------- Galerie ----------

  /** Photos de l'événement en cours validées par les invités, les plus récentes d'abord. */
  gallery() {
    return this.store.sessionsOfEvent(this.store.data.activeEventId)
      .filter((s) => s.final && !this.isUnvalidated(s))
      .map((s) => {
        const v = this.view(s);
        return { id: v.id, createdAt: v.createdAt, url: v.final.url, thumbUrl: v.final.thumbUrl, gif: v.gif, printing: s.status === 'printing' };
      });
  }

  /**
   * Réimpression depuis la galerie de la borne, selon gallery.reprint : « operator » demande le code
   * opérateur (et lève le quota comme sur la borne), « guest » applique toutes les limites.
   */
  async galleryPrint(id, copies, pin) {
    const cfg = this.cfg();
    const mode = cfg.gallery.reprint;
    if (mode !== 'operator' && mode !== 'guest') throw new HttpError(403, 'REPRINT_DISABLED', 'La réimpression est désactivée');
    const s = this.store.getSession(id);
    if (!s || s.eventId !== this.store.data.activeEventId || !s.final || this.isUnvalidated(s)) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Photo introuvable dans la galerie');
    }
    if (s.kind === 'gif') throw new HttpError(409, 'GIF_NO_PRINT', 'Un GIF ne s\'imprime pas');
    const operator = mode === 'operator';
    if (operator && String(pin ?? '') !== String(cfg.limits.operatorPin)) throw new HttpError(403, 'BAD_PIN', 'Code opérateur incorrect');
    const max = operator ? cfg.limits.operatorMaxCopies : cfg.limits.maxCopiesPerSession;
    if (!Number.isInteger(copies) || copies < 1 || copies > max) throw new HttpError(400, 'COPIES_INVALID', `Nombre de copies invalide (1 à ${max})`);
    if (s.status === 'printing') throw new HttpError(409, 'SESSION_PRINTING', 'Cette photo est déjà en cours d\'impression');
    if (this.printer.available === false) throw new HttpError(409, 'PRINTER_UNAVAILABLE', cfg.texts.printerUnavailable);
    if (copies > this.paperLeft()) throw new HttpError(409, 'PAPER_EMPTY', cfg.texts.paperEmpty);
    if (!operator && copies > this.quotaRemaining()) throw new HttpError(409, 'QUOTA_REACHED', cfg.texts.quotaReached);
    return this.sendToPrinter(s, copies, 'gallery');
  }

  async sendToPrinter(s, copies, origin) {
    if (copies === 0) {
      s.status = 'done';
      this.store.saveSession(s);
      this.broadcast({ type: 'session', sessionId: s.id, status: 'done' });
      return this.view(s);
    }
    let job;
    try {
      job = await this.printer.print(s.final.file, copies, { sessionId: s.id });
    } catch (e) {
      s.status = 'error';
      s.error = e.message;
      this.store.saveSession(s);
      throw new HttpError(502, 'PRINT_FAILED', `Impression impossible : ${e.message}`);
    }
    const c = this.store.counters();
    const paperTaken = Number.isFinite(c.paperRemaining) ? Math.min(copies, Math.max(0, c.paperRemaining)) : 0;
    // paperTaken : feuilles réellement décomptées, pour rembourser exactement si le tirage échoue
    s.printJobs.push({ jobId: job.jobId, copies, paperTaken, origin, status: 'queued', at: new Date().toISOString() });
    s.copies += copies;
    s.status = 'printing';
    s.error = null;
    this.jobToSession.set(job.jobId, s.id);
    this.store.saveSession(s);

    this.store.updateCounters({
      printed: c.printed + copies,
      paperRemaining: Number.isFinite(c.paperRemaining) ? c.paperRemaining - paperTaken : c.paperRemaining
    });
    this.store.addEventPrinted(s.eventId, copies);
    this.store.addPrint({ at: new Date().toISOString(), sessionId: s.id, templateId: s.templateId, copies, origin, jobId: job.jobId });
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
    return this.view(s);
  }

  onPrinterJob(job) {
    const sessionId = this.jobToSession.get(job.jobId);
    if (!sessionId) return;
    const s = this.store.getSession(sessionId);
    if (!s) return;
    const entry = s.printJobs.find((j) => j.jobId === job.jobId);
    if (entry) {
      entry.status = job.status;
      if (job.message) entry.message = job.message;
    }
    if (job.status === 'error') {
      s.status = 'error';
      s.error = job.message || 'Erreur imprimante';
      if (entry && !entry.refunded) this.chargeJob(s, entry, -1); // tirage raté : ni compté, ni papier consommé
    } else if (s.printJobs.every((j) => j.status === 'done')) {
      s.status = 'done';
    }
    // Tirage bloqué (papier) qui sort finalement une fois le papier remis : on le recompte.
    if (job.status === 'done' && entry?.refunded) this.chargeJob(s, entry, 1);
    this.store.saveSession(s);
    // Après une erreur on garde le lien : un tirage bloqué peut encore sortir (voir CupsPrinter.watch).
    if (job.status === 'done') this.jobToSession.delete(job.jobId);
    this.broadcast({ type: 'print', sessionId, jobId: job.jobId, status: job.status, message: job.message || null, sessionStatus: s.status });
  }

  /** Retire (sign = -1) ou remet (sign = 1) un tirage dans les compteurs : impressions et papier. */
  chargeJob(s, entry, sign) {
    const c = this.store.counters();
    this.store.updateCounters({
      printed: Math.max(0, c.printed + sign * entry.copies),
      paperRemaining: Number.isFinite(c.paperRemaining) ? Math.max(0, c.paperRemaining - sign * (entry.paperTaken || 0)) : c.paperRemaining
    });
    this.store.addEventPrinted(s.eventId, sign * entry.copies);
    entry.refunded = sign < 0;
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
  }

  /**
   * QR code Wi-Fi (format WIFI: reconnu par l'appareil photo d'iOS et d'Android) : rejoint le hotspot de la borne.
   * null quand il est désactivé ou incomplet.
   */
  async wifiQr() {
    const w = this.cfg().share.wifi || {};
    const ssid = String(w.ssid || '').trim();
    const open = w.security === 'nopass';
    if (!w.enabled || !ssid || (!open && !w.password)) return null;
    const escape = (v) => String(v).replace(/([\\;,:"])/g, '\\$1');
    const payload = `WIFI:T:${open ? 'nopass' : 'WPA'};S:${escape(ssid)};${open ? '' : `P:${escape(w.password)};`};`;
    const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 320, color: { dark: '#000000', light: '#ffffff' } });
    return { ssid, dataUrl };
  }

  /** Lien d'une photo : l'adresse publique si elle est réglée, sinon l'adresse de la borne sur le réseau. */
  photoUrl(id) {
    const pub = completeUrl(this.cfg().share.publicUrl, { scheme: 'https' });
    return `${pub || this.shareBaseUrl()}/g/${id}`;
  }

  async qr(id) {
    const s = this.load(id);
    const url = this.photoUrl(s.id);
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } });
    return { url, dataUrl };
  }

  async cameraStatus() {
    return this.camera.status();
  }

  async printerStatus() {
    return this.printer.status();
  }
}
