import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, SESSIONS_DIR } from './paths.js';
import { loadJsonSafe, writeJsonAtomic, backupJson } from './util.js';

const SESSION_FILE = 'session.json';

const EMPTY = () => ({
  counters: { printed: 0, paperRemaining: null, sessionsCount: 0 }, // printed : total historique, tous événements
  sessions: {},        // en mémoire seulement : chaque session est écrite dans son dossier (voir SESSION_FILE)
  prints: [],
  events: {},          // id → { id, name, date, createdAt, printed } : dossiers de sessions, compteur de tirages propre
  activeEventId: null, // événement qui reçoit les nouvelles sessions
  cutoutPerf: null     // { machine, preciseSec, measuredAt } : vitesse du détourage précis, mesurée une fois sur cette machine
});

const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'evenement';

/**
 * Persistance en JSON, en deux parties.
 *   - data/db.json : événements, historique des tirages, compteurs, mesures (quelques Ko, réécrit à chaque
 *     changement ; écriture sûre, voir writeJsonAtomic ; lecture protégée : fichier illisible → dernière
 *     sauvegarde ; sauvegardes dans backups/ au démarrage puis toutes les heures).
 *   - une fiche session.json par session, dans son dossier output/sessions/<id>/ à côté de ses photos :
 *     enregistrer une session n'écrit qu'un Ko, quel que soit l'historique. Toutes les fiches sont lues au
 *     démarrage (20 000 fiches : moins d'une seconde) et gardées en mémoire. Une session est autonome : son
 *     dossier suffit à la retrouver, même si db.json est perdu.
 * Les sessions encore rangées dans db.json (versions précédentes) sont déplacées dans leurs dossiers au premier
 * démarrage, après la sauvegarde du fichier d'origine.
 */
export class Store {
  constructor(file = DB_FILE, sessionsDir = SESSIONS_DIR) {
    this.file = file;
    this.sessionsDir = sessionsDir;
    this.data = EMPTY();
    const { data: saved, warning } = loadJsonSafe(file, 'Base de la borne');
    this.warning = warning; // affiché dans le tableau de bord
    if (saved) this.data = { ...EMPTY(), ...saved, counters: { ...EMPTY().counters, ...(saved.counters || {}) } };
    if (saved && !warning) backupJson(file); // copie saine au démarrage (sessions comprises si elles y sont encore)
    const legacy = Object.values(this.data.sessions || {});
    this.data.sessions = this.loadSessions();
    // Sessions d'une version précédente, encore dans db.json : déplacées dans leurs dossiers
    let moved = 0;
    for (const s of legacy) {
      if (!s?.id || this.data.sessions[s.id]) continue;
      this.writeSession(s);
      this.data.sessions[s.id] = s;
      moved++;
    }
    if (moved) console.log(`[données] ${moved} session(s) déplacée(s) de db.json vers leur dossier (${path.join(this.sessionsDir, '<id>', SESSION_FILE)})`);
    this.data.counters.sessionsCount = Object.keys(this.data.sessions).length; // le compteur, c'est le nombre de fiches
    this.migrateEvents();
    if (warning || moved || legacy.length) this.save(); // base réécrite tout de suite : reprise, ou db.json délesté des sessions
    this.backupTimer = setInterval(() => { try { backupJson(this.file); } catch (e) { console.warn(`[données] sauvegarde : ${e.message}`); } }, 60 * 60 * 1000);
    this.backupTimer.unref?.();
  }

  // ---------- Fiches de session (une par dossier) ----------

  sessionFile(id) {
    return path.join(this.sessionsDir, String(id), SESSION_FILE);
  }

  writeSession(session) {
    writeJsonAtomic(this.sessionFile(session.id), session);
  }

  /** Toutes les fiches des dossiers de sessions. Dossier sans fiche (photos orphelines) ou fiche illisible : ignoré. */
  loadSessions() {
    const out = {};
    if (!fs.existsSync(this.sessionsDir)) return out;
    let bad = 0;
    for (const id of fs.readdirSync(this.sessionsDir)) {
      const f = this.sessionFile(id);
      if (!fs.existsSync(f)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (s?.id === id) out[id] = s; else bad++;
      } catch { bad++; }
    }
    this.sessionWarning = bad ? `${bad} fiche(s) de session illisible(s) dans ${this.sessionsDir} : session(s) ignorée(s), photos laissées en place.` : null;
    if (bad) console.error(`[données] ${this.sessionWarning}`);
    return out;
  }

