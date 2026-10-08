#!/usr/bin/env bash
# Lance l'app Electron du dépôt (après npm install). L'app gère seule plein écran, arrêt et instance unique.
DIR="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
unset ELECTRON_RUN_AS_NODE
# Binaire absent (npm install sans téléchargement, depuis Electron 44.7) : on le télécharge avant de lancer
[ -x "$DIR/node_modules/electron/dist/electron" ] || node "$DIR/node_modules/electron/install.js"
exec "$DIR/node_modules/electron/dist/electron" "$DIR" "$@"
