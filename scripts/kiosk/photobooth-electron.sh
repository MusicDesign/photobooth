#!/usr/bin/env bash
# Lance l'app Electron du dépôt (après npm install). L'app gère seule plein écran, arrêt et instance unique.
DIR="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
LOG="$DIR/data/logs/launcher.log"
unset ELECTRON_RUN_AS_NODE
# Binaire absent (npm install sans téléchargement, depuis Electron 44.7) : on le télécharge avant de lancer
BIN="$DIR/node_modules/electron/dist/electron"
if [ ! -x "$BIN" ]; then
  mkdir -p "$(dirname "$LOG")"
  echo "$(date '+%F %T') binaire Electron absent : téléchargement" >>"$LOG"
  node "$DIR/node_modules/electron/install.js" >>"$LOG" 2>&1
fi
[ -x "$BIN" ] && exec "$BIN" "$DIR" "$@"
# Téléchargement raté (pas de réseau, node introuvable) : lanceur Chromium s'il y a un navigateur, sinon message.
echo "$(date '+%F %T') binaire Electron introuvable (relancer scripts/install.sh)" >>"$LOG"
for b in chromium-browser chromium google-chrome-stable google-chrome; do
  if command -v "$b" >/dev/null; then echo "$(date '+%F %T') lancement avec $b" >>"$LOG"; exec "$DIR/scripts/kiosk/photobooth.sh" "$@"; fi
done
if flatpak info org.chromium.Chromium >/dev/null 2>&1; then exec "$DIR/scripts/kiosk/photobooth.sh" "$@"; fi
notify-send "Cheeesy" "App Electron absente : relancez scripts/install.sh dans le Terminal" 2>/dev/null
exit 1
