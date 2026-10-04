/**
 * Page distante de l'adresse publique (share.publicUrl, ex. https://photobooth.domain.fr) :
 * hors du Wi-Fi de la borne, un QR code de photo y arrive. Elle rappelle de rejoindre le Wi-Fi de
 * la borne, puis interroge /api/ping toutes les 3 s : dès que la borne répond (le DNS du hotspot
 * fait pointer le domaine sur elle), la page se recharge et la borne sert la photo.
 *
 *   npm run remote [dossier de sortie]   (défaut : output/remote)
 *
 * Reprend le nom et les textes de la config actuelle, mais toujours le thème par défaut et le logo Cheeesy
 * d'origine (pas ceux de la borne) : à relancer après un changement de nom ou de textes.
 * Le mot de passe Wi-Fi n'y figure jamais (page publique).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../server/config.js';
import { Themes, DEFAULT_LOGO } from '../server/themes.js';
import { OUTPUT_DIR, PUBLIC_DIR } from '../server/paths.js';
import { completeUrl } from '../server/booth.js';

const OUT = path.resolve(process.argv[2] || path.join(OUTPUT_DIR, 'remote'));
const config = new Config();
const cfg = config.load();
// Toujours le thème par défaut et le logo Cheeesy d'origine, quel que soit le thème ou le logo de la borne
const theme = new Themes().resolve({ ...cfg, theme: { active: 'default-light' }, booth: { ...cfg.booth, logo: '', backgroundImage: '' } });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Logo : toujours le logo Cheeesy d'origine (aplat jaune), copié tel quel, sans le recolorer aux couleurs du thème
const logoName = 'logo.svg';
fs.copyFileSync(path.join(PUBLIC_DIR, DEFAULT_LOGO), path.join(OUT, logoName));

const c = theme.colors;
const ssid = cfg.share.wifi?.enabled ? String(cfg.share.wifi.ssid || '').trim() : '';
// Adresse de la borne sur son propre réseau (admin → Partage → URL de base) : lien de secours quand le DNS du
// réseau ne renvoie pas le domaine public vers la borne (Wi-Fi ordinaire, pas le hotspot de la borne)
const localBase = completeUrl(cfg.share.baseUrl, { port: Number(process.env.PORT) || 3000 })?.replace(/\/$/, '') || '';

const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(cfg.booth.name)}</title>
<style>
  :root{--primary:${c.primary};--secondary:${c.secondary};--bg:${c.background};--surface:${c.surface};--text:${c.text}}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;gap:22px;min-height:100vh;text-align:center}
  .logo{width:min(70vw,300px);height:72px;object-fit:contain}
  h1{font-size:24px;margin:0;color:var(--secondary);max-width:22ch}
  p{margin:0;opacity:.8;max-width:34ch;line-height:1.45}
  .ssid{background:var(--surface);border-radius:16px;padding:14px 22px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
  .ssid span{display:block;font-size:13px;opacity:.65}.ssid b{font-size:20px;color:var(--secondary)}
  .wait{display:flex;align-items:center;gap:10px;font-size:14px;opacity:.7}
  .go{display:inline-block;margin-top:6px;padding:14px 22px;border-radius:999px;background:var(--primary);color:#fff;font-weight:700;text-decoration:none}
  .spin{width:18px;height:18px;border-radius:50%;border:3px solid color-mix(in srgb,var(--primary) 25%,transparent);border-top-color:var(--primary);animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body>
  <img class="logo" src="/${logoName}" alt="${esc(cfg.booth.name)}">
  <h1>${esc(cfg.texts.remoteTitle)}</h1>
  <p>${esc(cfg.texts.remoteHint)}</p>
  ${ssid ? `<div class="ssid"><span>Réseau Wi-Fi</span><b>${esc(ssid)}</b></div>` : ''}
  <div class="wait"><div class="spin"></div>En attente de la connexion à la borne…</div>
  ${localBase ? `<a class="go" id="go" href="${esc(localBase)}">J'ai rejoint le Wi-Fi : voir ma photo</a>` : ''}
<script>
  // Sur le Wi-Fi de la borne, ce même domaine mène à la borne : /api/ping y répond en JSON, et la page
  // rechargée devient la photo (/g/<id>) servie par la borne. Ailleurs, l'hébergeur renvoie cette page.
  const target = /^\\/g\\/[^/]+/.test(location.pathname) ? location.pathname : '/galerie';
  async function check() {
    try {
      const r = await fetch('/api/ping?t=' + Date.now(), { cache: 'no-store' });
      // ?b= : adresse neuve, pour que le navigateur ne resserve pas cette page depuis son cache
      if ((await r.json()).photobooth) { location.replace(target + '?b=' + Date.now()); return; }
    } catch (e) { /* hébergeur (page HTML) ou pas de réseau : on réessaie */ }
    setTimeout(check, 3000);
  }
  check();
  // Lien de secours : directement l'adresse locale de la borne, avec la photo demandée (navigation, pas de fetch :
  // une page https ne peut pas interroger une adresse http, mais peut y mener)
  const go = document.getElementById('go');
  if (go) go.href = go.getAttribute('href') + target;
</script>
</body></html>
`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '404.html'), html); // GitHub Pages : toute adresse inconnue sert cette page
// Toutes les adresses /g/<id> servent la même page : Netlify / Cloudflare Pages, puis Apache (OVH, o2switch…).
fs.writeFileSync(path.join(OUT, '_redirects'), '/g/*  /index.html  200\n/galerie  /index.html  200\n');
fs.writeFileSync(path.join(OUT, '.htaccess'), [
  '# Toute adresse (/g/<id>, /galerie, /api/ping…) sert index.html ; jamais mise en cache : la page doit pouvoir',
  '# laisser place à la borne dès que le téléphone rejoint son Wi-Fi',
  'DirectoryIndex index.html',
  '# Filet de sécurité si la réécriture est ignorée : la page s\'affiche quand même (statut 404)',
  'ErrorDocument 404 /index.html',
  'RewriteEngine On',
  'RewriteBase /',
  'RewriteCond %{REQUEST_FILENAME} !-f',
  'RewriteCond %{REQUEST_FILENAME} !-d',
  'RewriteRule ^ /index.html [L]',
  '<IfModule mod_headers.c>',
  '  <FilesMatch "\\.html$">',
  '    Header set Cache-Control "no-store, max-age=0"',
  '  </FilesMatch>',
  '</IfModule>',
  ''
].join('\n'));

console.log(`Page distante dans ${OUT}`);
console.log(`  À déposer à la racine de ${cfg.share.publicUrl || '(adresse publique non réglée dans l\'admin)'}`);
if (!ssid) console.log('  Astuce : activez le QR code Wi-Fi dans l\'admin pour afficher le nom du réseau sur la page.');
