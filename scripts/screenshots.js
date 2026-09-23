/**
 * Vérification visuelle : démarre le serveur (caméra et imprimante simulées),
 * pilote Chrome en mode headless via le protocole DevTools et capture chaque
 * écran de la borne, de l'admin et de la galerie.
 *   node scripts/screenshots.js [dossier de sortie]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const OUT = process.argv[2] || path.join(process.cwd(), 'output', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-shots-'));
process.env.BOOTH_CAMERA = 'mock';
process.env.BOOTH_PRINTER = 'mock';
process.env.BOOTH_DB_FILE = path.join(tmp, 'db.json');
process.env.BOOTH_CONFIG_FILE = path.join(tmp, 'config.json');
process.env.BOOTH_OUTPUT_DIR = path.join(tmp, 'output');
process.env.BOOTH_TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.BOOTH_SAMPLES_DIR = path.join(tmp, 'samples');

const { generateDemoAssets } = await import('./make-demo-assets.js');
await generateDemoAssets({ templatesDir: process.env.BOOTH_TEMPLATES_DIR, samplesDir: process.env.BOOTH_SAMPLES_DIR });
const { createApp } = await import('../server/app.js');
const app = await createApp({ port: 0 });
await new Promise((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${app.server.address().port}`;
app.config.update({ printer: { mockDelayMs: 1500 }, limits: { countdownSec: 1 } });

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1920,1200',
  '--hide-scrollbars', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', () => reject(new Error('Chrome s\'est arrêté')));
  setTimeout(() => reject(new Error('Chrome ne répond pas')), 15000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (m, p) => send(m, p, sessionId);
await page('Page.enable');
await page('Runtime.enable');
await page('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1200, deviceScaleFactor: 1, mobile: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
  return r.result.value;
};
const waitFor = async (expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return;
    await sleep(150);
  }
  throw new Error(`Délai dépassé : ${expr}`);
};
fs.mkdirSync(OUT, { recursive: true });
const shot = async (name) => {
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  ✓ ${name}.png`);
};
const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click(), true`);

try {
  await page('Page.navigate', { url: `${base}/` });
  await waitFor(`document.querySelector('#screen-idle.active') && document.querySelector('#txtWelcome').textContent.length > 0`);
  await sleep(800);
  await shot('01-accueil');

  await click('#screen-idle');
  await waitFor(`document.querySelector('#screen-template.active') && document.querySelectorAll('.template-card').length === 2`);
  await sleep(800);
  await shot('02-choix-template');

  await evaluate(`document.querySelectorAll('.template-card')[1].click(), true`); // bande 3 photos
  await waitFor(`document.querySelector('#screen-capture.active') && !document.querySelector('#btnStart').classList.contains('hidden')`);
  await sleep(1800); // laisse arriver quelques images du flux live
  await shot('03-prise-de-vue-live-dans-template');

  await click('#btnStart');
  await sleep(600);
  await shot('04-decompte');
  await waitFor(`document.querySelector('#screen-review.active')`, 40000);
  await sleep(800);
  await shot('05-relecture');

  await click('#btnRetake');
  await sleep(500);
  await shot('06-choix-photo-a-refaire');
  await click('#retakeChooser .retake-thumb');
  await waitFor(`document.querySelector('#screen-capture.active')`);
  await sleep(1000);
  await shot('07-reprise-photo-1');
  await click('#btnStart');
  await waitFor(`document.querySelector('#screen-review.active')`, 30000);

  await click('#btnKeep');
  await waitFor(`document.querySelector('#screen-copies.active')`);
  await click('#btnPlus');
  await sleep(500);
  await shot('08-nombre-de-copies');

  await click('#btnPrint');
  await waitFor(`document.querySelector('#screen-printing.active')`);
  await sleep(300);
  await shot('09-impression');
  await waitFor(`document.querySelector('#screen-done.active') && document.querySelector('#qrImg').src.startsWith('data:')`, 20000);
  await sleep(500);
  await shot('10-fin-qr-code');

  // Administration
  await page('Page.navigate', { url: `${base}/admin.html` });
  await waitFor(`!document.querySelector('#login').classList.contains('hidden')`);
  await sleep(300);
  await shot('11-admin-connexion');
  await evaluate(`fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:${JSON.stringify(app.config.get().admin.pin)}})}).then(r=>r.ok)`);
  await evaluate(`location.hash = "dashboard"; location.reload(); true`);
  await waitFor(`!document.querySelector('#shell').classList.contains('hidden') && document.querySelector('.stat')`);
  await sleep(400);
  await shot('12-admin-tableau-de-bord');
  for (const [hash, name] of [['limits', '13-admin-limites'], ['theme', '14-admin-theme'], ['templates', '15-admin-templates'], ['editor=strip-3', '16-admin-editeur-template'], ['hardware', '17-admin-materiel'], ['sessions', '18-admin-sessions']]) {
    await evaluate(`location.hash = ${JSON.stringify(hash)}, true`);
    await sleep(hash.startsWith('editor') ? 1200 : 600);
    if (hash.startsWith('editor')) await evaluate(`document.querySelectorAll('#edLayers li')[1]?.click(), true`); // sélectionne un calque pour montrer les poignées
    await sleep(300);
    await shot(name);
  }

  // Galerie invité
  const sid = await evaluate(`fetch('/api/admin/state').then(r => r.json()).then(s => s.sessions[0].id)`);
  await page('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
  await page('Page.navigate', { url: `${base}/g/${sid}` });
  await sleep(1000);
  await shot('19-galerie-invite-mobile');
  console.log(`\nCaptures dans ${OUT}`);
} catch (e) {
  console.error(`\nÉchec : ${e.message}`);
  process.exitCode = 1;
  try { await shot('99-erreur'); } catch { /* ignore */ }
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  await app.close();
  for (const d of [tmp, profile]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Chrome peut encore écrire */ } }
}
