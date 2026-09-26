export class BaseCamera {
  /** 'server' : le serveur déclenche et récupère la photo. 'browser' : le navigateur envoie la photo. */
  mode = 'server';
  name = 'base';

  async init() {}

  /** Appelé avec true à la première image d'un live view, false quand il s'arrête (posé par Booth). */
  onLive = null;

  /** Le flux live envoie-t-il des images en ce moment ? (les pilotes sans live répondent oui) */
  streaming() { return true; }

  /** Avance, en ms, avec laquelle la borne doit appeler arm() avant le déclenchement (0 = inutile). */
  armLeadMs() { return 0; }

  /** Pré-armement pendant le décompte (facultatif) : { fireInMs, file } = déclenchement programmé. */
  async arm() {}

  /** Annule un déclenchement programmé (facultatif). */
  async disarm() {}

  /** Prend une photo et l'écrit dans destFile. Retourne destFile. */
  async capture(destFile) {
    throw new Error(`capture() non disponible pour le pilote ${this.name}`);
  }

  /** Boomerang : mise au point avant de filmer (facultatif). */
  async focus() {}

  /** Boomerang : filme quelques secondes dans l'aperçu. Rend des JPEG, dans l'ordre. */
  async recordClip({ durationMs, fps }) {
    if (!this.mjpeg) throw new Error(`Vidéo non disponible pour le pilote ${this.name}`);
    return this.mjpeg.record({ durationMs, fps });
  }

  /** Branche un client HTTP sur le flux MJPEG de l'aperçu live. */
  attachLiveClient(res) {
    res.status(503).json({ error: 'LIVE_UNAVAILABLE', message: `Pas d'aperçu serveur pour le pilote ${this.name}` });
  }

  status() {
    return { driver: this.name, mode: this.mode, ok: true };
  }

  async shutdown() {}
}
