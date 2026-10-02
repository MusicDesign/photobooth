import { EventEmitter } from 'node:events';
import { CONFIG_FILE } from './paths.js';
import { clone, deepMerge, loadJsonSafe, writeJsonAtomic, backupJson } from './util.js';

/**
 * Configuration par défaut. Le fichier data/config.json ne contient que ce que
 * l'admin a modifié ; tout ce qui manque est complété par ces valeurs.
 */
export const DEFAULTS = {
  booth: {
    name: 'Cheeesy',
    language: 'fr',
    idleReturnSec: 20,
    menuIdleSec: 30,       // choix du cadre et galerie : retour à l'accueil sans interaction (0 = jamais)
    mirrorPreview: true,
    // Filtres proposés à l'invité sur « On la garde ? » (public/filters.js), appliqués à tout le montage
    filters: { enabled: false, available: ['none', 'bw', 'noir', 'sepia', 'vintage', 'warm', 'cool', 'vivid'], default: 'none' },
    lensPosition: 'top',   // où est l'objectif par rapport à l'écran : top | bottom | left | right (sens de la flèche « Regardez l'objectif »)
    showName: true,        // affiche le nom à côté du logo
    cursor: 'show',        // curseur de la souris sur la borne : show | idle (masqué après 3 s sans mouvement) | hide
    touch: 'auto',         // écran tactile : auto (détection du navigateur, corrigée au premier toucher) | touch (toujours) | buttons (jamais : Stream Deck, clavier)
    window: 'kiosk',       // fenêtre de l'app Electron : kiosk (verrouillée, événement) | fullscreen (plein écran classique, l'ordinateur reste utilisable : tests)
    // Télécommande Elgato branchée en USB (sans écran tactile). position : où il est posé par rapport à l'écran,
    // pour la flèche de l'accueil quand l'écran n'est pas tactile (top | bottom | left | right).
    // showButtons : garder les boutons à l'écran même quand l'écran n'est pas tactile et qu'un Stream Deck pilote la borne
    streamDeck: { enabled: true, brightness: 70, position: 'bottom', showButtons: false },
    logo: '',              // /uploads/logo-xxx.png, vide = logo par défaut
    backgroundImage: ''
  },
  camera: {
    // auto    : gphoto2 si un boîtier est branché, sinon `fallback` (surveillé toutes les 10 s)
    // browser : webcam via le navigateur (dev sur Mac, ou webcam USB sur la borne Linux)
    // mock    : photos d'exemple, pour les tests automatiques
    // gphoto2 : Canon EOS 2000D en USB
    driver: 'auto',
    fallback: 'browser',
    // Réglages de prise de vue (admin → Matériel → Boîtier) : camera = le boîtier décide, manual = valeurs de
    // l'admin, auto = la borne gère (base + exposition trouvée par le calibrage sur place). Voir camera/control.js.
    control: { mode: 'camera', manual: {}, auto: { profile: null, calibratedAt: null, reason: '' } },
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
    // cups : commande lp (Linux + Gutenprint)
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
    // « Combien de tirages ? » laissé sans action : après ce délai (0 = jamais), print imprime le nombre affiché,
    // skip termine sans impression (seulement si l'invité a le droit de ne pas imprimer)
    copiesTimeoutSec: 30,
    copiesTimeoutAction: 'print',
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
    defaultFormat: '10x15-paysage',
    order: [],                // ordre d'affichage des cadres (glissé dans l'admin) ; les absents viennent après
    gifEnabled: false,        // templates GIF proposés aux invités (numérique uniquement)
    cutoutAuto: true          // machine trop lente pour le détourage précis : modèle rapide pour les invités
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
    pleaseWait: 'Veuillez patienter', // plein écran pendant l'assemblage d'un GIF
    boomerangGo: 'Bougez !',          // boomerang : pendant que la borne filme
    focusing: 'Mise au point…',       // boomerang : si la mise au point n'est pas finie au bout du décompte
    review: 'On la garde ?',
    retake: 'Refaire',
    keep: 'Je la garde',
    copies: 'Combien de tirages ?',
    print: 'Imprimer',
    noPrint: 'Sans impression',
    printing: 'Impression en cours…',
    thanks: 'Merci ! Scannez le QR code pour récupérer votre photo.',
    thanksNoQr: 'Merci et bonne soirée !', // écran de fin quand le QR code est désactivé
    thanksGif: 'Merci ! Scannez le QR code pour récupérer votre GIF.',
    thanksVideo: 'Merci ! Scannez le QR code pour récupérer votre vidéo.', // boomerang (MP4)
    reviewGif: 'On le garde ?', // relecture d'un GIF (review / keep sont au féminin, pour la photo)
    keepGif: 'Je le garde',
    gifInGallery: 'Merci ! Votre GIF vous attend dans la galerie de la borne.', // GIF sans QR code (pas de Wi-Fi)
    quotaReached: 'Les impressions sont terminées pour ce soir, mais votre photo vous attend en ligne !',
    paperEmpty: 'Plus de papier pour le moment, mais votre photo vous attend en ligne !', // stock à 0 (admin)
    printerUnavailable: "L'imprimante n'est pas disponible, mais votre photo vous attend en ligne !",
    finish: 'Terminer',
    gallery: 'Galerie',
    galleryTitle: 'Les photos de la soirée',
    galleryEmpty: 'Pas encore de photo : à vous de jouer !',
    reprint: 'Réimprimer',
    galleryQr: 'Scannez pour récupérer cette photo',
    galleryQrGif: 'Scannez pour récupérer ce GIF',     // visionneuse de la galerie : GIF
    galleryQrVideo: 'Scannez pour récupérer cette vidéo', // visionneuse de la galerie : boomerang (MP4)
    wifiQr: 'Wi-Fi des photos',
    remoteTitle: 'Votre photo vous attend sur la borne',   // page distante (adresse publique), hors du Wi-Fi de la borne
    remoteHint: 'Connectez-vous au Wi-Fi de la borne : scannez le QR code Wi-Fi en bas à droite de son écran. Votre photo s\'affichera ici toute seule.'
  },
  admin: { pin: '1234' },
  share: {
    baseUrl: '',           // vide = http://<ip locale>:<port>
    // Adresse publique (ex. https://photobooth.domain.fr) : les QR codes de photo y mènent. Sur le Wi-Fi de la borne,
    // le DNS du hotspot la fait pointer sur la borne ; ailleurs, la page distante (npm run remote) invite à s'y connecter.
    publicUrl: '',
    qrOnDone: true,        // QR code de la photo sur l'écran de fin
    requireWifi: true,     // QR codes de photo masqués quand la borne n'est pas en Wi-Fi (aucun téléphone ne la joindrait)
    // QR code Wi-Fi affiché en permanence en bas à droite de la borne : le téléphone rejoint le hotspot en un scan.
    // Doit reprendre le nom et le mot de passe du hotspot (TUTORIEL.md, étape 10.7). security : WPA | nopass (réseau ouvert)
    wifi: { enabled: false, ssid: '', password: '', security: 'WPA' }
  },
  gallery: {
    booth: false,          // bouton « Galerie » sur l'accueil de la borne
    web: false,            // page /galerie pour les téléphones connectés au Wi-Fi de la borne
    reprint: 'operator',   // réimpression depuis la galerie de la borne : off | operator (code opérateur) | guest (libre)
    qr: true               // QR code de la photo affichée dans la visionneuse de la borne
  },
  // Appareils connectés : lumières Govee du réseau local (server/lights). devices : id Govee → { name, sku, ip,
  // ambiance, shooting } (rôles de chaque lumière), rempli par les recherches.
  // Écran de la borne en DDC/CI (server/screen.js) : null = la borne ne touche pas à ce réglage de l'écran.
  // display : écran à piloter (identifiant vu par m1ddc ou ddcutil, ou son nom), vide = premier écran externe nommé
  screen: { brightness: null, volume: null, display: '' },
  lights: {
    enabled: false,
    devices: {},
    // Accueil : ambiance (effet fixed | cycle | breathe) | keep (lumières laissées telles quelles) | off (éteintes).
    // sync : cycle et respiration identiques sur toutes les lumières (sinon décalés entre elles)
    // white : blanc (température kelvin) à la place de la couleur, pour la couleur fixe et la respiration
    idle: { mode: 'ambiance', effect: 'cycle', color: '#ff7a1a', white: false, kelvin: 2700, brightness: 60, periodSec: 20, sync: false },
    // Du choix du template à la dernière photo, et pendant le calibrage
    shooting: { kelvin: 5000, brightness: 100 },
    // À l'arrêt de la borne : white (blanc chaud doux, pour ranger sans être dans le noir) | off (éteintes) | keep (comme avant la borne)
    shutdown: { mode: 'white', kelvin: 2700, brightness: 20 }
  }
};

