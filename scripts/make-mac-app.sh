#!/usr/bin/env bash
# Régénère « Cheeesy.app » à la racine du dépôt : raccourci macOS qui lance l'app Electron
# (npm run app) sans fenêtre Terminal. Le raccourci cherche l'app dans son propre dossier :
# il reste valable après un git clone. Rien d'installé encore : il ouvre le Terminal sur
# scripts/install.sh, qui installe tout ce qui manque puis lance la borne.
#   scripts/make-mac-app.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$DIR/Cheeesy.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/launcher.applescript" <<'EOF'
-- Lance l'app Electron de la borne depuis le dossier qui contient ce raccourci. Rien d'installé : installe les
-- modules nécessaires avec une fenêtre de progression (Node.js, dépendances npm, Electron, outils, modèle IA),
-- puis lance. Seul cas où le Terminal s'ouvre : Homebrew absent (son installeur demande le mot de passe).
set appPath to POSIX path of (path to me)
set rootDir to do shell script "dirname " & quoted form of appPath
set electronBin to rootDir & "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
set logFile to "/tmp/cheeesy-install.log"
set prefix to "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; cd " & quoted form of rootDir & " && "
set installed to (do shell script "test -x " & quoted form of electronBin & " && echo oui || echo non")
if installed is "non" then
	display dialog "Installation des modules nécessaires." buttons {"Annuler", "Installer"} default button "Installer" with icon note with title "Cheeesy"
	set hasBrew to (do shell script "test -x /opt/homebrew/bin/brew -o -x /usr/local/bin/brew && echo oui || echo non")
	if hasBrew is "non" then
		tell application "Terminal"
			activate
			do script "cd " & quoted form of rootDir & " && scripts/install.sh"
		end tell
		return
	end if
	set stepNames to {"Node.js", "Dépendances npm et Electron", "Modules nécessaires"}
	set stepIds to {"node", "deps", "modules"}
	set progress total steps to 3
	set progress description to "Installation des modules nécessaires"
	repeat with i from 1 to 3
		set progress completed steps to i - 1
		set progress additional description to item i of stepNames
		try
			do shell script prefix & "scripts/install.sh --step=" & item i of stepIds & " > " & logFile & " 2>&1"
		on error
			set tailLog to do shell script "tail -n 8 " & logFile
			display dialog (item i of stepNames) & " : échec." & return & return & tailLog buttons {"OK"} default button 1 with icon stop with title "Cheeesy"
			return
		end try
	end repeat
	set progress completed steps to 3
	set installed to (do shell script "test -x " & quoted form of electronBin & " && echo oui || echo non")
	if installed is "non" then
		display dialog "Electron n'a pas pu être téléchargé. Relancez l'icône." buttons {"OK"} default button 1 with icon stop with title "Cheeesy"
		return
	end if
end if
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
