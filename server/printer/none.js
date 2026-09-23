import { BasePrinter } from './base.js';

/**
 * Aucune imprimante : l'invité termine avec le QR code seulement. C'est le repli
 * du mode « auto » quand l'imprimante est éteinte ou débranchée, pour ne jamais
 * faire croire à un tirage qui ne sortira pas.
 */
export class NonePrinter extends BasePrinter {
  name = 'none';
  available = false;

  async print() {
    throw new Error('Aucune imprimante disponible');
  }

  async status() {
    return { driver: this.name, ok: false, available: false, message: 'Aucune imprimante : impression désactivée, QR code seulement' };
  }
}