export class Config extends EventEmitter {
  constructor(file = CONFIG_FILE) {
    super();
    this.file = file;
    this.data = clone(DEFAULTS);
    this.runtime = {}; // surcharges non persistées (variables d'environnement)
  }

  load() {
    // Illisible : dernière sauvegarde (voir loadJsonSafe), plutôt que les réglages par défaut qui l'écraseraient
    const { data: saved, warning } = loadJsonSafe(this.file, 'Configuration');
    this.warning = warning; // affiché dans le tableau de bord
    this.data = deepMerge(clone(DEFAULTS), saved || {});
    this.migrate();
    if (!saved || warning) this.save();
    else backupJson(this.file); // copie saine au démarrage
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

  /** Retire une clé, ex. remove(['lights', 'devices', id]) : deepMerge ne sait qu'ajouter ou remplacer. */
  remove(keys) {
    const last = keys.at(-1);
    const parent = keys.slice(0, -1).reduce((o, k) => o?.[k], this.data);
    if (parent && typeof parent === 'object' && last in parent) {
      delete parent[last];
      this.save();
      this.emit('change', this.get());
    }
    return this.get();
  }

  setRuntime(patch) {
    deepMerge(this.runtime, patch);
  }

  save() {
    writeJsonAtomic(this.file, this.data);
  }
}
