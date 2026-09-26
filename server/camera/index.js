import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserCamera } from './browser.js';
import { MockCamera } from './mock.js';
import { Gphoto2Camera } from './gphoto2.js';
import { parseAutoDetect, NOT_A_CAMERA } from './detect.js';

const execFileP = promisify(execFile);

/** 'auto' : gphoto2 si un boîtier est branché, sinon camera.fallback (voir devices.js). */
export const CAMERA_DRIVERS = ['auto', 'browser', 'mock', 'gphoto2'];
export const CAMERA_FALLBACKS = ['browser', 'mock'];

export function createCamera(cameraConfig) {
  switch (cameraConfig.driver) {
    case 'mock': return new MockCamera();
    case 'gphoto2': return new Gphoto2Camera(cameraConfig.gphoto2);
    case 'auto': throw new Error('createCamera : "auto" doit être résolu par Devices');
    case 'browser':
    default: return new BrowserCamera();
  }
}

/**
 * Un boîtier gphoto2 est-il branché ? Énumération USB seulement, sans réserver
 * l'appareil. La commande est surchargeable (tests).
 */
/**
 * Boîtier pilotable en USB. port : à imposer aux commandes seulement si un autre appareil est branché (un
 * iPhone…) : sans lui, gphoto2 prendrait le premier de la liste.
 */
export async function detectGphoto2(gphoto2Config = {}) {
  const cmd = gphoto2Config.detectCommand || 'gphoto2 --auto-detect';
  try {
    const { stdout } = await execFileP('sh', ['-c', cmd], { timeout: 8000 });
    const all = parseAutoDetect(stdout);
    const cams = all.filter((d) => !NOT_A_CAMERA.test(d.model));
    const ignored = all.filter((d) => NOT_A_CAMERA.test(d.model)).map((d) => d.model);
    if (!cams.length) return { found: false, reason: ignored.length ? `aucun boîtier en USB (${ignored.join(', ')} ignoré : téléphone, non pilotable)` : 'aucun boîtier détecté en USB' };
    return { found: true, model: cams[0].model, port: all.length > 1 ? cams[0].port : null, ignored };
  } catch (e) {
    if (/not found|introuvable|ENOENT/i.test(e.message) || e.code === 127) return { found: false, reason: 'gphoto2 non installé' };
    return { found: false, reason: `gphoto2 : ${e.message.split('\n')[0]}` };
  }
}
