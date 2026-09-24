import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { CONFIG_FILE } from './paths.js';
import { clone, deepMerge, readJson, writeJsonAtomic } from './util.js';

/**
 * Configuration par défaut. Le fichier data/config.json ne contient que ce que
 * l'admin a modifié ; tout ce qui manque est complété par ces valeurs.
 */
export const DEFAULTS = {
  booth: {
    name: 'Photo Booth',
    language: 'fr',
    idleReturnSec: 20,
    mirrorPreview: true,
    lensPosition: 'top',   // où est l'objectif par rapport à l'écran : top | bottom | left | right (sens de la flèche « Regardez l'objectif »)
    showName: true,        // affiche le nom à côté du logo
    // Télécommande Elgato branchée en USB (sans écran tactile). position : où il est posé par rapport à l'écran,
    // pour la flèche de l'accueil quand l'écran n'est pas tactile (top | bottom | left | right).
    streamDeck: { enabled: true, brightness: 70, position: 'bottom' },
    logo: '',              // /uploads/logo-xxx.png, vide = logo par défaut
    backgroundImage: ''
  },
  camera: {
    // auto    : gphoto2 si un boîtier est branché, sinon `fallback` (surveillé toutes les 10 s)
    // browser : webcam via le navigateur (dev sur Mac, ou webcam USB sur le Pi)
    // mock    : photos d'exemple, pour les tests automatiques
    // gphoto2 : Canon EOS 2000D en USB
    driver: 'auto',
    fallback: 'browser',
    gphoto2: {
      // Flash intégré : 'off' (jamais levé par la borne), 'on' (levé avant chaque photo), 'auto' (levé si la
      // scène est sombre, d'après la luminosité du live view). Une fois levé, il ne se rabat qu'à la main.
      flash: 'off',
      flashUpCommand: 'gphoto2 --set-config popupflash=1', // lancée à part juste avant la photo, non bloquante
      flashAutoThreshold: 60,                      // luminosité moyenne (0-255) sous laquelle le mode auto lève le flash
      captureCommand: 'gphoto2 --set-config capturetarget=0 --capture-image-and-download --filename {file} --force-overwrite',
      // Pendant le décompte, live coupé, en une seule session gphoto2 : demi-pression = mise au point, attente
      // {wait} ms, pression complète sans refaire le point pile à « 0 », téléchargement, relâchements. Vide = tout à « 0 ».
      armFireCommand: 'gphoto2 --set-config capturetarget=0 --set-config-index eosremoterelease=1 --wait-event={wait}ms --set-config-index eosremoterelease=4 --wait-event-and-download=FILEADDED --set-config-index eosremoterelease=6 --set-config-index eosremoterelease=5 --filename {file} --force-overwrite',
      liveviewCommand: 'gphoto2 --capture-movie --stdout',
      recoverCommand: 'gphoto2 --set-config-index eosremoterelease=6 --set-config-index eosremoterelease=5', // relâche le déclencheur si une commande a été interrompue
      liveview: true,
      settleMs: 800,
      liveIdleMs: 8000,    // coupure du live (obturateur fermé) quand aucun écran n'affiche l'aperçu
      // Poussé au boîtier à sa détection. Mode « Unique » (drivemode=0) : en rafale, le déclencheur maintenu
      // jusqu'au téléchargement prend plusieurs vues, les vues en trop saturent la mémoire interne et le boîtier
      // finit par refuser de déclencher (0x2019 « périphérique occupé »). Le 2000D ignore autopoweroff (voir son menu).
      setupCommand: 'gphoto2 --set-config-index drivemode=0'
    }
  },
  printer: {
    // auto : cups si la file nommée ci-dessous répond, sinon `fallback`
    // mock : écrit le fichier dans output/prints (dev)
    // cups : commande lp (Raspberry Pi + Gutenprint)
    // none : impression désactivée, l'invité repart avec le QR code
    driver: 'auto',
    fallback: 'none',
    cups: { name: '', options: ['media=Postcard', 'fit-to-page'] },
    mockDelayMs: 3000
  },
  limits: {
    maxCopiesPerSession: 2,
    allowZeroCopies: true,
    eventQuota: 200,          // 0 = illimité
    maxRetakesPerSession: 2,  // 0 = aucune reprise, -1 = illimité
    reviewTimeoutSec: 30,
    captureTimeoutSec: 30,    // personne ne lance la photo : retour à l'accueil (0 = jamais)
    countdownSec: 3,
    lowPaperThreshold: 20,
    operatorPin: '0000',
    operatorMaxCopies: 10
  },
  templates: {
    guestCanChoose: true,
    enabled: ['classic-10x15', 'strip-3'],
    default: 'classic-10x15',
    defaultFormat: '10x15-paysage'
  },
  theme: {
    active: 'default-light',  // id d'un thème de data/themes ou "custom"
    custom: {
      name: 'Personnalisé',
      colors: {
        primary: '#e63946',
        secondary: '#1d3557',
        background: '#f8f9fa',
        surface: '#ffffff',
        text: '#1a1a1a',
        onPrimary: '#ffffff'
      },
      font: 'system',
      logo: '',
      backgroundImage: ''
    }
  },
  texts: {
    welcome: "Touchez l'écran pour commencer",
    welcomeNoTouch: 'Appuyez sur le bouton pour commencer', // accueil quand l'écran n'est pas tactile (Stream Deck…)
    chooseTemplate: 'Choisissez votre cadre',
    getReady: 'Placez-vous devant l\'objectif',
    start: "C'est parti !",
    lookUp: "Regardez l'objectif", // bandeau avec flèche vers l'objectif (booth.lensPosition), juste avant le « 0 »
    holdPose: 'Gardez la pose !',   // affiché entre le « 0 » et l'arrivée de la photo
    review: 'On la garde ?',
    retake: 'Refaire',
    keep: 'Je la garde',
    copies: 'Combien de tirages ?',
    print: 'Imprimer',
    noPrint: 'Sans impression',
    printing: 'Impression en cours…',
    thanks: 'Merci ! Scannez le QR code pour récupérer votre photo.',
    quotaReached: 'Les impressions sont terminées pour ce soir, mais votre photo vous attend en ligne !',
    paperEmpty: 'Plus de papier pour le moment, mais votre photo vous attend en ligne !', // stock à 0 (admin)
    printerUnavailable: "L'imprimante n'est pas disponible, mais votre photo vous attend en ligne !",
    finish: 'Terminer'
  },
  admin: { pin: '1234' },
  share: { baseUrl: '' }  // vide = http://<ip locale>:<port>
};

