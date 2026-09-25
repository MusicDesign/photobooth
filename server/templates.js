import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { TEMPLATES_DIR } from './paths.js';
import { HttpError, readJson } from './util.js';
import { CUTOUT_MODES, DEFAULT_TOLERANCE, AI_DEFAULTS, aiMatteRange, applyMatte, removeColor } from '../public/cutout.js';
import { personMatte } from './cutout-ai.js';

/**
 * Un template = un dossier data/templates/<id>/ avec template.json et un
 * sous-dossier assets/ pour les images (logos, PNG importés).
 *
 * Le template est une pile de CALQUES rendue de bas en haut, côté navigateur
 * (aperçu live, éditeur) et côté serveur (impression) avec les mêmes règles :
 *   photo : emplacement d'une photo prise (shot = numéro, 0 = première)
 *   image : fichier du dossier assets/ (logo, cadre PNG…)
 *   text  : texte, police, taille, couleur, alignement
 *   rect  : rectangle plein et/ou bordure, coins arrondis
 * Chaque calque a x, y, width, height (pixels du template), opacity, visible.
 *
 * kind = 'gif' : GIF animé, uniquement en numérique (jamais imprimé). Plusieurs poses successives, chacune
 * posée dans les calques photo (tous affichent la pose en cours), puis assemblées en animation (voir gif).
 */
export const FORMATS = {
  '10x15-paysage': { name: '10x15 cm paysage', width: 1800, height: 1200 },
  '10x15-portrait': { name: '10x15 cm portrait (ou 2 bandes 5x15)', width: 1200, height: 1800 },
  '13x18-paysage': { name: '13x18 cm paysage', width: 2100, height: 1500 },
  '15x20-paysage': { name: '15x20 cm paysage', width: 2400, height: 1800 },
  '10x10-carre': { name: '10x10 cm carré', width: 1200, height: 1200 }
};
export const DEFAULT_FORMAT = '10x15-paysage';

/** Polices : clé stable → pile CSS. Le même tableau existe dans public/template-render.js. */
export const FONTS = {
  sans: { name: 'Sans (Helvetica / Arial)', css: 'Helvetica, Arial, "Liberation Sans", sans-serif' },
  serif: { name: 'Serif (Georgia / Times)', css: 'Georgia, "Times New Roman", "Liberation Serif", serif' },
  mono: { name: 'Mono (Courier)', css: '"Courier New", "Liberation Mono", monospace' },
  script: { name: 'Script (manuscrite)', css: '"Snell Roundhand", "Brush Script MT", "URW Chancery L", cursive' },
  rounded: { name: 'Rounded', css: '"Arial Rounded MT Bold", "Nunito", "Varela Round", sans-serif' }
};
export const LAYER_TYPES = ['photo', 'image', 'text', 'rect'];

