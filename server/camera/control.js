import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Réglages de prise de vue du boîtier, depuis l'admin (Matériel → Boîtier). Trois modes (camera.control.mode) :
 *   camera : la borne ne touche pas à l'exposition, le boîtier décide (molette, menus)
 *   manual : les valeurs choisies dans l'admin sont poussées au boîtier (à la détection et à l'enregistrement)
 *   auto   : la borne impose une base éprouvée et l'exposition trouvée par le calibrage sur place
 *
 * Les valeurs sont celles de gphoto2 en anglais (LANG=C), identiques quelle que soit la langue du système.
 * Vérifié sur le 2000D : le mode d'exposition imposé par USB prime sur la molette.
 */

/** Réglages proposés en mode manuel, dans l'ordre de l'admin, avec leur libellé. */
export const MANUAL_SETTINGS = [
  ['autoexposuremodedial', 'Mode d\'exposition'],
  ['shutterspeed', 'Vitesse'],
  ['aperture', 'Ouverture'],
  ['iso', 'ISO'],
  ['exposurecompensation', 'Correction d\'exposition (P, Av, Tv)'],
  ['meteringmode', 'Mesure de la lumière'],
  ['whitebalance', 'Balance des blancs'],
  ['whitebalanceadjusta', 'Correction de la balance (ambre / bleu)'],
  ['whitebalanceadjustb', 'Correction de la balance (magenta / vert)'],
  ['picturestyle', 'Style d\'image'],
  ['alomode', 'Correction auto de luminosité (ALO)'],
  ['imageformat', 'Qualité d\'image'],
  ['aspectratio', 'Format'],
  ['colorspace', 'Espace couleur'],
  ['focusmode', 'Autofocus'],
  ['afmethod', 'Méthode AF (live view)'],
  ['drivemode', 'Mode de déclenchement'],
  ['reviewtime', 'Affichage après la photo (écran du boîtier)']
];
export const MANUAL_KEYS = MANUAL_SETTINGS.map(([k]) => k);

/** Base imposée en mode auto : manuel, photo unique, AF un coup, JPEG grande taille fine, rendu neutre. */
export const AUTO_BASE = {
  autoexposuremodedial: 'Manual',
  drivemode: 'Single',
  focusmode: 'One Shot',
  imageformat: 'L',
  picturestyle: 'Standard',
  whitebalance: 'Auto',
  aspectratio: '3:2',
  reviewtime: 'None'
};

/** Exposition de départ si aucun calibrage n'a été fait. */
export const AUTO_DEFAULT = { flash: false, settings: { shutterspeed: '1/125', aperture: '5.6', iso: 'Auto' } };

export const MAX_SHOTS = 7;       // au plus 3 photos sans flash + 4 avec (annoncé à l'écran pendant le calibrage)
const TARGET = 118;                 // luminosité moyenne visée (0-255) : lumineuse sans être délavée
const OK_MIN = 92, OK_MAX = 152;    // fourchette acceptée
const MAX_CLIP = 0.02;              // 2 % de pixels brûlés au plus
const MAX_AMBIENT_ISO = 1600;       // au-delà, le bruit l'emporte : on passe au flash

