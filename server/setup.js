import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, TEMPLATES_DIR, SAMPLES_DIR } from './paths.js';
import { MODELS, modelPath, downloadModel } from './models.js';
import { ffmpegPath } from './video.js';

const require = createRequire(import.meta.url);

/**
 * Installation de la borne : ce dont elle a besoin, ce qui est là, ce qui manque et comment l'obtenir.
 *   - checkInstall() : état de chaque élément (Node, dépendances npm, Electron, gphoto2, ffmpeg, modèles IA, cadres,
 *     CUPS, écran DDC/CI, NetworkManager, Chromium) avec la commande qui installe ce qui manque.
 *   - Setup : garde le dernier état et installe ce qui manque. Au démarrage, la borne installe seule ce qui ne
 *     demande pas de mot de passe (Homebrew sur Mac, téléchargement du modèle IA, cadres de démo s'il n'y en a
 *     aucun) ; `npm run setup` dans un terminal fait aussi les paquets Linux (sudo). Le tableau de bord de l'admin
 *     affiche le bilan (carte Installation) et peut relancer l'installation.
 */
const WIN = process.platform === 'win32';
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']; // PATH réduit (app lancée depuis le bureau)
export function which(name) {
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of [...(process.env.PATH || '').split(WIN ? ';' : ':'), ...(WIN ? [] : BIN_DIRS)]) {
    if (!d) continue;
    for (const ext of exts) { const p = path.join(d, name + ext); if (fs.existsSync(p)) return p; }
  }
  return null;
}
function version(bin, args) {
  if (!args) return '';
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim(); } catch { return ''; }
}
const resolvable = (mod) => { try { require.resolve(mod); return true; } catch { return false; } };

/** Gestionnaire de paquets de la machine : brew (Mac), apt, dnf ou pacman (Linux), winget (Windows), sinon null. */
export function packageManager() {
  if (process.platform === 'darwin') return which('brew') ? 'brew' : null;
  if (process.platform === 'linux') return which('apt-get') ? 'apt' : which('dnf') ? 'dnf' : which('pacman') ? 'pacman' : null;
  if (WIN) return which('winget') ? 'winget' : null;
  return null;
}
/** Ubuntu (et dérivées) : Chromium y est le paquet « chromium-browser » ; Debian : « chromium », avec « chromium-l10n »
 * sans lequel Chromium reste en anglais et propose de traduire la borne. */
function isUbuntu() {
  try { return /^(ID|ID_LIKE)=.*\bubuntu\b/m.test(fs.readFileSync('/etc/os-release', 'utf8')); } catch { return false; }
}
const debInstalled = (pkg) => version('dpkg-query', ['-W', '-f=${Status}', pkg]).endsWith('installed');

/**
 * Borne Linux dédiée (installée par `scripts/install.sh --kiosk`) : réglages système hors de portée de la mise à
 * jour depuis l'admin (sudo, session graphique : connexion automatique, GRUB, extensions et gestes GNOME…).
 * install.sh note la version appliquée ; si le dépôt en apporte une plus récente, il faut le relancer une fois.
 */
