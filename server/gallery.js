/** Page de galerie ouverte par l'invité depuis le QR code (sans internet, via le Wi-Fi de la borne). */
export function galleryHtml({ session, theme, boothName, texts }) {
  const c = theme.colors;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const hasFinal = !!session.final;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(boothName)}</title>
<style>
  :root{--primary:${c.primary};--secondary:${c.secondary};--bg:${c.background};--surface:${c.surface};--text:${c.text};--on-primary:${c.onPrimary}}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;padding:24px 16px;gap:20px;min-height:100vh}
  h1{font-size:22px;margin:0;color:var(--secondary)}
  .card{background:var(--surface);border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,.12);padding:12px;max-width:640px;width:100%}
  img{display:block;width:100%;height:auto;border-radius:12px}
  a.btn{display:inline-block;background:var(--primary);color:var(--on-primary);text-decoration:none;font-weight:700;font-size:18px;padding:16px 28px;border-radius:999px}
  p{opacity:.75;text-align:center;max-width:520px}
  .logo{display:block;width:min(80vw,360px);height:72px;object-fit:contain;object-position:center;color:var(--secondary)}
</style></head>
<body>
  <img class="logo" src="${esc(theme.logo)}" alt="${esc(boothName)}">
  ${hasFinal ? `
  <div class="card"><img src="${esc(session.final.url)}" alt="Votre photo"></div>
  <a class="btn" href="${esc(session.final.url)}" download="${esc(boothName.replace(/\s+/g, '-'))}-${esc(session.id)}.jpg">Télécharger la photo</a>
  <p>Sur iPhone : appuyez longuement sur l'image puis « Enregistrer dans Photos ».</p>` : `
  <p>La photo n'est pas encore prête, réessayez dans quelques secondes.</p>`}
  <p style="font-size:12px">Session ${esc(session.id)}</p>
</body></html>`;
}