/** EXIF minimal : programme, vitesse, ouverture, ISO, flash parti. */
export function readExif(buf) {
  if (!buf || buf.length < 14) return {};
  const base = buf.toString('latin1', 0, 4) === 'Exif' ? 6 : 0;
  const le = buf.toString('latin1', base, base + 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const tags = {};
  const walk = (off, depth = 0) => {
    if (depth > 2 || base + off + 2 > buf.length) return;
    const n = u16(base + off);
    for (let i = 0; i < n; i++) {
      const e = base + off + 2 + i * 12;
      if (e + 12 > buf.length) return;
      const tag = u16(e), type = u16(e + 2), val = e + 8;
      if (tag === 0x8769) walk(u32(val), depth + 1);
      else if (type === 3) tags[tag] = u16(val);
      else if (type === 4) tags[tag] = u32(val);
      else if (type === 5 || type === 10) { const p = base + u32(val); if (p + 8 <= buf.length) tags[tag] = u32(p) / (u32(p + 4) || 1); }
    }
  };
  try { walk(u32(base + 4)); } catch { return {}; }
  return {
    program: tags[0x8822] ?? null,
    exposure: tags[0x829a] ?? null,
    fnumber: tags[0x829d] ?? null,
    iso: tags[0x8827] ?? null,
    flashFired: tags[0x9209] == null ? null : !!(tags[0x9209] & 1)
  };
}

/** Luminosité moyenne, part de pixels brûlés et EXIF d'une photo. */
export async function measurePhoto(file) {
  const img = sharp(file);
  const { exif } = await img.metadata();
  const px = await sharp(file).resize(480, 480, { fit: 'inside' }).greyscale().raw().toBuffer();
  let sum = 0, clipped = 0;
  for (const v of px) { sum += v; if (v >= 250) clipped++; }
  return { mean: Math.round(sum / px.length), clipped: clipped / px.length, ...readExif(exif) };
}

const fmtExposure = (t) => (t == null ? '?' : t >= 1 ? `${t} s` : `1/${Math.round(1 / t)} s`);
const describe = (m) => `${fmtExposure(m.exposure)} · f/${m.fnumber ?? '?'} · ISO ${m.iso ?? '?'}${m.flashFired ? ' · flash' : ''}`;
const quality = (m) => Math.abs(m.mean - TARGET) + (m.clipped > MAX_CLIP ? 200 * m.clipped : 0);
const good = (m) => m.mean >= OK_MIN && m.mean <= OK_MAX && m.clipped <= MAX_CLIP;

/**
 * Calibrage sur place : photos de test à l'endroit de la borne, pour trouver l'exposition du lieu.
 *   1. sans flash (1/125 s, f/5.6, ISO auto) : trop clair, on ferme le diaphragme ;
 *   2. puis avec flash, toujours (la borne le lève elle-même) : 1/60 s, f/5.6, ISO ajusté (400, puis
 *      800 / 1600 ou 200 / 100, puis diaphragme) ;
 *   3. choix : sans flash si la luminosité est bonne et l'ISO raisonnable, sinon le meilleur avec flash.
 * cam : { write(values), shoot(file), raiseFlash(), flashControl } fournis par le pilote.
 * Rend { profile, shots, reason } ; profile null si rien d'acceptable.
 */
export async function calibrate(cam, { dir, onStep = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  let n = 0;
  const shoot = async (label, settings) => {
    await cam.write(settings);
    const file = path.join(dir, `test-${++n}.jpg`);
    onStep({ step: n, label, settings });
    await cam.shoot(file);
    const thumb = path.join(dir, `test-${n}-thumb.jpg`);
    await sharp(file).resize(360, 360, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(thumb);
    const m = await measurePhoto(file);
    // Flash levé à la main : il est parti même sur une photo prévue sans flash
    if (m.flashFired && /^Sans flash/.test(label)) label = label.replace(/^Sans flash/, 'Flash levé à la main');
    const shot = { n, label, settings, file, thumb, ...m, summary: describe(m), ok: good(m) };
    shots.push(shot);
    onStep({ step: n, label, settings, shot });
    return shot;
  };

  await cam.write(AUTO_BASE);

  // 1. Lumière ambiante
  let ambient = null;
  let flashUp = false;
  let s = { shutterspeed: '1/125', aperture: '5.6', iso: 'Auto' };
  for (const aperture of ['5.6', '8', '11']) {
    s = { ...s, aperture };
    const shot = await shoot(`Sans flash, f/${aperture}`, s);
    if (shot.flashFired) { flashUp = true; break; } // flash levé à la main : pas de test sans flash possible
    ambient = shot;
    if (shot.mean <= OK_MAX && shot.clipped <= MAX_CLIP) break; // pas trop clair : inutile de fermer davantage
  }
  const ambientOk = !!ambient && good(ambient) && (ambient.iso ?? 0) <= MAX_AMBIENT_ISO;
  const noFlashProfile = ambient ? { flash: false, settings: { ...s } } : null;
  const why = flashUp ? 'Flash levé à la main dès le départ : pas de test sans flash possible.'
    : ambientOk ? `Sans flash : ${ambient.summary}, luminosité ${ambient.mean}/255.`
    : ambient && (ambient.iso ?? 0) > MAX_AMBIENT_ISO ? `Sans flash, il faudrait ISO ${ambient.iso} : trop de bruit.`
    : ambient ? `Sans flash, luminosité ${ambient.mean}/255 : hors de la fourchette.` : '';

  // 2. Avec flash, toujours (série complète : sans flash d'abord, puis la borne lève le flash elle-même,
  //    personne n'a à le rabattre entre deux photos)
  if (!cam.flashControl && !flashUp) {
    return { profile: noFlashProfile, shots, reason: `${why} Ce boîtier ne lève pas son flash par USB : réglage sans flash, à corriger à la main si besoin.` };
  }
  await cam.raiseFlash();
  const isos = ['100', '200', '400', '800', '1600'];
  let iso = 2; // 400
  let aperture = '5.6';
  const tried = [];
  for (let i = 0; i < 4; i++) {
    const fs_ = { shutterspeed: '1/60', aperture, iso: isos[iso] };
    const shot = await shoot(`Avec flash, ISO ${isos[iso]}, f/${aperture}`, fs_);
    tried.push({ shot, settings: fs_ });
    if (good(shot)) break;
    if (shot.mean < OK_MIN && iso < isos.length - 1) iso++;
    else if (shot.mean > OK_MAX && iso > 0) iso--;
    else if (shot.mean > OK_MAX && aperture !== '11') aperture = aperture === '5.6' ? '8' : '11';
    else break;
  }
  const best = tried.reduce((a, b) => (quality(b.shot) < quality(a.shot) ? b : a));
  const withFlash = `Avec flash : ${best.shot.summary}, luminosité ${best.shot.mean}/255${best.shot.ok ? '' : ' (au plus près de la cible)'}.`;

  // 3. Choix : la lumière naturelle si elle suffit (rendu plus doux), sinon le flash
  if (ambientOk) {
    return { profile: noFlashProfile, shots, reason: `${why} ${withFlash} Choix : sans flash, la lumière du lieu suffit (rabats le flash à la fin).` };
  }
  return { profile: { flash: true, settings: { ...best.settings } }, shots, reason: `${why} ${withFlash} Choix : avec flash.` };
}
