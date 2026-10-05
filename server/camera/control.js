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

/**
 * Flash interdit quand une ring light éclaire la scène (lights/index.js, hasRingLight) : posé par app.js, lu par
 * le pilote avant chaque photo. Pas d'éclair par-dessus une lumière continue.
 */
let flashBlocked = () => false;
export function setFlashBlocker(fn) { flashBlocked = fn; }
export const isFlashBlocked = () => { try { return !!flashBlocked(); } catch { return false; } };

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

/**
 * Dominante de couleur d'une photo (0 = neutre) : écart des moyennes rouge et bleu à la moyenne verte, en % de la
 * luminosité. Mesurée sur la photo réduite, toutes zones confondues.
 */
export async function colorCast(file) {
  const { channels } = await sharp(file).resize(320, 320, { fit: 'inside' }).stats();
  const [r, g, b] = channels.map((c) => c.mean);
  const y = Math.max(1, (r + g + b) / 3);
  return Math.round((Math.hypot(r - g, b - g) / y) * 1000) / 10;
}

/** Note d'une photo (plus petite = meilleure) : écart à la luminosité visée, zones brûlées, puis bruit (ISO). */
export function score(m) {
  const iso = Number(m.iso) || 100;
  return Math.round(Math.abs(m.mean - TARGET) + (m.clipped > MAX_CLIP ? 300 * m.clipped : 50 * m.clipped) + 4 * Math.log2(iso / 100));
}

/** Séries complètes, toujours les mêmes : on compare tout avant de choisir (MAX_SHOTS photos). */
const NO_FLASH_SERIES = [{ shutterspeed: '1/125', aperture: '5.6', iso: 'Auto' }, { shutterspeed: '1/125', aperture: '8', iso: 'Auto' }];
const FLASH_SERIES = ['200', '400', '800', '1600'].map((iso) => ({ shutterspeed: '1/60', aperture: '5.6', iso }));
const NO_FLASH_BONUS = 15; // à qualité proche, la lumière du lieu l'emporte (rendu plus doux, pas d'éblouissement)
// Ring light, jamais de flash : trois luminosités (jamais plus de 60 %, balance des blancs auto), puis trois couleurs à la meilleure
// luminosité, balance des blancs du boîtier fixée sur « Lumière du jour » pour que la couleur compte (MAX_SHOTS photos)
const LIGHT_LEVELS = [30, 45, 60]; // la ring light ne dépasse jamais 60 % (lights/elgato.js)
const LIGHT_KELVINS = [4000, 5000, 6000];
const LIGHT_WB = 'Daylight';
const CAST_WEIGHT = 1.5; // poids de la dominante de couleur dans la note de la série des couleurs
const LIGHT_GLARE = 0.08; // à qualité proche, la luminosité la plus douce l'emporte (moins d'éblouissement)

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
  // Chaque commande gphoto2 ouvre une liaison avec le boîtier (une bonne demi-seconde) : on n'envoie que les
  // réglages qui changent d'une photo à l'autre
  const sent = {};
  const write = async (values) => {
    const diff = Object.fromEntries(Object.entries(values).filter(([k, v]) => sent[k] !== v));
    if (!Object.keys(diff).length) return;
    await cam.write(diff);
    Object.assign(sent, diff);
  };
  const shoot = async (label, settings, flash) => {
    await write(settings);
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

  await write(AUTO_BASE);

  // Ring light : elle seule éclaire ; le flash n'est jamais levé
  if (cam.light) {
    const exposure = { shutterspeed: '1/125', aperture: '5.6', iso: 'Auto' };
    // 1. Luminosité : la plus douce qui expose bien
    for (const level of LIGHT_LEVELS) {
      await cam.light.set(level, 5000);
      const shot = await shoot(`Ring light ${level} %`, exposure, false);
      shot.light = { brightness: level, kelvin: 5000 };
      shot.score += Math.round(LIGHT_GLARE * level);
    }
    const lit = shots.slice().sort((a, b) => a.score - b.score)[0];
    // 2. Couleur, à cette luminosité : la plus neutre avec la balance du jour (lumière du lieu comprise)
    const daylight = { ...exposure, whitebalance: LIGHT_WB };
    for (const kelvin of LIGHT_KELVINS) {
      await cam.light.set(lit.light.brightness, kelvin);
      const shot = await shoot(`Ring light ${lit.light.brightness} %, ${kelvin} K`, daylight, false);
      shot.light = { brightness: lit.light.brightness, kelvin };
      shot.cast = await colorCast(shot.file);
      shot.summary += ` · dominante ${shot.cast}`;
      shot.score += Math.round(LIGHT_GLARE * lit.light.brightness + CAST_WEIGHT * shot.cast);
    }
    for (const sh of shots) if (sh.flashFired) sh.label = `${sh.label} (flash levé à la main : rabats-le)`;
    const best = shots.filter((sh) => sh.cast != null).sort((a, b) => a.score - b.score)[0];
    best.best = true;
    const up = shots.some((sh) => sh.flashFired);
    return {
      profile: { flash: false, settings: { ...best.settings }, light: { ...best.light } },
      shots,
      reason: `Ring light : ${best.light.brightness} % et ${best.light.kelvin} K (dominante ${best.cast}), ${best.summary.split(' · dominante')[0]}, luminosité ${best.mean}/255${best.ok ? '' : ', au plus près de la cible'}. Balance des blancs du boîtier : lumière du jour. Flash jamais utilisé.${up ? ' Le flash était levé : rabats-le à la main.' : ''}`
    };
  }

  // 1. Sans flash
  // Dans une scène trop sombre le boîtier refuse de déclencher (mise au point impossible) : ce n'est pas une panne,
  // la série avec flash (qui éclaire la scène) peut encore réussir
  let darkRefused = 0;
  for (const s of NO_FLASH_SERIES) {
    try { await shoot(`Sans flash, f/${s.aperture}`, s, false); } catch (e) {
      if (!/mise au point impossible/.test(e.message)) throw e;
      darkRefused++;
      console.warn(`[calibrage] sans flash f/${s.aperture} : le boîtier refuse de déclencher (scène trop sombre) → série avec flash`);
    }
  }
  const flashUp = shots.some((sh) => sh.flashFired);

  // 2. Avec flash
  let flashSilent = false;
  if (cam.flashControl || flashUp) {
    let retried = false;
    let up = flashUp; // flash parti sur la photo d'avant : il est levé (il ne se rabat qu'à la main), inutile de le relever
    for (const s of FLASH_SERIES) {
      // Levé avant la première photo, puis seulement s'il n'est pas parti (rabattu entre deux photos)
      if (!up) await cam.raiseFlash();
      let shot = await shoot(`Avec flash, ISO ${s.iso}`, s, true);
      if (!shot.flashFired && !retried) {
        // Pas parti : on laisse le boîtier finir, on relève le flash et on refait cette photo (une fois par série)
        retried = true;
        await new Promise((r) => setTimeout(r, 800));
        await cam.raiseFlash();
        await new Promise((r) => setTimeout(r, 600)); // charge du flash
        shots.splice(shots.indexOf(shot), 1);
        shot = await shoot(`Avec flash, ISO ${s.iso} (flash relevé)`, s, true);
      }
      up = !!shot.flashFired;
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
  const ambientNote = darkRefused ? 'Sans flash : le boîtier refuse de déclencher (scène trop sombre).' : flashUp ? 'Flash levé à la main dès le départ : pas de vraie photo sans flash.'
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
