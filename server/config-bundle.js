import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import AdmZip from 'adm-zip';
import { UPLOADS_DIR } from './paths.js';
import { validateConfigPatch } from './config-validate.js';
import { clone, HttpError, isPlainObject } from './util.js';

/**
 * Export et import de la configuration de la borne : un fichier .zip avec
 *   manifest.json   nom de la borne, version, date, contenu, présence des secrets
 *   settings.json   config.json (sans secrets par défaut)
 *   templates/<id>/ cadres photo (template.json, images)
 *   uploads/        logo et image de fond référencés par les réglages
 * L'import se fait en deux temps : lecture du fichier (readBundle, describe), puis application de ce que l'admin a coché
 * (applyBundle), après une sauvegarde complète de l'état actuel (backupBeforeImport).
 */
const FORMAT = 1;
const MAX_ENTRIES = 5000;
const MAX_TOTAL = 800 * 1024 * 1024;
const BACKUP_PREFIX = 'avant-import-';

export const SECTION_LABELS = {
  booth: 'Borne : nom, affichage, Stream Deck',
  camera: 'Appareil photo',
  printer: 'Impression',
  limits: 'Limites et code opérateur',
  templates: 'Templates : ordre, formats, options',
  theme: 'Thème actif et thème personnalisé (logo, couleurs)',
  texts: 'Textes des écrans',
  gallery: 'Galerie de la borne',
  share: 'Partage, QR codes, Wi-Fi',
  lights: 'Lumières',
  screen: 'Écran de la borne',
  usb: 'Clé USB',
  admin: 'Accès à l\'admin'
};

/** Secrets : [section, ...chemin]. Un chemin vers un objet entier (pont Hue) est traité comme un seul secret. */
const SECRET_PATHS = [['limits', 'operatorPin'], ['admin', 'pin'], ['share', 'wifi', 'password'], ['lights', 'hue']];

const getPath = (o, p) => p.reduce((x, k) => x?.[k], o);
function setPath(o, p, v) {
  const parent = p.slice(0, -1).reduce((x, k) => (x[k] = x[k] && typeof x[k] === 'object' ? x[k] : {}), o);
  if (v === undefined) delete parent[p.at(-1)]; else parent[p.at(-1)] = clone(v);
}

/** Config sans les codes et mots de passe. */
export function stripSecrets(cfg) {
  const out = clone(cfg);
  for (const p of SECRET_PATHS) if (getPath(out, p) !== undefined) setPath(out, p, undefined);
  return out;
}

/** Remet les secrets actuels de la borne dans une section importée. */
function keepCurrentSecrets(key, section, current) {
  for (const [k, ...p] of SECRET_PATHS) {
    if (k !== key) continue;
    const cur = getPath(current?.[key], p);
    setPath(section, p, cur);
  }
}

const uploadRefs = (cfg) => {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string' && v.startsWith('/uploads/')) out.add(path.basename(v));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(cfg);
  return [...out];
};

const templateDirs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'template.json'))) : []);

/**
 * Archive de la configuration, à brancher sur une réponse ou un fichier.
 * parts : { settings, templates } (booléens) ; secrets : codes et mots de passe inclus ou non.
 */
export function buildBundle({ config, templates, parts = {}, secrets = false, boothName = '', appVersion = '', extra = {} }) {
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const settings = parts.settings === false ? null : (secrets ? clone(config.data) : stripSecrets(config.data));
  zip.append(JSON.stringify({
    app: 'photobooth-config', format: FORMAT, appVersion, boothName, exportedAt: new Date().toISOString(),
    secrets: !!(settings && secrets), parts: { settings: !!settings, templates: !!parts.templates }, ...extra
  }, null, 2), { name: 'manifest.json' });
  if (settings) {
    zip.append(JSON.stringify(settings, null, 2), { name: 'settings.json' });
    for (const f of uploadRefs(settings)) {
      const file = path.join(UPLOADS_DIR, f);
      if (fs.existsSync(file)) zip.file(file, { name: `uploads/${f}` });
    }
  }
  if (parts.templates) for (const id of templateDirs(templates.dir)) zip.directory(path.join(templates.dir, id), `templates/${id}`);
  return zip;
}

/** Écrit l'archive dans un fichier. */
export function writeBundle(zip, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    out.on('close', resolve);
    out.on('error', reject);
    zip.on('error', reject);
    zip.pipe(out);
    zip.finalize();
  });
}