/** Réglages d'un template GIF : nombre de poses, durée d'une image, aller-retour, décompte entre deux poses. */
export const GIF_DEFAULTS = { frames: 4, frameMs: 500, boomerang: false, poseSec: 2 };
export const GIF_MAX_SIDE = 800; // taille du GIF (plus grand côté) : léger à ouvrir sur un téléphone

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SRC = /^(assets\/)?[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;
const ASSET_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function slugify(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'template';
}

const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round = (v) => Math.round(v);
const color = (v, fallback) => (HEX.test(v || '') ? String(v).toLowerCase() : fallback);
const colorOrNone = (v, fallback) => (v === 'none' ? 'none' : color(v, fallback));
/** Angle en degrés ramené dans ]-180, 180], au demi-degré. */
const normalizeAngle = (deg) => Math.round(((((deg + 180) % 360) + 360) % 360 - 180) * 2) / 2;

export function normalizeLayer(raw, i) {
  if (!raw || !LAYER_TYPES.includes(raw.type)) throw new HttpError(400, 'LAYER_TYPE', `Calque ${i + 1} : type inconnu`);
  const base = {
    id: typeof raw.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(raw.id) ? raw.id : `l-${Date.now().toString(36)}-${i}`,
    type: raw.type,
    name: String(raw.name || '').slice(0, 40),
    x: round(num(raw.x)),
    y: round(num(raw.y)),
    width: round(clamp(num(raw.width, 100), 1, 20000)),
    height: round(clamp(num(raw.height, 100), 1, 20000)),
    opacity: clamp(num(raw.opacity, 1), 0, 1),
    rotation: normalizeAngle(num(raw.rotation, 0)),
    visible: raw.visible !== false
  };
  const radius = round(clamp(num(raw.radius, 0), 0, 5000));
  switch (raw.type) {
    case 'photo':
      return {
        ...base, shot: clamp(round(num(raw.shot, 0)), 0, 19), radius,
        cutout: CUTOUT_MODES.includes(raw.cutout) ? raw.cutout : 'none', // détourage, voir public/cutout.js
        keyTolerance: clamp(round(num(raw.keyTolerance, DEFAULT_TOLERANCE)), 0, 100),
        // Curseurs du détourage IA (voir public/cutout.js)
        aiThreshold: clamp(round(num(raw.aiThreshold, AI_DEFAULTS.aiThreshold)), 0, 100),
        aiSoftness: clamp(round(num(raw.aiSoftness, AI_DEFAULTS.aiSoftness)), 0, 100),
        aiContour: clamp(round(num(raw.aiContour, AI_DEFAULTS.aiContour)), -10, 10),
        aiPrecision: raw.aiPrecision === 'fine' ? 'fine' : 'standard'
      };
    case 'image':
      if (!SRC.test(raw.src || '')) throw new HttpError(400, 'LAYER_SRC', `Calque ${i + 1} : fichier image manquant`);
      return {
        ...base, src: raw.src, radius,
        // Retirer le fond d'une image importée : version transparente calculée une fois (cutSrc), voir cutoutAsset
        bgRemove: ['color', 'ai'].includes(raw.bgRemove) ? raw.bgRemove : 'none',
        bgColor: /^#[0-9a-f]{6}$/i.test(raw.bgColor || '') ? raw.bgColor : '#ffffff',
        bgTolerance: clamp(round(num(raw.bgTolerance, 30)), 0, 100),
        bgContiguous: raw.bgContiguous !== false,
        aiThreshold: clamp(round(num(raw.aiThreshold, AI_DEFAULTS.aiThreshold)), 0, 100),
        aiSoftness: clamp(round(num(raw.aiSoftness, AI_DEFAULTS.aiSoftness)), 0, 100),
        aiContour: clamp(round(num(raw.aiContour, AI_DEFAULTS.aiContour)), -10, 10),
        aiPrecision: raw.aiPrecision === 'fine' ? 'fine' : 'standard',
        cutSrc: SRC.test(raw.cutSrc || '') ? raw.cutSrc : null
      };
    case 'text':
      return {
        ...base,
        text: String(raw.text ?? '').slice(0, 500),
        fontSize: round(clamp(num(raw.fontSize, 48), 6, 2000)),
        font: FONTS[raw.font] ? raw.font : 'sans',
        weight: raw.weight === 'bold' ? 'bold' : 'normal',
        italic: !!raw.italic,
        color: color(raw.color, '#000000'),
        align: ['left', 'center', 'right'].includes(raw.align) ? raw.align : 'center',
        lineHeight: clamp(num(raw.lineHeight, 1.2), 0.7, 3)
      };
    case 'rect':
      return {
        ...base,
        fill: colorOrNone(raw.fill, '#000000'),
        radius,
        stroke: colorOrNone(raw.stroke, 'none'),
        strokeWidth: round(clamp(num(raw.strokeWidth, 0), 0, 1000))
      };
    default:
      throw new HttpError(400, 'LAYER_TYPE', 'type inconnu');
  }
}

export function normalizeLayers(rawLayers) {
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) throw new HttpError(400, 'LAYERS_EMPTY', 'Le template doit contenir au moins un calque');
  if (rawLayers.length > 80) throw new HttpError(400, 'LAYERS_TOO_MANY', '80 calques maximum');
  const layers = rawLayers.map(normalizeLayer);
  const shots = [...new Set(layers.filter((l) => l.type === 'photo').map((l) => l.shot))].sort((a, b) => a - b);
  if (!shots.length) throw new HttpError(400, 'NO_PHOTO_LAYER', 'Ajoutez au moins un calque Photo');
  shots.forEach((s, i) => {
    if (s !== i) throw new HttpError(400, 'SHOTS_GAP', `Les photos doivent se suivre : la photo ${i + 1} n'est utilisée par aucun calque`);
  });
  return layers;
}

/** Ancien format (slots + overlay.png) converti en calques. */
function legacyLayers(raw) {
  const layers = (raw.slots || []).map((s) => ({
    type: 'photo', shot: s.shot ?? 0, name: `Photo ${(s.shot ?? 0) + 1}`, x: s.x, y: s.y, width: s.width, height: s.height
  }));
  if (raw.overlay) layers.push({ type: 'image', src: raw.overlay, name: 'Overlay', x: 0, y: 0, width: raw.width, height: raw.height });
  return layers;
}

function normalizeGif(g = {}) {
  return {
    frames: clamp(round(num(g.frames, GIF_DEFAULTS.frames)), 2, 10),
    frameMs: clamp(round(num(g.frameMs, GIF_DEFAULTS.frameMs)), 100, 2000),
    boomerang: !!g.boomerang,
    poseSec: clamp(round(num(g.poseSec, GIF_DEFAULTS.poseSec)), 1, 10)
  };
}

