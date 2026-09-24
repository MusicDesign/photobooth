#!/usr/bin/env bash
# Installe la borne pour l'utilisateur courant (Fedora / Ubuntu, bureau GNOME) :
# icône « Photo Booth » sur le bureau et dans les applications, lancement automatique à l'ouverture de session.
#
#   scripts/kiosk/install-linux.sh                    lanceur script + Chromium (par défaut)
#   scripts/kiosk/install-linux.sh --electron         app Electron du dépôt (npm run app)
#   scripts/kiosk/install-linux.sh --exec CHEMIN      autre exécutable, ex. l'AppImage construite
#   scripts/kiosk/install-linux.sh --no-autostart     sans lancement automatique
#   scripts/kiosk/install-linux.sh --no-sleep         écran jamais éteint ni verrouillé (borne dédiée)
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

if [ $UNINSTALL -eq 1 ]; then
  rm -f "${FILES[@]}"
  echo "Icônes et lancement automatique retirés."
  exit 0
fi

chmod +x "$DIR/scripts/kiosk/"*.sh
[ -x "$EXEC" ] || chmod +x "$EXEC"

entry() {
  cat <<EOF
[Desktop Entry]
Type=Application
Name=Photo Booth
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

if [ $NOSLEEP -eq 1 ] && command -v gsettings >/dev/null; then
  gsettings set org.gnome.desktop.session idle-delay 0
  gsettings set org.gnome.desktop.screensaver lock-enabled false
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
  gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
  echo "Mise en veille et verrouillage désactivés."
fi

echo "Installé : $EXEC"
echo "  icône bureau     : $DESK/photobooth.desktop"
echo "  applications     : $APPS/photobooth.desktop"
[ $AUTOSTART -eq 1 ] && echo "  démarrage auto   : $AUTO/photobooth.desktop"
echo
echo "Pour que la borne démarre seule à l'allumage, activez aussi la connexion automatique :"
echo "  Paramètres → Système → Utilisateurs → Connexion automatique."
