/**
 * Test de bout en bout sans matériel : caméra et imprimante simulées, données
 * dans un dossier temporaire (la vraie config n'est pas touchée).
 *   npm run smoke
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-smoke-'));
process.env.BOOTH_DB_FILE = path.join(tmp, 'db.json');
process.env.BOOTH_CONFIG_FILE = path.join(tmp, 'config.json');
process.env.BOOTH_OUTPUT_DIR = path.join(tmp, 'output');
process.env.BOOTH_TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.BOOTH_SAMPLES_DIR = path.join(tmp, 'samples');
process.env.BOOTH_CAMERA = 'mock';
process.env.BOOTH_PRINTER = 'mock';
process.env.BOOTH_STREAMDECK = 'off'; // ne pas prendre la main sur un Stream Deck branché

const { generateDemoAssets } = await import('./make-demo-assets.js');
await generateDemoAssets({ templatesDir: process.env.BOOTH_TEMPLATES_DIR, samplesDir: process.env.BOOTH_SAMPLES_DIR });
const { createApp } = await import('../server/app.js');
const { PUBLIC_DIR, SAMPLES_DIR } = await import('../server/paths.js');
const sharp = (await import('sharp')).default;

setTimeout(() => { console.error("\nTest bloqué > 90 s"); process.exit(2); }, 90000).unref();
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
    throw e;
  }
};

async function run(camera) {
  process.env.BOOTH_CAMERA = camera;
  // Chaque passe repart de compteurs et d'une config vierges.
  for (const f of [process.env.BOOTH_DB_FILE, process.env.BOOTH_CONFIG_FILE]) fs.rmSync(f, { force: true });
  const app = await createApp({ port: 0 });
  try {
    await runSteps(app, camera);
  } finally {
    await app.close();
  }
}

async function runSteps(app, camera) {
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const ADMIN = { 'x-admin-pin': app.config.get().admin.pin };
  const j = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  const post = (p, body, headers = {}) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const put = (p, body, headers = {}) => j(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const sampleJpeg = fs.readFileSync(path.join(SAMPLES_DIR, 'sample-1.jpg'));
  const uploadShot = async (id, index) => {
    const form = new FormData();
    form.append('photo', new Blob([sampleJpeg], { type: 'image/jpeg' }), 'shot.jpg');
    return j(`/api/session/${id}/shot/${index}`, { method: 'POST', body: form });
  };
  const shot = (id, index) => (camera === 'browser' ? uploadShot(id, index) : post(`/api/session/${id}/shot/${index}`, {}));
  const waitStatus = async (id, wanted, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const { data } = await j(`/api/session/${id}`);
      if (data.status === wanted) return data;
      if (Date.now() - t0 > ms) throw new Error(`statut ${data.status}, attendu ${wanted}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  console.log(`\nCaméra "${camera}" sur ${base}`);
  // Imprimante mock plus rapide pour le test.
  app.config.update({ printer: { mockDelayMs: 300 } });

  let boot;
  await step('bootstrap : templates, thème, mode caméra', async () => {
    boot = (await j('/api/bootstrap')).data;
    assert.equal(boot.camera.mode, camera === 'browser' ? 'browser' : 'server');
    assert.ok(boot.templates.items.some((t) => t.id === 'strip-3'));
    assert.ok(boot.theme.colors.primary);
    assert.equal(boot.limits.operatorPin, undefined, 'le PIN opérateur ne doit pas fuiter');
  });

  let s;
  await step('session bande 3 photos + prises de vue', async () => {
    s = (await post('/api/session', { templateId: 'strip-3' })).data;
    assert.equal(s.shotsExpected, 3);
    for (let i = 0; i < 3; i++) {
      assert.equal((await post(`/api/session/${s.id}/arm`, {})).status, 200); // pré-armement à « 1 » du décompte
      const r = await shot(s.id, i);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.shot.url.includes(`/output/sessions/${s.id}/`));
    }
  });

  await step('reprises : 2 autorisées, la 3e refusée', async () => {
    assert.equal((await shot(s.id, 1)).data.session.retakes, 1);
    assert.equal((await shot(s.id, 1)).data.session.retakes, 2);
    const r = await shot(s.id, 0);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'RETAKE_LIMIT');
  });

  await step('reprises illimitées (-1) puis retour à 2', async () => {
    await put('/api/admin/config', { limits: { maxRetakesPerSession: -1 } }, ADMIN);
    for (let k = 0; k < 3; k++) assert.equal((await shot(s.id, 1)).status, 200, 'reprise illimitée refusée');
    assert.equal((await j(`/api/session/${s.id}`)).data.retakesLeft, null);
    await put('/api/admin/config', { limits: { maxRetakesPerSession: 2 } }, ADMIN);
  });

  await step('montage final aux dimensions du template, overlay appliqué', async () => {
    const r = await post(`/api/session/${s.id}/compose`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    s = r.data;
    assert.equal(s.status, 'review');
    const file = path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id, 'final.jpg');
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 1800);
    // Le coin haut-gauche est couvert par l'overlay orange, pas par une photo.
    const px = await sharp(file).extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(px[0] > 200 && px[2] < 140, `pixel overlay inattendu ${[...px]}`);
  });

  await step('copies : 5 refusées (max 2), 2 acceptées, impression terminée, compteurs à jour', async () => {
    const bad = await post(`/api/session/${s.id}/print`, { copies: 5 });
    assert.equal(bad.status, 400);
    const ok = await post(`/api/session/${s.id}/print`, { copies: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.status, 'printing');
    const done = await waitStatus(s.id, 'done');
    assert.equal(done.copies, 2);
    const counters = (await j('/api/bootstrap')).data.counters;
    assert.equal(counters.printed, 2);
    assert.equal(counters.quotaRemaining, 198);
    const prints = fs.readdirSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'prints'));
    assert.ok(prints.some((f) => f.includes(s.id)), 'fichier imprimé absent');
  });

  await step('impression refusée après la relecture (session déjà terminée)', async () => {
    const r = await post(`/api/session/${s.id}/print`, { copies: 1 });
    assert.equal(r.status, 409);
  });

  await step('quota événement : refus au-delà, code opérateur lève la limite', async () => {
    assert.equal((await put('/api/admin/config', { limits: { eventQuota: 3 } }, ADMIN)).status, 200);
    const s2 = (await post('/api/session', { templateId: 'classic-10x15' })).data;
    await shot(s2.id, 0);
    await post(`/api/session/${s2.id}/compose`, {});
    const refused = await post(`/api/session/${s2.id}/print`, { copies: 2 });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.error, 'QUOTA_REACHED');
    const badPin = await post(`/api/session/${s2.id}/unlock`, { pin: '9999' });
    assert.equal(badPin.status, 403);
    const unlocked = await post(`/api/session/${s2.id}/unlock`, { pin: app.config.get().limits.operatorPin });
    assert.equal(unlocked.data.maxCopies, 10);
    const ok = await post(`/api/session/${s2.id}/print`, { copies: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    await waitStatus(s2.id, 'done');
    assert.equal((await j('/api/bootstrap')).data.counters.quotaReached, true);
  });

  await step('sans impression (0 copie) termine la session', async () => {
    await put('/api/admin/config', { limits: { eventQuota: 0 } }, ADMIN);
    const s3 = (await post('/api/session', {})).data; // template par défaut
    assert.equal(s3.templateId, 'classic-10x15');
    await shot(s3.id, 0);
    await post(`/api/session/${s3.id}/compose`, {});
    const r = await post(`/api/session/${s3.id}/print`, { copies: 0 });
    assert.equal(r.data.status, 'done');
  });

  await step('QR code et page galerie', async () => {
    const q = (await j(`/api/session/${s.id}/qr`)).data;
    assert.ok(q.url.endsWith(`/g/${s.id}`));
    assert.ok(q.dataUrl.startsWith('data:image/png'));
    const page = await fetch(`${base}/g/${s.id}`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('Télécharger la photo'));
  });

  await step('admin : refus sans PIN, état complet, réimpression, compteurs', async () => {
    assert.equal((await j('/api/admin/state')).status, 401);
    const st = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.ok(st.sessions.length >= 3);
    assert.ok(st.themes.length >= 3);
    const rp = await post(`/api/admin/reprint/${s.id}`, { copies: 1 }, ADMIN);
    assert.equal(rp.status, 200, JSON.stringify(rp.data));
    await waitStatus(s.id, 'done');
    const c = (await post('/api/admin/counters', { paperRemaining: 15 }, ADMIN)).data;
    assert.equal(c.lowPaper, true);
  });

  await step('admin : suppression d\'une session puis réinitialisation complète', async () => {
    const before = (await j('/api/admin/state', { headers: ADMIN })).data;
    const victim = before.sessions.find((x) => x.status === 'done' && x.id !== s.id);
    const dir = path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', victim.id);
    assert.ok(fs.existsSync(dir));
    assert.equal((await j(`/api/admin/sessions/${victim.id}`, { method: 'DELETE', headers: ADMIN })).status, 200);
    assert.ok(!fs.existsSync(dir), 'le dossier de la session doit être effacé');
    assert.equal((await j(`/api/session/${victim.id}`)).status, 404);
    assert.equal((await j(`/api/admin/sessions/${victim.id}`, { method: 'DELETE', headers: ADMIN })).status, 404);
    let after = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.equal(after.counters.sessions, before.counters.sessions - 1);
    assert.ok(!after.sessions.some((x) => x.id === victim.id));

    const reset = await post('/api/admin/sessions/reset', {}, ADMIN);
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    assert.equal(reset.data.removed, before.counters.sessions - 1);
    after = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.equal(after.counters.sessions, 0);
    assert.equal(after.sessions.length, 0);
    assert.equal(fs.readdirSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions')).length, 0);
    assert.ok(after.prints.length > 0, 'l\'historique des tirages est conservé');
    assert.equal((await j(`/g/${s.id}`)).status, 404);
    // La borne repart normalement après une réinitialisation.
    s = (await post('/api/session', { templateId: 'strip-3' })).data;
    for (let i = 0; i < 3; i++) await shot(s.id, i);
    await post(`/api/session/${s.id}/compose`, {});
    await post(`/api/session/${s.id}/print`, { copies: 0 });
    assert.equal((await j('/api/bootstrap')).data.counters.sessions, 1);
  });

  await step('auto-détection : imprimante absente → QR seulement, repli mock, caméra de repli, tout à chaud', async () => {
    // Le test force les pilotes par variables d'environnement : on lève la surcharge le temps de l'étape.
    const savedRuntime = app.config.runtime;
    app.config.runtime = {};
    const devices = async () => (await j('/api/admin/state', { headers: ADMIN })).data.devices;
    const until = async (pred, what) => {
      const t0 = Date.now();
      for (;;) {
        const d = await devices();
        if (pred(d)) return d;
        if (Date.now() - t0 > 8000) throw new Error(`${what} (état : ${JSON.stringify(d)})`);
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    try {
      // Caméra en auto sans boîtier (détection neutralisée) → repli = caméra du test.
      // Imprimante en auto avec une file CUPS inexistante → repli 'none'.
      const r = await put('/api/admin/config', {
        camera: { driver: 'auto', fallback: camera, gphoto2: { detectCommand: 'true' } },
        printer: { driver: 'auto', fallback: 'none', cups: { name: 'smoke-inexistante' } }
      }, ADMIN);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      let d = await until((x) => x.camera.driver === camera && x.printer.driver === 'none', 'replis attendus');
      assert.equal(d.camera.requested, 'auto');
      assert.equal(d.printer.requested, 'auto');
      let b = (await j('/api/bootstrap')).data;
      assert.equal(b.camera.driver, camera);
      assert.equal(b.printer.available, false);

      const s6 = (await post('/api/session', { templateId: 'classic-10x15' })).data;
      assert.equal((await shot(s6.id, 0)).status, 200);
      await post(`/api/session/${s6.id}/compose`, {});
      const refused = await post(`/api/session/${s6.id}/print`, { copies: 1 });
      assert.equal(refused.status, 409);
      assert.equal(refused.data.error, 'PRINTER_UNAVAILABLE');
      assert.equal((await post(`/api/session/${s6.id}/print`, { copies: 0 })).data.status, 'done');

      // Repli mock : l'impression repart, sans redémarrage.
      await put('/api/admin/config', { printer: { fallback: 'mock' } }, ADMIN);
      await until((x) => x.printer.driver === 'mock', 'repli mock attendu');
      assert.equal((await j('/api/bootstrap')).data.printer.available, true);
      const s7 = (await post('/api/session', { templateId: 'classic-10x15' })).data;
      await shot(s7.id, 0);
      await post(`/api/session/${s7.id}/compose`, {});
      assert.equal((await post(`/api/session/${s7.id}/print`, { copies: 1 })).status, 200);
      await waitStatus(s7.id, 'done');

      // Retour aux pilotes explicites du test.
      await put('/api/admin/config', { camera: { driver: camera }, printer: { driver: 'mock' } }, ADMIN);
      await until((x) => x.camera.requested === camera && x.printer.requested === 'mock', 'retour aux pilotes du test');
    } finally {
      app.config.runtime = savedRuntime;
    }
  });

  await step('admin : thème personnalisé + logo appliqué à tous les thèmes', async () => {
    const form = new FormData();
    form.append('logo', new Blob([fs.readFileSync(path.join(PUBLIC_DIR, 'assets', 'logo-default.svg'))], { type: 'image/svg+xml' }), 'logo.svg');
    const up = await j('/api/admin/logo', { method: 'POST', headers: ADMIN, body: form });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    await put('/api/admin/config', { booth: { name: 'Ma borne' }, theme: { active: 'default-dark' } }, ADMIN);
    let b = (await j('/api/bootstrap')).data;
    assert.equal(b.booth.name, 'Ma borne');
    assert.ok(b.theme.logo.startsWith('/uploads/logo-'), 'le logo doit s\'appliquer avec un thème livré');
    assert.equal((await fetch(base + b.theme.logo)).status, 200);
    await put('/api/admin/config', { theme: { active: 'custom', custom: { colors: { primary: '#123456' } } } }, ADMIN);
    b = (await j('/api/bootstrap')).data;
    assert.equal(b.theme.colors.primary, '#123456');
  });

  let tplA, tplB;
  await step('templates : création par nom, id déduit, taille du format par défaut', async () => {
    const r = await post('/api/admin/templates', { name: 'Mariage Julie & Marc' }, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    tplA = r.data;
    assert.equal(tplA.id, 'mariage-julie-marc');
    assert.equal(tplA.width, 1800);
    assert.equal(tplA.height, 1200);
    assert.equal(tplA.layers.length, 1);
    assert.equal(tplA.layers[0].type, 'photo');
    tplB = (await post('/api/admin/templates', { name: 'Mariage Julie & Marc', format: '10x15-portrait' }, ADMIN)).data;
    assert.equal(tplB.id, 'mariage-julie-marc-2');
    assert.equal(tplB.height, 1800);
    assert.equal((await post('/api/admin/templates', { name: '   ' }, ADMIN)).status, 400);
    assert.ok((await j('/api/bootstrap')).data.templates.items.some((t) => t.id === tplA.id), 'le nouveau template doit être activé');
  });

  await step('templates : calques (photo, forme, texte, image) enregistrés puis imprimés', async () => {
    const af = new FormData();
    const logoPng = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
    af.append('image', new Blob([logoPng], { type: 'image/png' }), 'logo.png');
    const asset = (await j(`/api/admin/templates/${tplA.id}/assets`, { method: 'POST', headers: ADMIN, body: af })).data;
    assert.ok(asset.src.startsWith('assets/'));
    assert.equal(asset.width, 200);
    const layers = [
      { type: 'rect', x: 0, y: 1000, width: 1800, height: 200, fill: '#ff0000' },
      { type: 'photo', shot: 0, x: 100, y: 100, width: 1600, height: 850, radius: 40 },
      { type: 'text', text: 'Julie & Marc\n23 septembre', x: 0, y: 1000, width: 1800, height: 200, fontSize: 60, font: 'serif', weight: 'bold', color: '#ffffff', align: 'center' },
      { type: 'image', src: asset.src, x: 1500, y: 20, width: 200, height: 100, opacity: 0.5 },
      // Rectangle 400x100 tourné de 90° autour de son centre (400, 250) : il occupe x 350..450, y 50..450
      { type: 'rect', x: 200, y: 200, width: 400, height: 100, fill: '#0000ff', rotation: 90 }
    ];
    const saved = await put(`/api/admin/templates/${tplA.id}`, { name: 'Julie & Marc', background: '#00ff00', layers }, ADMIN);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.name, 'Julie & Marc');
    assert.equal(saved.data.layers.length, 5);
    assert.ok(saved.data.layers[3].url.endsWith(asset.src));
    assert.equal(saved.data.layers[4].rotation, 90);

    const s5 = (await post('/api/session', { templateId: tplA.id })).data;
    await shot(s5.id, 0);
    const c = await post(`/api/session/${s5.id}/compose`, {});
    assert.equal(c.status, 200, JSON.stringify(c.data));
    const file = path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s5.id, 'final.jpg');
    const px = async (x, y) => [...await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()];
    const bg = await px(20, 20);      assert.ok(bg[1] > 200 && bg[0] < 60, `fond vert attendu, reçu ${bg}`);
    const band = await px(50, 1100);  assert.ok(band[0] > 200 && band[1] < 60, `bande rouge attendue, reçu ${band}`);
    const logo = await px(1600, 70);  assert.ok(logo[2] > 100 && logo[1] > 60, `logo bleu à 50 % sur rouge attendu, reçu ${logo}`);
    const photo = await px(900, 500); assert.ok(!(photo[1] > 200 && photo[0] < 60), 'la photo doit recouvrir le fond');
    const rot = await px(400, 400);   assert.ok(rot[2] > 200 && rot[0] < 60 && rot[1] < 60, `rectangle tourné attendu en (400,400), reçu ${rot}`);
    const unrot = await px(250, 250); assert.ok(!(unrot[2] > 200 && unrot[0] < 60 && unrot[1] < 60), `(250,250) ne doit plus être couvert par le rectangle une fois tourné, reçu ${unrot}`);

    const bad = await put(`/api/admin/templates/${tplA.id}`, { layers: [{ type: 'photo', shot: 2, x: 0, y: 0, width: 100, height: 100 }] }, ADMIN);
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'SHOTS_GAP');
    assert.equal((await put(`/api/admin/templates/${tplA.id}`, { layers: [{ type: 'rect', x: 0, y: 0, width: 10, height: 10 }] }, ADMIN)).data.error, 'NO_PHOTO_LAYER');
  });

  await step('templates : suppression', async () => {
    for (const id of [tplA.id, tplB.id]) assert.equal((await j(`/api/admin/templates/${id}`, { method: 'DELETE', headers: ADMIN })).status, 200);
    assert.ok(!fs.existsSync(path.join(app.templates.dir, tplA.id)));
    const st = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.ok(st.sessions.some((s) => s.templateName === tplA.id), 'une session dont le template est supprimé reste listée');
  });

  if (camera !== 'browser') {
    await step('flux MJPEG de l\'aperçu live', async () => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/api/live.mjpeg`, { signal: ctrl.signal });
      assert.ok(res.headers.get('content-type').includes('multipart/x-mixed-replace'));
      const reader = res.body.getReader();
      const { value } = await reader.read();
      assert.ok(value.length > 100);
      ctrl.abort();
    });
  } else {
    await step('mode navigateur : photo obligatoire dans la requête', async () => {
      const s4 = (await post('/api/session', {})).data;
      const r = await post(`/api/session/${s4.id}/shot/0`, {});
      assert.equal(r.status, 400);
      assert.equal(r.data.error, 'PHOTO_REQUIRED');
    });
  }

}

try {
  await run('mock');
  await run('browser');
  console.log(`\n${passed} étapes OK. Données temporaires : ${tmp}`);
} catch {
  console.error('\nÉchec du test.');
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