export class Config extends EventEmitter {
  constructor(file = CONFIG_FILE) {
    super();
    this.file = file;
    this.data = clone(DEFAULTS);
    this.runtime = {}; // surcharges non persistées (variables d'environnement)
  }

  load() {
    const saved = fs.existsSync(this.file) ? readJson(this.file, {}) : null;
    this.data = deepMerge(clone(DEFAULTS), saved || {});
    this.migrate();
    if (!saved) this.save();
    return this.get();
  }

  /** Nettoie les réglages enregistrés par d'anciennes versions de l'admin. */
  migrate() {
    const g = this.data.camera?.gphoto2;
    if (!g) return;
    let changed = false;
    for (const k of ['armCommand', 'captureArmedCommand', 'flashUpArgs']) {
      if (k in g) { delete g[k]; changed = true; }
    }
    if (g.setupCommand === 'gphoto2 --set-config autopoweroff=0') { g.setupCommand = ''; changed = true; } // le 2000D l'ignore
    for (const k of ['captureCommand', 'armFireCommand']) {
      if (typeof g[k] === 'string' && g[k].includes('{flash}')) { g[k] = g[k].replace(/\s*\{flash\}/, ''); changed = true; }
    }
    if (changed) this.save();
  }

  get() {
    return deepMerge(clone(this.data), this.runtime);
  }

  update(patch) {
    deepMerge(this.data, patch);
    this.save();
    const cfg = this.get();
    this.emit('change', cfg);
    return cfg;
  }

  setRuntime(patch) {
    deepMerge(this.runtime, patch);
  }

  save() {
    writeJsonAtomic(this.file, this.data);
  }
}
