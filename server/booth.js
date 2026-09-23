import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { SESSIONS_DIR, PUBLIC_DIR } from './paths.js';
import { HttpError, newId, lanIp } from './util.js';
import { compose, thumbnail, normalizeShot } from './compositor.js';

/** Version du code de la borne (date de modification des fichiers servis) : la page se recharge si elle change. */
function clientVersion() {
  let v = 0;
  for (const f of ['index.html', 'booth.js', 'booth.css', 'template-render.js']) {
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
    this.onJob = (job) => this.onPrinterJob(job);
    printer.on('job', this.onJob);
    this.onLive = (streaming) => this.broadcast({ type: 'live', streaming });
    camera.onLive = this.onLive;
  }

  /** Bascule de matériel à chaud (voir devices.js). */
  setCamera(camera) {
    if (this.camera) this.camera.onLive = null;
    this.camera = camera;
    camera.onLive = this.onLive;
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
    return {
      booth: cfg.booth,
      texts: cfg.texts,
      limits,
      camera: { mode: this.camera.mode, driver: this.camera.name, streaming: this.camera.streaming(), armLeadMs: this.camera.armLeadMs() },
      printer: { driver: this.printer.name, available: this.printer.available !== false },
      templates: {
        guestCanChoose: cfg.templates.guestCanChoose,
        default: cfg.templates.default,
        items: this.templates.enabled(cfg)
      },
      theme: this.themes.resolve(cfg),
      counters: this.publicCounters(),
      share: { baseUrl: this.shareBaseUrl() },
      clientVersion: clientVersion()
    };
  }

  publicCounters() {
    const { eventQuota, lowPaperThreshold } = this.cfg().limits;
    const c = this.store.counters();
    const quotaRemaining = eventQuota > 0 ? Math.max(0, eventQuota - c.printed) : null;
    const paperTracked = Number.isFinite(c.paperRemaining);
    return {
      printed: c.printed,
      sessions: c.sessionsCount,
      quotaRemaining,
      quotaReached: quotaRemaining === 0,
      paperRemaining: paperTracked ? c.paperRemaining : null,
      lowPaper: paperTracked && c.paperRemaining <= lowPaperThreshold
    };
  }

  shareBaseUrl() {
    const configured = this.cfg().share.baseUrl?.trim();
    return (configured || `http://${lanIp()}:${this.port}`).replace(/\/$/, '');
  }

  // ---------- Sessions ----------

  async createSession(templateId) {
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
      createdAt: new Date().toISOString(),
      templateId: template.id,
      status: 'shooting',
      shots: Array(template.shots).fill(null),
      retakes: 0,
      copies: 0,
      unlocked: false,
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

  /** Réinitialisation par l'admin : toutes les sessions, leurs photos et le compteur. */
  resetSessions() {
    const all = Object.values(this.store.data.sessions);
    if (all.some((s) => s.status === 'printing')) throw new HttpError(409, 'SESSION_PRINTING', 'Impression en cours : réessayez quand elle sera terminée');
    this.store.resetSessions();
    fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.forgetJobs(all.map((s) => s.id));
    this.broadcast({ type: 'counters', counters: this.publicCounters() });
    this.broadcast({ type: 'sessions' });
    return all.length;
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
      createdAt: s.createdAt,
      templateId: s.templateId,
      templateName: template?.name || s.templateId,
      status: s.status,
      shotsExpected: template?.shots ?? s.shots.length,
      shots: s.shots.map((sh, index) => (sh ? { index, url: urlFor(sh.file), takenAt: sh.takenAt } : null)),
      retakes: s.retakes,
      retakesLeft: cfg.limits.maxRetakesPerSession < 0 ? null : Math.max(0, cfg.limits.maxRetakesPerSession - s.retakes), // null = illimité
      copies: s.copies,
      unlocked: s.unlocked,
      maxCopies: s.unlocked ? cfg.limits.operatorMaxCopies : cfg.limits.maxCopiesPerSession,
      final: s.final ? { url: urlFor(s.final.file), thumbUrl: urlFor(s.final.thumb) } : null,
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
    const file = armed && armed.index === index ? armed.file : path.join(this.sessionDir(s.id), `shot-${index + 1}-${Date.now()}.jpg`);
    if (this.camera.mode === 'browser') {
      if (!photoBuffer) throw new HttpError(400, 'PHOTO_REQUIRED', 'Photo manquante (champ "photo")');
      await normalizeShot(photoBuffer, file);
    } else {
      await this.camera.capture(file);
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

  async composeSession(id) {
    const s = this.load(id);
    const template = this.templates.get(s.templateId);
    const missing = s.shots.findIndex((sh) => !sh);
    if (missing >= 0) throw new HttpError(409, 'SHOTS_MISSING', `Il manque la photo ${missing + 1}`);
    const dir = this.sessionDir(s.id);
    const finalFile = path.join(dir, 'final.jpg');
    const thumbFile = path.join(dir, 'thumb.jpg');
    await compose(template, s.shots.map((sh) => sh.file), finalFile);
    await thumbnail(finalFile, thumbFile);
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

  quotaRemaining() {
    const { eventQuota } = this.cfg().limits;
    if (!(eventQuota > 0)) return Infinity;
    return Math.max(0, eventQuota - this.store.counters().printed);
  }

  /** Impression demandée par l'invité : toutes les limites s'appliquent (sauf session déverrouillée). */
  async print(id, copies) {
    const s = this.load(id);
    const cfg = this.cfg();
    if (s.status !== 'review') throw new HttpError(409, 'NOT_REVIEWED', 'Le montage n\'est pas prêt');
    if (!s.final) throw new HttpError(409, 'NO_FINAL', 'Aucune image finale');
    // Quota atteint ou imprimante absente : l'invité doit toujours pouvoir terminer sans imprimer.
    const printerOff = this.printer.available === false;
    const min = cfg.limits.allowZeroCopies || printerOff || this.quotaRemaining() === 0 ? 0 : 1;
    const max = s.unlocked ? cfg.limits.operatorMaxCopies : cfg.limits.maxCopiesPerSession;
    if (!Number.isInteger(copies) || copies < min || copies > max) {
      throw new HttpError(400, 'COPIES_INVALID', `Nombre de copies invalide (${min} à ${max})`);
    }
    if (copies > 0 && printerOff) throw new HttpError(409, 'PRINTER_UNAVAILABLE', cfg.texts.printerUnavailable);
    if (copies > 0 && !s.unlocked && copies > this.quotaRemaining()) {
      throw new HttpError(409, 'QUOTA_REACHED', cfg.texts.quotaReached);
    }
    return this.sendToPrinter(s, copies, 'guest');
  }

  /** Réimpression depuis l'admin : pas de limite par session, mais les compteurs bougent. */
  async reprint(id, copies) {
    const s = this.load(id);
    if (!s.final) throw new HttpError(409, 'NO_FINAL', 'Aucune image finale pour cette session');
    if (!Number.isInteger(copies) || copies < 1 || copies > 50) throw new HttpError(400, 'COPIES_INVALID', 'Nombre de copies invalide');
    return this.sendToPrinter(s, copies, 'admin');
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
    s.printJobs.push({ jobId: job.jobId, copies, origin, status: 'queued', at: new Date().toISOString() });
    s.copies += copies;
    s.status = 'printing';
    s.error = null;
    this.jobToSession.set(job.jobId, s.id);
    this.store.saveSession(s);

    const c = this.store.counters();
    this.store.updateCounters({
      printed: c.printed + copies,
      paperRemaining: Number.isFinite(c.paperRemaining) ? Math.max(0, c.paperRemaining - copies) : c.paperRemaining
    });
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
    } else if (s.printJobs.every((j) => j.status === 'done')) {
      s.status = 'done';
    }
    this.store.saveSession(s);
    if (job.status === 'done' || job.status === 'error') this.jobToSession.delete(job.jobId);
    this.broadcast({ type: 'print', sessionId, jobId: job.jobId, status: job.status, message: job.message || null, sessionStatus: s.status });
  }

  async qr(id) {
    const s = this.load(id);
    const url = `${this.shareBaseUrl()}/g/${s.id}`;
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
