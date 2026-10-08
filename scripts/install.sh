#!/usr/bin/env bash
# Installation complète de la borne, selon le système et ce qui manque, puis lancement.
#   scripts/install.sh                installe ce qui manque et lance la borne (app de bureau)
#   scripts/install.sh --kiosk        idem, plus le lancement automatique à l'ouverture de session (borne dédiée) :
#                                     élément d'ouverture sur macOS, icône bureau + autostart + écran jamais éteint sur Linux
#   scripts/install.sh --no-start     installe seulement
#   scripts/install.sh --check        affiche l'état, n'installe rien
#   scripts/install.sh --no-models    sans le modèle IA de détourage précis (114 Mo)
#   scripts/install.sh --step=node|deps|modules   une seule étape, sans lancement (utilisé par l'icône Cheeesy.app)
# Systèmes : macOS (Homebrew installé au besoin), Linux Debian/Ubuntu (apt), Fedora (dnf), Arch (pacman), le mot de
# passe sudo étant demandé pour les paquets ; Windows via Git Bash délègue à scripts/install.ps1.
# Le script fait lui-même le gestionnaire de paquets, Node.js 22.12+ et npm install (binaire Electron compris) ; le
# reste (gphoto2, CUPS, ddcutil ou m1ddc, NetworkManager, Chromium sans app Electron, modèle IA, cadres de démo) passe par
# `npm run setup`, qui n'installe que ce qui manque. Relançable à volonté : ce qui est déjà là est sauté.
set -euo pipefail
cd "$(dirname "$0")/.."

START=1; CHECK=0; KIOSK=0; STEP=""; SETUP_ARGS=(); PS_ARGS=()
for a in "$@"; do
  case "$a" in
    --no-start) START=0; PS_ARGS+=(-NoStart) ;;
    --check) CHECK=1; START=0; PS_ARGS+=(-Check) ;;
    --no-models) SETUP_ARGS+=(--no-models); PS_ARGS+=(-NoModels) ;;
    --kiosk) KIOSK=1 ;;
    --step=*) STEP="${a#--step=}"; START=0; KIOSK=0 ;;
    *) echo "Option inconnue : $a (voir l'en-tête de $0)"; exit 2 ;;
  esac
done
want() { [ -z "$STEP" ] || [ "$STEP" = "$1" ]; } # étape demandée (toutes sans --step)
say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" # Homebrew, même si le terminal ne le connaît pas encore
OS="$(uname -s)"

# 1. Système et gestionnaire de paquets
PM=""
case "$OS" in
  Darwin)
    if ! have brew && [ "$CHECK" = 0 ] && want node; then
      say "Homebrew"
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
    fi
    PM=brew; [ -n "$STEP" ] || echo "macOS $(sw_vers -productVersion 2>/dev/null || true) · Homebrew" ;;
  Linux)
    if have apt-get; then PM=apt; elif have dnf; then PM=dnf; elif have pacman; then PM=pacman; fi
    [ -n "$STEP" ] || echo "Linux $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || true) · ${PM:-gestionnaire de paquets inconnu}" ;;
  MINGW*|MSYS*|CYGWIN*)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 ${PS_ARGS[@]+"${PS_ARGS[@]}"} ;;
  *) echo "Système non géré : $OS"; exit 1 ;;
esac

# 2. Node.js 22.12 ou plus (le binaire Electron se télécharge avec, depuis Electron 44.7)
node_ok() { have node && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; }
if want node; then
  if ! node_ok; then
    if [ "$CHECK" = 1 ]; then echo "✗ Node.js 22.12 ou plus absent"; exit 1; fi
    say "Node.js"
    case "$PM" in
      brew) brew install node ;;
      apt) # curl n'est pas installé d'office sur une Debian neuve
        have curl || sudo apt-get install -y curl ca-certificates
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs ;;
      dnf) sudo dnf install -y nodejs npm ;;
      pacman) sudo pacman -S --noconfirm --needed nodejs npm ;;
      *) echo "Node.js 22.12 ou plus requis (nodejs.org)"; exit 1 ;;
    esac
    # Une commande en échec dans « a && b » n'arrête pas le script (set -e) : on vérifie le résultat.
    node_ok || { echo "Node.js n'a pas pu être installé (réseau ?). Relancez ce script."; exit 1; }
  fi
  echo "Node.js $(node -v) · npm $(npm -v)"