const UPLOAD_EXTS = /^[^.][^/]*\.(png|jpe?g|webp|gif|svg|ttf|otf|woff2?)$/i;

const safeName = (n) => {
  const p = path.posix.normalize(String(n).replace(/\\/g, '/'));
  return !p.startsWith('/') && !p.startsWith('../') && p !== '..' && !p.includes('\0') ? p : null;
};

/** Lit et valide un fichier d'export. Rien n'est écrit sur le disque. */
export function readBundle(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw new HttpError(400, 'IMPORT_ZIP', 'Ce fichier n\'est pas une archive .zip valide'); }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > MAX_ENTRIES || entries.reduce((n, e) => n + e.header.size, 0) > MAX_TOTAL) throw new HttpError(400, 'IMPORT_SIZE', 'Archive trop volumineuse');
  const byName = new Map();
  for (const e of entries) { const n = safeName(e.entryName); if (n) byName.set(n, e); }
  const json = (name) => { try { return JSON.parse(byName.get(name).getData().toString('utf8')); } catch { return null; } };
  const manifest = byName.has('manifest.json') ? json('manifest.json') : null;
  if (manifest?.app !== 'photobooth-config') throw new HttpError(400, 'IMPORT_FORMAT', 'Ce fichier n\'est pas un export de configuration de la borne');
  if (manifest.format > FORMAT) throw new HttpError(400, 'IMPORT_VERSION', 'Export créé par une version plus récente de la borne : mets-la à jour d\'abord');
  const settings = byName.has('settings.json') ? json('settings.json') : null;
  const templates = new Map();
  const uploads = new Map();
  for (const [name, e] of byName) {
    let m;
    if ((m = /^templates\/([^/]+)\/(.+)$/.exec(name))) {
      const t = templates.get(m[1]) || { files: [], name: m[1] };
      t.files.push({ rel: m[2], entry: e });
      if (m[2] === 'template.json') t.name = json(name)?.name || m[1];
      templates.set(m[1], t);
    } else if ((m = /^uploads\/([^/]+)$/.exec(name)) && UPLOAD_EXTS.test(m[1])) uploads.set(m[1], e); // images et polices seulement : servies telles quelles par /uploads
  }
  for (const [id, t] of [...templates]) if (!t.files.some((f) => f.rel === 'template.json')) templates.delete(id);
  return { manifest, settings: settings && typeof settings === 'object' ? settings : null, templates, uploads };
}

/** Ce que contient le fichier, pour que l'admin choisisse quoi appliquer. */
export function describeBundle(bundle, { templates }) {
  const haveTemplates = new Set(templates.all().map((t) => t.id));
  return {
    boothName: bundle.manifest.boothName || '',
    exportedAt: bundle.manifest.exportedAt || null,
    appVersion: bundle.manifest.appVersion || '',
    secrets: !!bundle.manifest.secrets,
    sections: Object.entries(SECTION_LABELS).filter(([k]) => bundle.settings?.[k] && Object.keys(bundle.settings[k]).length).map(([key, label]) => ({ key, label })),
    templates: [...bundle.templates].map(([id, t]) => ({ id, name: t.name, exists: haveTemplates.has(id) }))
  };
}

/**
 * Fichier retouché à la main ou d'une autre version : les sections choisies passent la même vérification que les
 * réglages enregistrés depuis l'admin (config-validate.js) ; un nombre hors bornes y est ramené. Les cadres
 * proposés absents de la borne sont retirés après l'import (Templates.reconcile). Vérifié avant la sauvegarde et
 * avant d'écrire quoi que ce soit.
 */
export function checkBundle(bundle, sel) {
  for (const key of sel.sections || []) {
    if (!SECTION_LABELS[key] || !isPlainObject(bundle.settings?.[key])) continue;
    try {
      validateConfigPatch({ [key]: bundle.settings[key] }, { clamp: true });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      throw new HttpError(400, `IMPORT_${e.code}`, `Réglage invalide dans le fichier : ${e.message}`);
    }
  }
}

/** Copie un fichier de l'archive vers dir/rel, sans jamais sortir de dir. */
function extract(entry, dir, rel) {
  const base = path.resolve(dir);
  const dest = path.resolve(base, rel);
  if (dest !== base && !dest.startsWith(base + path.sep)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, entry.getData());
}

