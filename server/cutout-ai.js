import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from './paths.js';

/**
 * Détourage IA de la photo finale : MODNet (portrait matting, Apache-2.0) via onnxruntime, hors ligne.
 * Plus fin que le modèle de l'aperçu (cheveux, contours), ~0,1 à 0,5 s par photo selon la machine.
 * Modèle chargé au premier usage puis gardé en mémoire.
 */
const MODEL = path.join(ROOT, 'server', 'models', 'modnet.onnx');
const REF = { standard: 512, fine: 1024 }; // côté long donné au modèle (multiple de 32), selon la précision

let loading = null;
function session() {
  loading ||= (async () => {
    const ort = (await import('onnxruntime-node')).default;
    // Lu en mémoire : dans l'app empaquetée, le modèle est dans l'archive asar que onnxruntime ne sait pas lire.
    const s = await ort.InferenceSession.create(fs.readFileSync(MODEL));
    return { ort, s };
  })();
  loading.catch(() => { loading = null; }); // réessai au prochain appel
  return loading;
}

/**
 * Masque de personne (octets 0-255, un par pixel) d'une image RGB brute w×h.
 * precision 'fine' : modèle en 1024 px (cheveux, détails), plus lent. contour : ±px, élargit / rétrécit la découpe.
 */
export async function personMatte(rgb, w, h, { precision = 'standard', contour = 0 } = {}) {
  const { ort, s } = await session();
  const k = (REF[precision] || REF.standard) / Math.max(w, h);
  const W = Math.max(32, Math.round((w * k) / 32) * 32);
  const H = Math.max(32, Math.round((h * k) / 32) * 32);
  const small = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(W, H, { fit: 'fill' }).raw().toBuffer();
  const input = new Float32Array(3 * W * H);
  for (let i = 0, n = W * H; i < n; i++) {
    input[i] = small[i * 3] / 127.5 - 1;
    input[n + i] = small[i * 3 + 1] / 127.5 - 1;
    input[2 * n + i] = small[i * 3 + 2] / 127.5 - 1;
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) });
  const m = out[s.outputNames[0]].data;
  const bytes = Buffer.alloc(W * H);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(m[i] * 255)));
  // extractChannel : sans lui, sharp peut rendre le masque en 3 canaux (décalage d'une ligne à l'autre)
  let img = sharp(bytes, { raw: { width: W, height: H, channels: 1 } }).resize(w, h, { fit: 'fill' });
  const px = Math.round(Math.abs(contour));
  if (px) img = sharp(await img.extractChannel(0).raw().toBuffer(), { raw: { width: w, height: h, channels: 1 } })[contour > 0 ? 'erode' : 'dilate'](px); // sharp opère sur les zones sombres : erode élargit le blanc (la personne)
  return img.extractChannel(0).raw().toBuffer();
}
