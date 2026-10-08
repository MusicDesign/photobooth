import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { FONTS, GIF_MAX_SIDE, BOOMERANG_SPEEDS, BOOMERANG_MAX_SIDE } from './templates.js';
import { chromaKey, applyMatte, aiMatteRange } from '../public/cutout.js';
import { shotMatte, adjustContour, cleanEdges } from './cutout-ai.js';
import { ffmpegPath, encodeMp4 } from './video.js';
import { applyFilter } from '../public/filters.js';

/**
 * Rendu du template pour l'impression : chaque calque est dessiné dans l'ordre,
 * avec les mêmes règles de placement que public/template-render.js (aperçu).
 * La rotation se fait autour du centre du calque, dans le sens horaire.
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svgDoc = (w, h, inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`);
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const PLAIN_SIDE = 360; // vignette sans filtre : 4 à 8 vignettes de filtre côte à côte
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

/**
 * Photo détourée (fond vert / bleu ou IA) : PNG transparent là où le fond est retiré.
 * IA : masque de la photo entière (souvent déjà calculé pendant la séance, voir shotMatte), recadré et
 * retourné comme la photo, puis bords nettoyés.
 */
async function cutout(img, l, file, mirror, fastCutout) {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (l.cutout === 'ai') {
    const m = await (fastCutout ? shotMatte(file, 'fast', { maxSide: 512 }) : shotMatte(file, l.aiPrecision));
    let mi = sharp(m.data, { raw: { width: m.w, height: m.h, channels: 1 } });
    if (mirror) mi = mi.flop();
    let matte = await mi.resize(info.width, info.height, { fit: 'cover', position: 'centre' }).extractChannel(0).raw().toBuffer();
    matte = await adjustContour(matte, info.width, info.height, l.aiContour);
    const [lo, hi] = aiMatteRange(l);
    applyMatte(data, matte, 255, lo, hi);
    await cleanEdges(data, info.width, info.height);
  } else {
    chromaKey(data, l.cutout, l.keyTolerance);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function renderLayer(l, { template, shotFiles, mirror, fastCutout }) {
  const W = template.width;
  const H = template.height;
  switch (l.type) {
    case 'photo': {
      const file = shotFiles[l.shot];
      if (!file) throw new Error(`Photo ${l.shot + 1} manquante`);
      let img = sharp(file).rotate();
      if (mirror) img = img.flop(); // photo en miroir, comme l'aperçu : chacun reste là où il s'est vu par rapport au cadre
      img = img.resize(l.width, l.height, { fit: 'cover', position: 'centre' });
      let buf = l.cutout && l.cutout !== 'none' ? await cutout(img, l, file, mirror, fastCutout) : await img.png().toBuffer();
      buf = await roundCorners(buf, l.width, l.height, l.radius);
      buf = await withOpacity(buf, l.opacity);
      return placeLayer(buf, l, W, H);
    }
    case 'image': {
      // Version sans fond si demandée, l'originale si son fichier a disparu
      const cut = l.bgRemove && l.bgRemove !== 'none' && l.cutSrc && fs.existsSync(path.join(template.dir, l.cutSrc));
      const src = cut ? l.cutSrc : l.src;
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

/**
 * Tous les calques assemblés sur le fond (sharp prêt à écrire), puis le filtre de l'invité (public/filters.js)
 * sur tout le montage : photos, cadre, textes et logo. Le détourage se fait avant, sur les couleurs d'origine.
 * plainFile : vignette du montage sans filtre (vignettes des filtres sur « On la garde ? »).
 */
async function render(template, shotFiles, mirror, filter = 'none', { fastCutout = false, plainFile = null } = {}) {
  const layers = [];
  for (const l of template.layers) {
    if (l.visible === false) continue;
    const placed = await renderLayer(l, { template, shotFiles, mirror, fastCutout });
    if (placed) layers.push(placed);
  }
  const montage = sharp({ create: { width: template.width, height: template.height, channels: 3, background: template.background || '#ffffff' } })
    .composite(layers);
  if (plainFile) await sharp(await montage.clone().jpeg({ quality: 90 }).toBuffer()).resize(PLAIN_SIDE, PLAIN_SIDE, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(plainFile);
  if (!filter || filter === 'none') return montage;
  const { data, info } = await montage.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  applyFilter(data, filter);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).removeAlpha();
}

export async function compose(template, shotFiles, outFile, { mirror = false, filter = 'none', plainFile = null } = {}) {
  await (await render(template, shotFiles, mirror, filter, { plainFile })).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(outFile);
  return outFile;
}

/**
 * Template GIF : chaque pose montée dans le template (tous les calques photo la montrent), réduite
 * à GIF_MAX_SIDE, puis assemblée en animation qui boucle. Aller-retour : 1 2 3 2, puis on recommence.
 * posterFile : première image en JPEG (miniatures de la galerie).
 */
export async function composeGif(template, frameFiles, outFile, { mirror = false, posterFile = null, filter = 'none', plainFile = null } = {}) {
  const k = Math.min(1, GIF_MAX_SIDE / Math.max(template.width, template.height));
  const w = Math.round(template.width * k), h = Math.round(template.height * k);
  const frames = [];
  for (const [i, file] of frameFiles.entries()) {
    const full = await (await render(template, [file], mirror, filter, { plainFile: i === 0 ? plainFile : null })).jpeg({ quality: 95 }).toBuffer();
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

/**
 * Boomerang : chaque image filmée montée dans le template, puis jouée en avant et en arrière, plus vite que
 * filmée (vitesse du template). Vidéo MP4 (H.264, BOOMERANG_MAX_SIDE) si ffmpeg est là : légère et fidèle,
 * même avec le bruit du capteur. Sinon GIF de secours, réduit et allégé (sans tramage, pixels identiques
 * d'une image à l'autre réutilisés) : environ 1 Mo au lieu de 10.
 * outBase : chemin sans extension. Rend le fichier écrit (.mp4 ou .gif). posterFile : image du milieu (miniatures).
 * Détourage IA : modèle rapide, en taille réduite, quel que soit le réglage du calque. Le modèle précis prend
 * ~5 s par image, soit plus de 2 minutes pour les ~25 images filmées ; le rapide ~0,1 s, à la taille de la vidéo.
 */
export async function composeBoomerang(template, frameFiles, outBase, { mirror = false, posterFile = null, filter = 'none', plainFile = null } = {}) {
  const video = !!ffmpegPath();
  const side = video ? BOOMERANG_MAX_SIDE : 480;
  const small = scaleTemplate(template, Math.min(1, side / Math.max(template.width, template.height)));
  const frames = [];
  const mid = Math.floor(frameFiles.length / 2); // image du poster
  for (const [i, file] of frameFiles.entries()) {
    let img = await (await render(small, [file], mirror, filter, { fastCutout: true, plainFile: i === mid ? plainFile : null })).jpeg({ quality: 92 }).toBuffer();
    if (!video) img = await sharp(img).median(3).jpeg({ quality: 92 }).toBuffer(); // bruit du capteur : le GIF le compresse mal
    frames.push(img);
  }
  if (posterFile) await sharp(frames[Math.floor(frames.length / 2)]).toFile(posterFile);
  const seq = frames.length > 2 ? [...frames, ...frames.slice(1, -1).reverse()] : frames;
  const delay = BOOMERANG_SPEEDS[template.boomerang?.speed] || BOOMERANG_SPEEDS[2]; // lecture accélérée
  if (video) {
    try {
      return await encodeMp4(seq, `${outBase}.mp4`, { fps: 1000 / delay });
    } catch (e) {
      console.warn(`[video] ${e.message} : boomerang en GIF`);
    }
  }
  await sharp(seq, { join: { animated: true } }).gif({ delay: seq.map(() => delay), loop: 0, effort: 4, dither: 0, interFrameMaxError: 24, colours: 128 }).toFile(`${outBase}.gif`);
  return `${outBase}.gif`;
}

/** Template ramené à l'échelle k (montage réduit : bien plus rapide que monter en grand puis réduire). */
export function scaleTemplate(template, k) {
  return { ...template, width: Math.round(template.width * k), height: Math.round(template.height * k), layers: template.layers.map((l) => scaleLayer(l, k)) };
}

/** Calque ramené à l'échelle k. */
function scaleLayer(l, k) {
  const r = (v) => Math.round(v * k);
  const out = { ...l, x: r(l.x), y: r(l.y), width: Math.max(1, r(l.width)), height: Math.max(1, r(l.height)) };
  if (l.radius) out.radius = r(l.radius);
  if (l.fontSize) out.fontSize = Math.max(1, r(l.fontSize));
  if (l.strokeWidth) out.strokeWidth = Math.max(1, r(l.strokeWidth));
  return out;
}
