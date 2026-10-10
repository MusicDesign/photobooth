# Cheeesy

Borne photo tactile pensée pour tourner **hors ligne sur un PC Linux** (tablette ou
mini-PC tactile, Debian, Ubuntu ou Fedora), avec un **Canon EOS 2000D** piloté par gphoto2 et une
imprimante photo via CUPS. Interface web plein écran (app Electron, ou Chromium en kiosque),
backend Node.js 22.12 ou plus.

État : **borne fonctionnelle**, mise au point sur Mac avec le vrai matériel : Canon EOS 2000D
piloté et calibré par gphoto2 (aperçu en direct, flash, détourage IA), Stream Deck, lumières
Govee et Elgato, écran externe en DDC/CI, 20 thèmes et éditeur de templates. Le flux invité
complet se teste aussi sans matériel (caméra et imprimante simulées). Reste à valider :
l'impression sur l'imprimante retenue et l'installation sur le mini PC Linux de la borne
(voir « Prochaines étapes »).

## Démarrer sur le Mac

Guide complet pas à pas (Mac, boîtier Canon, imprimante, PC Linux de la borne, jour J) :
[TUTORIEL.md](TUTORIEL.md).

```bash
scripts/install.sh    # première fois : installe tout ce qui manque (Homebrew, Node.js, dépendances npm, gphoto2, m1ddc, modèle IA) puis lance la borne
                      # --kiosk : en plus, lancement automatique à l'ouverture de session · Windows (essais) : scripts\install.cmd
npm run setup         # la même installation sans lancer, Node.js déjà là · npm run check : l'état seulement (aussi dans l'admin → Installation)
npm start             # http://localhost:3000  ·  admin : http://localhost:3000/admin.html (PIN 1234)
```

Par défaut la caméra est la **webcam du navigateur** (FaceTime, iPhone via Continuity
Camera, ou webcam USB) et l'imprimante est **simulée** : les tirages sont écrits dans
`output/prints/`. La webcam n'est accessible que sur `http://localhost` (contrainte
navigateur) : ouvrez la borne en local, pas via l'adresse IP.

```bash
npm run smoke                 # test de bout en bout, sans matériel (données temporaires)
npm run app                   # la borne en app de bureau plein écran (Electron), Ctrl+Maj+Q pour quitter
npm run remote                # page distante de l'adresse publique → output/remote (TUTORIEL.md, étape 10.8)
scripts/make-mac-app.sh       # régénère « Cheeesy.app » (raccourci Mac : double-clic = npm run app, ou scripts/install.sh si rien n'est installé)
node scripts/screenshots.js   # capture tous les écrans avec Chrome headless → output/screenshots/
BOOTH_CAMERA=mock npm start   # caméra simulée côté serveur (flux MJPEG), utile sans webcam
```

## Sur la borne (PC Linux)

```bash
sudo apt install -y git                     # Debian/Ubuntu neuves (Fedora : sudo dnf install -y git)
git clone https://github.com/MusicDesign/photobooth.git && cd photobooth
scripts/install.sh --kiosk                  # Node.js 22.12+, dépendances npm et app Electron, gphoto2, CUPS, ddcutil, NetworkManager (sudo),
                                            # modèle IA, icône bureau + lancement auto en plein écran (écran jamais éteint), puis lance la borne
```

Debian installée avec un mot de passe root : l'utilisateur n'a pas le droit `sudo`. Une fois, puis fermer
et rouvrir la session : `su -c 'usermod -aG sudo VOTRE_UTILISATEUR'` (mot de passe root demandé).
Cloner le dépôt sans `sudo` : un dépôt appartenant à root bloque les mises à jour depuis l'admin.

Au démarrage de la session, la borne s'ouvre seule en plein écran. **Éteindre la borne**
(admin, en bas du menu) ferme le logiciel ; l'icône **Cheeesy** du bureau le relance.
Deux lanceurs au choix, même comportement :

