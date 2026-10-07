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
# Le script fait lui-même le gestionnaire de paquets, Node.js 20+ et npm install (binaire Electron compris) ; le
# reste (gphoto2, CUPS, ddcutil ou m1ddc, NetworkManager, Chromium, modèle IA, cadres de démo) passe par
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

# 2. Node.js 20 ou plus
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
if want node; then
  if ! have node || [ "$(node_major)" -lt 20 ]; then
    if [ "$CHECK" = 1 ]; then echo "✗ Node.js 20 ou plus absent"; exit 1; fi
    say "Node.js"
    case "$PM" in
      brew) brew install node ;;
      apt) # curl n'est pas installé d'office sur une Debian neuve
        have curl || sudo apt-get install -y curl ca-certificates
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs ;;
      dnf) sudo dnf install -y nodejs npm ;;
      pacman) sudo pacman -S --noconfirm --needed nodejs npm ;;
      *) echo "Node.js 20 ou plus requis (nodejs.org)"; exit 1 ;;
    esac
    # Une commande en échec dans « a && b » n'arrête pas le script (set -e) : on vérifie le résultat.
    { have node && [ "$(node_major)" -ge 20 ]; } || { echo "Node.js n'a pas pu être installé (réseau ?). Relancez ce script."; exit 1; }
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
  npm run --silent setup -- ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
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
    echo
    echo "Redémarrez le PC pour terminer : connexion automatique, icône Cheeesy sur le bureau, borne en plein écran."
  fi
fi

# 6. Lancement (Electron directement : pas de détour par l'icône)
if [ "$START" = 1 ]; then
  [ -d node_modules/electron/dist ] || { echo "Electron absent : la borne ne peut pas se lancer."; exit 1; }
  say "Lancement"
  (env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . >/dev/null 2>&1 &)
fi
