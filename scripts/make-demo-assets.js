/**
 * Génère les templates de démonstration (à calques) et les photos d'exemple :
 *  - data/templates/classic-10x15/  cadre simple 10x15 paysage
 *  - data/templates/strip-3/        bande 3 photos, dupliquée sur une feuille 10x15
 *  - data/samples/sample-*.jpg      photos d'exemple pour la caméra simulée
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let TPL = process.env.BOOTH_TEMPLATES_DIR || path.join(ROOT, 'data', 'templates');
let SAMPLES = process.env.BOOTH_SAMPLES_DIR || path.join(ROOT, 'data', 'samples');

async function writeTemplate(def) {
  const dir = path.join(TPL, def.id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'template.json'), JSON.stringify(def, null, 2));
}

async function classic() {
  const W = 1800, H = 1200;
  await writeTemplate({
    id: 'classic-10x15',
    name: 'Classique 10x15',
    format: '10x15-paysage',
    width: W, height: H,
    background: '#1d3557',
    layers: [
      { id: 'photo1', type: 'photo', shot: 0, name: 'Photo 1', x: 60, y: 60, width: 1680, height: 970, radius: 26 },
      { id: 'cadre', type: 'rect', name: 'Cadre rouge', x: 50, y: 50, width: 1700, height: 990, fill: 'none', stroke: '#e63946', strokeWidth: 12, radius: 32 },
      { id: 'titre', type: 'text', name: 'Titre', text: 'PHOTO BOOTH', x: 0, y: 1050, width: W, height: 120, fontSize: 60, font: 'sans', weight: 'bold', color: '#ffffff', align: 'center' },
      { id: 'point-g', type: 'rect', name: 'Point gauche', x: 124, y: 1094, width: 32, height: 32, fill: '#e63946', radius: 16 },
      { id: 'point-d', type: 'rect', name: 'Point droit', x: 1644, y: 1094, width: 32, height: 32, fill: '#e63946', radius: 16 }
    ]
  });
}

async function strip() {
  const W = 1200, H = 1800;
  const layers = [];
  for (const [c, col] of [0, 600].entries()) {
    [40, 470, 900].forEach((y, i) => {
      layers.push({ id: `photo${i + 1}-${c}`, type: 'photo', shot: i, name: `Photo ${i + 1}`, x: col + 40, y, width: 520, height: 390, radius: 18 });
    });
    layers.push({ id: `titre-${c}`, type: 'text', name: 'Titre', text: 'PHOTO\nBOOTH', x: col, y: 1380, width: 600, height: 200, fontSize: 72, font: 'sans', weight: 'bold', color: '#1d3557', align: 'center', lineHeight: 1.15 });
    layers.push({ id: `date-${c}`, type: 'text', name: 'Date', text: '23 · 09 · 2026', x: col, y: 1620, width: 600, height: 60, fontSize: 36, font: 'sans', weight: 'normal', color: '#1d3557', align: 'center' });
    layers.push({ id: `point-${c}`, type: 'rect', name: 'Point', x: col + 290, y: 1718, width: 20, height: 20, fill: '#e63946', radius: 10 });
  }
  layers.push({ id: 'decoupe', type: 'rect', name: 'Ligne de découpe', x: 598, y: 0, width: 4, height: H, fill: '#ffffff', opacity: 0.9 });
  await writeTemplate({
    id: 'strip-3',
    name: 'Bande 3 photos',
    format: '10x15-portrait',
    width: W, height: H,
    background: '#f4a261',
    layers
  });
}

async function samples() {
  await fs.mkdir(SAMPLES, { recursive: true });
  const palette = [['#264653', '#2a9d8f'], ['#e76f51', '#f4a261'], ['#6d597a', '#b56576']];
  for (let i = 0; i < 3; i++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1280">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${palette[i][0]}"/><stop offset="1" stop-color="${palette[i][1]}"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="960" cy="560" r="280" fill="rgba(255,255,255,0.15)"/>
  <text x="960" y="710" font-family="Helvetica, Arial, sans-serif" font-size="440" font-weight="700" fill="#ffffff" text-anchor="middle">${i + 1}</text>
  <text x="960" y="1150" font-family="Helvetica, Arial, sans-serif" font-size="64" fill="#ffffff" text-anchor="middle">Photo d'exemple, caméra simulée</text>
</svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(path.join(SAMPLES, `sample-${i + 1}.jpg`));
  }
}

/** Génère templates et photos d'exemple dans les dossiers indiqués (utilisé par les tests). */
export async function generateDemoAssets({ templatesDir, samplesDir } = {}) {
  if (templatesDir) TPL = templatesDir;
  if (samplesDir) SAMPLES = samplesDir;
  await classic();
  await strip();
  await samples();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateDemoAssets();
  console.log('Templates et photos de démonstration générés.');
}
