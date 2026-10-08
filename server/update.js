import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './paths.js';
import { run } from './setup.js';

const execFileP = promisify(execFile);
const first = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
/** Version X.X.X du package.json : c'est elle qu'on affiche ; le commit n'est qu'un détail. */
export const localVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null; } catch { return null; } };

/**
 * Mise à jour de la borne depuis l'admin (page Installation) : version en cours (commit git), vérification de ce
 * qui attend sur origin, puis `git pull --ff-only`, `npm install`, modules manquants (setup.js) et redémarrage.
 * Seulement quand le projet est un dépôt git (clone) : une app empaquetée se met à jour par réinstallation.
 * Refusée s'il y a des modifications locales non enregistrées : c'est à l'humain de trancher.
 * Réussie, elle relance le logiciel toute seule (restart), après l'impression en cours s'il y en a une (busy).
 */
export class Updater {
  constructor({ setup = null, restart = null, busy = () => false } = {}) {
    this.setup = setup;
    this.restart = restart;
    this.busy = busy;
    this.state = { available: fs.existsSync(path.join(ROOT, '.git')), version: localVersion(), remoteVersion: null, commit: null, date: null, subject: null, branch: null, behind: null, incoming: [], checkedAt: null, error: null, updating: false, log: [], updatedAt: null, needRestart: false, restarting: false };
  }

  git(...args) {
    return execFileP('git', args, { cwd: ROOT, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then((r) => r.stdout.trim());
  }

  /** Commit, date, sujet et branche en cours. */
  async version() {
    if (!this.state.available) return this.status();
    try {
      const [commit, date, subject, branch] = await Promise.all([this.git('rev-parse', '--short', 'HEAD'), this.git('log', '-1', '--format=%cI'), this.git('log', '-1', '--format=%s'), this.git('rev-parse', '--abbrev-ref', 'HEAD')]);
      Object.assign(this.state, { version: localVersion(), commit, date, subject, branch });
    } catch (e) {
      this.state.available = false;
      this.state.error = `git : ${first(e)}`;
    }
    return this.status();
  }

  /** git fetch, puis nombre de commits en retard sur origin/<branche> et leurs sujets. */
  async check() {
    if (!this.state.available) return this.status();
    try {
      if (!this.state.branch) await this.version();
      const branch = this.state.branch || 'main';
      await this.git('fetch', '--quiet', 'origin', branch);
      const behind = Number(await this.git('rev-list', '--count', `HEAD..origin/${branch}`)) || 0;
      const incoming = behind ? (await this.git('log', `HEAD..origin/${branch}`, '--format=%s', '-n', '20')).split('\n').filter(Boolean) : [];
      let remoteVersion = null;
      try { remoteVersion = JSON.parse(await this.git('show', `origin/${branch}:package.json`)).version || null; } catch { /* pas de package.json distant */ }
      Object.assign(this.state, { behind, incoming, remoteVersion, checkedAt: new Date().toISOString(), error: null });
    } catch (e) {
      this.state.error = `vérification impossible : ${first(e)}`;
      this.state.checkedAt = new Date().toISOString();
    }
    return this.status();
  }

  /** Met à jour : pull, dépendances, modules manquants, puis relance du logiciel (sinon needRestart : à la main). */
  async update({ log = null } = {}) {
    if (this.state.updating || !this.state.available) return this.status();
    this.state.updating = true;
    this.state.error = null;
    this.state.log = [];
    const say = (line) => { if (!line) return; this.state.log.push(line); log?.(line); console.log(`[update] ${line}`); };
    try {
      if (await this.git('status', '--porcelain', '--untracked-files=no')) throw new Error('modifications locales non enregistrées : mise à jour refusée (voir git status)');
      const branch = this.state.branch || 'main';
      say(`git pull --ff-only origin ${branch}`);
      say(await this.git('pull', '--ff-only', 'origin', branch));
      say('npm install');
      await run('npm install --no-audit --no-fund', { say });
      if (this.setup) { say('Modules nécessaires'); await this.setup.install({ log: say }); }
      await this.version();
      Object.assign(this.state, { behind: 0, incoming: [], remoteVersion: this.state.version, updatedAt: new Date().toISOString(), needRestart: true });
      if (!this.restart) say(`Version ${this.state.version} installée : redémarrage de la borne nécessaire.`);
      else {
        say(`Version ${this.state.version} installée : relance du logiciel.`);
        this.state.restarting = true;
        // L'admin lit encore l'état (restarting) avant que le serveur ferme ; une impression en cours se termine.
        const relaunch = () => (this.busy() ? setTimeout(relaunch, 2000) : this.restart());
        setTimeout(relaunch, 2000);
      }
    } catch (e) {
      this.state.error = first(e);
      say(`Échec : ${first(e)}`);
    } finally {
      this.state.updating = false;
    }
    return this.status();
  }

  status() {
    return { ...this.state, log: this.state.log.slice(-30), canRestart: !!this.restart };
  }
}
