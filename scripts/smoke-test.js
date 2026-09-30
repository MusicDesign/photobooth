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
    assert.ok(!(await page.text()).includes('Télécharger la photo'));
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
    // Seules les sessions de l'événement sont effacées (pas les dossiers laissés par la passe précédente)
    const left = fs.readdirSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions'));
    assert.ok(!before.sessions.some((x) => left.includes(x.id)), 'les dossiers des sessions de l\'événement doivent être effacés');
    assert.ok(after.prints.length > 0, 'l\'historique des tirages est conservé');
    assert.equal((await j(`/g/${s.id}`)).status, 404);
    // La borne repart normalement après une réinitialisation.
    s = (await post('/api/session', { templateId: 'strip-3' })).data;
    for (let i = 0; i < 3; i++) await shot(s.id, i);
    await post(`/api/session/${s.id}/compose`, {});
    await post(`/api/session/${s.id}/print`, { copies: 0 });
    assert.equal((await j('/api/bootstrap')).data.counters.sessions, 1);
  });

  await step('sessions : seules les sessions validées (« Je la garde ») sont conservées', async () => {
    const make = async () => {
      const x = (await post('/api/session', { templateId: 'strip-3' })).data;
      for (let i = 0; i < 3; i++) await shot(x.id, i);
      await post(`/api/session/${x.id}/compose`, {});
      return x.id;
    };
    const abandoned = await make();
    assert.equal((await post(`/api/session/${abandoned}/abandon`, {})).data.deleted, true, 'relecture abandonnée : supprimée');
    assert.equal((await j(`/api/session/${abandoned}`)).status, 404);
    assert.ok(!fs.existsSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', abandoned)), 'photos effacées');
    const kept = await make();
    assert.equal((await post(`/api/session/${kept}/keep`, {})).status, 200);
    assert.equal((await post(`/api/session/${kept}/abandon`, {})).data.deleted, false, 'validée : conservée');
    const printed = await make();
    await post(`/api/session/${printed}/print`, { copies: 0 });
    assert.equal((await post(`/api/session/${printed}/abandon`, {})).data.deleted, false, 'terminée : conservée');
    // Filet de sécurité : une session non validée ancienne est purgée, une validée jamais
    const old = await make();
    app.store.getSession(old).createdAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    app.store.getSession(kept).createdAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    app.booth.purgeUnvalidatedSessions();
    assert.equal((await j(`/api/session/${old}`)).status, 404);
    assert.equal((await j(`/api/session/${kept}`)).status, 200);
  });

  await step('événements : création, rattachement, compteurs par événement, déplacement, export ZIP, suppression', async () => {
    const st = (await j('/api/admin/state', { headers: ADMIN })).data;
    const first = st.activeEventId;
    assert.equal(st.events.find((e) => e.id === first).name, 'Tests', 'les sessions existantes sont rangées dans « Tests »');
    const ev = (await post('/api/admin/events', { name: 'Mariage Léa & Tom', date: '2026-10-03', activate: true }, ADMIN)).data;
    assert.equal(ev.active, true);
    let b = (await j('/api/bootstrap')).data.counters;
    assert.equal(b.eventId, ev.id);
    assert.equal(b.printed, 0, 'compteur de tirages propre au nouvel événement');
    assert.equal(b.sessions, 0);
    // Une session imprimée va dans l'événement en cours et compte pour lui seul
    await post('/api/admin/counters', { paperRemaining: null }, ADMIN);
    const s2 = (await post('/api/session', { templateId: 'strip-3' })).data;
    for (let i = 0; i < 3; i++) await shot(s2.id, i);
    await post(`/api/session/${s2.id}/compose`, {});
    await post(`/api/session/${s2.id}/print`, { copies: 2 });
    await waitStatus(s2.id, 'done');
    b = (await j('/api/bootstrap')).data.counters;
    assert.equal(b.printed, 2);
    assert.equal(b.sessions, 1);
    const evs = (await j(`/api/admin/events/${ev.id}/sessions`, { headers: ADMIN })).data;
    assert.deepEqual(evs.sessions.map((x) => x.id), [s2.id]);
    // Export : originaux, montages, les deux
    const zipNames = async (content) => {
      const res = await fetch(`${base}/api/admin/events/${ev.id}/export?content=${content}`, { headers: ADMIN });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /Mariage/);
      const buf = Buffer.from(await res.arrayBuffer());
      const names = [];
      for (let i = buf.indexOf('PK\x01\x02'); i >= 0; i = buf.indexOf('PK\x01\x02', i + 4)) names.push(buf.toString('utf8', i + 46, i + 46 + buf.readUInt16LE(i + 28)));
      return names;
    };
    const o = await zipNames('originals');
    assert.equal(o.length, 3);
    assert.ok(o.every((n) => n.includes(`/originaux/${s2.id}/photo-`)), o.join());
    const f = await zipNames('finals');
    assert.deepEqual(f.map((n) => n.split('/').slice(1).join('/')), [`montages/${s2.id}.jpg`]);
    assert.equal((await zipNames('both')).length, 4);
    // Déplacement vers « Tests » : la session et ses tirages suivent
    await post(`/api/admin/sessions/${s2.id}/move`, { eventId: first }, ADMIN);
    b = (await j('/api/bootstrap')).data.counters;
    assert.equal(b.printed, 0);
    assert.equal(b.sessions, 0);
    assert.equal((await j(`/api/admin/events/${ev.id}/export?content=both`, { headers: ADMIN })).status, 404, 'événement vide : rien à exporter');
    // Suppression : refusée pour l'événement en cours, acceptée après changement
    assert.equal((await j(`/api/admin/events/${ev.id}`, { method: 'DELETE', headers: ADMIN })).status, 409);
    await post(`/api/admin/events/${first}/activate`, {}, ADMIN);
    assert.equal((await j(`/api/admin/events/${ev.id}`, { method: 'DELETE', headers: ADMIN })).status, 200);
    const after = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.ok(!after.events.some((e) => e.id === ev.id));
    assert.ok(after.sessions.some((x) => x.id === s2.id), 'la session déplacée reste dans « Tests »');
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
    // Ordre d'affichage (glissé dans l'admin) : la borne et la liste de l'admin le suivent
    await put('/api/admin/config', { templates: { order: [tplB.id, tplA.id] } }, ADMIN);
    const ids = (await j('/api/bootstrap')).data.templates.items.map((t) => t.id);
    assert.ok(ids.indexOf(tplB.id) < ids.indexOf(tplA.id), `ordre choisi sur la borne : ${ids}`);
    const adminIds = (await j('/api/admin/state', { headers: ADMIN })).data.templates.map((t) => t.id);
    assert.deepEqual(adminIds.slice(0, 2), [tplB.id, tplA.id]);
    await put('/api/admin/config', { templates: { order: [] } }, ADMIN);
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
    // Miniature du choix du cadre : calculée à l'enregistrement, servie, renouvelée quand le template change
    assert.equal(saved.data.previews.length, 1);
    const thumb = await fetch(`${base}${saved.data.previews[0]}`);
    assert.equal(thumb.status, 200);
    assert.equal((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width, 720);
    assert.ok(!saved.data.previews[0].endsWith(tplA.previews?.[0] || 'x'), 'nouvelle miniature après modification');
    assert.ok((await j('/api/bootstrap')).data.templates.items.find((t) => t.id === tplA.id).previews.length);

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

  await step('GIF : masqué tant que désactivé, poses, animation, jamais imprimé, refaire toutes les poses', async () => {
    const g = (await post('/api/admin/templates', { name: 'GIF soirée', kind: 'gif', format: '10x10-carre' }, ADMIN)).data;
    assert.equal(g.kind, 'gif');
    assert.deepEqual(g.gif, { frames: 3, frameMs: 500, boomerang: false, poseSec: 2 });
    assert.ok(!(await j('/api/bootstrap')).data.templates.items.some((t) => t.id === g.id), 'GIF désactivés : pas proposé');
    assert.equal((await post('/api/session', { templateId: g.id })).status, 400);
    await put('/api/admin/config', { templates: { gifEnabled: true } }, ADMIN);
    // Deux calques photo (même pose), 3 poses en aller-retour : 1 2 3 2
    const layers = [
      { type: 'photo', shot: 0, x: 0, y: 0, width: 600, height: 1200 },
      { type: 'photo', shot: 3, x: 600, y: 0, width: 600, height: 1200 },
      { type: 'text', text: 'GIF', x: 0, y: 0, width: 1200, height: 200, fontSize: 80, color: '#ffffff' }
    ];
    const saved = (await put(`/api/admin/templates/${g.id}`, { layers, gif: { frames: 3, frameMs: 300, boomerang: true } }, ADMIN)).data;
    assert.equal(saved.shots, 3);
    assert.ok(saved.layers.filter((l) => l.type === 'photo').every((l) => l.shot === 0), 'GIF : tous les calques photo montrent la pose');
    const s = (await post('/api/session', { templateId: g.id })).data;
    assert.equal(s.gif, true);
    assert.equal(s.shotsExpected, 3);
    for (let i = 0; i < 3; i++) await shot(s.id, i);
    const c = (await post(`/api/session/${s.id}/compose`, {})).data;
    assert.ok(c.final.url.endsWith('/final.gif') && c.final.thumbUrl.endsWith('/thumb.jpg') && c.final.gif);
    const meta = await sharp(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id, 'final.gif'), { animated: true }).metadata();
    // Aller-retour 1 2 3 2 à 300 ms (l'encodeur fusionne les images identiques : la durée totale fait foi)
    assert.equal(meta.delay.reduce((a, b) => a + b, 0), 1200, `aller-retour : ${meta.delay}`);
    assert.equal(meta.width, 800, 'GIF réduit à 800 px');
    // Refaire : toutes les poses, une reprise comptée
    const r = (await post(`/api/session/${s.id}/restart`, {})).data;
    assert.ok(r.shots.every((x) => x === null) && r.retakes === 1 && !r.final);
    for (let i = 0; i < 3; i++) await shot(s.id, i);
    await post(`/api/session/${s.id}/compose`, {});
    assert.equal((await post(`/api/session/${s.id}/print`, { copies: 1 })).data.error, 'GIF_NO_PRINT');
    assert.equal((await post(`/api/session/${s.id}/print`, { copies: 0 })).data.status, 'done');
    assert.equal((await post(`/api/admin/reprint/${s.id}`, { copies: 1 }, ADMIN)).data.error, 'GIF_NO_PRINT');
    await put('/api/admin/config', { templates: { gifEnabled: false } }, ADMIN);
    assert.equal((await j(`/api/admin/templates/${g.id}`, { method: 'DELETE', headers: ADMIN })).status, 200);
  });

  await step('filtres : refusés tant que désactivés, noir & blanc sur les photos seulement, gardé à la reprise', async () => {
    const s = (await post('/api/session', { templateId: tplA.id })).data;
    await shot(s.id, 0);
    assert.equal((await post(`/api/session/${s.id}/compose`, { filter: 'bw' })).data.error, 'FILTER', 'filtres désactivés');
    await put('/api/admin/config', { booth: { filters: { enabled: true, available: ['none', 'bw', 'sepia'] } } }, ADMIN);
    assert.equal((await post(`/api/session/${s.id}/compose`, { filter: 'vivid' })).data.error, 'FILTER', 'filtre non proposé');
    const c = (await post(`/api/session/${s.id}/compose`, { filter: 'bw' })).data;
    assert.equal(c.filter, 'bw');
    const file = path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id, 'final.jpg');
    const px = async (x, y) => [...await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()];
    const photo = await px(900, 500); assert.ok(Math.max(...photo) - Math.min(...photo) <= 3, `photo en gris : ${photo}`);
    const band = await px(50, 1100); assert.ok(band[0] > 200 && band[1] < 60, `cadre gardé en couleur (bande rouge) : ${band}`);
    const back = (await post(`/api/session/${s.id}/compose`, { filter: 'none' })).data;
    assert.equal(back.filter, 'none');
    await put('/api/admin/config', { booth: { filters: { enabled: false } } }, ADMIN);
  });

  await step('boomerang : vidéo filmée, aller-retour, jamais imprimé, nouvelle vidéo = reprise', async () => {
    const b = (await post('/api/admin/templates', { name: 'Boomerang soirée', kind: 'boomerang', format: '10x15-paysage' }, ADMIN)).data;
    assert.equal(b.kind, 'boomerang');
    assert.deepEqual(b.boomerang, { durationSec: 2, speed: 2 });
    assert.equal(b.shots, 1);
    await put('/api/admin/config', { templates: { gifEnabled: true } }, ADMIN);
    const saved = (await put(`/api/admin/templates/${b.id}`, { layers: [{ type: 'photo', shot: 2, cutout: 'ai', x: 0, y: 0, width: 1800, height: 1200 }], boomerang: { durationSec: 1 } }, ADMIN)).data;
    assert.equal(saved.layers[0].shot, 0);
    assert.equal(saved.layers[0].cutout, 'none', 'pas de détourage IA sur un boomerang');
    const s = (await post('/api/session', { templateId: b.id })).data;
    assert.equal(s.gif, true);
    assert.equal(s.kind, 'boomerang');
    assert.equal((await post(`/api/session/${s.id}/focus`, {})).status, 200);
    const clip = await post(`/api/session/${s.id}/clip`, {});
    if (app.booth.camera.mode === 'browser') { assert.equal(clip.data.error, 'FRAMES_REQUIRED'); return; }
    assert.equal(clip.status, 200, JSON.stringify(clip.data));
    const c = (await post(`/api/session/${s.id}/compose`, {})).data;
    const n = Math.round(1 * 12.5); // 1 s filmée à 12,5 i/s, aller-retour de 2n-2 images, lecture ×2 (40 ms)
    const { ffmpegPath } = await import('../server/video.js');
    if (ffmpegPath()) {
      // Vidéo MP4 : durée de l'aller-retour, 960 px, H.264
      assert.ok(c.final.url.endsWith('/final.mp4') && c.final.video && c.final.gif, JSON.stringify(c.final));
      const { spawnSync } = await import('node:child_process');
      const info = spawnSync(ffmpegPath(), ['-hide_banner', '-i', path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id, 'final.mp4')], { encoding: 'utf8' }).stderr;
      const [, mm, ss] = /Duration: 00:(\d+):([\d.]+)/.exec(info) || [];
      assert.ok(Math.abs(Number(mm) * 60 + Number(ss) - (2 * n - 2) * 0.04) < 0.1, `durée de la vidéo : ${mm}:${ss}`);
      assert.ok(/h264/.test(info) && /960x\d+/.test(info), info.split('\n').find((l) => /Video:/.test(l)));
    } else {
      assert.ok(c.final.url.endsWith('/final.gif') && c.final.gif);
      const meta = await sharp(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id, 'final.gif'), { animated: true }).metadata();
      assert.equal(meta.delay.reduce((a, x) => a + x, 0), (2 * n - 2) * 40, `aller-retour : ${meta.delay}`);
      assert.equal(meta.width, 480, 'GIF de secours réduit à 480 px');
    }
    // Page téléphone : lecteur vidéo, flèches lisibles, pas de numéro de session
    const phone = await (await fetch(`${base}/g/${s.id}`)).text();
    if (c.final.video) {
      assert.ok(phone.includes('<video') && phone.includes('Enregistrer la vidéo'));
      // Bouton d'enregistrement : le fichier arrive en téléchargement (Safari ne propose pas d'enregistrer un MP4 ouvert)
      await post(`/api/session/${s.id}/keep`, {});
      const dl = await fetch(`${base}/g/${s.id}/fichier`);
      assert.equal(dl.status, 200);
      assert.ok(/attachment/.test(dl.headers.get('content-disposition') || '') && /\.mp4/.test(dl.headers.get('content-disposition')), dl.headers.get('content-disposition'));
      assert.equal(dl.headers.get('content-type'), 'video/mp4');
    }
    assert.ok(!phone.includes(`Session ${s.id}`), 'numéro de session caché aux invités');
    // Vignette des filtres : l'adresse de la 1re image de la vidéo (sous-dossier clip-…) doit répondre
    const firstFrame = (await j(`/api/session/${s.id}`)).data.shots[0].url;
    assert.ok(/\/clip-\d+\/f-001\.jpg$/.test(firstFrame), firstFrame);
    assert.equal((await fetch(`${base}${firstFrame}`)).status, 200, `image introuvable : ${firstFrame}`);
    const again = (await post(`/api/session/${s.id}/clip`, {})).data;
    assert.equal(again.session.retakes, 1, 'nouvelle vidéo comptée comme reprise');
    await post(`/api/session/${s.id}/compose`, {});
    assert.equal((await post(`/api/session/${s.id}/print`, { copies: 1 })).data.error, 'GIF_NO_PRINT');
    assert.equal((await post(`/api/session/${s.id}/print`, { copies: 0 })).data.status, 'done');
    assert.ok((await j('/api/gallery', { headers: ADMIN })).status !== 500);
    await put('/api/admin/config', { templates: { gifEnabled: false } }, ADMIN);
    assert.equal((await j(`/api/admin/templates/${b.id}`, { method: 'DELETE', headers: ADMIN })).status, 200);
  });

  await step('QR code Wi-Fi : désactivé par défaut, format WIFI:, caractères spéciaux échappés', async () => {
    assert.equal((await j('/api/wifi')).data.wifi, null);
    await put('/api/admin/config', { share: { wifi: { enabled: true, ssid: 'Photo;Booth', password: '' } } }, ADMIN);
    assert.equal((await j('/api/wifi')).data.wifi, null, 'WPA sans mot de passe : pas de QR');
    await put('/api/admin/config', { share: { wifi: { password: 'a:b"c' } } }, ADMIN);
    const w = (await j('/api/wifi')).data.wifi;
    assert.equal(w.ssid, 'Photo;Booth');
    assert.ok(w.dataUrl.startsWith('data:image/png'));
    // ; : " échappés par une barre oblique inverse, comme le veut le format WIFI: des QR codes
    const payload = 'WIFI:T:WPA;S:Photo\\;Booth;P:a\\:b\\"c;;';
    const expected = await (await import('qrcode')).default.toDataURL(payload, { margin: 1, width: 320, color: { dark: '#000000', light: '#ffffff' } });
    assert.equal(w.dataUrl, expected, 'contenu du QR code');
    await put('/api/admin/config', { share: { wifi: { enabled: false, ssid: '', password: '' } } }, ADMIN);
  });

  await step('adresse publique : QR codes vers le domaine, /api/ping, page distante générée', async () => {
    assert.equal((await j('/api/ping')).data.photobooth, true);
    const x = (await post('/api/session', { templateId: 'classic-10x15' })).data;
    await put('/api/admin/config', { share: { publicUrl: 'https://photobooth.example.fr/', wifi: { enabled: true, ssid: 'PhotoBooth', password: 'secret-wifi' } } }, ADMIN);
    assert.equal((await j(`/api/session/${x.id}/qr`)).data.url, `https://photobooth.example.fr/g/${x.id}`);
    const out = path.join(tmp, `remote-${camera}`);
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    execFileSync(process.execPath, [fileURLToPath(new URL('./build-remote.js', import.meta.url)), out], { env: process.env });
    const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(page.includes('/api/ping') && page.includes('PhotoBooth'), 'rappel Wi-Fi et vérification de la borne');
    assert.ok(!page.includes('secret-wifi'), 'jamais le mot de passe Wi-Fi sur la page publique');
    for (const f of ['404.html', '_redirects', '.htaccess']) assert.ok(fs.existsSync(path.join(out, f)), f);
    await put('/api/admin/config', { share: { publicUrl: '', wifi: { enabled: false, ssid: '', password: '' } } }, ADMIN);
    assert.ok((await j(`/api/session/${x.id}/qr`)).data.url.endsWith(`/g/${x.id}`));
    await post(`/api/session/${x.id}/abandon`, {});
  });

  let galleryIds;
  await step('galerie : fermée par défaut, photos validées de l\'événement, pages téléphone', async () => {
    assert.equal((await j('/api/gallery')).status, 403);
    assert.equal((await fetch(`${base}/galerie`)).status, 404);
    const make = async () => {
      const x = (await post('/api/session', { templateId: 'classic-10x15' })).data;
      await shot(x.id, 0);
      await post(`/api/session/${x.id}/compose`, {});
      return x.id;
    };
    const older = await make();
    await post(`/api/session/${older}/print`, { copies: 0 });
    const newer = await make();
    await post(`/api/session/${newer}/keep`, {});
    const pending = await make(); // en relecture, pas validée : jamais dans la galerie

    await put('/api/admin/config', { gallery: { booth: true } }, ADMIN);
    const gboot = (await j('/api/bootstrap')).data;
    assert.equal(gboot.gallery.enabled, true);
    assert.equal(gboot.gallery.qr, true, 'QR de la galerie actif par défaut');
    assert.equal(gboot.share.qrOnDone, true, 'QR de fin actif par défaut');
    await put('/api/admin/config', { gallery: { qr: false }, share: { qrOnDone: false } }, ADMIN);
    const off = (await j('/api/bootstrap')).data;
    assert.equal(off.gallery.qr, false);
    assert.equal(off.share.qrOnDone, false);
    await put('/api/admin/config', { gallery: { qr: true }, share: { qrOnDone: true } }, ADMIN);
    const { items } = (await j('/api/gallery')).data;
    const ids = items.map((it) => it.id);
    assert.ok(ids.includes(older) && ids.includes(newer), 'photos validées absentes');
    assert.ok(!ids.includes(pending), 'une photo non validée ne doit pas apparaître');
    assert.ok(ids.indexOf(newer) < ids.indexOf(older), 'plus récentes d\'abord');
    assert.ok(items.every((it) => it.url && it.thumbUrl));
    assert.equal((await fetch(`${base}/galerie`)).status, 404, 'page téléphone fermée tant que gallery.web est faux');

    await put('/api/admin/config', { gallery: { web: true } }, ADMIN);
    const grid = await (await fetch(`${base}/galerie`)).text();
    assert.ok(grid.includes(`/g/${older}`) && !grid.includes(pending), 'la grille ouvre la page unique /g/:id');
    // Une seule page photo : celle des QR codes, avec la navigation quand la galerie téléphone est ouverte
    const photo = await (await fetch(`${base}/g/${older}`)).text();
    assert.ok(!photo.includes('Télécharger la photo') && photo.includes('Photo suivante') && photo.includes('href="/galerie"'));
    assert.ok(photo.includes(`href="/g/${newer}"`), 'flèche vers la photo voisine');
    assert.ok(!(await (await fetch(`${base}/g/${pending}`)).text()).includes('href="/galerie"'), 'photo hors galerie : pas de navigation');
    assert.equal((await fetch(`${base}/galerie/${older}`, { redirect: 'manual' })).headers.get('location'), `/g/${older}`);
    await post(`/api/session/${pending}/abandon`, {});
    galleryIds = { older, newer };
  });

  await step('galerie : réimpression off / code opérateur / libre, limites appliquées', async () => {
    const { older, newer } = galleryIds;
    const reprint = (id, body) => post(`/api/gallery/${id}/print`, body);
    await put('/api/admin/config', { gallery: { reprint: 'off' } }, ADMIN);
    assert.equal((await reprint(older, { copies: 1 })).data.error, 'REPRINT_DISABLED');

    await put('/api/admin/config', { gallery: { reprint: 'operator' }, limits: { eventQuota: 0 } }, ADMIN);
    assert.equal((await reprint(older, { copies: 1 })).data.error, 'BAD_PIN');
    const pin = app.config.get().limits.operatorPin;
    const before = (await j('/api/bootstrap')).data.counters.printed;
    const ok = await reprint(older, { copies: 3, pin }); // au-delà du max invité (2), permis à l'opérateur
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal((await reprint(older, { copies: 1, pin })).data.error, 'SESSION_PRINTING');
    await waitStatus(older, 'done');
    assert.equal((await j('/api/bootstrap')).data.counters.printed, before + 3);

    await put('/api/admin/config', { gallery: { reprint: 'guest' } }, ADMIN);
    assert.equal((await reprint(newer, { copies: 3 })).data.error, 'COPIES_INVALID');
    assert.equal((await reprint(newer, { copies: 1 })).status, 200);
    await waitStatus(newer, 'done');
    await put('/api/admin/config', { limits: { eventQuota: (await j('/api/bootstrap')).data.counters.printed } }, ADMIN);
    assert.equal((await reprint(newer, { copies: 1 })).data.error, 'QUOTA_REACHED');
    await put('/api/admin/config', { limits: { eventQuota: 0 }, gallery: { booth: false, web: false, reprint: 'operator' } }, ADMIN);
    assert.equal((await reprint(newer, { copies: 1 })).status, 403, 'galerie fermée : plus de réimpression');
  });

  await step('arrêt : indisponible sans lanceur (409)', async () => {
    const r = await post('/api/admin/shutdown', {}, ADMIN);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'SHUTDOWN_UNAVAILABLE');
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

/** « Éteindre la borne » : code admin exigé, serveur fermé, puis le lanceur est prévenu. */
async function runShutdown() {
  console.log('\nArrêt depuis l\'admin');
  let notify;
  const notified = new Promise((r) => { notify = r; });
  const app = await createApp({ port: 0, onShutdown: () => notify() });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const shutdown = (headers = {}) => fetch(`${base}/api/admin/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  await step('arrêt depuis l\'admin : code exigé, serveur fermé, lanceur prévenu', async () => {
    assert.equal((await shutdown()).status, 401);
    const ADMIN = { 'x-admin-pin': app.config.get().admin.pin };
    const state = await (await fetch(`${base}/api/admin/state`, { headers: ADMIN })).json();
    assert.equal(state.canShutdown, true);
    assert.equal((await shutdown(ADMIN)).status, 200);
    await notified;
    await assert.rejects(fetch(`${base}/api/bootstrap`), 'le serveur devrait être fermé');
  });
}

try {
  await run('mock');
  await run('browser');
  await runShutdown();
  console.log(`\n${passed} étapes OK. Données temporaires : ${tmp}`);
} catch {
  console.error('\nÉchec du test.');
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