- **App Electron** (défaut, installée par `scripts/install.sh --kiosk`) : `scripts/kiosk/photobooth-electron.sh`,
  ou `install-linux.sh --exec` vers l'AppImage construite par `npm run app:build` sur la borne elle-même.
- **Chromium en kiosque** : `scripts/kiosk/install-linux.sh` sans option (lanceur `scripts/kiosk/photobooth.sh`,
  serveur relancé s'il plante), Chromium à installer soi-même.

Détails, connexion automatique, pare-feu et hotspot : [TUTORIEL.md, étape 10](TUTORIEL.md#10-installer-sur-le-pc-de-la-borne-linux).

## Ce que fait la borne

Flux invité : accueil → choix du cadre (optionnel) → aperçu live **dans le template**
→ décompte → photos (1 ou plusieurs) → relecture avec **reprise** →
**choix du nombre de copies** → impression → écran final avec **QR code** vers une galerie
locale.

Admin (`/admin.html`, ou 5 appuis en haut à droite de la borne, ou G D G D sur les touches du haut du Stream Deck, dans la même fenêtre ;
« Retour à la borne » y revient en déconnectant l'admin) :

- **Limites** : copies max par passage, « sans impression » autorisé ou non, reprises
  max, validation automatique, décompte, **quota total de l'événement**, alerte papier,
  code opérateur pour lever la limite ponctuellement.
- **Thème** : nom de la borne, **logo** et image de fond valables pour tous les thèmes ; sans logo
  importé, le logo Cheeesy prend les couleurs du thème (aplat en accent, lettres en texte des boutons) ;
  20 thèmes livrés (clair, sombre, festif, mariage, noir & or, néon, océan, forêt, corail, bonbon, entreprise,
  Noël, lavande, bohème, minuit, tropical, rétro, Halloween, givre, graphite), une carte par thème avec l'accueil en miniature et l'aperçu de trois écrans toujours affiché,
  + couleurs personnalisées avec alerte de contraste ;
  tous les textes modifiables. Appliqué sur la borne en direct via WebSocket.
- **Templates** : création par simple nom, **éditeur visuel de calques** (photos, textes,
  images, formes : glisser, redimensionner, tourner, ordre, opacité), activation, template
  par défaut, choix laissé ou non à l'invité.
- **Matériel** : pilote caméra (`auto`, `browser`, `mock`, `gphoto2`) et imprimante (`auto`,
  `mock`, `cups`, `none`), commandes gphoto2 et options `lp` éditables sans toucher au code.
  En `auto`, la borne détecte le boîtier et l'imprimante toutes les 10 s et bascule à chaud,
  avec un repli explicite (webcam ; impression désactivée ou simulée). Le live view du boîtier
  ne tourne que pendant la prise de vue : au repos l'obturateur est refermé.
- **Stream Deck** : télécommande Elgato en USB, les touches reprennent les actions de l'écran
  en cours (pictogrammes, miniatures), pour une borne sans écran tactile. L'écran est détecté
  tactile ou non ; Écran & contrôle permet de forcer l'un ou l'autre, et règle le curseur.
- **Clé USB** : branchée sur la borne, les photos de l'événement en cours y sont copiées
  (originaux et montages), puis éjection depuis l'admin. **Mise à jour** depuis l'admin
  (page Installation) : version en cours, nouveautés sur GitHub, mise à jour et redémarrage.
- **Écran** : luminosité et volume de l'écran de la borne en DDC/CI (`m1ddc` sur Mac, `ddcutil`
  sur Linux), depuis l'admin, renvoyés à l'écran à chaque démarrage ; état dans le tableau de bord.
- **Galerie** (désactivée par défaut) : sur la borne, bouton « Galerie » à l'accueil pour parcourir
  les photos de l'événement en cours (grille, photo par photo, balayage) ; sur les téléphones,
  page `/galerie` sur le Wi-Fi de la borne. Réimpression depuis la borne seulement :
  désactivée, avec le code opérateur, ou libre (quota, papier et copies max appliqués).
- **Adresse publique** (facultative, ex. `https://photobooth.domain.fr`) : les QR codes de photo y
  mènent ; sur le Wi-Fi de la borne le domaine pointe vers elle, ailleurs une page distante
  (`npm run remote`) rappelle de rejoindre le Wi-Fi et affiche la photo dès que c'est fait.
- **QR code Wi-Fi** (désactivé par défaut) : en bas à droite de tous les écrans, il connecte le
  téléphone au hotspot de la borne en un scan (format `WIFI:` reconnu par iOS et Android).
- **Sessions** : historique par id, réimpression, lien galerie, suppression d'une session ou réinitialisation complète (fiches, photos et compteur). **Compteurs** : tirages, papier restant.

## Templates

Un template est une **pile de calques** posée sur le tirage, composée dans l'éditeur
visuel de l'admin (Templates → Modifier). Pour en créer un, il suffit d'un nom :
l'identifiant est déduit du nom et la taille du format choisi (10x15 paysage par défaut,
modifiable dans l'admin).

Calques disponibles, du bas vers le haut :

- **Photo** : emplacement d'une photo prise (Photo 1, Photo 2…). Plusieurs calques peuvent
  afficher la même photo, par exemple pour une bande dupliquée à découper. Le nombre de
  photos à prendre est déduit des calques.
- **Texte** : contenu multi-lignes, police, taille, gras, italique, couleur, alignement.
- **Image** : PNG, JPEG ou WebP envoyé depuis l'éditeur (logo, cadre créé dans Canva…).
- **Forme** : rectangle plein et/ou bordure, coins arrondis.

Chaque calque a une position, une taille, une **rotation** (poignée ronde au-dessus de la
sélection, Maj = pas de 15°, ou champ en degrés), une opacité et peut être masqué. Dans
l'éditeur, un calque ne peut pas sortir du cadre du tirage. Le rendu est
identique dans l'aperçu live de la borne, dans l'éditeur et à l'impression : même
recadrage « cover » centré des photos, même placement du texte.

Le fichier `data/templates/<id>/template.json` reste lisible et modifiable à la main :

```json
{
  "id": "mariage-julie-marc", "name": "Mariage Julie & Marc", "format": "10x15-paysage",
  "width": 1800, "height": 1200, "background": "#ffffff",
  "layers": [
    { "type": "photo", "shot": 0, "x": 60, "y": 60, "width": 1680, "height": 970, "radius": 24 },
    { "type": "rect",  "x": 0, "y": 1040, "width": 1800, "height": 160, "fill": "#1d3557" },
    { "type": "text",  "text": "Julie & Marc", "x": 0, "y": 1040, "width": 1800, "height": 160,
      "fontSize": 64, "font": "serif", "weight": "bold", "color": "#ffffff", "align": "center" },
    { "type": "image", "src": "assets/logo.png", "x": 1500, "y": 1060, "width": 240, "height": 120 }
  ]
}
```

Repères 300 dpi : 10x15 cm = 1800 × 1200 px (paysage) ou 1200 × 1800 (portrait), bande
5x15 = 600 × 1800. Les anciens templates « PNG + emplacements » sont convertis automatiquement
en calques au chargement. Sur la borne, installez les polices Liberation (`liberation-fonts`
sous Fedora, `fonts-liberation` sous Ubuntu) pour que les polices du serveur correspondent
à celles du navigateur.

## Structure

```
server/
  index.js          démarrage
  app.js            assemblage Express + WebSocket + routes
  booth.js          logique métier : sessions, reprises, copies, quotas, impression
  config.js         valeurs par défaut + data/config.json
  store.js          persistance JSON : événements, tirages, compteurs dans data/db.json ; une fiche session.json par dossier de session
  templates.js      chargement / validation / création des templates
  themes.js         thèmes livrés (data/themes) + thème personnalisé
  screen.js         écran de la borne en DDC/CI : luminosité, volume (m1ddc sur Mac, ddcutil sur Linux)
  compositor.js     montage final avec sharp
  camera/           browser · mock · gphoto2 (+ diffuseur MJPEG)
  printer/          mock · cups
  routes/           api.js (borne) · admin.js (PIN)
  gallery.js        pages téléphone : /g/:id (photo, tous les QR codes) et /galerie (grille)
electron/
  main.js           app de bureau : serveur dans le processus + fenêtre kiosque, ou plein écran classique pour les essais (Écran & contrôle)
scripts/kiosk/
  photobooth.sh           lanceur Linux : serveur + Chromium plein écran
  photobooth-electron.sh  lanceur Linux de l'app Electron du dépôt
  install-linux.sh        icône bureau, menu, lancement automatique
public/
  index.html booth.js booth.css    interface tactile
  admin.html admin.js admin.css    administration
data/
  config.json   réglages (créé au premier démarrage, modifiable depuis l'admin)
  db.json       événements, tirages, compteurs (les sessions : output/sessions/<id>/session.json, avec leurs photos)
  templates/    un dossier par template
  themes/       thèmes livrés
  samples/      photos de la caméra simulée
  uploads/      logos et fonds envoyés depuis l'admin
output/
  sessions/<id>/  photos brutes, final.jpg, thumb.jpg
  prints/         tirages de l'imprimante simulée
```

API principale (JSON) : `GET /api/bootstrap`, `POST /api/session`,
`POST /api/session/:id/shot/:index` (multipart `photo` en mode navigateur),
`POST /api/session/:id/compose`, `POST /api/session/:id/print {copies}`,
`POST /api/session/:id/unlock {pin}`, `GET /api/session/:id/qr`, `GET /api/live.mjpeg`.
Galerie : `GET /api/gallery` (borne si `gallery.booth`, téléphones si `gallery.web`),
`POST /api/gallery/:id/print {copies, pin?}` (depuis la borne uniquement, c'est-à-dire une
requête locale, selon `gallery.reprint`).
Admin sous `/api/admin/*` (cookie après `POST /api/admin/login`, ou en-tête `x-admin-pin`).
Sessions côté admin : `DELETE /api/admin/sessions/:id`, `POST /api/admin/sessions/reset`.
Arrêt : `POST /api/admin/shutdown` (refusé pendant une impression sauf `{force: true}`) ;
le serveur se ferme puis sort avec le code 0, que le lanceur lit comme un arrêt volontaire.

## Prochaines étapes

1. **Impression réelle** (pilote `cups` écrit, à valider) : imprimante à choisir
   (Selphy CP1500 en perso, DNP DS-RX1HS ou HiTi P525L en événementiel), pilote
   Gutenprint, nom de file et option `media` dans l'admin, calibrage des marges.
2. **Mini PC Linux** (HP EliteDesk 800 G3 commandé ; lanceurs écrits, à valider sur la
   machine) : écran tactile, veille, connexion automatique, `gvfs-gphoto2-volume-monitor`
   désactivé, hotspot Wi-Fi + `share.baseUrl` pour le QR code, `ddcutil` pour l'écran,
   vitesse du détourage précis (repli automatique sur le modèle rapide si trop lent).
3. **Répétition générale** sur le mini PC avec tout le matériel : 4 à 6 h, quelques centaines de
   séances, partage par QR code avec de vrais téléphones. La carte « Prêt pour l'événement » du
   tableau de bord liste ce qui reste à régler avant d'ouvrir la borne.

## Limites connues

- Persistance en JSON : une fiche par session dans son dossier, `data/db.json` pour les événements et
  les compteurs (historique des tirages limité aux 5000 derniers, compteurs non concernés). Suffisant
  pour des dizaines de milliers de sessions ; SQLite n'apporterait rien tant qu'un seul serveur écrit.
- L'authentification admin est un simple PIN : suffisant sur un réseau local fermé,
  pas pour une exposition sur internet.
