import fs from 'node:fs';
import path from 'node:path';
import { THEMES_DIR, PUBLIC_DIR } from './paths.js';
import { readJson } from './util.js';

export const DEFAULT_LOGO = '/assets/cheesy_logo.svg';

/** Couleur « #rrggbb » normalisée en minuscules, ou null. */
const hex6 = (v) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '')); return m ? `#${m[1].toLowerCase()}` : null; };

/**
 * Logo Cheeesy par défaut aux couleurs du thème : l'aplat prend la couleur d'accent (primary), les lettres la
 * couleur « texte des boutons » (onPrimary), prévue pour être lisible sur l'accent. L'URL porte les couleurs
 * (route /logo.svg dans app.js) : chaque variante se met en cache, et un changement de thème en charge une autre.
 */
export const defaultLogoUrl = (colors = {}) => `/logo.svg?c=${(hex6(colors.primary) || FALLBACK.colors.primary).slice(1)}&t=${(hex6(colors.onPrimary) || FALLBACK.colors.onPrimary).slice(1)}`;

let logoTemplate = null;
/** Le SVG du logo par défaut, recoloré. Sans classes ni <style> : inséré tel quel dans la page de la borne, rien ne fuit. */
export function defaultLogoSvg(colors = {}) {
  if (!logoTemplate) {
    logoTemplate = fs.readFileSync(path.join(PUBLIC_DIR, DEFAULT_LOGO), 'utf8')
      .replace(/<defs>[\s\S]*?<\/defs>\s*/, '')
      .replace(/class="cls-1"/g, 'fill="__FILL__"')   // aplat jaune d'origine
      .replace(/class="cls-2"/g, 'fill="__TEXT__"');  // lettres blanches d'origine
  }
  return logoTemplate.replace(/__FILL__/g, hex6(colors.primary) || FALLBACK.colors.primary).replace(/__TEXT__/g, hex6(colors.onPrimary) || FALLBACK.colors.onPrimary);
}

/**
 * Motifs de fond (public/assets/backgrounds, 1920×1080, formes sans couleur ou traits en currentColor) : recolorés à
 * une couleur du thème, en transparence, par la route /pattern.svg (app.js). Le nom du fichier est l'identifiant du motif.
 */
const PATTERNS_DIR = path.join(PUBLIC_DIR, 'assets', 'backgrounds');
export const PATTERNS = {
  'diagonal-stripes': 'Rayures diagonales',
  'horizontal-stripes': 'Rayures horizontales',
  'vertical-stripes': 'Rayures verticales',
  checkerboard: 'Damier',
  spiral: 'Spirale',
  waves: 'Vagues',
  snowflakes: 'Flocons',
  pumpkins: 'Citrouilles',
  ripples: 'Ondes'
};
export const PATTERN_OPACITY = 0.08; // assez pour se voir, sans gêner la lecture des textes posés dessus

const patternSources = new Map();
/** Le SVG d'un motif, d'une couleur et d'une opacité données (null : motif inconnu). */
export function patternSvg(id, color, opacity = PATTERN_OPACITY) {
  if (!Object.hasOwn(PATTERNS, id)) return null;
  if (!patternSources.has(id)) {
    const src = fs.readFileSync(path.join(PATTERNS_DIR, `${id}.svg`), 'utf8');
    const viewBox = /viewBox="([^"]+)"/.exec(src)?.[1] || '0 0 1920 1080';
    const body = src.replace(/<\?xml[^>]*>\s*/, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    patternSources.set(id, { viewBox, body });
  }
  const { viewBox, body } = patternSources.get(id);
  const o = Math.min(1, Math.max(0, Number(opacity) || 0));
  const c = hex6(color) || '#000000';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid slice"><g fill="${c}" color="${c}" opacity="${o}">${body}</g></svg>`;
}

/**
 * Image de fond d'un motif de thème. pattern : identifiant, ou { id, color, opacity } ; color est une couleur du
 * thème (primary, secondary, text…) ou un « #rrggbb » ; par défaut la couleur des titres.
 */
export function patternUrl(pattern, colors = {}) {
  const p = typeof pattern === 'string' ? { id: pattern } : pattern || {};
  if (!Object.hasOwn(PATTERNS, p.id)) return '';
  const color = hex6(colors[p.color || 'secondary']) || hex6(p.color) || FALLBACK.colors.secondary;
  const o = Math.round((p.opacity ?? PATTERN_OPACITY) * 100);
  return `/pattern.svg?p=${p.id}&c=${color.slice(1)}&o=${o}`;
}

const FALLBACK = {
  id: 'default-light',
  name: 'Clair',
  colors: {
    primary: '#e63946',
    secondary: '#1d3557',
    background: '#f8f9fa',
    surface: '#ffffff',
    text: '#1a1a1a',
    onPrimary: '#ffffff'
  },
  font: 'system',
  logo: '',
  backgroundImage: '',
  pattern: ''
};

export class Themes {
  constructor(dir = THEMES_DIR) {
    this.dir = dir;
    this.items = new Map();
    this.reload();
  }

  reload() {
    this.items.clear();
    fs.mkdirSync(this.dir, { recursive: true });
    // Dans l'ordre du champ « order » de chaque fichier (sans ordre : après, par nom) : l'ordre des cartes de l'admin
    const list = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort()
      .map((f) => readJson(path.join(this.dir, f)))
      .filter((t) => t?.id && t.colors)
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name), 'fr'));
    for (const t of list) this.items.set(t.id, { ...FALLBACK, ...t, colors: { ...FALLBACK.colors, ...t.colors } });
    if (this.items.size === 0) this.items.set(FALLBACK.id, FALLBACK);
  }

  /** Thèmes livrés ; backgroundImage : l'image du thème, ou son motif aux couleurs du thème. */
  all() {
    return [...this.items.values()].map((t) => ({ ...t, backgroundImage: t.backgroundImage || patternUrl(t.pattern, t.colors) }));
  }

  /** Thème actif : un thème livré, ou le thème personnalisé de la config. */
  resolve(config) {
    const active = config.theme?.active || FALLBACK.id;
    let theme;
    if (active === 'custom') {
      const c = config.theme.custom || {};
      theme = { ...FALLBACK, ...c, id: 'custom', colors: { ...FALLBACK.colors, ...(c.colors || {}) } };
    } else {
      theme = this.items.get(active) || this.all()[0];
    }
    // Logo et image de fond sont réglés pour la borne, indépendamment du thème choisi.
    // Sans logo importé : le logo Cheeesy aux couleurs du thème (defaultLogo = true, l'admin le sait).
    const ownLogo = config.booth?.logo || config.theme?.custom?.logo || theme.logo || '';
    const logo = ownLogo || defaultLogoUrl(theme.colors);
    const backgroundImage = config.booth?.backgroundImage || config.theme?.custom?.backgroundImage || theme.backgroundImage || patternUrl(theme.pattern, theme.colors);
    return { ...theme, logo, defaultLogo: !ownLogo, backgroundImage };
  }
}