fi

# 3. Dépendances npm, binaire Electron compris (son téléchargement est une étape à part, qui peut avoir échoué)
if want deps; then
  if [ ! -d node_modules/sharp ] || [ ! -d node_modules/electron ]; then
    if [ "$CHECK" = 1 ]; then echo "✗ Dépendances npm absentes : npm install"; else say "Dépendances npm"; npm install --no-audit --no-fund; fi
  fi
  if [ "$CHECK" = 0 ] && [ -d node_modules/electron ] && [ ! -d node_modules/electron/dist ]; then
    say "Binaire Electron"
    node node_modules/electron/install.js
    [ -d node_modules/electron/dist ] || { echo "Le binaire Electron n'a pas pu être téléchargé (réseau ?). Relancez ce script."; exit 1; }
  fi
fi

# 4. Le reste, selon ce qui manque (server/setup.js)
if [ "$CHECK" = 1 ]; then npm run --silent check; exit $?; fi
if want modules; then
  say "Modules nécessaires"
  # Indispensable manquant (gphoto2…) : les réglages de la borne dédiée se font quand même, le script échoue à la fin.
  npm run --silent setup -- ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} || SETUP_FAILED=1
fi

# 5. Borne dédiée : lancement automatique à l'ouverture de session, selon le système
if [ "$KIOSK" = 1 ]; then
  say "Lancement automatique"
  if [ "$OS" = Darwin ]; then
    osascript -e "tell application \"System Events\" to if not (exists login item \"Cheeesy\") then make login item at end with properties {path:\"$PWD/Cheeesy.app\", hidden:false}" >/dev/null
    echo "Élément d'ouverture ajouté"
  else
    # Icône Cheeesy visible sur le bureau GNOME (pour relancer la borne) : extension Desktop Icons NG.
    if [ "$PM" = apt ] && have gnome-shell && [ ! -d /usr/share/gnome-shell/extensions/ding@rastersoft.com ]; then
      sudo apt-get install -y gnome-shell-extension-desktop-icons-ng || echo "Desktop Icons NG non installée : pas d'icônes sur le bureau"
    fi
    scripts/kiosk/install-linux.sh --electron --no-sleep
    # Ubuntu 23.10+ : AppArmor interdit les espaces de noms utilisateur aux applications sans profil, et Electron
    # (bac à sable de Chromium) plante au lancement. Profil qui les autorise pour le binaire Electron du dépôt.
    AA_FILE=/etc/apparmor.d/cheeesy-electron
    if [ -d /etc/apparmor.d ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
      AA_WANT="abi <abi/4.0>,
include <tunables/global>

profile cheeesy-electron \"$PWD/node_modules/electron/dist/electron\" flags=(unconfined) {
  userns,

  include if exists <local/cheeesy-electron>
}"
      if [ "$(cat "$AA_FILE" 2>/dev/null)" != "$AA_WANT" ]; then
        printf '%s\n' "$AA_WANT" | sudo tee "$AA_FILE" >/dev/null
        if sudo apparmor_parser -r "$AA_FILE"; then echo "Profil AppArmor d'Electron installé ($AA_FILE)"
        else echo "Profil AppArmor d'Electron : échec de apparmor_parser"; KIOSK_FAILED=1; fi
      fi
    fi
    # Connexion automatique (GDM) : à l'allumage, la borne démarre seule au lieu d'attendre un mot de passe.
    for f in /etc/gdm3/daemon.conf /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
      [ -f "$f" ] || continue
      if ! grep -qx "AutomaticLogin=$USER" "$f"; then
        sudo sed -i '/^AutomaticLoginEnable=/d; /^AutomaticLogin=/d' "$f"
        grep -q '^\[daemon\]' "$f" || echo '[daemon]' | sudo tee -a "$f" >/dev/null
        sudo sed -i "/^\[daemon\]/a AutomaticLoginEnable=true\nAutomaticLogin=$USER" "$f"
      fi
      echo "Connexion automatique de $USER ($f)"
      break
    done
    # Écran de démarrage (Plymouth) : thème Cheeesy (scripts/kiosk/plymouth), logo public/assets/bootlogo.png.
    # L'activation reconstruit l'image de démarrage (initramfs, une trentaine de secondes) : seulement quand le thème
    # ou le logo changent. Il faut le module « script » de Plymouth (paquet plymouth-plugin-script sous Fedora).
    PLY_SET=/usr/sbin/plymouth-set-default-theme PLY_DIR=/usr/share/plymouth/themes/cheeesy
    PLY_SCRIPT="$(ls /usr/lib*/plymouth/script.so /usr/lib/*/plymouth/script.so 2>/dev/null | head -1 || true)"
    if [ ! -x "$PLY_SET" ] || [ -z "$PLY_SCRIPT" ]; then echo "Écran de démarrage : Plymouth (module script) absent, logo Cheeesy non installé"
    elif [ "$("$PLY_SET" 2>/dev/null || true)" != cheeesy ] || ! cmp -s public/assets/bootlogo.png "$PLY_DIR/bootlogo.png" || ! cmp -s scripts/kiosk/plymouth/cheeesy.script "$PLY_DIR/cheeesy.script"; then
      sudo mkdir -p "$PLY_DIR"
      sudo cp scripts/kiosk/plymouth/cheeesy.plymouth scripts/kiosk/plymouth/cheeesy.script public/assets/bootlogo.png "$PLY_DIR/"
      echo "Écran de démarrage : reconstruction de l'image de démarrage…"
      if PLY_ERR="$(sudo "$PLY_SET" -R cheeesy 2>&1 >/dev/null)"; then echo "Écran de démarrage Cheeesy installé"
      else echo "Écran de démarrage : échec de plymouth-set-default-theme"; echo "$PLY_ERR" | tail -5; KIOSK_FAILED=1; fi
    fi
    # Menu de démarrage (GRUB) masqué : démarrage direct, menu toujours joignable en maintenant Échap ou Maj.
    # « splash » sur la ligne du noyau : Plymouth affiche le logo au lieu des messages de démarrage.
    # plymouth.ignore-serial-consoles : avec une console série (VM UTM : ttyAMA0), Plymouth forcerait le texte.
    # update-grub et grub2-mkconfig sont dans /usr/sbin, hors du PATH d'un utilisateur Debian : chemins complets.
    # Le menu est régénéré tant qu'il est plus ancien que le réglage (une régénération ratée est retentée).
    # Fedora : pas de GRUB_CMDLINE_LINUX_DEFAULT, la ligne du noyau de chaque entrée se règle avec grubby.
    if [ -f /etc/default/grub ]; then
      if ! grep -qx 'GRUB_TIMEOUT=0' /etc/default/grub || ! grep -qx 'GRUB_TIMEOUT_STYLE=hidden' /etc/default/grub; then
        sudo sed -i '/^GRUB_TIMEOUT=/d; /^GRUB_TIMEOUT_STYLE=/d' /etc/default/grub
        printf 'GRUB_TIMEOUT=0\nGRUB_TIMEOUT_STYLE=hidden\n' | sudo tee -a /etc/default/grub >/dev/null
      fi
      GRUBBY="$(command -v grubby || ls /usr/sbin/grubby /sbin/grubby 2>/dev/null | head -1 || true)"
      if grep -q '^GRUB_CMDLINE_LINUX_DEFAULT=' /etc/default/grub; then
        if ! grep -q '^GRUB_CMDLINE_LINUX_DEFAULT=.*splash' /etc/default/grub \
          || ! grep -q '^GRUB_CMDLINE_LINUX_DEFAULT=.*plymouth.ignore-serial-consoles' /etc/default/grub; then
          sudo sed -i '/^GRUB_CMDLINE_LINUX_DEFAULT=/{/splash/!s/"$/ splash"/}; /^GRUB_CMDLINE_LINUX_DEFAULT=/{/plymouth.ignore-serial-consoles/!s/"$/ plymouth.ignore-serial-consoles"/}' /etc/default/grub
        fi
      elif [ -n "$GRUBBY" ]; then
        GRUB_ARGS="$(sudo "$GRUBBY" --info=ALL 2>/dev/null | grep '^args=' || true)"
        if [ -z "$GRUB_ARGS" ] || grep -qv 'splash' <<<"$GRUB_ARGS" || grep -qv 'plymouth.ignore-serial-consoles' <<<"$GRUB_ARGS"; then
          if sudo "$GRUBBY" --update-kernel=ALL --args="splash plymouth.ignore-serial-consoles"; then echo "Ligne du noyau : splash (grubby)"
          else echo "Ligne du noyau : échec de grubby"; KIOSK_FAILED=1; fi
        fi
      else echo "Ligne du noyau : ni GRUB_CMDLINE_LINUX_DEFAULT ni grubby, logo au démarrage non activé"
      fi
      GRUB_CFG=/boot/grub/grub.cfg; [ -d /boot/grub2 ] && GRUB_CFG=/boot/grub2/grub.cfg
      if ! sudo test "$GRUB_CFG" -nt /etc/default/grub; then # sudo : /boot/grub2 n'est lisible que par root (Fedora)
        if [ -x /usr/sbin/update-grub ]; then GRUB_MK=(/usr/sbin/update-grub)
        elif [ -x /usr/sbin/grub2-mkconfig ]; then GRUB_MK=(/usr/sbin/grub2-mkconfig -o "$GRUB_CFG")
        else GRUB_MK=(); fi
        if [ ${#GRUB_MK[@]} = 0 ]; then echo "Menu de démarrage : update-grub introuvable, réglage non appliqué"; KIOSK_FAILED=1
        elif GRUB_ERR="$(sudo "${GRUB_MK[@]}" 2>&1 >/dev/null)"; then echo "Menu de démarrage masqué (Échap ou Maj au démarrage pour l'afficher)"
        else echo "Menu de démarrage : échec de ${GRUB_MK[0]##*/}"; echo "$GRUB_ERR" | tail -5; KIOSK_FAILED=1; fi
      fi
    fi
    # Version des réglages système appliqués : l'admin (page Installation) demande de relancer ce script quand une
    # mise à jour en apporte de nouveaux (server/setup.js, scripts/kiosk/SETUP_VERSION).
    # Seulement si tout est passé : sinon l'admin continue de demander de relancer ce script.
    if [ "${KIOSK_FAILED:-0}" = 1 ]; then echo; echo "Réglages système incomplets : relancez scripts/install.sh --kiosk (mot de passe demandé)."; exit 1; fi
    mkdir -p "$HOME/.config/photobooth" && cp scripts/kiosk/SETUP_VERSION "$HOME/.config/photobooth/kiosk-setup-version"
    echo
    echo "Redémarrez le PC pour terminer : logo Cheeesy au démarrage, connexion automatique, borne en plein écran."
  fi
fi

if [ "${SETUP_FAILED:-0}" = 1 ]; then echo; echo "Modules indispensables manquants (voir le bilan plus haut) : relancez ce script."; exit 1; fi

# 6. Lancement (Electron directement : pas de détour par l'icône)
if [ "$START" = 1 ]; then
  [ -d node_modules/electron/dist ] || { echo "Electron absent : la borne ne peut pas se lancer."; exit 1; }
  say "Lancement"
  (env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . >/dev/null 2>&1 &)
fi