function normalize(raw, dir) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'TEMPLATE_INVALID', 'template.json illisible');
  if (!/^[a-z0-9][a-z0-9-_]{0,60}$/i.test(raw.id || '')) throw new HttpError(400, 'TEMPLATE_ID', 'Identifiant invalide');
  const format = FORMATS[raw.format] ? raw.format : null;
  const width = round(num(raw.width, format ? FORMATS[format].width : 0));
  const height = round(num(raw.height, format ? FORMATS[format].height : 0));
  if (width < 100 || height < 100 || width > 8000 || height > 8000) throw new HttpError(400, 'TEMPLATE_SIZE', 'Dimensions invalides');
  const kind = raw.kind === 'gif' ? 'gif' : 'photo';
  let rawLayers = raw.layers?.length ? raw.layers : legacyLayers({ ...raw, width, height });
  if (kind === 'gif') rawLayers = rawLayers.map((l) => (l?.type === 'photo' ? { ...l, shot: 0 } : l)); // tous montrent la pose en cours
  const layers = normalizeLayers(rawLayers);
  const photoLayers = layers.filter((l) => l.type === 'photo');
  const gif = kind === 'gif' ? normalizeGif(raw.gif) : null;
  return {
    id: raw.id,
    name: String(raw.name || raw.id).slice(0, 80),
    kind,
    gif,
    format,
    width,
    height,
    background: color(raw.background, '#ffffff'),
    layers,
    shots: gif ? gif.frames : Math.max(...photoLayers.map((l) => l.shot)) + 1,
    slots: photoLayers.map((l) => ({ shot: l.shot, x: l.x, y: l.y, width: l.width, height: l.height })),
    dir
  };
}

export class Templates {
  constructor(dir = TEMPLATES_DIR) {
    this.dir = dir;
    this.items = new Map();
    this.reload();
  }

