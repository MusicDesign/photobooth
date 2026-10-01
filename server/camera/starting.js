import { BaseCamera } from './base.js';

/**
 * Caméra provisoire du lancement : le boîtier se prépare en arrière-plan (remise à zéro USB, réglages, quelques
 * secondes) pendant que le serveur et l'écran de la borne démarrent. Remplacée par le vrai pilote dès qu'il est
 * prêt (même bascule que quand on branche le boîtier en cours de route).
 */
export class StartingCamera extends BaseCamera {
  name = 'starting';

  streaming() { return false; }

  async capture() {
    throw new Error('Appareil photo en cours de préparation, encore quelques secondes');
  }

  attachLiveClient(res) {
    res.status(503).json({ error: 'CAMERA_STARTING', message: 'Appareil photo en cours de préparation' });
  }

  status() {
    return { driver: this.name, mode: this.mode, ok: false, message: 'Appareil photo en cours de préparation' };
  }
}
