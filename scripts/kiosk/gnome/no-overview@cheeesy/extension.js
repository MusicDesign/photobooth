// GNOME 40+ ouvre la session sur la vue Activités : sur une borne dédiée, elle passerait devant
// Chromium en plein écran. On masque la vue le temps du démarrage du shell, puis on la rend.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class NoOverviewAtStartup {
  enable() {
    if (!Main.layoutManager._startingUp) return;
    this._hasOverview = Main.sessionMode.hasOverview;
    Main.sessionMode.hasOverview = false;
    this._id = Main.layoutManager.connect('startup-complete', () => this._restore());
  }

  disable() {
    this._restore();
  }

  _restore() {
    if (this._id) Main.layoutManager.disconnect(this._id);
    this._id = null;
    if (this._hasOverview !== undefined) Main.sessionMode.hasOverview = this._hasOverview;
    this._hasOverview = undefined;
  }
}
