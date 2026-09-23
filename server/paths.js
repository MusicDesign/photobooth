import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.BOOTH_DATA_DIR || path.join(ROOT, 'data');
export const OUTPUT_DIR = process.env.BOOTH_OUTPUT_DIR || path.join(ROOT, 'output');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const TEMPLATES_DIR = process.env.BOOTH_TEMPLATES_DIR || path.join(DATA_DIR, 'templates');
export const THEMES_DIR = path.join(DATA_DIR, 'themes');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const SAMPLES_DIR = process.env.BOOTH_SAMPLES_DIR || path.join(DATA_DIR, 'samples');
export const SESSIONS_DIR = path.join(OUTPUT_DIR, 'sessions');
export const PRINTS_DIR = path.join(OUTPUT_DIR, 'prints');
export const DB_FILE = process.env.BOOTH_DB_FILE || path.join(DATA_DIR, 'db.json');
export const CONFIG_FILE = process.env.BOOTH_CONFIG_FILE || path.join(DATA_DIR, 'config.json');
