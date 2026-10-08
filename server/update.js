import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './paths.js';
import { run } from './setup.js';

const execFileP = promisify(execFile);
const first = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
/** Version X.X.X du package.json : c'est elle qu'on affiche ; le commit n'est qu'un détail. */
/** Modifications locales que la mise à jour gère seule (voir prepare) : templates suivis par git (le « default »
 * avant la 0.8.13) et package-lock.json réécrit par un npm d'une autre version. */
const TEMPLATES = 'data/templates/';
const LOCK = 'package-lock.json';
/** Chemins de `git status --porcelain -z` (les deux pour un renommage). */
function statusPaths(out) {
  const parts = out.split('\0').filter(Boolean), paths = [];
  for (let i = 0; i < parts.length; i++) {
    paths.push(parts[i].slice(3));
    if (/^[RC]/.test(parts[i])) paths.push(parts[++i]);
  }
  return paths;
}
export const localVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null; } catch { return null; } };

/**
 * Mise à jour de la borne depuis l'admin (page Installation) : version en cours (commit git), vérification de ce
 * qui attend sur origin, puis `git pull --ff-only`, `npm install`, modules manquants (setup.js) et redémarrage.
 * Seulement quand le projet est un dépôt git (clone) : une app empaquetée se met à jour par réinstallation.
 * Refusée s'il y a des modifications locales non enregistrées (hors templates et package-lock.json, voir prepare) :
 * c'est à l'humain de trancher. Dépendances en échec : retour à la version précédente.
 * Réussie, elle relance le logiciel toute seule (restart), après l'impression en cours s'il y en a une (busy).
 */
export class Updater {
  constructor({ setup = null, restart = null, busy = () => false } = {}) {
    this.setup = setup;
    this.restart = restart;
    this.busy = busy;
    this.state = { available: fs.existsSync(path.join(ROOT, '.git')), version: localVersion(), remoteVersion: null, commit: null, date: null, subject: null, branch: null, behind: null, incoming: [], checkedAt: null, error: null, updating: false, log: [], updatedAt: null, needRestart: false, restarting: false, step: null };
  }

