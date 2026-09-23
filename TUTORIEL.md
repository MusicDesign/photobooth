# Tutoriel : configurer la borne de A à Z

Ce guide part d'un Mac pour les tests, puis passe sur le Raspberry Pi pour
l'installation définitive. Chaque étape se termine par une vérification : ne
passe à la suivante que si elle est bonne.

Sommaire

1. [Comprendre le montage](#1-comprendre-le-montage)
2. [Installer et démarrer sur le Mac](#2-installer-et-démarrer-sur-le-mac)
3. [Premier tour dans l'admin](#3-premier-tour-dans-ladmin)
4. [Régler le Canon EOS 2000D](#4-régler-le-canon-eos-2000d)
5. [Brancher le Canon et tester gphoto2](#5-brancher-le-canon-et-tester-gphoto2)
6. [Activer le Canon dans la borne](#6-activer-le-canon-dans-la-borne)
7. [Configurer l'imprimante](#7-configurer-limprimante)
8. [Personnaliser : thème, textes, templates](#8-personnaliser--thème-textes-templates)
9. [Régler les limites d'impression](#9-régler-les-limites-dimpression)
10. [Installer sur le Raspberry Pi](#10-installer-sur-le-raspberry-pi)
11. [Checklist du jour J](#11-checklist-du-jour-j)
12. [Dépannage](#12-dépannage)

---

## 1. Comprendre le montage

Trois briques, toujours les mêmes :

| Brique | Rôle | Où ça tourne |
|---|---|---|
| Serveur Node.js | Sessions, compositing, quotas, pilotes caméra et imprimante | Mac pour les tests, Raspberry Pi en production |
| Écran de la borne | Page web plein écran, tactile | Chromium sur le Pi (ou un iPad récent en Accès guidé, voir 10.7) |
| Admin | Page web `/admin.html`, protégée par un PIN | N'importe quel navigateur sur le même réseau |

La caméra et l'imprimante se branchent **sur la machine qui fait tourner le
serveur**, jamais sur l'écran. Toute la configuration se fait dans l'admin et
finit dans `data/config.json` ; les photos vont dans `output/sessions/<id>/`.

---

## 2. Installer et démarrer sur le Mac

### 2.1 Prérequis

- Node.js 20 ou plus : `node -v`. Sinon installe-le via nvm ou nodejs.org.
- Homebrew (pour gphoto2 à l'étape 5) : `brew -v`.

### 2.2 Installation

```bash
cd /Applications/MAMP/htdocs/photo_booth
npm install
npm run demo-assets     # templates de démo + photos d'exemple (inutile si déjà fait)
```

### 2.3 Démarrer

Deux commandes selon l'usage :

```bash
npm run dev     # développement : redémarre seul quand un fichier serveur change
npm start       # production : pas de surveillance, c'est celle du Pi
```

Le port par défaut est 3000 (`PORT=8080 npm start` pour en changer). Deux
variables permettent de forcer un pilote sans toucher à la config, pratique
quand le serveur refuse de démarrer :

```bash
BOOTH_CAMERA=browser npm run dev    # webcam du navigateur
BOOTH_CAMERA=mock npm run dev       # caméra simulée côté serveur (flux MJPEG)
BOOTH_PRINTER=mock npm run dev      # imprimante simulée
```

Arrêter : Ctrl+C dans le terminal. Si tu ne retrouves pas le terminal :
`pkill -f "server/index.js"`.

**Vérification.** Le terminal affiche les adresses Borne, Admin et Réseau.
Ouvre http://localhost:3000 : l'accueil s'affiche et un passage complet
fonctionne avec la webcam du Mac. Attention : la webcam du navigateur n'est
accessible que sur `localhost`, pas via l'adresse IP (contrainte de sécurité
des navigateurs).

---

## 3. Premier tour dans l'admin

Ouvre http://localhost:3000/admin.html, PIN par défaut `1234`. Depuis la borne,
5 appuis en haut à droite de l'écran ouvrent aussi l'admin.

Sept sections dans le menu de gauche :

| Section | Ce qu'on y fait |
|---|---|
| Tableau de bord | Compteurs, état caméra et imprimante, papier restant, remises à zéro |
| Limites d'impression | Copies par passage, reprises, quota de l'événement, code opérateur |
| Thème & textes | Nom, logo, couleurs, police, tous les textes des écrans |
| Templates | Création, éditeur de calques, activation, template par défaut |
| Caméra & imprimante | Pilotes (dont le mode auto), commandes gphoto2, file CUPS et options lp |
| Sessions | Historique par id, réimpression, galerie, suppression, réinitialisation |
| Codes & partage | PIN admin, code opérateur, URL de base du QR code |

**Première chose à faire : changer les codes** dans Codes & partage.

- PIN admin (défaut `1234`) : celui qui ouvre cette page.
- Code opérateur (défaut `0000`) : saisi sur la borne, il lève la limite de
  copies pour un passage. À donner à la personne qui tient la borne.

**Vérification.** Déconnecte-toi, reconnecte-toi avec le nouveau PIN.

---

## 4. Régler le Canon EOS 2000D

À faire une fois, boîtier en main, avant tout branchement.

| Réglage | Valeur | Pourquoi |
|---|---|---|
| Molette | **M**, Av ou P | Les modes automatiques (A+, CA, Scène) gardent la main sur le flash et l'exposition ; en mode vidéo la photo à distance échoue |
| Qualité d'image | **JPEG L fine**, pas de RAW | Le serveur traite les JPEG uniquement ; en RAW+JPEG deux fichiers arrivent et le pilote n'en attend qu'un |
| Objectif | **MF**, mise au point faite à la distance des invités | L'autofocus en live view est lent et, s'il échoue, le déclenchement renvoie une erreur |
| Stabilisateur | OFF | Boîtier fixe sur trépied |
| Arrêt automatique | **Désactivé** (menu du boîtier, obligatoire) | Au repos la borne referme l'obturateur et ne parle plus au boîtier : avec l'arrêt auto (30 s par défaut) il s'éteint, et la borne repasse sur le repli. Le 2000D ignore la désactivation par USB, il faut passer par son menu |
| Wi-Fi / NFC | **Désactivés** | Le Wi-Fi actif coupe la liaison USB |
| Carte SD | Insérée | Le boîtier peut refuser de déclencher sans carte, même si la photo est téléchargée directement |
| Balance des blancs | Fixe, réglée sur la lumière de la salle | Même teinte sur tous les tirages |
| Alimentation | Coupleur secteur DR-E10 + ACK-E10 pour un événement | Le live view par USB vide une batterie en une à deux heures |

Point de départ en intérieur avec un éclairage LED continu :

```
M · 1/125 s · f/5.6 · ISO 800 · balance des blancs sur la lumière de la salle
```

Le flash intégré : en P/Av/M il ne se déclenche que s'il est levé, et il ne
se rabat qu'à la main. L'admin propose une option (Caméra & imprimante → Flash
intégré : off, on, auto avec seuil de luminosité) qui envoie la commande de
levée `popupflash` avant la photo, mais **le 2000D accepte cette commande sans
lever le flash** (vérifié : il ne se charge pas). Sur ce boîtier, le flash se
décide donc à la main : levé = à chaque photo, rabattu = jamais. Un éclairage
continu (panneau LED, ring light) reste de toute façon plus flatteur, sans yeux
rouges ni temps de recharge, et l'aperçu live reste fidèle à la photo.

---

## 5. Brancher le Canon et tester gphoto2

### 5.1 Installer gphoto2

```bash
brew install gphoto2          # Mac
sudo apt install gphoto2      # Raspberry Pi
```

### 5.2 Test en ligne de commande

Branche le boîtier en USB, allumé, molette sur M. Puis :

```bash
killall ptpcamerad 2>/dev/null   # Mac uniquement : libère l'appareil accaparé par macOS
gphoto2 --auto-detect            # doit lister "Canon EOS 2000D"
gphoto2 --summary                # infos du boîtier
gphoto2 --set-config capturetarget=0 --capture-image-and-download --filename test.jpg
```

Puis le live view, quelques secondes :

```bash
gphoto2 --capture-movie --stdout > live.mjpeg    # Ctrl+C après 3 s
ls -la live.mjpeg                                # taille > 0
```

**Vérification.** `test.jpg` existe et s'ouvre, `live.mjpeg` n'est pas vide.
Si l'app Transfert d'images s'ouvre au branchement, désactive son ouverture
automatique dans ses préférences. Si le PIN et le boîtier sont bons mais que
gphoto2 répond « Could not claim the USB device », relance `killall ptpcamerad`.

---

## 6. Activer le Canon dans la borne

1. Admin → Caméra & imprimante → Pilote caméra : **auto** (le défaut). La borne
   détecte le boîtier en USB et passe sur gphoto2 toute seule, en 10 secondes
   au plus ; s'il est éteint ou débranché, elle repasse sur le repli choisi
   (webcam du navigateur par défaut). Le bloc « En ce moment » dit quel pilote
   est actif et pourquoi ; « Détecter maintenant » force une vérification.
   Tu peux aussi imposer **gphoto2** en dur. Dans les deux cas, le changement
   s'applique immédiatement, sans redémarrage.
2. Laisse les commandes gphoto2 par défaut, elles correspondent au test de
   l'étape 5.
3. Ouvre la borne, lance un passage : l'aperçu live vient du Canon, la photo
   est prise par le Canon.

Réglages fins dans la même section :

- **Pause après arrêt du live avant capture** (800 ms par défaut) : monte à
  1200 ou 1500 si la photo échoue juste après l'arrêt du live. Cette pause est
  prise pendant le décompte.
- **Mise au point pendant le décompte** : dès le début du décompte, la borne
  coupe le live, laisse le miroir redescendre et ouvre une seule liaison
  gphoto2 qui fait la mise au point (demi-pression, par le viseur : rapide et
  fiable), attend, puis **déclenche pile à « 0 » sans refaire le point** et
  récupère le JPEG dès qu'il est prêt, environ une seconde plus tard. Le
  déclenchement est calé côté serveur, il ne dépend pas du réseau. L'aperçu se
  fige sur la dernière image pendant le décompte, puis l'obturateur dessiné se
  referme avec le flash jusqu'à l'arrivée de la photo. Un décompte de 4 ou 5 s
  laisse une phase de live visible avant le gel de l'image. Vider la case
  « Décompte : mise au point puis déclenchement » revient à l'ancien
  comportement (tout à « 0 », 3 s de plus).
  Objectif en MF : la demi-pression ne bouge rien, tout reste valable.
- **Aperçu live via gphoto2** : décoche la case pour désactiver le live
  (l'invité voit alors un cadre sans aperçu, mais la photo marche quand même).
- **Coupure du live view quand l'aperçu n'est plus affiché** (8 s par défaut) :
  hors prise de vue, le serveur arrête gphoto2 et le boîtier referme son
  obturateur (miroir baissé, capteur et batterie au repos). Le live redémarre
  dès qu'un invité touche l'écran d'accueil ; pendant la seconde ou deux que
  met le boîtier, l'emplacement montre un obturateur à lamelles fermé, qui
  s'ouvre sur le flux à la première image. Le tableau de bord affiche au repos
  « live view en veille ».

**Vérification.** Tableau de bord → Caméra `gphoto2` avec le badge OK. Une
photo prise depuis la borne apparaît dans `output/sessions/<id>/`.

---

## 7. Configurer l'imprimante

### 7.1 D'abord sans imprimante

Pilote **mock** (défaut) : chaque tirage est écrit dans `output/prints/` comme
un JPEG, à la taille exacte du template. Ouvre-les pour vérifier le cadrage
avant d'engager du papier.

### 7.2 Déclarer l'imprimante dans CUPS

Sur Mac, ajoute-la dans Réglages Système → Imprimantes. Sur le Pi :

```bash
sudo apt install cups printer-driver-gutenprint
sudo usermod -aG lpadmin $USER      # puis déconnexion / reconnexion
```

Puis http://localhost:631 → Administration → Ajouter une imprimante, avec le
pilote Gutenprint correspondant (Canon Selphy, DNP, HiTi…).

### 7.3 Trouver le nom de file et le format papier

```bash
lpstat -p -d                  # noms des files, imprimante par défaut
lpoptions -p NOM -l           # options supportées, dont la liste des "media"
```

Exemples de `media` : `Postcard` (10x15 sur Selphy), `w288h432` (4x6 pouces
sur DNP). Prends celui qui correspond au papier chargé.

### 7.4 Test manuel

```bash
lp -d NOM -o media=Postcard -o fit-to-page output/prints/<un-tirage>.jpg
lpstat -W not-completed -o    # la file doit se vider quand le tirage sort
```

### 7.5 Activer dans la borne

Admin → Caméra & imprimante → Pilote imprimante : **auto** (le défaut) ou
**cups**. Nom de la file : celui de `lpstat`, obligatoire en auto pour ne
jamais imprimer sur une autre imprimante. Options lp, une par ligne, celles
du test manuel. Enregistre : c'est appliqué tout de suite. Lance un passage
complet avec 1 copie.

En auto, si l'imprimante est éteinte ou débranchée, la borne bascule sur le
repli : **none** (l'invité repart avec le QR code, message configurable dans
Thème & textes) ou **mock** (fichiers dans `output/prints`, pratique sur le
Mac). Sur le Pi, garde **none** : jamais de faux tirage qui consomme le quota.

**Vérification.** Le tirage sort, la session passe en `done` dans Sessions, le
compteur « tirages imprimés » avance. Si les marges sont mauvaises, ajuste le
template dans l'éditeur (étape 8) plutôt que les options lp.

---

## 8. Personnaliser : thème, textes, templates

### 8.1 Thème & textes

- **Identité** : nom de la borne, délai de retour à l'accueil après l'écran final.
- **Thème actif** : clair, sombre, festif, ou Personnalisé avec tes couleurs.
  L'admin signale un contraste insuffisant entre le texte et le fond.
- **Logo** (PNG transparent ou SVG) et **image de fond** : valables pour tous
  les thèmes.
- **Textes des écrans** : chaque phrase vue par l'invité est modifiable, y
  compris le message quand le quota est atteint.

Les changements s'appliquent sur la borne en direct, sans redémarrage.

### 8.2 Templates

Un template est le tirage final : une pile de calques (photos, textes, images,
formes) à la taille du papier.

1. Templates → Nouveau template : un nom suffit, choisis le format
   (10x15 paysage ou portrait, bande…) puis **Créer et ouvrir l'éditeur**.
   L'identifiant est déduit du nom.
2. Dans l'éditeur (bouton **Modifier** sur un template existant) : glisse,
   redimensionne, tourne les calques,
   ajoute un texte (nom de l'événement, date), un logo, une forme de fond.
   Le nombre de calques photo définit le nombre de prises de vue.
3. Sur la carte du template, coche **Activé** pour le proposer à l'invité et
   **Par défaut** pour celui qui s'impose quand l'invité ne choisit pas. La case
   « L'invité choisit son template » décide si l'écran de choix apparaît.

**Vérification.** Avec l'imprimante mock, lance un passage par template et
ouvre le résultat dans `output/prints/`.

---

## 9. Régler les limites d'impression

Admin → Limites d'impression.

| Réglage | Défaut | Conseil |
|---|---|---|
| Copies maximum par passage | 2 | 1 par personne sur la photo, plafonné à 3 |
| Autoriser « sans impression » (QR code seulement) | oui | Garde-le, ça économise le papier |
| Reprises de photo autorisées | 2 | 0 = aucune, case « Illimité » possible ; au-delà de 2 la file d'attente s'allonge |
| Validation automatique de la relecture | 30 s | Évite les sessions abandonnées devant l'écran |
| Retour à l'accueil si personne ne lance la photo | 30 s | Même idée à l'écran de prise de vue ; l'obturateur se referme au retour à l'accueil |
| Décompte avant la photo | 3 s | 3 à 5 selon le public |
| Quota total de tirages | 200 | Nombre de feuilles achetées pour la soirée |
| Alerte papier en dessous de | 20 | Le tableau de bord passe en orange |
| Copies maximum avec le code opérateur | 10 | Pour les demandes exceptionnelles |

Le papier restant se saisit dans le tableau de bord (Consommables) au moment
où tu charges l'imprimante ; il décroît à chaque tirage.

---

## 10. Installer sur le Raspberry Pi

Testé sur Raspberry Pi OS Bookworm **64 bits** (indispensable pour sharp).

### 10.1 Système et dépendances

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y gphoto2 cups printer-driver-gutenprint git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # v20 ou plus
```

### 10.2 Le projet

Copie le dossier du projet (sans `node_modules`, `output` ni `data/db.json`)
dans `/home/pi/photo_booth`, puis :

```bash
cd /home/pi/photo_booth
npm install
npm start          # premier test, Ctrl+C ensuite
```

Le fichier `data/config.json` peut être copié depuis le Mac pour garder le
thème, les templates (dossier `data/templates`) et les limites. Le fichier
`data/db.json` est la base de sessions : repars de zéro sur le Pi.

### 10.3 Libérer l'appareil photo

Le bureau du Pi monte l'appareil comme une clé USB dès qu'on le branche, ce
qui bloque gphoto2. À désactiver une fois :

```bash
systemctl --user mask gvfs-gphoto2-volume-monitor
systemctl --user stop gvfs-gphoto2-volume-monitor
```

Puis refais le test de l'étape 5.2 (sans la ligne `killall`).

### 10.4 Le serveur au démarrage (systemd)

```bash
sudo tee /etc/systemd/system/photo-booth.service > /dev/null <<'UNIT'
[Unit]
Description=Photo Booth
After=network.target

[Service]
User=pi
WorkingDirectory=/home/pi/photo_booth
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now photo-booth
sudo systemctl status photo-booth       # "active (running)"
```

Ensuite : `sudo systemctl restart photo-booth` pour redémarrer,
`journalctl -u photo-booth -f` pour lire les logs.

### 10.5 Chromium en kiosque

1. `sudo raspi-config` → System Options → Boot / Auto Login → **Desktop
   Autologin**, et Display Options → Screen Blanking → **No**.
2. Lancement automatique de Chromium en plein écran. Sur Bookworm récent
   (bureau labwc) :

```bash
mkdir -p ~/.config/labwc
cat >> ~/.config/labwc/autostart <<'AUTO'
chromium-browser --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --check-for-update-interval=31536000 http://localhost:3000 &
AUTO
```

Si ton Pi utilise encore Wayfire, la même commande va dans la section
`[autostart]` de `~/.config/wayfire.ini` (`chromium = chromium-browser --kiosk …`).

3. Redémarre : la borne s'affiche seule, plein écran, tactile. L'admin reste
   accessible depuis un autre appareil du réseau sur `http://<ip-du-pi>:3000/admin.html`.

### 10.6 Hotspot Wi-Fi pour le QR code

Hors ligne, les invités récupèrent leur photo en se connectant au Wi-Fi du Pi :

```bash
sudo nmcli device wifi hotspot ifname wlan0 ssid PhotoBooth password 'motdepasse-8-caracteres-min'
sudo nmcli connection modify Hotspot connection.autoconnect yes
```

Le Pi prend l'adresse `10.42.0.1`. Dans l'admin → Codes & partage → URL de
base : `http://10.42.0.1:3000`. Le QR code de l'écran final pointe alors vers
la galerie de la session. Écris le nom du Wi-Fi et le mot de passe sur la borne.

### 10.7 Stream Deck (utilisation sans écran tactile)

Un Stream Deck Elgato branché en USB sert de télécommande : ses touches
reprennent en permanence les actions de l'écran affiché, en pictogrammes aux
couleurs du thème (appareil photo pour commencer, coche pour garder, flèche
pour refaire, imprimante, − et +, QR code pour « sans impression », etc.). Les
choix de cadre et de photo à refaire montrent leur miniature. Le pavé du code
opérateur passe aussi sur les touches, en plusieurs pages sur un Mini.
Tous les modèles sont reconnus (Mini 6 touches, MK.2 15, XL 32, Neo, Plus), à
chaud, sans redémarrage. Réglages : admin → Caméra & imprimante → Stream Deck.

- **Mac** : quitter l'application Stream Deck d'Elgato, qui réserve l'appareil.
- **Pi** : donner l'accès USB sans sudo, une fois :

```bash
sudo tee /etc/udev/rules.d/50-streamdeck.rules > /dev/null <<'RULES'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", MODE="0660", GROUP="plugdev"
KERNEL=="hidraw*", ATTRS{idVendor}=="0fd9", MODE="0660", GROUP="plugdev"
RULES
sudo usermod -aG plugdev $USER
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Puis débrancher et rebrancher le Stream Deck. Le tableau de bord indique
« Stream Deck … connecté » avec le nombre de touches.

### 10.8 Écran

Écran tactile officiel 7 pouces branché au Pi : rien à configurer, l'interface
a un mode portrait et paysage. Un iPad peut aussi servir d'écran s'il fait
tourner iPadOS 16.2 ou plus : ouvre `http://<ip-du-pi>:3000` dans Safari,
active Accès guidé (Réglages → Accessibilité) pour le verrouiller, et désactive
le verrouillage automatique. Un iPad trop ancien (iOS 9 et avant) ne convient pas.

---

## 11. Checklist du jour J

**La veille**

- [ ] Test complet sur le Pi : passage, photo, impression, QR code lu depuis un téléphone.
- [ ] Papier et ruban chargés, nombre de feuilles saisi dans Consommables.
- [ ] Quota de l'événement = feuilles disponibles.
- [ ] Sessions → **Réinitialiser les sessions**, Tableau de bord → **Remettre à zéro** le compteur de tirages.
- [ ] Batterie du boîtier ou coupleur secteur, objectif en MF avec mise au point faite sur place.
- [ ] Codes admin et opérateur changés, code opérateur donné à l'équipe.

**Sur place**

- [ ] Boîtier en M, réglages ajustés à la lumière réelle, une photo test imprimée.
- [ ] Balance des blancs refaite si l'éclairage a changé.
- [ ] Hotspot visible depuis un téléphone, QR code testé.
- [ ] Tableau de bord ouvert sur un téléphone ou une tablette pour surveiller papier et quota.

**Après**

- [ ] Récupérer `output/sessions/` (toutes les photos) et `output/prints/` si mock.
- [ ] Réinitialiser les sessions pour le prochain événement.

---

## 12. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| « Could not claim the USB device » | macOS (`ptpcamerad`) ou le bureau du Pi (`gvfs`) tient l'appareil | Mac : `killall ptpcamerad`. Pi : étape 10.3 |
| Aucun aperçu live, badge caméra en erreur | Live view coupé (boîtier endormi, câble, mode vidéo) | Arrêt auto désactivé, molette sur M, rebrancher ; le pilote relance le live toutes les 2 s tant qu'un écran l'attend |
| Badge caméra en erreur « Erreur d'acquisition vidéo », photos refusées, boîtier pourtant détecté | Déclencheur resté « enfoncé » côté USB après une commande interrompue | La borne relâche le déclencheur toute seule et relance ; à la main : `gphoto2 --set-config-index eosremoterelease=6 --set-config-index eosremoterelease=5`. En dernier recours, éteindre et rallumer le boîtier |
| Badge caméra OK mais « live view en veille » | Normal : aucun écran n'affiche l'aperçu, l'obturateur est fermé | Rien à faire, le live repart au premier appui sur la borne |
| Photo nette sur le décor, floue sur les gens | L'autofocus en live view a accroché le fond (zone AF centrale, pas de visage détecté) | Objectif en MF, mise au point faite sur une marque au sol ; ou méthode AF « Visage + suivi » et invités au centre |
| Photos floues ou traînées en mode P | Vitesse trop lente en intérieur (1/50 s et moins) | Mode M ou Tv à 1/125 s minimum, ISO en conséquence, ou plus de lumière |
| La photo échoue juste après le décompte | Autofocus qui échoue, ou pause trop courte après l'arrêt du live | Objectif en MF ; monter la pause à 1200–1500 ms |
| Photo prise mais « gphoto2 a terminé sans produire de fichier » | Boîtier en RAW ou RAW+JPEG | Qualité d'image : JPEG seul |
| Impression bloquée, erreur après 5 min | Papier, ruban, bourrage, mauvaise file | `lpstat -p`, vider la file avec `cancel -a`, vérifier le `media` |
| Webcam refusée en mode navigateur | Borne ouverte via l'adresse IP | Ouvrir sur `http://localhost:3000` (ou passer en pilote gphoto2 / mock) |
| La borne dit « L'imprimante n'est pas disponible » | Mode auto : file CUPS absente, désactivée, ou imprimante USB éteinte | Admin → Caméra & imprimante, bloc « En ce moment » donne la raison ; rallumer, puis « Détecter maintenant » |
| La borne utilise la webcam alors que le Canon est branché | Mode auto : boîtier pas encore détecté (éteint, endormi, câble) | Tableau de bord → raison affichée sous « Caméra » ; le boîtier est repris dès qu'il répond, 10 s au plus |
| La borne repasse en webcam une minute après l'allumage du Canon | Arrêt automatique du boîtier encore actif | Menu du boîtier → Arrêt auto : Désactiver (le 2000D ignore la commande USB) |
| Le serveur s'arrête au démarrage avec « gphoto2 introuvable » | Ancien comportement | Ne se produit plus : la borne démarre sur le repli et l'admin affiche l'erreur sous « Caméra » |
| Admin inaccessible depuis un autre appareil | Pare-feu ou mauvais réseau | Même Wi-Fi que le Pi, adresse affichée au démarrage du serveur |
| Une session reste en `shooting` ou `review` | Invité parti en cours de route | Normal ; elle se supprime dans Sessions, et la validation automatique limite le phénomène |

Journal du serveur : la sortie du terminal sur Mac, `journalctl -u photo-booth -f`
sur le Pi. Les erreurs gphoto2 remontent aussi dans le tableau de bord, sous le
badge caméra.
