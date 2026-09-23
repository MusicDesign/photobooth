# Photo Booth

Borne photo tactile pensée pour tourner **hors ligne sur un Raspberry Pi**, avec un
**Canon EOS 2000D** piloté par gphoto2 et une imprimante photo via CUPS. Interface
web plein écran (Chromium en mode kiosque), backend Node.js.

État : **POC de l'étape 1**. Tout le flux invité fonctionne avec une caméra et une
imprimante simulées, testable sur un Mac. Les pilotes gphoto2 et CUPS sont écrits
mais pas encore validés avec le matériel (étapes 2 et 3).

## Démarrer sur le Mac

Guide complet pas à pas (Mac, boîtier Canon, imprimante, Raspberry Pi, jour J) :
[TUTORIEL.md](TUTORIEL.md).

```bash
npm install
npm run demo-assets   # génère 2 templates de démo + photos d'exemple (déjà fait une fois)
npm start             # http://localhost:3000  ·  admin : http://localhost:3000/admin.html (PIN 1234)
```

Par défaut la caméra est la **webcam du navigateur** (FaceTime, iPhone via Continuity
Camera, ou webcam USB) et l'imprimante est **simulée** : les tirages sont écrits dans
`output/prints/`. La webcam n'est accessible que sur `http://localhost` (contrainte
navigateur) : ouvrez la borne en local, pas via l'adresse IP.

```bash
npm run smoke                 # test de bout en bout, sans matériel (30 étapes, données temporaires)
node scripts/screenshots.js   # capture tous les écrans avec Chrome headless → output/screenshots/
BOOTH_CAMERA=mock npm start   # caméra simulée côté serveur (flux MJPEG), utile sans webcam
```

## Ce que fait le POC

Flux invité : accueil → choix du cadre (optionnel) → aperçu live **dans le template**
→ décompte → photos (1 ou plusieurs) → relecture avec **reprise photo par photo** →
**choix du nombre de copies** → impression → écran final avec **QR code** vers une galerie
locale.

Admin (`/admin.html`, ou 5 appuis en haut à droite de la borne) :

- **Limites** : copies max par passage, « sans impression » autorisé ou non, reprises
  max, validation automatique, décompte, **quota total de l'événement**, alerte papier,
  code opérateur pour lever la limite ponctuellement.
- **Thème** : nom de la borne, **logo** et image de fond valables pour tous les thèmes ;
  3 thèmes livrés (clair, sombre, festif) + couleurs personnalisées avec alerte de contraste ;
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
  en cours (pictogrammes, miniatures), pour une borne sans écran tactile.
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
en calques au chargement. Sur le Raspberry Pi, installez `fonts-liberation` pour que les
polices du serveur correspondent à celles du navigateur.

## Structure

```
server/
  index.js          démarrage
  app.js            assemblage Express + WebSocket + routes
  booth.js          logique métier : sessions, reprises, copies, quotas, impression
  config.js         valeurs par défaut + data/config.json
  store.js          persistance JSON (data/db.json) : sessions, tirages, compteurs
  templates.js      chargement / validation / création des templates
  themes.js         thèmes livrés (data/themes) + thème personnalisé
  compositor.js     montage final avec sharp
  camera/           browser · mock · gphoto2 (+ diffuseur MJPEG)
  printer/          mock · cups
  routes/           api.js (borne) · admin.js (PIN)
  gallery.js        page /g/:id ouverte depuis le QR code
public/
  index.html booth.js booth.css    interface tactile
  admin.html admin.js admin.css    administration
data/
  config.json   réglages (créé au premier démarrage, modifiable depuis l'admin)
  db.json       sessions et compteurs
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
Admin sous `/api/admin/*` (cookie après `POST /api/admin/login`, ou en-tête `x-admin-pin`).
Sessions côté admin : `DELETE /api/admin/sessions/:id`, `POST /api/admin/sessions/reset`.

## Prochaines étapes

2. **Canon 2000D via gphoto2** (pilote écrit, à valider) : `brew install gphoto2` sur le
   Mac pour un premier test, puis sur le Pi. Réglages boîtier : arrêt auto désactivé,
   Wi-Fi désactivé, carte SD insérée, objectif en manuel à distance fixe. Sur le Pi,
   désactiver `gvfs-gphoto2-volume-monitor`. Les commandes sont modifiables dans l'admin.
3. **Impression réelle** (pilote `cups` écrit, à valider) : imprimante à choisir
   (Selphy CP1500 en perso, DNP DS-RX1HS ou HiTi P525L en événementiel), pilote
   Gutenprint, nom de file et option `media` dans l'admin, calibrage des marges.
4. **Kiosque Raspberry Pi** : Raspberry Pi OS 64 bits, Chromium `--kiosk` au démarrage
   sur `http://localhost:3000`, écran tactile, veille désactivée, service systemd pour
   le serveur, hotspot Wi-Fi + `share.baseUrl` pour le QR code.
5. **Finitions** : profils d'événement, filtres, bouton physique GPIO, passage de la
   persistance JSON à SQLite, alignement magnétique dans l'éditeur.

## Limites connues du POC

- Persistance en fichier JSON : très bien pour un événement, à passer en SQLite pour
  des milliers de sessions.
- L'authentification admin est un simple PIN : suffisant sur un réseau local fermé,
  pas pour une exposition sur internet.