  /**
   * Premier démarrage avec les événements : les sessions existantes vont dans « Tests », qui devient
   * l'événement en cours et reprend le compteur de tirages. Toute session sans événement y est aussi rangée.
   */
  migrateEvents() {
    const d = this.data;
    let changed = false;
    if (!Object.keys(d.events).length) {
      const first = Object.values(d.sessions).map((s) => s.createdAt).sort()[0] || new Date().toISOString();
      d.events.tests = { id: 'tests', name: 'Tests', date: first.slice(0, 10), createdAt: new Date().toISOString(), printed: d.counters.printed || 0 };
      changed = true;
    }
    if (!d.events[d.activeEventId]) {
      d.activeEventId = Object.values(d.events).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0].id;
      changed = true;
    }
    for (const s of Object.values(d.sessions)) {
      if (!d.events[s.eventId]) { s.eventId = d.events.tests ? 'tests' : d.activeEventId; this.writeSession(s); changed = true; }
    }
    if (changed) this.save();
  }

  // ---------- Événements ----------

  listEvents() {
    return Object.values(this.data.events).sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  }

  getEvent(id) {
    return this.data.events[id] || null;
  }

  activeEvent() {
    return this.data.events[this.data.activeEventId];
  }

  createEvent({ name, date }) {
    const base = slug(`${date || ''} ${name}`);
    let id = base;
    for (let i = 2; this.data.events[id]; i++) id = `${base}-${i}`;
    const ev = { id, name: String(name).trim(), date: date || new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString(), printed: 0 };
    this.data.events[id] = ev;
    this.save();
    return ev;
  }

  updateEvent(id, patch) {
    Object.assign(this.data.events[id], patch);
    this.save();
    return this.data.events[id];
  }

  setActiveEvent(id) {
    this.data.activeEventId = id;
    this.save();
  }

  deleteEvent(id) {
    delete this.data.events[id];
    this.save();
  }

  /** Tirages comptés pour un événement (delta positif ou négatif, jamais sous zéro). */
  addEventPrinted(id, delta) {
    const ev = this.data.events[id];
    if (!ev) return;
    ev.printed = Math.max(0, (ev.printed || 0) + delta);
    this.save();
  }

  sessionsOfEvent(id) {
    return Object.values(this.data.sessions)
      .filter((s) => s.eventId === id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** db.json : tout sauf les sessions, qui ont chacune leur fiche. */
  save() {
    const { sessions, ...rest } = this.data;
    writeJsonAtomic(this.file, rest);
  }

  /** Sessions dans cet état, tous événements confondus. */
  sessionsWithStatus(status) {
    return Object.values(this.data.sessions).filter((s) => s.status === status);
  }

  getSession(id) {
    return this.data.sessions[id] || null;
  }

  /** Écrit la fiche de la session dans son dossier ; nouvelle session : le compteur suit (dans db.json). */
  saveSession(session) {
    const isNew = !this.data.sessions[session.id];
    this.data.sessions[session.id] = session;
    this.writeSession(session);
    if (isNew) { this.data.counters.sessionsCount += 1; this.save(); }
    return session;
  }

  /** Supprime une session (sa fiche ; les photos, c'est la borne) ; le compteur suit pour que le tableau de bord reste juste. */
  deleteSession(id) {
    if (!this.data.sessions[id]) return false;
    delete this.data.sessions[id];
    fs.rmSync(this.sessionFile(id), { force: true });
    this.data.counters.sessionsCount = Math.max(0, this.data.counters.sessionsCount - 1);
    this.save();
    return true;
  }

  /** Efface les sessions d'un événement et remet son compteur de tirages à zéro (l'historique des tirages est conservé). */
  resetEventSessions(eventId) {
    for (const s of this.sessionsOfEvent(eventId)) { delete this.data.sessions[s.id]; fs.rmSync(this.sessionFile(s.id), { force: true }); }
    this.data.counters.sessionsCount = Object.keys(this.data.sessions).length;
    if (this.data.events[eventId]) this.data.events[eventId].printed = 0;
    this.save();
  }


  counters() {
    return { ...this.data.counters };
  }

  updateCounters(patch) {
    Object.assign(this.data.counters, patch);
    this.save();
    return this.counters();
  }

  /** Vitesse du détourage précis sur cette machine (cutout-ai.js) : mesurée une fois, gardée d'un lancement à l'autre. */
  cutoutPerf() {
    return this.data.cutoutPerf || null;
  }

  setCutoutPerf(perf) {
    this.data.cutoutPerf = perf;
    this.save();
  }

  addPrint(print) {
    this.data.prints.push(print);
    if (this.data.prints.length > 5000) this.data.prints.shift();
    this.save();
  }

  listPrints(limit = 100) {
    return this.data.prints.slice(-limit).reverse();
  }
}
