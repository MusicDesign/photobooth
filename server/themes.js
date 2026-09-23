import fs from 'node:fs';
import path from 'node:path';
import { THEMES_DIR } from './paths.js';
import { readJson } from './util.js';

export const DEFAULT_LOGO = '/assets/logo-default.svg';

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
  backgroundImage: ''
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
    for (const f of fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort()) {
      const t = readJson(path.join(this.dir, f));
      if (t?.id && t.colors) this.items.set(t.id, { ...FALLBACK, ...t, colors: { ...FALLBACK.colors, ...t.colors } });
    }
    if (this.items.size === 0) this.items.set(FALLBACK.id, FALLBACK);
  }

  all() {
    return [...this.items.values()];
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
    const logo = config.booth?.logo || config.theme?.custom?.logo || theme.logo || DEFAULT_LOGO;
    const backgroundImage = config.booth?.backgroundImage || config.theme?.custom?.backgroundImage || theme.backgroundImage || '';
    return { ...theme, logo, backgroundImage };
  }
}
