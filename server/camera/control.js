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

export const MAX_SHOTS = 6;       // 2 photos sans flash + 4 avec, toujours (annoncé à l'écran pendant le calibrage)
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
const good = (m) => m.mean >= OK_MIN && m.mean <= OK_MAX && m.clipped <= MAX_CLIP;

/** Note d'une photo (plus petite = meilleure) : écart à la luminosité visée, zones brûlées, puis bruit (ISO). */
export function score(m) {
  const iso = Number(m.iso) || 100;
  return Math.round(Math.abs(m.mean - TARGET) + (m.clipped > MAX_CLIP ? 300 * m.clipped : 50 * m.clipped) + 4 * Math.log2(iso / 100));
}

/** Séries complètes, toujours les mêmes : on compare tout avant de choisir (MAX_SHOTS photos). */
const NO_FLASH_SERIES = [{ shutterspeed: '1/125', aperture: '5.6', iso: 'Auto' }, { shutterspeed: '1/125', aperture: '8', iso: 'Auto' }];
const FLASH_SERIES = ['200', '400', '800', '1600'].map((iso) => ({ shutterspeed: '1/60', aperture: '5.6', iso }));
const NO_FLASH_BONUS = 15; // à qualité proche, la lumière du lieu l'emporte (rendu plus doux, pas d'éblouissement)

/**
 * Calibrage sur place, complet : photos de test à l'endroit de la borne, pour trouver l'exposition du lieu.
 *   1. sans flash : ISO auto à f/5.6 puis f/8 ;
 *   2. avec flash (la borne le lève elle-même) : 1/60 s, f/5.6, ISO 200, 400, 800 et 1600 ;
 *   3. choix : la meilleure note (voir score) ; sans flash seulement si l'ISO reste raisonnable, et gagnant
 *      à qualité proche.
 * cam : { write(values), shoot(file), raiseFlash(), flashControl } fournis par le pilote.
 * Rend { profile, shots, reason } ; profile null si rien d'acceptable.
 */
export async function calibrate(cam, { dir, onStep = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  let n = 0;
  const shoot = async (label, settings, flash) => {
    await cam.write(settings);
    const file = path.join(dir, `test-${++n}.jpg`);
    onStep({ step: n, label, settings });
    await cam.shoot(file);
    const thumb = path.join(dir, `test-${n}-thumb.jpg`);
    await sharp(file).resize(360, 360, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(thumb);
    const m = await measurePhoto(file);
    // Flash levé à la main : il est parti même sur une photo prévue sans flash
    if (m.flashFired && !flash) label = label.replace(/^Sans flash/, 'Flash levé à la main');
    const shot = { n, label, settings, file, thumb, ...m, summary: describe(m), ok: good(m), score: score(m), flash: flash || !!m.flashFired };
    shots.push(shot);
    onStep({ step: n, label, settings, shot });
    return shot;
  };

  await cam.write(AUTO_BASE);

  // 1. Sans flash
  for (const s of NO_FLASH_SERIES) await shoot(`Sans flash, f/${s.aperture}`, s, false);
  const flashUp = shots.some((sh) => sh.flashFired);

  // 2. Avec flash
  let flashSilent = false;
  if (cam.flashControl || flashUp) {
    let retried = false;
    for (const s of FLASH_SERIES) {
      // Avant chaque photo : le flash a pu être rabattu entre deux photos, ou l'ordre arriver trop tôt
      await cam.raiseFlash();
      const shot = await shoot(`Avec flash, ISO ${s.iso}`, s, true);
      if (!shot.flashFired && !retried) {
        // Pas parti : on laisse le boîtier finir, on relève le flash et on refait cette photo (une fois par série)
        retried = true;
        await new Promise((r) => setTimeout(r, 800));
        await cam.raiseFlash();
        await new Promise((r) => setTimeout(r, 600)); // charge du flash
        shots.splice(shots.indexOf(shot), 1);
        await shoot(`Avec flash, ISO ${s.iso} (flash relevé)`, s, true);
      }
    }
    // Aucune photo de la série n'a flashé (EXIF) : flash rabattu, ou émission de l'éclair coupée dans le menu
    flashSilent = shots.filter((sh) => sh.flash && !sh.flashFired).length === FLASH_SERIES.length;
    if (flashSilent) for (const sh of shots) if (sh.flash && !sh.flashFired) { sh.flash = false; sh.label = sh.label.replace('Avec flash', 'Flash non parti'); sh.ok = false; }
  }

  // 3. Choix
  const byScore = (a, b) => a.score - b.score;
  const ambient = shots.filter((sh) => !sh.flash && sh.ok && (sh.iso ?? 0) <= MAX_AMBIENT_ISO).sort(byScore)[0];
  const flashed = shots.filter((sh) => sh.flash).sort(byScore)[0];
  let best;
  if (ambient && (!flashed || ambient.score <= flashed.score + NO_FLASH_BONUS)) best = ambient;
  else best = flashed || shots.slice().sort(byScore)[0];
  const silentNote = flashSilent ? ' Le flash n\'est parti sur aucune photo de la série avec flash : vérifie qu\'il est levé et que « Émission de l\'éclair » est activée dans le menu Contrôle du flash du boîtier, puis recommence.' : '';
  if (flashSilent && !ambient) return { profile: null, shots, reason: `Pas de réglage fiable.${silentNote}` };
  // Trop sombre sans flash et série avec flash impossible (flash non pilotable, pas levé à la main) : on ne
  // garde pas une photo noire comme « la lumière du lieu suffit »
  if (!ambient && !flashed) {
    const dark = shots.map((sh) => `luminosité ${sh.mean}/255`).join(', ');
    const why = cam.flashControl ? '' : ' La borne n\'a pas pu lever le flash (flash pas encore reconnu comme pilotable par USB : le boîtier vient peut-être d\'être rallumé, réessayez dans 30 s), et il n\'était pas levé à la main.';
    return { profile: null, shots, reason: `Pas de réglage fiable : trop sombre sans flash (${dark}).${why} Levez le flash à la main puis recommencez, ou éclairez le lieu.` };
  }
  if (!best) return { profile: null, shots, reason: 'Aucune photo exploitable.' };
  best.best = true;
  const ambientNote = flashUp ? 'Flash levé à la main dès le départ : pas de vraie photo sans flash.'
    : ambient ? `Meilleure sans flash : ${ambient.summary}, luminosité ${ambient.mean}/255 (note ${ambient.score}).`
    : `Sans flash : ${shots.filter((sh) => !sh.flash).map((sh) => `ISO ${sh.iso ?? '?'}, luminosité ${sh.mean}`).join(' ; ')}, pas assez bon.`;
  const flashNote = flashed ? ` Meilleure avec flash : ${flashed.summary}, luminosité ${flashed.mean}/255 (note ${flashed.score}).` : '';
  const pick = best.flash ? 'avec flash' : 'sans flash, la lumière du lieu suffit (rabats le flash à la fin)';
  return {
    profile: { flash: !!best.flash, settings: { ...best.settings } },
    shots,
    reason: `${ambientNote}${flashNote} Choix : ${pick}${best.ok ? '' : ', au plus près de la cible'}.${silentNote}`
  };
}
