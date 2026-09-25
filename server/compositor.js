import path from 'node:path';
import sharp from 'sharp';
import { FONTS, GIF_MAX_SIDE } from './templates.js';
import { chromaKey, applyMatte, aiMatteRange } from '../public/cutout.js';
import { personMatte } from './cutout-ai.js';

/**
 * Rendu du template pour l'impression : chaque calque est dessiné dans l'ordre,
 * avec les mêmes règles de placement que public/template-render.js (aperçu).
 * La rotation se fait autour du centre du calque, dans le sens horaire.
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svgDoc = (w, h, inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`);
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const rotateAttr = (l) => (l.rotation ? ` transform="rotate(${l.rotation} ${l.x + l.width / 2} ${l.y + l.height / 2})"` : '');

async function withOpacity(buf, opacity) {
  if (opacity >= 1) return buf;
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * opacity);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function roundCorners(buf, w, h, radius) {
  if (!radius) return buf;
  const r = Math.min(radius, w / 2, h / 2);
  const mask = svgDoc(w, h, `<rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/>`);
  return sharp(buf).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * Applique la rotation autour du centre puis recadre ce qui dépasse du tirage
 * (sharp refuse un calque qui sort du canevas). Retourne null si rien n'est visible.
 */
async function placeLayer(buf, l, W, H) {
  let left = l.x, top = l.y, w = l.width, h = l.height;
  if (l.rotation) {
    const r = await sharp(buf).ensureAlpha().rotate(l.rotation, { background: TRANSPARENT }).png().toBuffer({ resolveWithObject: true });
    buf = r.data;
    w = r.info.width;
    h = r.info.height;
    left = Math.round(l.x + l.width / 2 - w / 2);
    top = Math.round(l.y + l.height / 2 - h / 2);
  }
  const x0 = Math.max(0, left), y0 = Math.max(0, top);
  const x1 = Math.min(W, left + w), y1 = Math.min(H, top + h);
  if (x1 <= x0 || y1 <= y0) return null;
  if (x0 !== left || y0 !== top || x1 - x0 !== w || y1 - y0 !== h) {
    buf = await sharp(buf).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  }
  return { input: buf, left: x0, top: y0 };
}

/** Même calcul que textLayout() côté navigateur. */
export function textLayout(l) {
  const lines = String(l.text ?? '').split('\n');
  const lh = l.fontSize * (l.lineHeight || 1.2);
  const total = lines.length * lh;
  const tx = l.x + (l.align === 'center' ? l.width / 2 : l.align === 'right' ? l.width : 0);
  const y0 = l.y + l.height / 2 - total / 2 + lh / 2 + l.fontSize * 0.35;
  return { lines, lh, tx, y0 };
}

function textSvg(l) {
  const { lines, lh, tx, y0 } = textLayout(l);
  const anchor = { left: 'start', center: 'middle', right: 'end' }[l.align] || 'middle';
  const fam = (FONTS[l.font] || FONTS.sans).css;
  const texts = lines.map((line, i) =>
    `<text x="${tx}" y="${y0 + i * lh}" font-family='${esc(fam)}' font-size="${l.fontSize}" font-weight="${l.weight === 'bold' ? 700 : 400}" font-style="${l.italic ? 'italic' : 'normal'}" fill="${l.color}" text-anchor="${anchor}" xml:space="preserve">${esc(line)}</text>`
  ).join('');
  return `<g opacity="${l.opacity}"${rotateAttr(l)}>${texts}</g>`;
}

function rectSvg(l) {
  const r = Math.min(l.radius || 0, l.width / 2, l.height / 2);
  const stroke = l.stroke && l.stroke !== 'none' && l.strokeWidth > 0 ? ` stroke="${l.stroke}" stroke-width="${l.strokeWidth}"` : '';
  return `<rect x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}" rx="${r}" ry="${r}" fill="${l.fill || 'none'}"${stroke} opacity="${l.opacity}"${rotateAttr(l)}/>`;
}