export const KIOSK_MARKER = path.join(os.homedir(), '.config', 'photobooth', 'kiosk-setup-version');
function kioskSetup(add) {
  if (!fs.existsSync(path.join(os.homedir(), '.config', 'autostart', 'photobooth.desktop'))) return; // pas une borne dédiée
  const read = (f) => { try { return Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch { return 0; } };
  const want = read(path.join(ROOT, 'scripts', 'kiosk', 'SETUP_VERSION')), have = read(KIOSK_MARKER);
  const ok = have >= want;
  add({ id: 'kiosk', label: 'Réglages système de la borne', state: ok ? 'ok' : 'missing',
    detail: ok ? `à jour (version ${have})` : 'nouveaux réglages après la mise à jour : à relancer une fois dans le Terminal (mot de passe demandé)',
    fix: ok ? null : `cd ${ROOT} && scripts/install.sh --kiosk` });
}

const PKGS = { // paquet(s) par gestionnaire
  gphoto2: { brew: 'gphoto2', apt: 'gphoto2', dnf: 'gphoto2', pacman: 'gphoto2' },
  ddc: { brew: 'm1ddc', apt: 'ddcutil', dnf: 'ddcutil', pacman: 'ddcutil' },
  cups: { apt: 'cups printer-driver-gutenprint', dnf: 'cups gutenprint-cups', pacman: 'cups gutenprint' },
  nmcli: { apt: 'network-manager', dnf: 'NetworkManager', pacman: 'networkmanager' },
  chromium: { apt: isUbuntu() ? 'chromium-browser' : 'chromium chromium-l10n', dnf: 'chromium', pacman: 'chromium' }
};
export const installCommand = (pm, pkgs) => ({ brew: `brew install ${pkgs}`, apt: `sudo apt-get install -y ${pkgs}`, dnf: `sudo dnf install -y ${pkgs}`, pacman: `sudo pacman -S --noconfirm --needed ${pkgs}`, winget: `winget install ${pkgs}` })[pm] || null;
const DEPS = ['express', 'ws', 'sharp', 'onnxruntime-node', 'qrcode', 'archiver', 'multer', 'ffmpeg-static', '@elgato-stream-deck/node', '@mediapipe/tasks-vision'];

/**
 * État de l'installation : { platform, pkg, items }. Chaque item : { id, label, state ('ok' | 'missing'), required,
 * detail, fix (commande à lancer), pkg (paquet système manquant), auto (installable par la borne sans mot de passe) }.
 */
export function checkInstall() {
  const mac = process.platform === 'darwin', linux = process.platform === 'linux';
  const pm = packageManager();
  const items = [];
  const add = (it) => items.push({ state: 'ok', required: false, detail: '', fix: null, pkg: null, auto: false, ...it });
  const tool = (id, label, bin, { required = false, missing = 'absent', args = null } = {}) => {
    const p = which(bin);
    const names = PKGS[id]?.[pm] || null;
    add({ id, label, required, state: p ? 'ok' : 'missing', detail: p ? (version(p, args) || p) : missing,
      fix: p ? null : names ? installCommand(pm, names) : (mac ? 'installer Homebrew (brew.sh), puis brew install' : WIN ? 'non disponible sous Windows' : 'paquet système à installer'),
      pkg: p ? null : names, auto: !p && !!names && pm === 'brew' });
  };

  const major = Number(process.versions.node.split('.')[0]);
  add({ id: 'node', label: 'Node.js', required: true, state: major >= 20 ? 'ok' : 'missing', detail: `v${process.versions.node}`, fix: major >= 20 ? null : 'installer Node.js 20 ou plus (nodejs.org)' });
  const missingDeps = DEPS.filter((d) => !resolvable(d));
  add({ id: 'deps', label: 'Dépendances npm', required: true, state: missingDeps.length ? 'missing' : 'ok', detail: missingDeps.length ? `manquantes : ${missingDeps.join(', ')}` : `${DEPS.length} paquets présents`, fix: missingDeps.length ? 'npm install' : null });
  const electron = fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist'));
  add({ id: 'electron', label: 'App de bureau (Electron)', state: electron ? 'ok' : 'missing', detail: electron ? 'présente' : 'absente : la borne s\'ouvre dans un navigateur', fix: electron ? null : 'npm install' });
  if (WIN) add({ id: 'gphoto2', label: 'Boîtier Canon (gphoto2)', state: 'missing', detail: 'pas de gphoto2 sous Windows : webcam du navigateur seulement' });
  else tool('gphoto2', 'Boîtier Canon (gphoto2)', 'gphoto2', { required: true, missing: 'absent : webcam seulement', args: ['--version'] });
  const ff = ffmpegPath();
  add({ id: 'ffmpeg', label: 'Vidéo des boomerangs (ffmpeg)', state: ff ? 'ok' : 'missing', detail: ff ? (ff.includes('node_modules') ? 'livré avec l\'app' : ff) : 'absent : boomerangs en GIF', fix: ff ? null : 'npm install' });
  const fast = fs.existsSync(path.join(ROOT, 'server', 'models', 'modnet.onnx'));
  add({ id: 'model-fast', label: 'Détourage rapide (MODNet)', required: true, state: fast ? 'ok' : 'missing', detail: fast ? 'livré avec l\'app' : 'server/models/modnet.onnx absent', fix: fast ? null : 'git checkout server/models/modnet.onnx' });
  const precise = modelPath('subject');
  add({ id: 'model-precise', label: MODELS.subject.name, state: precise ? 'ok' : 'missing', detail: precise ? 'installé' : `à télécharger une fois (${Math.round(MODELS.subject.size / 1048576)} Mo, internet)`, fix: precise ? null : 'npm run models', auto: !precise });
  const nTemplates = fs.existsSync(TEMPLATES_DIR) ? fs.readdirSync(TEMPLATES_DIR).filter((d) => fs.existsSync(path.join(TEMPLATES_DIR, d, 'template.json'))).length : 0;
  add({ id: 'templates', label: 'Cadres', state: nTemplates ? 'ok' : 'missing', detail: nTemplates ? `${nTemplates} cadre${nTemplates > 1 ? 's' : ''}` : 'aucun : cadres de démo à générer', fix: nTemplates ? null : 'npm run demo-assets', auto: !nTemplates });
  if (linux) tool('cups', 'Impression (CUPS)', 'lpstat', { missing: 'absent : impression impossible' });
  else if (WIN) add({ id: 'cups', label: 'Impression (CUPS)', state: 'missing', detail: 'impression CUPS non gérée sous Windows' });
  else add({ id: 'cups', label: 'Impression (CUPS)', state: which('lpstat') ? 'ok' : 'missing', detail: which('lpstat') ? 'intégré à macOS' : 'lpstat introuvable' });
  if (!WIN) tool('ddc', 'Écran (DDC/CI)', mac ? 'm1ddc' : 'ddcutil', { missing: 'absent : luminosité et volume de l\'écran non réglables', args: mac ? null : ['--version'] });
  if (linux) tool('nmcli', 'Hotspot Wi-Fi (NetworkManager)', 'nmcli', { missing: 'absent : pas de hotspot', args: ['--version'] });
  if (linux) tool('chromium', 'Chromium (lanceur kiosque)', which('chromium') ? 'chromium' : 'chromium-browser', { missing: electron ? 'absent : l\'app Electron suffit' : 'absent', args: ['--version'] });
  // Debian : Chromium présent sans sa traduction (« chromium-l10n ») reste en anglais et propose de traduire la borne
  if (linux && pm === 'apt' && !isUbuntu() && which('chromium') && !debInstalled('chromium-l10n')) {
    Object.assign(items.at(-1), { state: 'missing', detail: 'sans traduction française : Chromium propose de traduire la borne', fix: installCommand(pm, 'chromium-l10n'), pkg: 'chromium-l10n' });
  }
  if (linux) kioskSetup(add);
  if (mac && !pm) add({ id: 'brew', label: 'Homebrew', state: 'missing', detail: 'absent : la borne ne peut rien installer seule', fix: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' });
  return { platform: process.platform, pkg: pm, items };
}

/** Bilan lisible dans un terminal (npm run check). */
export function formatReport(c) {
  const lines = c.items.map((it) => `  ${it.state === 'ok' ? '✓' : it.required ? '✗' : '!'} ${it.label.padEnd(34)} ${it.detail}${it.state !== 'ok' && it.fix ? `\n      → ${it.fix}` : ''}`);
  const missing = c.items.filter((it) => it.state !== 'ok');
  lines.push('', missing.length ? `${missing.length} élément(s) manquant(s)${missing.some((i) => i.required) ? ', dont indispensable(s)' : ', facultatif(s)'}.` : 'Tout est installé.');
  return lines.join('\n');
}

/** Commande shell suivie ligne à ligne (ou laissée au terminal si interactive : sudo peut demander le mot de passe).
 * Lancée depuis le projet : la borne démarrée par l'autostart a pour dossier courant le home (npm install y échouait). */
export function run(cmd, { say, interactive = false, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' };
    if (!interactive) env.DEBIAN_FRONTEND = 'noninteractive';
    const p = WIN ? spawn('cmd', ['/c', cmd], { cwd: ROOT, env, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
      : spawn('sh', ['-c', cmd], { cwd: ROOT, env, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d) => { const s = String(d); tail = (tail + s).slice(-2000); for (const line of s.split('\n')) if (line.trim()) say(line.trim()); };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    const timer = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`${cmd} : trop long, interrompu`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`${cmd} : code ${code}${tail.trim() ? ` (${tail.trim().split('\n').pop()})` : ''}`)); });
  });
}

export class Setup {
  constructor() {
    this.last = null;
    this.installing = false;
    this.log = [];
    this.error = null;
    this.finishedAt = null;
  }

  check() {
    this.last = { at: new Date().toISOString(), ...checkInstall() };
    return this.last;
  }

  status() {
    const c = this.last || this.check();
    return { ...c, installing: this.installing, log: this.log.slice(-30), error: this.error, finishedAt: this.finishedAt };
  }

  /** Ce qui manque et que la borne peut installer : sans mot de passe par défaut, tout ce qui a une commande avec sudo. */
  pending({ sudo = false } = {}) {
    return (this.last || this.check()).items.filter((it) => it.state !== 'ok' && (it.auto || (sudo && it.pkg)));
  }

  /**
   * Installe ce qui manque : paquets système en une commande (brew sans mot de passe ; apt ou dnf seulement avec
   * sudo, dans un terminal), modèle IA (models = false pour s'en passer), cadres de démo s'il n'y en a aucun.
   * Une installation à la fois ; l'état est revérifié à la fin.
   */
  async install({ sudo = false, interactive = false, models = true, log = null } = {}) {
    if (this.installing) return this.status();
    this.installing = true;
    this.error = null;
    this.log = [];
    const say = (line) => { this.log.push(line); if (this.log.length > 400) this.log.shift(); log?.(line); if (!interactive) console.log(`[setup] ${line}`); };
    try {
      const c = this.check();
      const todo = this.pending({ sudo }).filter((it) => models || it.id !== 'model-precise');
      if (!todo.length) { say('Rien à installer.'); return this.status(); }
      const pkgs = todo.filter((it) => it.pkg).map((it) => it.pkg);
      if (pkgs.length) {
        const cmd = installCommand(c.pkg, pkgs.join(' '));
        say(cmd);
        await run(cmd, { say, interactive });
      }
      if (todo.some((it) => it.id === 'model-precise')) {
        say(`Téléchargement de ${MODELS.subject.name} (${Math.round(MODELS.subject.size / 1048576)} Mo)…`);
        await downloadModel('subject', { log: say });
      }
      if (todo.some((it) => it.id === 'templates')) {
        say('Cadres de démo et photos d\'exemple…');
        const { generateDemoAssets } = await import('../scripts/make-demo-assets.js');
        await generateDemoAssets({ templatesDir: TEMPLATES_DIR, samplesDir: SAMPLES_DIR });
      }
      this.check();
      const left = this.last.items.filter((it) => it.state !== 'ok');
      say(left.length ? `Reste à faire : ${left.map((it) => it.label).join(', ')}.` : 'Tout est installé.');
    } catch (e) {
      this.error = e.message;
      say(`Échec : ${e.message}`);
      this.check();
    } finally {
      this.installing = false;
      this.finishedAt = new Date().toISOString();
    }
    return this.status();
  }
}
