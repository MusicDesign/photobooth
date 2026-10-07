// Borne dédiée sous GNOME :
//  - GNOME 40+ ouvre la session sur la vue Activités, qui passerait devant la borne en plein écran : on la masque
//    le temps du démarrage du shell, puis on la rend (elle reste joignable par l'opérateur, Alt+Tab compris) ;
//  - les gestes tactiles et pavé tactile (balayage à 3 doigts : vue Activités, changement d'espace de travail) sont
//    coupés, pour qu'un invité ne sorte pas de la borne. Les raccourcis clavier et le coin actif : install-linux.sh.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class CheeesyKiosk {
  enable() {
    if (Main.layoutManager._startingUp) {
      this._hasOverview = Main.sessionMode.hasOverview;
      Main.sessionMode.hasOverview = false;
      this._id = Main.layoutManager.connect('startup-complete', () => this._restoreOverview());
    }
    // `enabled` coupe d'un coup les gestes tactiles, pavé tactile et défilement d'un SwipeTracker. GNOME le remet
    // à true à la fermeture de la vue Activités (espaces de travail) : on le recoupe à chaque changement.
    const trackers = [Main.overview._swipeTracker, Main.wm._workspaceAnimation?._swipeTracker].filter(Boolean);
    this._trackers = trackers.map((t) => {
      t.enabled = false;
      return [t, t.connect('notify::enabled', () => { if (t.enabled) t.enabled = false; })];
    });
  }

  disable() {
    this._restoreOverview();
    for (const [t, id] of this._trackers ?? []) {
      t.disconnect(id);
      t.enabled = true;
    }
    this._trackers = null;
  }

  _restoreOverview() {
    if (this._id) Main.layoutManager.disconnect(this._id);
    this._id = null;
    if (this._hasOverview !== undefined) Main.sessionMode.hasOverview = this._hasOverview;
    this._hasOverview = undefined;
  }
}
