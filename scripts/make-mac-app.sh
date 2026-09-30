#!/usr/bin/env bash
# Régénère « Cheeesy.app » à la racine du dépôt : raccourci macOS qui lance l'app Electron
# (npm run app) sans fenêtre Terminal. Le raccourci cherche l'app dans son propre dossier :
# il reste valable après un git clone, une fois npm install fait.
#   scripts/make-mac-app.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$DIR/Cheeesy.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/launcher.applescript" <<'EOF'
-- Lance l'app Electron de la borne depuis le dossier qui contient ce raccourci.
set appPath to POSIX path of (path to me)
set rootDir to do shell script "dirname " & quoted form of appPath
set electronBin to rootDir & "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
try
	do shell script "test -x " & quoted form of electronBin
on error
	display dialog "Electron n'est pas installé. Dans le dossier du projet, lancer : npm install" buttons {"OK"} default button 1 with icon stop with title "Cheeesy"
	return
end try
do shell script "cd " & quoted form of rootDir & " && env -u ELECTRON_RUN_AS_NODE " & quoted form of electronBin & " . > /dev/null 2>&1 &"
EOF

rm -rf "$APP"
osacompile -o "$APP" "$WORK/launcher.applescript"

# Icône de la borne (build/icon.png, tirée du logo Cheeesy) à la place de celle d'AppleScript
mkdir -p "$WORK/icon.iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$DIR/build/icon.png" --out "$WORK/icon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  if [ $double -le 512 ]; then sips -z $double $double "$DIR/build/icon.png" --out "$WORK/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null; fi
done
iconutil -c icns "$WORK/icon.iconset" -o "$APP/Contents/Resources/applet.icns"
rm -f "$APP/Contents/Resources/Assets.car" # sinon macOS garde l'icône par défaut

# L'icône a changé après la signature d'osacompile : signature ad hoc refaite
codesign --force --deep --sign - "$APP"
codesign --verify "$APP"
echo "Créé : $APP"
