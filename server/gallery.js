/**
 * Pages ouvertes par les invités sur leur téléphone (sans internet, via le Wi-Fi de la borne) :
 * la photo d'une session depuis le QR code, et la galerie de l'événement quand elle est ouverte.
 * HTML simple, sans script : fonctionne sur les vieux téléphones.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** Couleur la plus lisible sur un fond, parmi des candidates (contraste WCAG), comme sur la borne. */
function readableOn(bg, ...candidates) {
  const lum = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 0.5;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
  return candidates.reduce((best, c) => (contrast(bg, c) > contrast(bg, best) ? c : best));
}
// Pas de bouton de téléchargement : sur téléphone, l'appui long est ce qui range la photo dans la pellicule.
const SAVE_TIP = 'Pour l\'avoir dans vos photos : appuyez longuement sur l\'image.';
// Boomerang (vidéo) : l'appui long n'enregistre pas une vidéo, et Safari ouvre un MP4 dans son lecteur sans
// proposer de l'enregistrer. Bouton : feuille de partage d'iOS (« Enregistrer la vidéo », page en HTTPS
// seulement), sinon téléchargement du fichier (Android : galerie ; iPhone : app Fichiers).
const shareScript = (fileUrl, fileName) => `<script>
(function () {
  var btn = document.getElementById('save');
  if (!btn || !window.fetch || !navigator.canShare || !window.File) return; // téléchargement simple
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    btn.textContent = 'Préparation…';
    fetch(${JSON.stringify(fileUrl)}).then(function (r) { return r.blob(); }).then(function (b) {
      var f = new File([b], ${JSON.stringify(fileName)}, { type: b.type || 'video/mp4' });
      if (navigator.canShare({ files: [f] })) return navigator.share({ files: [f] });
      location.href = btn.href; // partage de fichier refusé : téléchargement
    }).catch(function () {}).then(function () { btn.textContent = 'Enregistrer la vidéo'; });
  });
})();
</script>`;

function page({ theme, boothName, title = boothName, css = '', body }) {
  const c = theme.colors;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/fonts/font-awesome/css/fontawesome.min.css">
<link rel="stylesheet" href="/fonts/font-awesome/css/solid.min.css">
<style>
  :root{--primary:${c.primary};--secondary:${c.secondary};--bg:${c.background};--surface:${c.surface};--text:${c.text};--on-primary:${c.onPrimary};--on-surface:${readableOn(c.surface, c.secondary, c.text, c.background, '#ffffff', '#000000')}}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;padding:24px 16px;gap:20px;min-height:100vh}
  h1{font-size:22px;margin:0;color:var(--secondary)}
  .card{background:var(--surface);border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,.12);padding:12px;max-width:640px;width:100%}
  img,video{display:block;width:100%;height:auto;border-radius:12px}
  a.btn{display:inline-block;background:var(--primary);color:var(--on-primary);text-decoration:none;font-weight:700;font-size:18px;padding:16px 28px;border-radius:999px}
  a.link{color:var(--secondary);font-weight:600}
  .gif-tag{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.6);color:#fff;font:800 12px/1 system-ui,sans-serif;letter-spacing:.06em;padding:5px 7px;border-radius:6px}
  p{opacity:.75;text-align:center;max-width:520px}
  .logo{display:block;width:min(80vw,360px);height:72px;object-fit:contain;object-position:center;color:var(--secondary)}
  ${css}
</style></head>
<body>
  <img class="logo" src="${esc(theme.logo)}" alt="${esc(boothName)}">
  ${body}
</body></html>`;
}

/**
 * Page d'une photo, la seule côté téléphone : ouverte par tous les QR codes (écran de fin, galerie de la
 * borne) et depuis la grille /galerie. nav (galerie téléphone ouverte et photo dans la galerie) ajoute
 * la précédente, la suivante et le retour à la grille.
 */
export function galleryHtml({ session, theme, boothName, texts, nav = null }) {
  const hasFinal = !!session.final;
  // Flèches en gros boutons ronds, faciles à toucher au pouce
  const css = `.nav{display:flex;gap:12px;align-items:center;justify-content:space-between;width:100%;max-width:640px}
  .nav a,.nav .off{width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface);color:var(--on-surface);text-decoration:none;box-shadow:0 4px 16px rgba(0,0,0,.12)}
  .nav svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
  .nav .off{opacity:.25}.nav .count{font-size:16px;opacity:.75}`;
  const glyphs = { prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>', next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>' };
  const arrow = (target, glyph, label) => (target ? `<a href="/g/${esc(target.id)}" aria-label="${label}">${glyph}</a>` : `<span class="off" aria-hidden="true">${glyph}</span>`);
  return page({ theme, boothName, css, body: `
  ${nav ? `<div class="nav">${arrow(nav.prev, glyphs.prev, 'Photo précédente')}<span class="count">${nav.index + 1} / ${nav.total}</span>${arrow(nav.next, glyphs.next, 'Photo suivante')}</div>` : ''}
  ${hasFinal && session.final.video ? `
  <div class="card"><video src="${esc(session.final.url)}" autoplay loop muted playsinline></video></div>
  <a class="btn" id="save" href="/g/${esc(session.id)}/fichier" download>Enregistrer la vidéo</a>
  ${shareScript(session.final.url, `boomerang-${session.id}.mp4`)}` : hasFinal ? `
  <div class="card"><img src="${esc(session.final.url)}" alt="${session.final.gif ? 'Votre GIF' : 'Votre photo'}"></div>
  <p>${SAVE_TIP}</p>` : `
  <p>La photo n'est pas encore prête, réessayez dans quelques secondes.</p>`}
  ${nav ? `<a class="link" href="/galerie"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${esc(texts.galleryTitle)}</a>` : ''}` });
}

/** QR code d'une photo qui n'existe plus (supprimée, événement vidé) : même habillage, retour à la galerie si elle est ouverte. */
export function missingHtml({ theme, boothName, texts, gallery = false }) {
  return page({ theme, boothName, body: `
  <p>Cette photo n'est plus disponible.</p>
  ${gallery ? `<a class="link" href="/galerie"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${esc(texts.galleryTitle)}</a>` : ''}` });
}

/** Galerie de l'événement en cours : grille de miniatures (items = null : galerie fermée). */
export function eventGalleryHtml({ items, theme, boothName, texts }) {
  if (!items) return page({ theme, boothName, body: `<p>La galerie n'est pas ouverte pour le moment.</p>` });
  // Grille rangée ligne par ligne (de gauche à droite, les plus récentes en haut) : 2 colonnes sur téléphone, plus sur grand écran
  const css = `.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;align-items:start;width:100%;max-width:960px}
  .grid a{position:relative;display:block;background:var(--surface);border-radius:14px;padding:6px;box-shadow:0 4px 16px rgba(0,0,0,.08)}
  .grid img{border-radius:10px}`;
  return page({ theme, boothName, title: `${texts.galleryTitle} · ${boothName}`, css, body: `
  <h1>${esc(texts.galleryTitle)}</h1>
  ${items.length ? `<p>${items.length} photo${items.length > 1 ? 's' : ''}</p>
  <div class="grid">${items.map((it) => `<a href="/g/${esc(it.id)}"><img src="${esc(it.thumbUrl)}" alt="" loading="lazy">${it.gif ? `<span class="gif-tag">${it.kind === 'boomerang' ? 'BOOMERANG' : 'GIF'}</span>` : ''}</a>`).join('')}</div>`
    : `<p>${esc(texts.galleryEmpty)}</p>`}` });
}
