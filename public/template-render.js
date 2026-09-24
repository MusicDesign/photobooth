/**
 * Rendu d'un template à calques sur un canvas. Partagé par la borne (aperçu live,
 * choix du cadre) et l'admin (éditeur, vignettes). Les règles de placement sont
 * les mêmes que dans server/compositor.js : ce qui est à l'écran est ce qui s'imprime.
 */

export const FONT_STACKS = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: 'Georgia, "Times New Roman", "Liberation Serif", serif',
  mono: '"Courier New", "Liberation Mono", monospace',
  script: '"Snell Roundhand", "Brush Script MT", "URW Chancery L", cursive',
  rounded: '"Arial Rounded MT Bold", "Nunito", "Varela Round", sans-serif'
};

export function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Charge les images des calques "image" dans un cache src → Image. */
export async function loadAssets(template, cache = new Map()) {
  const todo = template.layers.filter((l) => l.type === 'image' && !cache.has(l.src));
  await Promise.all(todo.map(async (l) => {
    const img = await loadImage(l.url || `/templates/${template.id}/${l.src}`);
    if (img) cache.set(l.src, img);
  }));
  return cache;
}

/** Recadrage "cover" centré (même règle que sharp fit: cover, position: centre). */
export function drawCover(ctx, src, sw, sh, d, mirror = false) {
  if (!sw || !sh) return;
  const r = Math.max(d.w / sw, d.h / sh);
  const cw = d.w / r;
  const ch = d.h / r;
  const sx = (sw - cw) / 2;
  const sy = (sh - ch) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(d.x, d.y, d.w, d.h);
  ctx.clip();
  if (mirror) {
    ctx.translate(d.x + d.w, d.y);
    ctx.scale(-1, 1);
    ctx.drawImage(src, sx, sy, cw, ch, 0, 0, d.w, d.h);
  } else {
    ctx.drawImage(src, sx, sy, cw, ch, d.x, d.y, d.w, d.h);
  }
  ctx.restore();
}

/**
 * Obturateur à lamelles (iris) dans le rectangle d. closed = 1 : fermé, 0 : ouvert.
 * Un seul masque sombre percé d'un hexagone (pas de chevauchement de teintes), puis les
 * arêtes visibles des lamelles : depuis chaque sommet, une ligne qui prolonge le bord
 * voisin vers l'extérieur, comme sur un vrai diaphragme. L'ensemble tourne en s'ouvrant.
 */
export function drawIris(ctx, d, closed, scale = 1) {
  const n = 6;
  const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
  const L = Math.hypot(d.w, d.h);
  const open = Math.max(0, Math.min(1, 1 - closed));
  const aMax = (L / 2) / Math.cos(Math.PI / n) * 1.04; // rayon du polygone qui dégage tout le rectangle
  const a = aMax * open;
  const twist = open * (Math.PI / n) * 0.9;
  const vertex = (k) => {
    const ang = twist + Math.PI / n + (k * 2 * Math.PI) / n;
    return [cx + a * Math.cos(ang), cy + a * Math.sin(ang)];
  };
  ctx.save();
  // Masque : rectangle plein moins l'hexagone d'ouverture (règle evenodd).
  ctx.beginPath();
  ctx.rect(d.x, d.y, d.w, d.h);
  if (a > 0) {
    const [x0, y0] = vertex(0);
    ctx.moveTo(x0, y0);
    for (let k = 1; k < n; k++) { const [x, y] = vertex(k); ctx.lineTo(x, y); }
    ctx.closePath();
  }
  ctx.fillStyle = '#161616';
  ctx.fill('evenodd');
  // Arêtes des lamelles.
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const [x1, y1] = vertex(k);
    const [x2, y2] = vertex((k + 1) % n);
    // direction du bord k→k+1 (si fermé, tous les sommets sont au centre : on prend la direction théorique)
    const ang = twist + Math.PI / n + (k * 2 * Math.PI) / n + Math.PI / 2 + Math.PI / n;
    const dx = a > 0 ? x2 - x1 : Math.cos(ang), dy = a > 0 ? y2 - y1 : Math.sin(ang);
    const len = Math.hypot(dx, dy) || 1;
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 + (dx / len) * L, y2 + (dy / len) * L);
  }
  ctx.stroke();
  ctx.restore();
}

