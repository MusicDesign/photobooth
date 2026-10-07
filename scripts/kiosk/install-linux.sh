#!/usr/bin/env bash
# Installe la borne pour l'utilisateur courant (Fedora / Ubuntu, bureau GNOME) :
# icône « Cheeesy » sur le bureau et dans les applications, lancement automatique à l'ouverture de session.
#
#   scripts/kiosk/install-linux.sh                    lanceur script + Chromium (par défaut)
#   scripts/kiosk/install-linux.sh --electron         app Electron du dépôt (npm run app)
#   scripts/kiosk/install-linux.sh --exec CHEMIN      autre exécutable, ex. l'AppImage construite
#   scripts/kiosk/install-linux.sh --no-autostart     sans lancement automatique
#   scripts/kiosk/install-linux.sh --no-sleep         écran jamais éteint ni verrouillé, pas de vue Activités ni de gestes GNOME (borne dédiée)
#   scripts/kiosk/install-linux.sh --uninstall        retire icônes et lancement automatique
set -eu

DIR="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
EXEC="$DIR/scripts/kiosk/photobooth.sh"
AUTOSTART=1 NOSLEEP=0 UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --electron) EXEC="$DIR/scripts/kiosk/photobooth-electron.sh" ;;
    --exec) EXEC="$(readlink -f "$2")"; shift ;;
    --no-autostart) AUTOSTART=0 ;;
    --no-sleep) NOSLEEP=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
  shift
done

APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTO="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
FILES=("$APPS/photobooth.desktop" "$AUTO/photobooth.desktop" "$DESK/photobooth.desktop")
EXT_UUID="no-overview@cheeesy"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"

if [ $UNINSTALL -eq 1 ]; then
  rm -f "${FILES[@]}"
  rm -rf "$EXT_DIR"
  if command -v gsettings >/dev/null; then # réglages de borne dédiée (--no-sleep) rendus au bureau
    gsettings reset org.gnome.desktop.interface enable-hot-corners
    gsettings reset org.gnome.mutter overlay-key
    for k in toggle-overview toggle-application-view toggle-message-tray toggle-quick-settings; do gsettings reset org.gnome.shell.keybindings "$k" 2>/dev/null || true; done
    gsettings reset org.gnome.desktop.notifications show-banners
  fi
  echo "Icônes et lancement automatique retirés."
  exit 0
fi

chmod +x "$DIR/scripts/kiosk/"*.sh
[ -x "$EXEC" ] || chmod +x "$EXEC"

entry() {
  cat <<EOF
[Desktop Entry]
Type=Application
Name=Cheeesy
Comment=Lancer la borne photo en plein écran
Exec="$EXEC"
Icon=$DIR/build/icon.png
Terminal=false
Categories=Utility;
StartupNotify=false
EOF
}

mkdir -p "$APPS" "$DESK"
entry >"$APPS/photobooth.desktop"
entry >"$DESK/photobooth.desktop"
chmod +x "$DESK/photobooth.desktop"
# GNOME n'exécute une icône du bureau que si elle est marquée « de confiance ».
gio set "$DESK/photobooth.desktop" metadata::trusted true 2>/dev/null || true

if [ $AUTOSTART -eq 1 ]; then
  mkdir -p "$AUTO"
  { entry; echo "X-GNOME-Autostart-enabled=true"; echo "X-GNOME-Autostart-Delay=3"; } >"$AUTO/photobooth.desktop"
else
  rm -f "$AUTO/photobooth.desktop"
fi

# Ajoute une valeur à une liste gsettings (extensions actives, favoris du dock) si elle n'y est pas déjà.
gnome_list_add() {
  local cur; cur="$(gsettings get "$1" "$2")"
  case "$cur" in
    *"'$3'"*) ;;
    "@as []"|"[]") gsettings set "$1" "$2" "['$3']" ;;
    *) gsettings set "$1" "$2" "${cur%]}, '$3']" ;;
  esac
}

# GNOME n'affiche pas d'icônes sur le bureau : extension Desktop Icons NG si elle est installée
# (scripts/install.sh --kiosk l'installe sous Debian/Ubuntu), et Cheeesy épinglé au dock dans tous les cas.
if command -v gsettings >/dev/null && gsettings list-schemas | grep -qx org.gnome.shell; then
  DING=ding@rastersoft.com
  if [ -d "/usr/share/gnome-shell/extensions/$DING" ] || [ -d "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$DING" ]; then
    gnome_list_add org.gnome.shell enabled-extensions "$DING"
    echo "Icônes du bureau activées (Desktop Icons NG)."
  else
    echo "Icônes du bureau : installez l'extension Desktop Icons NG (Debian/Ubuntu : sudo apt install gnome-shell-extension-desktop-icons-ng)."
  fi
  gnome_list_add org.gnome.shell favorite-apps photobooth.desktop
  echo "Cheeesy épinglé au dock."
fi

if [ $NOSLEEP -eq 1 ] && command -v gsettings >/dev/null; then
  gsettings set org.gnome.desktop.session idle-delay 0
  gsettings set org.gnome.desktop.screensaver lock-enabled false
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
  gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
  echo "Mise en veille et verrouillage désactivés."
  # GNOME ouvre la session sur la vue Activités, devant la borne : petite extension qui la saute au démarrage.
  mkdir -p "$EXT_DIR"
  cp "$DIR/scripts/kiosk/gnome/$EXT_UUID/"* "$EXT_DIR/"
  gnome_list_add org.gnome.shell enabled-extensions "$EXT_UUID"
  gsettings set org.gnome.shell disable-user-extensions false
  # Sorties de la borne vers le bureau coupées : coin actif, touche Super (⌘ dans une VM), raccourcis de la vue
  # Activités, bannières de notification par-dessus la borne. Alt+Tab et Ctrl+Maj+Q restent à l'opérateur.
  gsettings set org.gnome.desktop.interface enable-hot-corners false
  gsettings set org.gnome.mutter overlay-key ''
  for k in toggle-overview toggle-application-view toggle-message-tray toggle-quick-settings; do
    gsettings set org.gnome.shell.keybindings "$k" "[]" 2>/dev/null || true
  done
  gsettings set org.gnome.desktop.notifications show-banners false
  echo "Vue Activités sautée à l'ouverture de session, gestes et raccourcis de GNOME coupés (effet à la prochaine connexion)."
fi

echo "Installé : $EXEC"
echo "  icône bureau     : $DESK/photobooth.desktop"
echo "  applications     : $APPS/photobooth.desktop"
[ $AUTOSTART -eq 1 ] && echo "  démarrage auto   : $AUTO/photobooth.desktop"
echo
echo "Pour que la borne démarre seule à l'allumage, activez aussi la connexion automatique :"
echo "  Paramètres → Système → Utilisateurs → Connexion automatique."
