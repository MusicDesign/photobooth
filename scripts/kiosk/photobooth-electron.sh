#!/usr/bin/env bash
# Lance l'app Electron du dépôt (après npm install). L'app gère seule plein écran, arrêt et instance unique.
DIR="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
unset ELECTRON_RUN_AS_NODE
exec "$DIR/node_modules/electron/dist/electron" "$DIR" "$@"