/** r : un rayon, ou [haut-gauche, haut-droit, bas-droit, bas-gauche]. */
export function roundedRectPath(ctx, x, y, w, h, r) {
  const clamp = (v) => Math.max(0, Math.min(v || 0, w / 2, h / 2));
  const [tl, tr, br, bl] = (Array.isArray(r) ? r : [r, r, r, r]).map(clamp);
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, [tl, tr, br, bl]);
  } else {
    ctx.moveTo(x + tl, y);
    ctx.arcTo(x + w, y, x + w, y + h, tr);
    ctx.arcTo(x + w, y + h, x, y + h, br);
    ctx.arcTo(x, y + h, x, y, bl);
    ctx.arcTo(x, y, x + w, y, tl);
    ctx.closePath();
  }
}

/** Même calcul que textLayout() côté serveur. */
export function textLayout(l) {
  const lines = String(l.text ?? '').split('\n');
  const lh = l.fontSize * (l.lineHeight || 1.2);
  const total = lines.length * lh;
  const tx = l.x + (l.align === 'center' ? l.width / 2 : l.align === 'right' ? l.width : 0);
  const y0 = l.y + l.height / 2 - total / 2 + lh / 2 + l.fontSize * 0.35;
  return { lines, lh, tx, y0 };
}

export function fontCss(l) {
  return `${l.italic ? 'italic ' : ''}${l.weight === 'bold' ? '700' : '400'} ${l.fontSize}px ${FONT_STACKS[l.font] || FONT_STACKS.sans}`;
}

/**
 * Dessine le template. Le canvas doit avoir la taille template × scale.
 * opts.photos   : { [shot]: HTMLImageElement } photos déjà prises
 * opts.live     : { el, w, h, shot, shutter? } flux live à afficher dans les emplacements de cette photo ;
 *                 shutter ∈ [0,1] = fermeture de l'obturateur dessiné par-dessus (1 = fermé, 0 = ouvert)
 * opts.assets   : Map src → Image (voir loadAssets)
 * opts.placeholder : dessiner un gris "Photo N" dans les emplacements vides
 * opts.highlightShot : souligner les emplacements de cette photo (couleur highlightColor)
 */
