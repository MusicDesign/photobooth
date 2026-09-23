import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserCamera } from './browser.js';
import { MockCamera } from './mock.js';
import { Gphoto2Camera } from './gphoto2.js';

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
export async function detectGphoto2(gphoto2Config = {}) {
  const cmd = gphoto2Config.detectCommand || 'gphoto2 --auto-detect';
  try {
    const { stdout } = await execFileP('sh', ['-c', cmd], { timeout: 8000 });
    const line = stdout.split('\n').find((l) => /\busb:/i.test(l));
    if (!line) return { found: false, reason: 'aucun boîtier détecté en USB' };
    return { found: true, model: line.replace(/\s+usb:.*$/i, '').trim() || 'Boîtier' };
  } catch (e) {
    if (/not found|introuvable|ENOENT/i.test(e.message) || e.code === 127) return { found: false, reason: 'gphoto2 non installé' };
    return { found: false, reason: `gphoto2 : ${e.message.split('\n')[0]}` };
  }
}