/** Photo détourée (fond vert / bleu ou IA) : PNG transparent là où le fond est retiré. */
async function cutout(img, l) {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (l.cutout === 'ai') {
    const rgb = Buffer.alloc(info.width * info.height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
    const [lo, hi] = aiMatteRange(l);
    applyMatte(data, await personMatte(rgb, info.width, info.height, { precision: l.aiPrecision, contour: l.aiContour }), 255, lo, hi);
  } else {
    chromaKey(data, l.cutout, l.keyTolerance);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function renderLayer(l, { template, shotFiles, mirror }) {
  const W = template.width;
  const H = template.height;
  switch (l.type) {
    case 'photo': {
      const file = shotFiles[l.shot];
      if (!file) throw new Error(`Photo ${l.shot + 1} manquante`);
      let img = sharp(file).rotate();
      if (mirror) img = img.flop(); // photo en miroir, comme l'aperçu : chacun reste là où il s'est vu par rapport au cadre
      img = img.resize(l.width, l.height, { fit: 'cover', position: 'centre' });
      let buf = l.cutout && l.cutout !== 'none' ? await cutout(img, l) : await img.png().toBuffer();
      buf = await roundCorners(buf, l.width, l.height, l.radius);
      buf = await withOpacity(buf, l.opacity);
      return placeLayer(buf, l, W, H);
    }
    case 'image': {
      const src = l.bgRemove && l.bgRemove !== 'none' && l.cutSrc ? l.cutSrc : l.src; // version sans fond si demandée
      let buf = await sharp(path.join(template.dir, src)).resize(l.width, l.height, { fit: 'fill' }).png().toBuffer();
      buf = await roundCorners(buf, l.width, l.height, l.radius);
      buf = await withOpacity(buf, l.opacity);
      return placeLayer(buf, l, W, H);
    }
    case 'rect':
      return { input: svgDoc(W, H, rectSvg(l)), left: 0, top: 0 };
    case 'text':
      return { input: svgDoc(W, H, textSvg(l)), left: 0, top: 0 };
    default:
      throw new Error(`Calque inconnu : ${l.type}`);
  }
}

/** Tous les calques assemblés sur le fond (sharp prêt à écrire). */
async function render(template, shotFiles, mirror) {
  const layers = [];
  for (const l of template.layers) {
    if (l.visible === false) continue;
    const placed = await renderLayer(l, { template, shotFiles, mirror });
    if (placed) layers.push(placed);
  }
  return sharp({ create: { width: template.width, height: template.height, channels: 3, background: template.background || '#ffffff' } })
    .composite(layers);
}

export async function compose(template, shotFiles, outFile, { mirror = false } = {}) {
  await (await render(template, shotFiles, mirror)).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(outFile);
  return outFile;
}

/**
 * Template GIF : chaque pose montée dans le template (tous les calques photo la montrent), réduite
 * à GIF_MAX_SIDE, puis assemblée en animation qui boucle. Aller-retour : 1 2 3 4 3 2, puis on recommence.
 * posterFile : première image en JPEG (miniatures de la galerie).
 */
export async function composeGif(template, frameFiles, outFile, { mirror = false, posterFile = null } = {}) {
  const k = Math.min(1, GIF_MAX_SIDE / Math.max(template.width, template.height));
  const w = Math.round(template.width * k), h = Math.round(template.height * k);
  const frames = [];
  for (const file of frameFiles) {
    const full = await (await render(template, [file], mirror)).jpeg({ quality: 95 }).toBuffer();
    frames.push(await sharp(full).resize(w, h).jpeg({ quality: 95 }).toBuffer());
  }
  if (posterFile) await sharp(frames[0]).toFile(posterFile);
  const { frameMs, boomerang } = template.gif;
  const seq = boomerang && frames.length > 2 ? [...frames, ...frames.slice(1, -1).reverse()] : frames;
  await sharp(seq, { join: { animated: true } }).gif({ delay: seq.map(() => frameMs), loop: 0, effort: 7, dither: 0.8 }).toFile(outFile);
  return outFile;
}

export async function thumbnail(inFile, outFile, size = 900) {
  await sharp(inFile).resize(size, size, { fit: 'inside' }).jpeg({ quality: 82 }).toFile(outFile);
  return outFile;
}

export async function normalizeShot(inputBuffer, outFile) {
  await sharp(inputBuffer).rotate().jpeg({ quality: 94 }).toFile(outFile);
  return outFile;
}
