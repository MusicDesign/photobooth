import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * La borne est-elle en Wi-Fi ? Les QR codes de photo n'ont de sens que si les téléphones
 * peuvent la joindre, donc on ne les affiche que si une interface Wi-Fi a une adresse IPv4
 * (connectée à un réseau, ou hotspot de la borne).
 */

let macWifiDevices = null;

/** Noms des interfaces Wi-Fi (en0…) sur macOS, lus une fois : le matériel ne change pas en cours de route. */
function wifiDevicesMac() {
  if (macWifiDevices) return macWifiDevices;
  try {
    const out = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 5000 });
    macWifiDevices = [...out.matchAll(/Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/g)].map((m) => m[1]);
  } catch {
    macWifiDevices = [];
  }
  return macWifiDevices;
}

function isWireless(name) {
  if (process.platform === 'darwin') return wifiDevicesMac().includes(name);
  if (process.platform === 'linux') return fs.existsSync(`/sys/class/net/${name}/wireless`) || fs.existsSync(`/sys/class/net/${name}/phy80211`);
  return false;
}

/** { connected, iface, ip } : première interface Wi-Fi avec une adresse IPv4. */
export function wifiStatus() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const v4 = (list || []).find((i) => i.family === 'IPv4' && !i.internal);
    if (v4 && isWireless(name)) return { connected: true, iface: name, ip: v4.address };
  }
  return { connected: false, iface: null, ip: null };
}