/**
 * Applique l'import. sel : { sections: [clés], templates: [id], secrets: bool }.
 * Les secrets de la borne (codes, Wi-Fi, pont Hue) sont gardés sauf si sel.secrets et si le fichier en contient.
 */
export function applyBundle(bundle, sel, { config, templates }) {
  const done = { sections: 0, templates: 0 };
  for (const id of sel.templates || []) {
    const t = bundle.templates.get(id);
    if (!t || !/^[A-Za-z0-9][\w.-]*$/.test(id)) continue;
    const dir = path.join(templates.dir, id);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of t.files) extract(f.entry, dir, f.rel);
    done.templates++;
  }
  if (done.templates) templates.reload();
  const useSecrets = !!sel.secrets && !!bundle.manifest.secrets;
  const patch = {};
  for (const key of sel.sections || []) {
    if (!SECTION_LABELS[key] || !isPlainObject(bundle.settings?.[key])) continue;
    const section = clone(bundle.settings[key]);
    if (!useSecrets) keepCurrentSecrets(key, section, config.data);
    patch[key] = section;
    done.sections++;
  }
  if (done.sections) {
    for (const [f, e] of bundle.uploads) if (!fs.existsSync(path.join(UPLOADS_DIR, f))) extract(e, UPLOADS_DIR, f);
    config.replaceSections(patch);
  } else if (done.templates) config.emit('change', config.get());
  return done;
}

// ---------- Sauvegarde automatique avant un import ----------

const backupDir = (config) => path.join(path.dirname(config.file), 'backups');
export const lastImportBackup = (config) => {
  const dir = backupDir(config);
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith('.zip')).sort().at(-1);
  return f ? { file: path.join(dir, f), name: f, at: fs.statSync(path.join(dir, f)).mtime.toISOString() } : null;
};

/**
 * État actuel complet (secrets compris) dans backups/avant-import-<date>.zip ; les 3 plus récentes sont gardées.
 * bundle et sel (l'import qui va suivre) : templates et fichiers envoyés qu'il ajoute, notés dans le manifeste
 * pour que l'annulation les retire.
 */
export async function backupBeforeImport({ config, templates, boothName, appVersion, bundle = null, sel = {} }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = backupDir(config);
  const file = path.join(dir, `${BACKUP_PREFIX}${stamp}.zip`);
  const before = new Set(templateDirs(templates.dir));
  const added = {
    addedTemplates: (sel.templates || []).filter((id) => bundle?.templates.has(id) && /^[A-Za-z0-9][\w.-]*$/.test(id) && !before.has(id)),
    addedUploads: (sel.sections || []).length && bundle ? [...bundle.uploads.keys()].filter((f) => !fs.existsSync(path.join(UPLOADS_DIR, f))) : []
  };
  await writeBundle(buildBundle({ config, templates, parts: { settings: true, templates: true }, secrets: true, boothName, appVersion, extra: added }), file);
  const old = fs.readdirSync(dir).filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith('.zip')).sort().reverse().slice(3);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/** Applique tout le contenu de la dernière sauvegarde d'avant import (annulation). */
export function revertLastImport(ctx) {
  const last = lastImportBackup(ctx.config);
  if (!last) throw new HttpError(404, 'NO_BACKUP', 'Aucune sauvegarde d\'avant import');
  const bundle = readBundle(fs.readFileSync(last.file));
  // Ajouts de l'import annulé : templates et fichiers envoyés absents avant lui
  let removed = 0;
  for (const id of [].concat(bundle.manifest.addedTemplates || [])) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(id) || bundle.templates.has(id)) continue;
    const dir = path.join(ctx.templates.dir, id);
    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
  }
  if (removed) ctx.templates.reload();
  const done = applyBundle(bundle, { sections: Object.keys(SECTION_LABELS), templates: [...bundle.templates.keys()], secrets: true }, ctx);
  const used = new Set(uploadRefs(ctx.config.data));
  for (const f of [].concat(bundle.manifest.addedUploads || [])) {
    if (typeof f === 'string' && /^[A-Za-z0-9][\w.-]*$/.test(f) && !used.has(f)) fs.rmSync(path.join(UPLOADS_DIR, f), { force: true });
  }
  return { ...done, removedTemplates: removed };
}
