// Notification de connexion ou de déconnexion d'un appareil, en haut à droite (admin et borne).
// Reçue du serveur : { type: 'device', id, label, connected }.
const SHOW_MS = 4500;
let box = null;

function ensureBox() {
  if (box?.isConnected) return box;
  const css = document.createElement('style');
  css.textContent = `
    #deviceToasts { position: fixed; top: 16px; right: 16px; z-index: 100000; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
    .device-toast { display: flex; align-items: center; gap: 10px; max-width: min(420px, 90vw); padding: 10px 16px; border-radius: 12px; background: rgba(24, 26, 32, .94); color: #fff; font: 600 15px/1.3 system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0, 0, 0, .3); animation: deviceToastIn .25s ease-out; transition: opacity .3s, transform .3s; }
    .device-toast i { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #2fbf71; }
    .device-toast.off i { background: #e5534b; }
    .device-toast.update i { background: #4c8dff; }
    .device-toast small { font-weight: 400; opacity: .75; margin-left: 4px; }
    .device-toast.leaving { opacity: 0; transform: translateX(20px); }
    @keyframes deviceToastIn { from { opacity: 0; transform: translateX(20px); } }`;
  document.head.appendChild(css);
  box = document.createElement('div');
  box.id = 'deviceToasts';
  document.body.appendChild(box);
  return box;
}

function show(kind, label, detail, ms = SHOW_MS) {
  const el = document.createElement('div');
  el.className = `device-toast${kind ? ` ${kind}` : ''}`;
  el.setAttribute('role', 'status');
  const dot = document.createElement('i');
  const text = document.createElement('span');
  text.textContent = label;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    text.appendChild(small);
  }
  el.append(dot, text);
  const parent = ensureBox();
  parent.appendChild(el);
  while (parent.children.length > 5) parent.firstChild.remove();
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 320); }, ms);
}

export function deviceNotice({ label, connected }) {
  show(connected ? '' : 'off', label, connected ? 'connecté' : 'déconnecté');
}

// Erreur du système (boîtier, imprimante, montage, essais du code bloqués…) : même notification, pastille rouge.
// Le toast de la borne reste aux messages pour l'invité.
export function systemNotice(text, ms = 6000) {
  show('off', text, '', Math.max(ms, 5000));
}

// Mise à jour disponible, annoncée au lancement de la borne : { type: 'update', version }. Une fois par page.
let updateShown = false;
export function updateNotice({ version }) {
  if (updateShown) return;
  updateShown = true;
  show('update', 'Mise à jour disponible', version || '', 10000);
}
