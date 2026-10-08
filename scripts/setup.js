/**
 * Installe tout ce qu'il faut à la borne, puis vérifie : dépendances npm, outils système (gphoto2, m1ddc ou
 * ddcutil, CUPS, NetworkManager, Chromium), modèle IA de détourage précis, cadres de démo s'il n'y en a aucun.
 *   npm run setup                  installe ce qui manque (demande le mot de passe sudo sur Linux), puis affiche l'état
 *   npm run check                  affiche seulement l'état
 *   npm run setup -- --no-models   sans le téléchargement du modèle IA (114 Mo)
 * Le même bilan est dans l'admin → Tableau de bord → Installation ; au démarrage, la borne installe seule ce qui
 * ne demande pas de mot de passe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) { console.error(`Node.js ${process.versions.node} : il faut la version 22.12 ou plus (nodejs.org).`); process.exit(1); }

// Dépendances npm d'abord : sans elles, rien d'autre ne se charge
const depsOk = ['express', 'sharp', 'onnxruntime-node'].every((d) => fs.existsSync(path.join(root, 'node_modules', d)));
if (!depsOk && !args.has('--check')) {
  console.log('npm install…');
  const r = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status || 1);
}
const { Setup, formatReport } = await import('../server/setup.js');
const setup = new Setup();
if (!args.has('--check')) {
  const todo = setup.pending({ sudo: true }).filter((it) => args.has('--no-models') ? it.id !== 'model-precise' : true);
  if (todo.length) {
    console.log(`\nÀ installer : ${todo.map((it) => it.label).join(', ')}\n`);
    await setup.install({ sudo: true, interactive: true, models: !args.has('--no-models'), log: (l) => console.log(`  ${l}`) });
  }
}
const c = setup.check();
console.log(`\nInstallation de la borne (${c.platform}${c.pkg ? `, ${c.pkg}` : ''})\n`);
console.log(formatReport(c));
process.exit(c.items.some((it) => it.state !== 'ok' && it.required) ? 1 : 0);
