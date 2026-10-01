/**
 * Mesure des temps de montage sur cette machine (à lancer sur la borne, ex. le mini PC à son arrivée) :
 * détourage IA rapide et précis, montage d'une photo, boomerang. Données dans un dossier temporaire, la vraie
 * config n'est pas touchée.
 *   npm run bench
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-bench-'));
process.env.BOOTH_TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.BOOTH_SAMPLES_DIR = path.join(tmp, 'samples');
process.env.BOOTH_OUTPUT_DIR = path.join(tmp, 'output');

const sharp = (await import('sharp')).default;
const { generateDemoAssets } = await import('./make-demo-assets.js');
await generateDemoAssets({ templatesDir: process.env.BOOTH_TEMPLATES_DIR, samplesDir: process.env.BOOTH_SAMPLES_DIR });
const { Templates } = await import('../server/templates.js');
const { compose, composeBoomerang } = await import('../server/compositor.js');
const { subjectMatte, preciseReady, SLOW_SEC } = await import('../server/cutout-ai.js');
const { ffmpegPath } = await import('../server/video.js');

// Variantes du template de démo : photo sans détourage, détourage rapide, détourage précis
const base = JSON.parse(fs.readFileSync(path.join(process.env.BOOTH_TEMPLATES_DIR, 'classic-10x15', 'template.json'), 'utf8'));
for (const [id, cut] of [['bench-none', null], ['bench-fast', 'fast'], ['bench-precise', 'precise']]) {
  const dir = path.join(process.env.BOOTH_TEMPLATES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const layers = base.layers.map((l) => (l.type === 'photo' && cut ? { ...l, cutout: 'ai', aiPrecision: cut } : l));
  fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify({ ...base, id, name: id, layers }));
}
const templates = new Templates();

const sample = path.join(process.env.BOOTH_SAMPLES_DIR, fs.readdirSync(process.env.BOOTH_SAMPLES_DIR).find((f) => f.endsWith('.jpg')));
let n = 0;
const freshShot = () => { const f = path.join(tmp, `shot-${++n}.jpg`); fs.copyFileSync(sample, f); return f; }; // nouveau fichier : pas de masque en cache
const time = async (fn) => { const t = Date.now(); await fn(); return (Date.now() - t) / 1000; };
const avg = async (runs, fn) => { let s = 0; for (let i = 0; i < runs; i++) s += await time(fn); return s / runs; };
const fmt = (s) => (s == null ? '—' : `${s.toFixed(1).replace('.', ',')} s`);
const row = (label, sec, note = '') => { console.log(`  ${label.padEnd(44)} ${fmt(sec).padStart(8)}  ${note}`); };

console.log(`\nMachine : ${os.cpus()[0]?.model?.trim()} · ${os.cpus().length} cœurs · ${Math.round(os.totalmem() / 2 ** 30)} Go · ${os.platform()} ${os.release()}\n`);

const { data, info } = await sharp(sample).resize(1600, 1600, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
await subjectMatte(data, info.width, info.height, { model: 'fast' }); // chargement du modèle
row('Détourage rapide (MODNet, photo)', await avg(3, () => subjectMatte(data, info.width, info.height, { model: 'fast' })));
row('Détourage rapide (MODNet, image de boomerang)', await avg(3, () => subjectMatte(data, info.width, info.height, { model: 'fast', maxSide: 512 })));
let precise = null;
if (preciseReady()) {
  const load = await time(() => subjectMatte(data, info.width, info.height, { model: 'precise' }));
  precise = await avg(2, () => subjectMatte(data, info.width, info.height, { model: 'precise' }));
  row('Détourage précis (BiRefNet, photo)', precise, `(premier : ${fmt(load)}, chargement compris)`);
} else {
  row('Détourage précis (BiRefNet, photo)', null, 'modèle non installé (npm run models)');
}

const out = path.join(tmp, 'final.jpg');
row('Montage photo, sans détourage', await avg(3, () => compose(templates.get('bench-none'), [freshShot()], out)));
row('Montage photo, détourage rapide', await avg(2, () => compose(templates.get('bench-fast'), [freshShot()], out)));
if (preciseReady()) row('Montage photo, détourage précis', await avg(1, () => compose(templates.get('bench-precise'), [freshShot()], out)));

const frames = [];
for (let i = 0; i < 25; i++) { const f = path.join(tmp, `frame-${i}.jpg`); await sharp(sample).resize(960).jpeg({ quality: 85 }).toFile(f); frames.push(f); }
row(`Boomerang 25 images, sans détourage (${ffmpegPath() ? 'MP4' : 'GIF'})`, await time(() => composeBoomerang(templates.get('bench-none'), frames, path.join(tmp, 'bm-a'))));
row('Boomerang 25 images, détourage IA (rapide)', await time(() => composeBoomerang(templates.get('bench-fast'), frames, path.join(tmp, 'bm-b'))));

console.log('');
if (precise == null) console.log('Détourage précis : non mesuré (modèle absent).');
else if (precise > SLOW_SEC) console.log(`Détourage précis trop lent ici (${fmt(precise)} > ${SLOW_SEC} s) : la borne passera d'elle-même au modèle rapide pour les invités (réglage dans admin → Templates).`);
else console.log(`Détourage précis utilisable ici (${fmt(precise)} ≤ ${SLOW_SEC} s).`);
fs.rmSync(tmp, { recursive: true, force: true });