export function renderTemplate(ctx, template, opts = {}) {
  const {
    scale = 1, photos = {}, live = null, assets = new Map(), placeholder = true,
    mirror = false, highlightShot = null, highlightColor = '#e63946', frameRadius = 0,
    cutter = null // (src, sw, sh, layer, dest, mirror, isLive) → canvas détouré à dessiner, ou null (voir booth.js)
  } = opts;
  // Calque détouré : la source passe par le cutter (fond vert / bleu, IA), sinon dessin direct.
  const drawPhoto = (src, sw, sh, l, d, isLive) => {
    const cut = cutter && l.cutout && l.cutout !== 'none' ? cutter(src, sw, sh, l, d, mirror, isLive) : null;
    if (cut) ctx.drawImage(cut, d.x, d.y, d.w, d.h);
    else drawCover(ctx, src, sw, sh, d, mirror);
  };
  // À l'écran, le canvas est arrondi par le CSS : dans les coins d'un calque qui touchent le bord
  // du template, le liseré (et donc le flux visible) suit cet arrondi au lieu de rester carré.
  const displayRadii = (l) => {
    const r = l.radius || 0;
    if (!frameRadius || l.rotation) return r;
    const eps = 1;
    const left = l.x <= eps, top = l.y <= eps, right = l.x + l.width >= template.width - eps, bottom = l.y + l.height >= template.height - eps;
    return [top && left, top && right, bottom && right, bottom && left].map((corner) => (corner ? Math.max(r, frameRadius) : r));
  };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.scale(scale, scale);
  ctx.fillStyle = template.background || '#ffffff';
  ctx.fillRect(0, 0, template.width, template.height);

  for (const l of template.layers) {
    if (l.visible === false) continue;
    ctx.save();
    ctx.globalAlpha = l.opacity ?? 1;
    if (l.rotation) {
      const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate((l.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }

    if (l.type === 'photo') {
      const d = { x: l.x, y: l.y, w: l.width, h: l.height };
      ctx.save();
      roundedRectPath(ctx, l.x, l.y, l.width, l.height, l.radius);
      ctx.clip();
      const img = photos[l.shot];
      const iw = img ? (img.naturalWidth || img.videoWidth) : 0;
      if (img && iw) {
        drawPhoto(img, iw, img.naturalHeight || img.videoHeight, l, d, false); // photos prises : même sens que le live
      } else if (live && live.shot === l.shot && (live.w || live.shutter > 0)) {
        if (live.w) drawPhoto(live.el, live.w, live.h, l, d, true);
        else { ctx.fillStyle = '#101010'; ctx.fillRect(d.x, d.y, d.w, d.h); }
        // Obturateur à lamelles : fermé tant que le boîtier n'envoie rien, s'ouvre sur la première image.
        if (live.shutter > 0) drawIris(ctx, d, live.shutter, scale);
      } else if (placeholder) {
        ctx.fillStyle = 'rgba(0,0,0,0.10)';
        ctx.fillRect(d.x, d.y, d.w, d.h);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.font = `700 ${Math.max(12, Math.min(d.w, d.h) / 6)}px ${FONT_STACKS.sans}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`Photo ${l.shot + 1}`, d.x + d.w / 2, d.y + d.h / 2);
      }
      ctx.restore();
      if (highlightShot === l.shot && !(img && iw)) {
        const lw = 8 / scale;
        const radii = displayRadii(l);
        // Liseré tracé sur le bord exact du calque, en double épaisseur, découpé au calque :
        // sa moitié extérieure disparaît et la moitié restante suit fidèlement la courbe du coin.
        ctx.save();
        roundedRectPath(ctx, l.x, l.y, l.width, l.height, radii);
        ctx.clip();
        ctx.lineWidth = lw * 2;
        ctx.strokeStyle = highlightColor;
        roundedRectPath(ctx, l.x, l.y, l.width, l.height, radii);
        ctx.stroke();
        ctx.restore();
      }
    } else if (l.type === 'image') {
      const img = assets.get(l.src);
      if (img && img.naturalWidth) {
        ctx.save();
        roundedRectPath(ctx, l.x, l.y, l.width, l.height, l.radius);
        ctx.clip();
        ctx.drawImage(img, l.x, l.y, l.width, l.height);
        ctx.restore();
      } else if (placeholder) {
        ctx.setLineDash([12 / scale, 8 / scale]);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 2 / scale;
        ctx.strokeRect(l.x, l.y, l.width, l.height);
        ctx.setLineDash([]);
      }
    } else if (l.type === 'rect') {
      roundedRectPath(ctx, l.x, l.y, l.width, l.height, l.radius);
      if (l.fill && l.fill !== 'none') {
        ctx.fillStyle = l.fill;
        ctx.fill();
      }
      if (l.stroke && l.stroke !== 'none' && l.strokeWidth > 0) {
        ctx.lineWidth = l.strokeWidth;
        ctx.strokeStyle = l.stroke;
        ctx.stroke();
      }
    } else if (l.type === 'text') {
      ctx.font = fontCss(l);
      ctx.fillStyle = l.color || '#000000';
      ctx.textAlign = l.align || 'center';
      ctx.textBaseline = 'alphabetic';
      const { lines, lh, tx, y0 } = textLayout(l);
      lines.forEach((line, i) => ctx.fillText(line, tx, y0 + i * lh));
    }
    ctx.restore();
  }
  ctx.restore();
}
