import { BaseCamera } from './base.js';

/**
 * La webcam est gérée côté navigateur (getUserMedia). Le client fait l'aperçu
 * et envoie la photo capturée au serveur. Idéal pour développer sur le Mac,
 * utilisable aussi avec une webcam USB sur le Pi.
 */
export class BrowserCamera extends BaseCamera {
  mode = 'browser';
  name = 'browser';

  async capture() {
    throw new Error('En mode navigateur, la photo doit être envoyée par le client (champ "photo").');
  }
}
