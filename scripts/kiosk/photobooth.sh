#!/usr/bin/env bash
# Lance la borne sous Linux : serveur Node + Chromium en plein écran (kiosque).
#
#  - Un deuxième lancement (double clic sur l'icône) ne fait rien si la borne tourne déjà.
#  - « Éteindre la borne » dans l'admin : le serveur sort avec le code 0, Chromium est fermé.
#  - Le serveur plante (code ≠ 0) : il est relancé, la page se reconnecte toute seule.
#  - Chromium fermé (Alt+F4) : le serveur est arrêté aussi.
#
# Variables utiles : PORT (3000, ou le suivant libre), BOOTH_BROWSER (chemin d'un navigateur Chromium/Chrome).
set -u

DIR="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/photobooth-$USER"
# Port réellement ouvert, écrit par le serveur (3000 pris par une autre application : le suivant libre)
export BOOTH_PORT_FILE="$RUN_DIR/port"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/photobooth/chromium"
LOG="$DIR/data/logs/launcher.log"
mkdir -p "$RUN_DIR" "$PROFILE" "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >>"$LOG"; }

exec 9>"$RUN_DIR/lock"
if ! flock -n 9; then log "déjà lancée, rien à faire"; exit 0; fi
rm -f "$RUN_DIR/stop" "$BOOTH_PORT_FILE"

# Lancé depuis le bureau, le shell ne charge pas ~/.bashrc : Node installé via nvm n'est pas dans le PATH.
NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null; NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ]; then log "node introuvable"; notify-send "Cheeesy" "Node.js introuvable" 2>/dev/null; exit 1; fi

BROWSER=()
if [ -n "${BOOTH_BROWSER:-}" ]; then BROWSER=("$BOOTH_BROWSER")
else
  for b in chromium-browser chromium google-chrome-stable google-chrome; do
    if command -v "$b" >/dev/null; then BROWSER=("$b"); break; fi
  done
  if [ ${#BROWSER[@]} -eq 0 ] && flatpak info org.chromium.Chromium >/dev/null 2>&1; then BROWSER=(flatpak run org.chromium.Chromium); fi
fi
if [ ${#BROWSER[@]} -eq 0 ]; then log "Chromium introuvable"; notify-send "Cheeesy" "Chromium introuvable (sudo dnf install chromium)" 2>/dev/null; exit 1; fi

# ---------- Serveur (relancé s'il plante) ----------
run_server() {
  cd "$DIR" || exit 1
  while :; do
    # Relance : même port qu'avant s'il est libre, la page ouverte dans Chromium s'y reconnecte
    [ -s "$BOOTH_PORT_FILE" ] && export PORT="$(cat "$BOOTH_PORT_FILE")"
    BOOTH_LAUNCHER=1 "$NODE" server/index.js >>"$LOG" 2>&1 &
    echo $! >"$RUN_DIR/server.pid"
    wait $!
    code=$?
    if [ $code -eq 0 ] || [ -f "$RUN_DIR/stop" ]; then log "serveur arrêté"; break; fi
    # 75 : « Redémarrer la borne » dans l'admin (server/index.js), relance immédiate ; la page se reconnecte seule.
    if [ $code -eq 75 ]; then log "redémarrage demandé depuis l'admin"; continue; fi
    log "serveur tombé (code $code), relance dans 3 s"
    sleep 3
  done
}
stop_server() {
  touch "$RUN_DIR/stop"
  [ -f "$RUN_DIR/server.pid" ] && kill "$(cat "$RUN_DIR/server.pid")" 2>/dev/null
}
stop_browser() {
  [ -n "${BROWSER_PID:-}" ] && kill "$BROWSER_PID" 2>/dev/null
  pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null
}

log "démarrage"
run_server &
SERVER_LOOP=$!
trap 'stop_server; stop_browser; wait; exit 0' INT TERM

URL=
for _ in $(seq 1 60); do
  [ -s "$BOOTH_PORT_FILE" ] && URL="http://localhost:$(cat "$BOOTH_PORT_FILE")" && curl -sf -o /dev/null "$URL/" && break
  kill -0 $SERVER_LOOP 2>/dev/null || { log "le serveur n'a pas démarré, voir ce journal"; exit 1; }
  sleep 0.5
done
[ -n "$URL" ] || { log "le serveur n'a pas répondu à temps"; stop_server; wait; exit 1; }
log "borne : $URL"

# ---------- Navigateur plein écran ----------
# Chromium coupé net la dernière fois : sans ça, il afficherait « Restaurer les pages ? ».
PREFS="$PROFILE/Default/Preferences"
[ -f "$PREFS" ] && sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
# Traduction coupée et langue française dans le profil : l'option --disable-features=Translate ne suffit plus
# sur les Chromium récents, qui proposeraient encore de traduire la borne.
mkdir -p "$(dirname "$PREFS")"
"$NODE" -e '
  const fs = require("fs"), f = process.argv[1];
  let p = {}; try { p = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  p.translate = { ...p.translate, enabled: false };
  p.intl = { ...p.intl, accept_languages: "fr-FR,fr", selected_languages: "fr-FR,fr" };
  fs.writeFileSync(f, JSON.stringify(p));
' "$PREFS" || log "préférences Chromium non modifiées"

# --password-store=basic : avec la connexion automatique, le trousseau GNOME reste verrouillé et Chromium
# demanderait son mot de passe au démarrage de la borne.
"${BROWSER[@]}" \
  --user-data-dir="$PROFILE" \
  --kiosk "$URL" \
  --ozone-platform-hint=auto \
  --no-first-run --no-default-browser-check \
  --lang=fr-FR \
  --password-store=basic \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-features=Translate,TranslateUI \
  --overscroll-history-navigation=0 --disable-pinch \
  --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  >>"$LOG" 2>&1 &
BROWSER_PID=$!

# Le premier des deux qui s'arrête emporte l'autre.
wait -n $SERVER_LOOP $BROWSER_PID
if kill -0 $SERVER_LOOP 2>/dev/null; then log "navigateur fermé, arrêt du serveur"; stop_server
else log "serveur arrêté, fermeture du navigateur"; stop_browser; fi
wait
log "borne arrêtée"
