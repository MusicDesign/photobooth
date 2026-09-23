import fs from 'node:fs';
import { DB_FILE } from './paths.js';
import { readJson, writeJsonAtomic } from './util.js';

const EMPTY = () => ({
  counters: { printed: 0, paperRemaining: null, sessionsCount: 0 },
  sessions: {},
  prints: []
});

/**
 * Persistance simple dans un fichier JSON. Suffisant pour le POC ; à remplacer
 * par SQLite quand le volume de sessions grossira.
 */
export class Store {
  constructor(file = DB_FILE) {
    this.file = file;
    this.data = EMPTY();
    if (fs.existsSync(file)) {
      const saved = readJson(file, {});
      this.data = { ...EMPTY(), ...saved, counters: { ...EMPTY().counters, ...(saved.counters || {}) } };
    }
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

  /** Efface toutes les sessions et remet leur compteur à zéro (l'historique des tirages est conservé). */
  resetSessions() {
    this.data.sessions = {};
    this.data.counters.sessionsCount = 0;
    this.save();
  }

  listSessions(limit = 50) {
    return Object.values(this.data.sessions)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
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