  reload() {
    this.items.clear();
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir).sort()) {
      const dir = path.join(this.dir, name);
      const file = path.join(dir, 'template.json');
      if (!fs.existsSync(file)) continue;
      const raw = readJson(file);
      if (raw && !raw.id) raw.id = name;
      try {
        this.items.set(raw.id, normalize(raw, dir));
      } catch (e) {
        console.warn(`[templates] ${name} ignoré : ${e.message}`);
      }
    }
    return this.all();
  }

  all() {
    return [...this.items.values()];
  }

  get(id) {
    const t = this.items.get(id);
    if (!t) throw new HttpError(404, 'TEMPLATE_NOT_FOUND', `Template inconnu : ${id}`);
    return t;
  }

  /** Templates activés, dans l'ordre de la config. Les GIF seulement si l'option GIF est active. */
  enabled(config) {
    const ids = config.templates.enabled?.length ? config.templates.enabled : [...this.items.keys()];
    return ids.filter((id) => this.items.has(id) && (this.items.get(id).kind !== 'gif' || config.templates.gifEnabled))
      .map((id) => this.toPublic(this.items.get(id)));
  }

  toPublic(t) {
    const { dir, ...pub } = t;
    return { ...pub, layers: t.layers.map((l) => (l.type === 'image' ? { ...l, url: `/templates/${t.id}/${l.src}` } : l)) };
  }

  uniqueId(name) {
    const base = slugify(name);
    let id = base;
    let n = 2;
    while (this.items.has(id) || fs.existsSync(path.join(this.dir, id))) id = `${base}-${n++}`;
    return id;
  }

  write(def) {
    const { id, name, kind, gif, format, width, height, background, layers } = def;
    fs.mkdirSync(def.dir, { recursive: true });
    const out = { id, name, ...(kind === 'gif' ? { kind, gif } : {}), format, width, height, background, layers };
    fs.writeFileSync(path.join(def.dir, 'template.json'), JSON.stringify(out, null, 2));
  }

  /** Nouveau template : un nom suffit. L'id est déduit du nom, la taille du format. */
  create({ name, kind = 'photo', format = DEFAULT_FORMAT, background, overlayBuffer = null }) {
    if (!name || !String(name).trim()) throw new HttpError(400, 'NAME_REQUIRED', 'Donnez un nom au template');
    const f = FORMATS[format];
    if (!f) throw new HttpError(400, 'FORMAT', 'Format inconnu');
    const id = this.uniqueId(name);
    const dir = path.join(this.dir, id);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    const m = Math.round(Math.min(f.width, f.height) * 0.05);
    const layers = [{ type: 'photo', shot: 0, name: 'Photo 1', x: m, y: m, width: f.width - 2 * m, height: f.height - 2 * m, radius: 0 }];
    if (overlayBuffer) {
      fs.writeFileSync(path.join(dir, 'assets', 'overlay.png'), overlayBuffer);
      layers[0] = { ...layers[0], x: 0, y: 0, width: f.width, height: f.height };
      layers.push({ type: 'image', src: 'assets/overlay.png', name: 'PNG importé', x: 0, y: 0, width: f.width, height: f.height });
    }
    const def = normalize({ id, name: String(name).trim(), kind, gif: GIF_DEFAULTS, format, width: f.width, height: f.height, background: background || '#ffffff', layers }, dir);
    this.write(def);
    this.reload();
    return this.toPublic(this.get(id));
  }

  /** Enregistrement depuis l'éditeur : nom, fond, calques. */
  update(id, patch = {}) {
    const cur = this.get(id);
    const def = normalize({
      id,
      name: patch.name ?? cur.name,
      kind: cur.kind,
      gif: { ...cur.gif, ...patch.gif },
      format: cur.format,
      width: cur.width,
      height: cur.height,
      background: patch.background ?? cur.background,
      layers: patch.layers ?? cur.layers
    }, cur.dir);
    for (const l of def.layers) {
      if (l.type === 'image' && !fs.existsSync(path.join(cur.dir, l.src))) throw new HttpError(400, 'ASSET_MISSING', `Image introuvable : ${l.src}`);
    }
    this.write(def);
    this.reload();
    return this.toPublic(this.get(id));
  }

  async addAsset(id, file) {
    const t = this.get(id);
    const ext = ASSET_EXT[file?.mimetype];
    if (!ext) throw new HttpError(400, 'FILE_TYPE', 'Image attendue en PNG, JPEG ou WebP');
    const name = `asset-${Date.now()}${ext}`;
    fs.mkdirSync(path.join(t.dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'assets', name), file.buffer);
    const meta = await sharp(file.buffer).metadata();
    return { src: `assets/${name}`, url: `/templates/${id}/assets/${name}`, width: meta.width, height: meta.height };
  }

  /**
   * Version sans fond d'une image du template (fond uni ou personne par IA), écrite à côté de l'originale :
   * assets/<nom>-sansfond-<réglages>.png. Calculée une fois, puis utilisée par l'aperçu et la photo finale.
   */
  async cutoutAsset(id, src, o = {}) {
    const t = this.get(id);
    if (!SRC.test(src || '')) throw new HttpError(400, 'LAYER_SRC', 'Image inconnue');
    const file = path.join(t.dir, src);
    if (!fs.existsSync(file)) throw new HttpError(404, 'ASSET_MISSING', 'Image introuvable dans le template');
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (o.mode === 'ai') {
      const rgb = Buffer.alloc(info.width * info.height * 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
      const [lo, hi] = aiMatteRange(o);
      applyMatte(data, await personMatte(rgb, info.width, info.height, { precision: o.aiPrecision, contour: o.aiContour }), 255, lo, hi);
    } else {
      removeColor(data, info.width, info.height, { color: o.bgColor, tolerance: o.bgTolerance, contiguous: o.bgContiguous !== false });
    }
    const key = crypto.createHash('sha1').update(JSON.stringify([src, o.mode, o.bgColor, o.bgTolerance, o.bgContiguous, o.aiThreshold, o.aiSoftness, o.aiContour, o.aiPrecision])).digest('hex').slice(0, 8);
    const base = path.basename(src).replace(/\.[a-z]+$/i, '').replace(/-sansfond-[0-9a-f]{8}$/, '');
    const cutSrc = `assets/${base}-sansfond-${key}.png`;
    fs.mkdirSync(path.join(t.dir, 'assets'), { recursive: true });
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(path.join(t.dir, cutSrc));
    return { cutSrc, url: `/templates/${id}/${cutSrc}` };
  }

  /** Couleur des coins d'une image (médiane) : proposée comme couleur de fond à retirer. */
  async cornerColor(id, src) {
    const t = this.get(id);
    if (!SRC.test(src || '')) throw new HttpError(400, 'LAYER_SRC', 'Image inconnue');
    const { data, info } = await sharp(path.join(t.dir, src)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => [0, 1, 2].map((c) => data[(y * info.width + x) * 3 + c]);
    const pts = [at(0, 0), at(info.width - 1, 0), at(0, info.height - 1), at(info.width - 1, info.height - 1)];
    const med = [0, 1, 2].map((c) => pts.map((p) => p[c]).sort((a, b) => a - b)[1]);
    return `#${med.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  remove(id) {
    const t = this.get(id);
    fs.rmSync(t.dir, { recursive: true, force: true });
    this.reload();
  }
}
