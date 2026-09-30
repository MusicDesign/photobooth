import { DB_FILE } from './paths.js';
import { loadJsonSafe, writeJsonAtomic, backupJson } from './util.js';

const EMPTY = () => ({
  counters: { printed: 0, paperRemaining: null, sessionsCount: 0 }, // printed : total historique, tous événements
  sessions: {},
  prints: [],
  events: {},          // id → { id, name, date, createdAt, printed } : dossiers de sessions, compteur de tirages propre
  activeEventId: null  // événement qui reçoit les nouvelles sessions
});

const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'evenement';

/**
 * Persistance dans un fichier JSON, largement suffisant pour une borne (5 000 sessions : 4,5 Mo réécrits en
 * quelques ms). Écriture sûre (voir writeJsonAtomic), lecture protégée (fichier illisible : dernière
 * sauvegarde), sauvegardes dans backups/ au démarrage puis toutes les heures.
 */
export class Store {
  constructor(file = DB_FILE) {
    this.file = file;
    this.data = EMPTY();
    const { data: saved, warning } = loadJsonSafe(file, 'Base des sessions');
    this.warning = warning; // affiché dans le tableau de bord
    if (saved) this.data = { ...EMPTY(), ...saved, counters: { ...EMPTY().counters, ...(saved.counters || {}) } };
    this.migrateEvents();
    if (saved && !warning) backupJson(file); // copie saine au démarrage
    else if (warning) this.save(); // reprise d'une sauvegarde (ou départ à neuf) : la base est réécrite tout de suite
    this.backupTimer = setInterval(() => { try { backupJson(this.file); } catch (e) { console.warn(`[données] sauvegarde : ${e.message}`); } }, 60 * 60 * 1000);
    this.backupTimer.unref?.();
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
      if (!d.events[s.eventId]) { s.eventId = d.events.tests ? 'tests' : d.activeEventId; changed = true; }
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

  save() {
    writeJsonAtomic(this.file, this.data);
  }

  getSession(id) {
    return this.data.sessions[id] || null;
  }

  saveSession(session) {
    if (!this.data.sessions[session.id]) this.data.counters.sessionsCount += 1;
    this.data.sessions[session.id] = session;
    this.save();
    return session;
  }

  /** Supprime une session ; le compteur suit pour que le tableau de bord reste juste. */
  deleteSession(id) {
    if (!this.data.sessions[id]) return false;
    delete this.data.sessions[id];
    this.data.counters.sessionsCount = Math.max(0, this.data.counters.sessionsCount - 1);
    this.save();
    return true;
  }

  /** Efface les sessions d'un événement et remet son compteur de tirages à zéro (l'historique des tirages est conservé). */
  resetEventSessions(eventId) {
    for (const s of this.sessionsOfEvent(eventId)) delete this.data.sessions[s.id];
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

  addPrint(print) {
    this.data.prints.push(print);
    if (this.data.prints.length > 5000) this.data.prints.shift();
    this.save();
  }

  listPrints(limit = 100) {
    return this.data.prints.slice(-limit).reverse();
  }
}