  git(...args) {
    return this.gitRaw(...args).then((out) => out.trim());
  }
  gitRaw(...args) {
    return execFileP('git', args, { cwd: ROOT, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then((r) => r.stdout);
  }

  /** Commit, date, sujet et branche en cours. */
  async version() {
    if (!this.state.available) return this.status();
    try {
      const [commit, date, subject, branch] = await Promise.all([this.git('rev-parse', '--short', 'HEAD'), this.git('log', '-1', '--format=%cI'), this.git('log', '-1', '--format=%s'), this.git('rev-parse', '--abbrev-ref', 'HEAD')]);
      Object.assign(this.state, { version: localVersion(), commit, date, subject, branch });
    } catch (e) {
      this.state.available = false;
      // Dépôt cloné par un autre utilisateur (sudo git clone) : git refuse d'y travailler
      this.state.error = /dubious ownership/i.test(String(e?.stderr || e?.message))
        ? `git refuse le dossier ${ROOT}, qui appartient à un autre utilisateur (cloné avec sudo ?) : sudo chown -R ${os.userInfo().username} "${ROOT}"`
        : `git : ${first(e)}`;
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

  /** Met à jour : pull, dépendances, modules manquants, puis relance du logiciel (sinon needRestart : à la main).
   * Dépendances en échec : retour au code d'avant (git reset) et à ses dépendances, la mise à jour reste proposée. */
  async update({ log = null } = {}) {
    if (this.state.updating || !this.state.available) return this.status();
    this.state.updating = true;
    this.state.error = null;
    this.state.log = [];
    // Étape en cours, pour la barre de progression de l'admin (le détail reste dans log et la console)
    const step = (s) => { this.state.step = s; };
    const say = (line) => { if (!line) return; this.state.log.push(line); log?.(line); console.log(`[update] ${line}`); };
    let before = null, kept = null;
    try {
      kept = await this.prepare(say);
      const branch = this.state.branch || 'main';
      before = await this.git('rev-parse', 'HEAD');
      step('pull');
      say(`git pull --ff-only origin ${branch}`);
      say(await this.git('pull', '--ff-only', 'origin', branch));
      this.restore(kept, say);
      step('deps');
      say('npm install');
      await this.npmInstall(say);
      step('modules');
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
      let error = first(e);
      say(`Échec : ${error}`);
      // Code déjà tiré mais dépendances en échec : retour à la version d'avant, sinon la borne tournerait avec le
      // nouveau code et les anciennes dépendances (binaire Electron compris), et se dirait « à jour ».
      const now = before && await this.git('rev-parse', 'HEAD').catch(() => null);
      if (now && now !== before) {
        try {
          say(`Retour à la version précédente (git reset --hard ${before.slice(0, 7)})`);
          await this.git('reset', '--hard', before);
          this.restore(kept, say);
          say('npm install');
          await this.npmInstall(say);
          error += ' : mise à jour annulée, version précédente remise';
        } catch (e2) {
          error += ` ; retour à la version précédente incomplet (${first(e2)})`;
          say(`Échec du retour : ${first(e2)}`);
        }
        await this.version();
        await this.check(); // la mise à jour reste proposée
      }
      this.restore(kept, say); // templates de la borne remis tels qu'elle les avait
      this.state.error = error;
    } finally {
      this.state.updating = false;
      this.state.step = null;
    }
    return this.status();
  }

  /** npm install, puis package-lock.json remis tel que dans git s'il a été réécrit (autre version de npm) : sinon la
   * mise à jour suivante serait refusée (modifications locales). Les dépendances installées restent celles du lock. */
  async npmInstall(say) {
    await run('npm install --no-audit --no-fund', { say });
    if (await this.git('status', '--porcelain', '--', LOCK)) await this.git('checkout', 'HEAD', '--', LOCK);
  }

  /**
   * Avant le pull, modifications locales : package-lock.json réécrit par npm est remis tel que dans git ; les
   * templates suivis par git (le « default » avant la 0.8.13) sont mis de côté tels quels (modifiés, supprimés ou
   * intacts : le pull peut les retirer), remis en état d'origine pour que le pull passe, puis rendus par restore().
   * Toute autre modification fait refuser la mise à jour : c'est à l'humain de trancher.
   */
  async prepare(say) {
    const dirty = statusPaths(await this.gitRaw('status', '--porcelain', '-z', '--untracked-files=no'));
    const other = dirty.filter((p) => p !== LOCK && !p.startsWith(TEMPLATES));
    if (other.length) throw new Error(`modifications locales non enregistrées : mise à jour refusée (${other.slice(0, 3).join(', ')}${other.length > 3 ? '…' : ''}, voir git status)`);
    if (dirty.includes(LOCK)) { say(`${LOCK} remis tel que dans git`); await this.git('checkout', 'HEAD', '--', LOCK); }
    const kept = new Map();
    for (const p of (await this.git('ls-tree', '-r', '--name-only', 'HEAD', '--', TEMPLATES)).split('\n').filter(Boolean)) {
      const f = path.join(ROOT, p);
      kept.set(p, fs.existsSync(f) ? fs.readFileSync(f) : null);
    }
    const touched = dirty.filter((p) => kept.has(p));
    if (touched.length) {
      say(`Templates modifiés à la borne, mis de côté pendant la mise à jour : ${touched.join(', ')}`);
      await this.git('checkout', 'HEAD', '--', ...touched);
    }
    return kept;
  }

  /** Remet les templates mis de côté par prepare() tels que la borne les avait (null : supprimé à la borne). */
  restore(kept, say) {
    for (const [p, data] of kept || []) {
      const f = path.join(ROOT, p);
      try {
        if (data === null) fs.rmSync(f, { force: true });
        else if (!fs.existsSync(f) || !fs.readFileSync(f).equals(data)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); }
      } catch (e) { say(`${p} non remis : ${e.message}`); }
    }
  }

  status() {
    return { ...this.state, log: this.state.log.slice(-30), canRestart: !!this.restart };
  }
}
