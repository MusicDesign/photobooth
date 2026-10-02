# Tutoriel : configurer la borne de A à Z

Ce guide part d'un Mac pour les tests, puis passe sur le PC Linux de la borne
pour l'installation définitive. Chaque étape se termine par une vérification : ne
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
10. [Installer sur le PC de la borne (Linux)](#10-installer-sur-le-pc-de-la-borne-linux)
11. [Checklist du jour J](#11-checklist-du-jour-j)
12. [Dépannage](#12-dépannage)

---

## 1. Comprendre le montage

Trois briques, toujours les mêmes :

| Brique | Rôle | Où ça tourne |
|---|---|---|
| Serveur Node.js | Sessions, compositing, quotas, pilotes caméra et imprimante | Mac pour les tests, PC Linux en production |
| Écran de la borne | Page web plein écran, tactile | Chromium en kiosque ou app Electron sur le PC de la borne (ou un iPad récent en Accès guidé, voir 10.10) |
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
scripts/install.sh      # installe tout ce qui manque (Homebrew, Node.js, dépendances, gphoto2, m1ddc, modèle IA) puis lance la borne
npm run check           # l'état seulement
```

Un double-clic sur Cheeesy.app fait la même chose : si rien n'est installé, il ouvre le
Terminal sur ce script.

Le même bilan est dans l'admin → Installation (menu de gauche). À chaque démarrage, la
borne installe seule ce qui ne demande pas de mot de passe (Homebrew sur Mac, modèle IA,
cadres de démo) et signale le reste.

### 2.3 Démarrer

Deux commandes selon l'usage :

```bash
npm run dev     # développement : redémarre seul quand un fichier serveur change
npm start       # production : pas de surveillance, c'est celle de la borne
npm run app     # app de bureau plein écran (Electron), Ctrl+Maj+Q pour quitter
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
5 appuis en haut à droite de l'écran ouvrent aussi l'admin, dans la même
fenêtre ; sur le Stream Deck, les touches du haut dans l'ordre gauche, droite,
gauche, droite (moins de 1,5 s entre deux appuis). Le code admin est demandé,
son pavé s'affiche aussi sur le Stream Deck, qui propose ensuite retour à la
borne, déconnexion et arrêt. En bas du menu : **← Retour à la borne** (revient à l'accueil et
déconnecte l'admin), **Déconnexion**, et **Éteindre la borne** quand elle a été
lancée par l'icône ou au démarrage (étape 10.5).

Le menu de gauche : trois sections de travail, puis les réglages.

| Section | Ce qu'on y fait |
|---|---|
| Tableau de bord | Compteurs, état du matériel et du Wi-Fi, papier restant, remises à zéro |
| Événements & photos | Un dossier par événement : sessions, réimpression, exports, suppression |
| Templates | Création, éditeur de calques (dont le détourage), activation, template par défaut |
| Parcours invité | Décompte, reprises, relecture, miroir, filtres, retours à l'accueil, galerie de l'événement |
| Impression | Imprimante (auto, CUPS, options lp), copies par passage, quota, alerte papier |
| Partage | QR code des photos, Wi-Fi obligatoire ou non, adresses, QR code Wi-Fi de la borne |
| Apparence | Nom, logo, couleurs, police, tous les textes des écrans |
| Appareil photo | Caméra (pilote, flash, calibrage, commandes gphoto2 avancées) |
| Écran & contrôle | Écran (luminosité, volume), tactile ou boutons, curseur de la souris, fenêtre kiosque ou plein écran, Stream Deck |
| Lumières | Govee et Elgato du réseau local : ambiance à l'accueil (couleur ou blanc), prise de vue, état à l'arrêt de la borne |
| Sécurité | PIN admin, code opérateur |
| Installation | Ce qui est installé sur la machine, ce qui manque et comment l'obtenir ; installation en un clic |

**Première chose à faire : changer les codes** dans Sécurité.

- PIN admin (défaut `1234`) : celui qui ouvre cette page.
- Code opérateur (défaut `0000`) : saisi sur la borne, il lève la limite de
  copies pour un passage. À donner à la personne qui tient la borne.

**Vérification.** Déconnecte-toi, reconnecte-toi avec le nouveau PIN.

### La galerie de l'événement

Parcours invité → Galerie de l'événement. Trois réglages, tous désactivés au départ :

| Réglage | Effet |
|---|---|
| Sur la borne | Bouton « Galerie » en bas à gauche de l'accueil : grille des photos, puis photo par photo (flèches ‹ ›, balayage, ← → au clavier). Retour à l'accueil après 60 s sans geste |
| Réimpression | **Désactivée** (consultation seulement), **code opérateur** (l'équipe valide, le quota est levé comme sur la borne) ou **libre** (quota, papier et copies max par passage appliqués) |
| QR code sur chaque photo | Dans la visionneuse de la borne, le QR code de la photo affichée, pour la récupérer sur un téléphone |
| Sur les téléphones | Page `http://<adresse-de-la-borne>:3000/galerie`, et lien « Les photos de la soirée » sur la page du QR code. Consultation et téléchargement, jamais de réimpression |

Le QR code de l'**écran de fin** (après l'impression) se coupe à part, dans
la carte Partage (QR code). Il n'y a alors plus d'écran de fin : dès la fin de
l'impression, la borne revient à l'accueil et affiche quelques secondes le texte
`thanksNoQr` (Apparence).

La galerie montre les photos **validées** (« Je la garde » ou impression) de
l'événement en cours, les plus récentes d'abord. Changer d'événement dans
Événements & photos change la galerie. Attention : sur les téléphones, toute personne
connectée au Wi-Fi de la borne voit toutes les photos de la soirée.

**Vérification.** Galerie activée sur la borne, touche le bouton, ouvre une
photo, réimprime-la avec le code opérateur : le tirage sort et le compteur
avance.

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
se rabat qu'à la main. L'admin propose une option (Appareil photo → Flash
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
sudo dnf install gphoto2      # borne Linux (Fedora ; Ubuntu : sudo apt install gphoto2)
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

1. Admin → Appareil photo → Pilote caméra : **auto** (le défaut). La borne
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

Sur Mac, ajoute-la dans Réglages Système → Imprimantes. Sur la borne Linux :

```bash
sudo dnf install cups gutenprint-cups && sudo systemctl enable --now cups
# Ubuntu : sudo apt install cups printer-driver-gutenprint && sudo usermod -aG lpadmin $USER
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

Admin → Impression → Pilote imprimante : **auto** (le défaut) ou
**cups**. Nom de la file : celui de `lpstat`, obligatoire en auto pour ne
jamais imprimer sur une autre imprimante. Options lp, une par ligne, celles
du test manuel. Enregistre : c'est appliqué tout de suite. Lance un passage
complet avec 1 copie.

En auto, si l'imprimante est éteinte ou débranchée, la borne bascule sur le
repli : **none** (l'invité repart avec le QR code, message configurable dans
Apparence) ou **mock** (fichiers dans `output/prints`, pratique sur le
Mac). Sur la borne, garde **none** : jamais de faux tirage qui consomme le quota.

**Vérification.** Le tirage sort, la session passe en `done` dans Événements & photos, le
compteur « tirages imprimés » avance. Si les marges sont mauvaises, ajuste le
template dans l'éditeur (étape 8) plutôt que les options lp.

---

## 8. Personnaliser : thème, textes, templates

### 8.1 Apparence

- **Identité** : nom de la borne, délai de retour à l'accueil après l'écran final.
- **Thème actif** : une carte par thème livré (clair, sombre, festif, mariage, noir & or,
  néon, océan, forêt, corail, bonbon, entreprise, Noël), l'accueil de la borne en miniature
  dans ses couleurs, ou Personnalisé avec tes couleurs. Les trois écrans d'aperçu dessous
  montrent toujours le thème choisi.
  L'admin signale un contraste insuffisant entre le texte et le fond.
- **Logo** (PNG transparent ou SVG) et **image de fond** : valables pour tous
  les thèmes. Sans logo importé, le logo Cheeesy prend les couleurs du thème
  (aplat en couleur d'accent, lettres en « texte des boutons »).
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

Admin → Impression (limites) et Parcours invité (déroulé d'un passage).

| Réglage | Défaut | Conseil |
|---|---|---|
| Copies maximum par passage | 2 | 1 par personne sur la photo, plafonné à 3 |
| L'invité peut terminer sans imprimer | oui | Avec une imprimante branchée ; décoché, au moins un tirage par passage |
| Reprises de photo autorisées | 2 | 0 = aucune, case « Illimité » possible ; au-delà de 2 la file d'attente s'allonge |
| Validation automatique de la relecture | 30 s | Évite les sessions abandonnées devant l'écran |
| Retour à l'accueil si personne ne lance la photo | 30 s | Même idée à l'écran de prise de vue ; l'obturateur se referme au retour à l'accueil |
| Retour à l'accueil sur le choix du cadre et la galerie | 30 s | Sans interaction (écran, clavier ou Stream Deck) |
| Décompte avant la photo | 3 s | 3 à 5 selon le public |
| Quota de tirages de l'événement | 200 | Nombre de feuilles achetées pour la soirée |
| Alerte papier en dessous de | 20 | Le tableau de bord passe en orange |
| Copies maximum avec le code opérateur | 10 | Pour les demandes exceptionnelles |

Le papier restant se saisit dans le tableau de bord (Consommables) au moment
où tu charges l'imprimante ; il décroît à chaque tirage.

---

## 10. Installer sur le PC de la borne (Linux)

Cible : un PC tactile (tablette type Surface, mini-PC + écran tactile) sous
**Fedora Workstation** (bureau GNOME), processeur x86 64 bits. Ubuntu convient
aussi : les commandes équivalentes sont indiquées.

### 10.1 Système

Installe Fedora depuis une clé USB, avec un compte utilisateur dédié à la
borne (ex. `borne`). Sur une **Microsoft Surface**, ajoute le noyau
[linux-surface](https://github.com/linux-surface/linux-surface) (instructions
« Installation » du projet, section Fedora) : sans lui, l'écran tactile ne
répond pas. Redémarre et vérifie que le tactile marche avant d'aller plus loin.

### 10.2 Dépendances

```bash
sudo dnf install -y nodejs git gphoto2 cups gutenprint-cups chromium liberation-fonts
# Ubuntu : sudo apt install -y nodejs npm git gphoto2 cups printer-driver-gutenprint chromium-browser fonts-liberation
node -v      # v20 ou plus
scripts/install.sh --kiosk   # ou, depuis le projet : Node.js, les mêmes paquets (sudo) + ddcutil, NetworkManager, modèle IA, icône et lancement auto (10.5)
```

Chromium n'est utile qu'avec le lanceur par défaut (10.5) ; l'app Electron
embarque le sien.

### 10.3 Le projet

```bash
cd ~
git clone https://github.com/MusicDesign/photobooth.git
cd photobooth
npm install
npm start          # premier test sur http://localhost:3000, Ctrl+C ensuite
```

Le fichier `data/config.json` et le dossier `data/templates` peuvent être
copiés depuis le Mac pour garder le thème, les templates et les limites. Le
fichier `data/db.json` (événements, compteurs) et le dossier `output/sessions/` (une fiche
`session.json` par session, avec ses photos) forment la base : repars de zéro sur la borne.
Mise à jour plus tard : `git pull && npm install`, puis relancer la borne.

### 10.4 Libérer l'appareil photo

GNOME monte l'appareil comme une clé USB dès qu'on le branche, ce qui bloque
gphoto2. À désactiver une fois :

```bash
systemctl --user mask gvfs-gphoto2-volume-monitor
systemctl --user stop gvfs-gphoto2-volume-monitor
```

Puis refais le test de l'étape 5.2 (sans la ligne `killall`).

### 10.5 Plein écran au démarrage, icône sur le bureau

```bash
scripts/kiosk/install-linux.sh --no-sleep
```

Le script, pour l'utilisateur courant et sans sudo :

- pose l'icône **Cheeesy** sur le bureau et dans les applications ;
- lance la borne à l'ouverture de session (`~/.config/autostart`) ;
- avec `--no-sleep` : écran jamais éteint, pas de verrouillage (borne dédiée).

Deux lanceurs, au choix, avec le même comportement :

| Lanceur | Installation | Principe |
|---|---|---|
| Chromium en kiosque (défaut) | `install-linux.sh` | `scripts/kiosk/photobooth.sh` démarre le serveur Node puis Chromium plein écran, avec un profil à part |
| App Electron | `install-linux.sh --electron` | Serveur et fenêtre plein écran dans une seule app (`npm run app`) |
| App Electron empaquetée | `npm run app:build` puis `install-linux.sh --exec dist/Cheeesy-*.AppImage` | Un fichier unique ; ses données vont dans `~/.config/Cheeesy/` (`~/.config/Cheesy/` si la borne a été installée sous l'ancien nom) et non dans le dépôt |

L'AppImage se construit **sur la borne elle-même** : les modules natifs
(sharp, Stream Deck) sont propres au système.

Comportement :

- **Éteindre** : admin → bas du menu → **Éteindre la borne**. Le serveur
  s'arrête proprement (caméra, Stream Deck) et la fenêtre se ferme. Refusé
  pendant une impression, sauf confirmation.
- **Relancer** : icône Cheeesy du bureau. Un deuxième appui pendant que la
  borne tourne ne lance rien de plus.
- **Borne ↔ admin** : 5 appuis en haut à droite (ou G D G D sur les touches du
  haut du Stream Deck) ouvrent l'admin dans la même fenêtre ; **← Retour à la borne** revient à l'accueil et déconnecte l'admin
  (le prochain invité ne peut pas y entrer sans le code).
- **Plantage du serveur** : relancé en 3 s par le lanceur Chromium, la page se
  reconnecte seule.
- **Clavier branché** : Alt+F4 ferme la borne (serveur compris) ; dans l'app
  Electron, Ctrl+Maj+Q aussi.

Pour que la borne démarre **seule à l'allumage**, active la connexion
automatique : Paramètres → Système → Utilisateurs → **Connexion
automatique**. Sans elle, l'écran de connexion attend un mot de passe.

L'icône du bureau : GNOME n'affiche pas d'icônes sur le bureau par défaut.
Installe l'extension **Desktop Icons NG (DING)** avec le Gestionnaire
d'extensions, ou épingle Cheeesy au dock (Activités → clic droit →
Épingler). Retirer le tout : `install-linux.sh --uninstall`.

**Vérification.** Redémarre le PC : la borne s'affiche seule, plein écran.
Admin → Éteindre la borne : retour au bureau. Icône Cheeesy : la borne
revient. Journaux : `data/logs/launcher.log` (lanceur) et `data/logs/booth.log`
(serveur).

### 10.6 Pare-feu

Fedora bloque par défaut les connexions entrantes : sans cette règle, le QR
code et l'admin depuis un téléphone ne répondent pas.

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
# Ubuntu : rien à faire si ufw est inactif, sinon sudo ufw allow 3000/tcp
```

### 10.7 Hotspot Wi-Fi pour le QR code

Hors ligne, les invités récupèrent leur photo en se connectant au Wi-Fi de la
borne. Repère le nom de la carte Wi-Fi (`nmcli device`, colonne DEVICE,
type wifi, ex. `wlp1s0`) :

```bash
sudo nmcli device wifi hotspot ifname wlp1s0 ssid PhotoBooth password 'motdepasse-8-caracteres-min'
sudo nmcli connection modify Hotspot connection.autoconnect yes
```

La borne prend l'adresse `10.42.0.1`. Dans l'admin → Partage → URL de
base : `http://10.42.0.1:3000`.

**QR code Wi-Fi permanent.** Admin → Partage → Wi-Fi de la borne :
coche « Afficher le QR code Wi-Fi » et reprends le nom (`PhotoBooth`) et le mot
de passe du hotspot. Un petit QR code s'affiche alors en bas à droite de tous
les écrans de la borne : l'appareil photo d'un iPhone ou d'un Android propose
« Rejoindre le réseau » en un scan, sans rien taper. Choisis « Réseau ouvert »
si le hotspot n'a pas de mot de passe. Le QR code de l'écran final pointe alors vers
la galerie de la session. Écris le nom du Wi-Fi et le mot de passe sur la borne.

### 10.8 Adresse publique (QR code valable partout)

Sans elle, le QR code d'une photo pointe vers `http://10.42.0.1:3000/g/<id>` :
il ne marche que si le téléphone est **déjà** sur le Wi-Fi de la borne. Avec
une adresse publique, par exemple `https://photobooth.domain.fr`, le même lien
marche dans les deux cas :

| Le téléphone est… | `photobooth.domain.fr` mène à… | L'invité voit… |
|---|---|---|
| sur le Wi-Fi de la borne | la borne (son DNS répond `10.42.0.1`) | sa photo, directement |
| sur ses données mobiles | la page distante, hébergée chez toi | « Votre photo vous attend sur la borne » + le nom du Wi-Fi, puis sa photo toute seule dès qu'il a rejoint le Wi-Fi (vérification toutes les 3 s) |

Mise en place, une fois :

1. **Admin** → Partage → Adresse publique : `https://photobooth.domain.fr`.
   Active aussi le QR code Wi-Fi (étape 10.7) : la page distante affiche le nom
   du réseau (jamais le mot de passe, elle est publique).
2. **Page distante** : `npm run remote` produit `output/remote/`. Dépose son
   contenu à la racine de `photobooth.domain.fr` (Netlify, Cloudflare Pages,
   GitHub Pages, ou un hébergement Apache comme OVH : les règles de réécriture
   sont fournies). À refaire après un changement de nom, de thème ou de logo.
3. **DNS public** : un enregistrement pour `photobooth.domain.fr` vers
   l'hébergeur, avec une durée de cache courte (TTL 60 s).
4. **Sur la borne, le domaine pointe vers elle** (DNS du hotspot) :

```bash
echo 'address=/photobooth.domain.fr/10.42.0.1' | sudo tee /etc/NetworkManager/dnsmasq-shared.d/photobooth.conf
sudo nmcli connection down Hotspot && sudo nmcli connection up Hotspot
```

5. **HTTPS sur la borne** : sans certificat valide pour le domaine, le
   navigateur afficherait une alerte. Certificat gratuit Let's Encrypt, obtenu
   par validation DNS (la borne n'a pas besoin d'être joignable depuis
   internet), quand elle a une connexion :

```bash
sudo dnf install -y certbot
sudo certbot certonly --manual --preferred-challenges dns -d photobooth.domain.fr
# ajoute l'enregistrement TXT demandé chez ton registrar ; valable 90 jours, à renouveler
```

   Puis donne le certificat au serveur et fais arriver le port 443 dessus :

```bash
# variables du lanceur (ex. dans ~/.config/environment.d/photobooth.conf, puis reconnexion)
BOOTH_TLS_CERT=/etc/letsencrypt/live/photobooth.domain.fr/fullchain.pem
BOOTH_TLS_KEY=/etc/letsencrypt/live/photobooth.domain.fr/privkey.pem
# la clé doit être lisible par l'utilisateur de la borne :
sudo setfacl -R -m u:$USER:rX /etc/letsencrypt/live /etc/letsencrypt/archive
sudo firewall-cmd --permanent --add-forward-port=port=443:proto=tcp:toport=3443
sudo firewall-cmd --reload
```

**Vérification.** Téléphone sur ses données mobiles : scanne le QR code d'une
photo, la page d'attente s'affiche. Scanne le QR code Wi-Fi de la borne : en
quelques secondes, la photo apparaît. Si le téléphone reste bloqué sur la page
d'attente, il a gardé l'ancienne adresse en cache : attendre une minute, ou
couper et remettre le Wi-Fi.

Limite : un téléphone réglé sur un « DNS privé » forcé (réglage rare sur
Android) ignore le DNS de la borne et reste sur la page d'attente.

### 10.9 Stream Deck (utilisation sans écran tactile)

Un Stream Deck Elgato branché en USB sert de télécommande : ses touches
reprennent en permanence les actions de l'écran affiché, en pictogrammes aux
couleurs du thème (appareil photo pour commencer, coche pour garder, flèche
pour refaire, imprimante, − et +, QR code pour « sans impression », etc.). Les
choix de cadre et de photo à refaire montrent leur miniature. Le pavé du code
opérateur passe aussi sur les touches, en plusieurs pages sur un Mini.
Tous les modèles sont reconnus (Mini 6 touches, MK.2 15, XL 32, Neo, Plus), à
chaud, sans redémarrage. Réglages : admin → Écran & contrôle → Stream Deck.

- **Mac** : quitter l'application Stream Deck d'Elgato, qui réserve l'appareil.
- **Linux** : donner l'accès USB à l'utilisateur connecté, une fois :

```bash
sudo tee /etc/udev/rules.d/70-streamdeck.rules > /dev/null <<'RULES'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
KERNEL=="hidraw*", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
RULES
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Puis débrancher et rebrancher le Stream Deck. Le tableau de bord indique
« Stream Deck … connecté » avec le nombre de touches.

### 10.10 Écran et branchements

L'écran tactile du PC sert directement ; l'interface a un mode portrait et
paysage. Une tablette avec un seul port USB (Surface) demande un **hub USB
alimenté** pour le boîtier, l'imprimante et le Stream Deck, et reste branchée
sur secteur pendant l'événement.

**Luminosité et volume de l'écran** : admin → Écran & contrôle → Écran. La
borne parle à l'écran en DDC/CI, le canal de commande des moniteurs qui passe dans le
câble vidéo (HDMI, DisplayPort ou USB-C), avec `ddcutil` sur Linux
(`sudo apt install ddcutil`, module `i2c-dev` chargé, utilisateur ajouté au groupe
`i2c`) ou `m1ddc` sur Mac (`brew install m1ddc`). Coche « Régler l'écran depuis la
borne » : les valeurs sont envoyées tout de suite et à chaque démarrage. Le tableau de
bord montre l'écran détecté et ses valeurs. Certains écrans portables n'acceptent le
DDC/CI que sur un de leurs ports : « Relire l'écran » après avoir changé de câble.

Un iPad peut aussi servir d'écran s'il fait tourner iPadOS 16.2 ou plus :
ouvre `http://<ip-de-la-borne>:3000` dans Safari, active Accès guidé
(Réglages → Accessibilité) pour le verrouiller, et désactive le verrouillage
automatique. Un iPad trop ancien (iOS 9 et avant) ne convient pas.

---

## 11. Checklist du jour J

**La veille**

- [ ] Test complet sur la borne : allumage jusqu'au plein écran, passage, photo, impression, QR code lu depuis un téléphone, Éteindre puis relancer par l'icône.
- [ ] Papier et ruban chargés, nombre de feuilles saisi dans Consommables.
- [ ] Quota de l'événement = feuilles disponibles.
- [ ] Événements & photos → **Vider l'événement**, Tableau de bord → **Remettre à zéro** le compteur de tirages.
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
| « Could not claim the USB device » | macOS (`ptpcamerad`) ou le bureau Linux (`gvfs`) tient l'appareil | Mac : `killall ptpcamerad`. Linux : étape 10.4 |
| Aucun aperçu live, badge caméra en erreur | Live view coupé (boîtier endormi, câble, mode vidéo) | Arrêt auto désactivé, molette sur M, rebrancher ; le pilote relance le live toutes les 2 s tant qu'un écran l'attend |
| Badge caméra en erreur « Erreur d'acquisition vidéo », photos refusées, boîtier pourtant détecté | Déclencheur resté « enfoncé » côté USB après une commande interrompue | La borne relâche le déclencheur toute seule et relance ; à la main : `gphoto2 --set-config-index eosremoterelease=6 --set-config-index eosremoterelease=5`. En dernier recours, éteindre et rallumer le boîtier |
| Badge caméra OK mais « live view en veille » | Normal : aucun écran n'affiche l'aperçu, l'obturateur est fermé | Rien à faire, le live repart au premier appui sur la borne |
| Photo nette sur le décor, floue sur les gens | L'autofocus en live view a accroché le fond (zone AF centrale, pas de visage détecté) | Objectif en MF, mise au point faite sur une marque au sol ; ou méthode AF « Visage + suivi » et invités au centre |
| Photos floues ou traînées en mode P | Vitesse trop lente en intérieur (1/50 s et moins) | Mode M ou Tv à 1/125 s minimum, ISO en conséquence, ou plus de lumière |
| La photo échoue juste après le décompte | Autofocus qui échoue, ou pause trop courte après l'arrêt du live | Objectif en MF ; monter la pause à 1200–1500 ms |
| Photo prise mais « gphoto2 a terminé sans produire de fichier » | Boîtier en RAW ou RAW+JPEG | Qualité d'image : JPEG seul |
| Impression bloquée, erreur après 5 min | Papier, ruban, bourrage, mauvaise file | `lpstat -p`, vider la file avec `cancel -a`, vérifier le `media` |
| Webcam refusée en mode navigateur | Borne ouverte via l'adresse IP | Ouvrir sur `http://localhost:3000` (ou passer en pilote gphoto2 / mock) |
| La borne dit « L'imprimante n'est pas disponible » | Mode auto : file CUPS absente, désactivée, ou imprimante USB éteinte | Admin → Impression, bloc « En ce moment » donne la raison ; rallumer, puis « Détecter maintenant » |
| La borne utilise la webcam alors que le Canon est branché | Mode auto : boîtier pas encore détecté (éteint, endormi, câble) | Tableau de bord → raison affichée sous « Caméra » ; le boîtier est repris dès qu'il répond, 10 s au plus |
| La borne repasse en webcam une minute après l'allumage du Canon | Arrêt automatique du boîtier encore actif | Menu du boîtier → Arrêt auto : Désactiver (le 2000D ignore la commande USB) |
| Le serveur s'arrête au démarrage avec « gphoto2 introuvable » | Ancien comportement | Ne se produit plus : la borne démarre sur le repli et l'admin affiche l'erreur sous « Caméra » |
| Admin ou QR code inaccessibles depuis un téléphone | Pare-feu ou mauvais réseau | Port 3000 ouvert (étape 10.6), même Wi-Fi que la borne, adresse affichée au démarrage du serveur |
| L'icône du bureau n'apparaît pas | GNOME sans icônes de bureau | Extension Desktop Icons NG, ou lancer Cheeesy depuis Activités (étape 10.5) |
| L'icône du bureau ouvre un éditeur de texte | Lanceur non autorisé | Clic droit sur l'icône → Autoriser l'exécution |
| Rien ne s'ouvre au clic sur l'icône | Node ou Chromium introuvable, port 3000 pris | Lire `data/logs/launcher.log` |
| Le port 3000 est déjà utilisé | Une autre application écoute dessus | `PORT=3001` dans le lanceur, ou arrêter l'autre application |
| Une session reste en `shooting` ou `review` | Invité parti en cours de route | Normal ; elle se supprime dans Événements & photos, et la validation automatique limite le phénomène |

Journal du serveur : la sortie du terminal sur Mac, `data/logs/booth.log` partout
(`data/logs/launcher.log` pour le lanceur Linux ; `~/.config/Cheeesy/data/logs/`
pour l'AppImage). Les erreurs gphoto2 remontent aussi dans le tableau de bord, sous le
badge caméra.
