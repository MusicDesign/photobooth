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
process.env.BOOTH_UPLOADS_DIR = path.join(tmp, 'uploads'); // logos envoyés pendant le test : jamais dans data/uploads
process.env.BOOTH_THEMES_DIR = path.join(tmp, 'themes'); // copie des thèmes : un import de test n'écrit jamais dans data/themes
fs.cpSync(new URL('../data/themes', import.meta.url).pathname, process.env.BOOTH_THEMES_DIR, { recursive: true });
process.env.BOOTH_AUTO_INSTALL = 'off';  // pas d'installation (Homebrew, modèle IA) pendant un test
process.env.BOOTH_LOG_FILE = path.join(tmp, 'logs', 'booth.log'); // journal de test : jamais data/logs
process.env.BOOTH_USB_DIRS = path.join(tmp, 'cle-usb'); // clé USB simulée : ce dossier, quand il existe (jamais les vraies clés)
process.env.BOOTH_CAMERA = 'mock';
process.env.BOOTH_PRINTER = 'mock';
process.env.BOOTH_STREAMDECK = 'off'; // ne pas prendre la main sur un Stream Deck branché
process.env.BOOTH_LIGHTS = 'mock';     // lumières simulées : jamais celles du réseau
process.env.BOOTH_SCREEN = 'mock';     // écran simulé : jamais l'écran de cette machine

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
  // Chaque passe repart de compteurs, d'une config et de sessions vierges (les fiches de session sont dans leurs dossiers).
  for (const f of [process.env.BOOTH_DB_FILE, process.env.BOOTH_CONFIG_FILE]) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions'), { recursive: true, force: true });
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

  await step('cadres proposés : installation neuve, ancienne liste vide (= tous), liste vide = aucun, cadres disparus', async () => {
    const { Templates } = await import('../server/templates.js');
    const { DEFAULTS } = await import('../server/config.js');
    const dir = fs.mkdtempSync(path.join(tmp, 'tpl-neuf-'));
    const fresh = new Templates(dir); // aucun template : « Photo seule » créé
    const fakeConfig = (templates) => ({ data: { templates }, update(p) { Object.assign(this.data.templates, p.templates); } });
    const c1 = fakeConfig(structuredClone(DEFAULTS.templates));
    fresh.reconcile(c1);
    assert.deepEqual(c1.data.templates.enabled, ['default'], 'installation neuve : « Photo seule » proposé');
    assert.equal(c1.data.templates.default, 'default');
    assert.equal(fresh.enabled(c1.data).length, 1);
    // Config d'avant : liste vide = tous les cadres, convertie une fois
    fs.cpSync(path.join(process.env.BOOTH_TEMPLATES_DIR, 'strip-3'), path.join(dir, 'strip-3'), { recursive: true });
    fresh.reload();
    const c2 = fakeConfig({ ...structuredClone(DEFAULTS.templates), enabled: [], default: '' });
    fresh.reconcile(c2);
    assert.deepEqual(c2.data.templates.enabled.sort(), ['default', 'strip-3']);
    // Après conversion, liste vide = aucun cadre (l'admin l'affiche ainsi)
    const c3 = fakeConfig({ ...c2.data.templates, enabled: [] });
    assert.equal(fresh.selection(c3.data.templates), null, 'liste vide voulue : gardée');
    assert.equal(fresh.enabled(c3.data).length, 0);
    // Cadres proposés tous disparus (supprimés à la main) : tous les présents
    const c4 = fakeConfig({ ...c2.data.templates, enabled: ['parti'], default: 'parti' });
    fresh.reconcile(c4);
    assert.deepEqual(c4.data.templates.enabled.sort(), ['default', 'strip-3']);
    assert.ok(['default', 'strip-3'].includes(c4.data.templates.default));
    // Sur la borne de test : config par défaut (« default » absent) → cadres de démo proposés, séance possible
    assert.equal(app.config.data.templates.schema, 2);
    assert.deepEqual([...app.config.get().templates.enabled].sort(), ['classic-10x15', 'strip-3']);
    // Liste vide = aucun cadre, aussi pour la borne
    await put('/api/admin/config', { templates: { enabled: [] } }, ADMIN);
    assert.equal((await j('/api/bootstrap')).data.templates.items.length, 0);
    assert.equal((await post('/api/session', {})).data.error, 'NO_TEMPLATE');
    await put('/api/admin/config', { templates: { enabled: ['classic-10x15', 'strip-3'] } }, ADMIN);
    // Liste invalide ou cadre inconnu : refusés (la suppression d'un cadre échouait ensuite)
    for (const enabled of ['strip-3', { a: 1 }, [1], ['inconnu']]) {
      assert.equal((await put('/api/admin/config', { templates: { enabled } }, ADMIN)).status, 400, JSON.stringify(enabled));
    }
    assert.equal((await put('/api/admin/config', { templates: { default: 'inconnu' } }, ADMIN)).status, 400);
    assert.ok(Array.isArray(app.config.get().templates.enabled));
  });

  let s;
  await step('appareil photo hors service : séance refusée, l\'accueil le sait avant', async () => {
    const cam = app.booth.camera;
    assert.equal((await j('/api/camera')).data.ok, true);
    if (cam.mode === 'browser') return; // webcam : vérifiée par la borne (elle doit s'ouvrir), pas par le serveur
    cam.status = () => ({ ok: false, message: 'boîtier débranché' });
    try {
      const st = (await j('/api/camera')).data;
      assert.equal(st.ok, false);
      assert.equal(st.message, 'boîtier débranché');
      const r = await post('/api/session', { templateId: 'strip-3' });
      assert.equal(r.status, 409);
      assert.equal(r.data.error, 'CAMERA_UNAVAILABLE');
    } finally { delete cam.status; }
    assert.ok(app.config.get().texts.cameraUnavailable, 'message pour l\'invité');
  });

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
    // Code opérateur vide, trop court ou pas en chiffres : refusé à l'enregistrement ; vide (ancienne config) : rien ne déverrouille
    for (const pin of ['12', 'abcd', '123456789']) { // code admin : le pavé de la borne n'a que 8 chiffres
      const r = await put('/api/admin/config', { admin: { pin } }, ADMIN);
      assert.equal(r.status, 400, `code admin ${JSON.stringify(pin)} accepté`);
      assert.equal(r.data.error, 'ADMIN_PIN');
    }
    for (const operatorPin of ['', '12', 'abcd', '123456789']) {
      const r = await put('/api/admin/config', { limits: { operatorPin } }, ADMIN);
      assert.equal(r.status, 400, `code ${JSON.stringify(operatorPin)} accepté`);
      assert.equal(r.data.error, 'OPERATOR_PIN');
    }
    const pinBefore = app.config.get().limits.operatorPin;
    app.config.update({ limits: { operatorPin: '' } });
    assert.equal((await post(`/api/session/${s2.id}/unlock`, { pin: '' })).status, 403, 'code vide : refusé');
    assert.equal((await post(`/api/session/${s2.id}/unlock`, {})).status, 403);
    app.config.update({ limits: { operatorPin: pinBefore } });
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

  await step('impression en échec : relecture gardée (pas de boucle), puis fin sans tirage', async () => {
    const x = (await post('/api/session', { templateId: 'classic-10x15' })).data;
    await shot(x.id, 0);
    await post(`/api/session/${x.id}/compose`, {});
    const printer = app.booth.printer;
    const before = (await j('/api/bootstrap')).data.counters.printed;
    printer.print = async () => { throw new Error('lp introuvable'); };
    try {
      const r = await post(`/api/session/${x.id}/print`, { copies: 1 });
      assert.equal(r.data.error, 'PRINT_FAILED');
    } finally {
      delete printer.print;
    }
    const after = (await j(`/api/session/${x.id}`)).data;
    assert.equal(after.status, 'review', 'nouvel essai ou fin sans tirage possibles');
    assert.ok(after.error);
    assert.equal((await post(`/api/session/${x.id}/print`, { copies: 0 })).data.status, 'done');
    assert.equal((await j('/api/bootstrap')).data.counters.printed, before, 'rien de compté');
  });

  await step('QR code et page galerie', async () => {
    const q = (await j(`/api/session/${s.id}/qr`)).data;
    assert.ok(q.url.endsWith(`/g/${s.id}`));
    assert.ok(q.dataUrl.startsWith('data:image/png'));
    const page = await fetch(`${base}/g/${s.id}`);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes('Télécharger la photo'));
    // Photo supprimée depuis : page aux couleurs de la borne (logo), pas l'erreur brute
    const gone = await fetch(`${base}/g/inconnue`);
    const html = await gone.text();
    assert.equal(gone.status, 404);
    assert.ok(/text\/html/.test(gone.headers.get('content-type')) && html.includes('class="logo"') && html.includes('plus disponible'), html.slice(0, 120));
  });

  await step('sessions paginées : pages de taille fixe, la plus récente d\'abord', async () => {
    const evId = (await j('/api/bootstrap')).data.counters.eventId;
    const p1 = (await j(`/api/admin/events/${evId}/sessions?per=2&page=1`, { headers: ADMIN })).data;
    assert.ok(p1.total >= 3, `au moins 3 sessions (${p1.total})`);
    assert.equal(p1.sessions.length, 2);
    assert.equal(p1.pages, Math.ceil(p1.total / 2));
    const p2 = (await j(`/api/admin/events/${evId}/sessions?per=2&page=2`, { headers: ADMIN })).data;
    assert.ok(!p2.sessions.some((x) => p1.sessions.some((y) => y.id === x.id)), 'pages disjointes');
    assert.ok(p1.sessions[0].createdAt >= p2.sessions[0].createdAt, 'les plus récentes d\'abord');
    const st = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.ok(st.sessions.length <= st.sessionsPerPage, 'l\'état n\'envoie que la première page');
  });

  await step('mise à jour : version lue dans le dépôt git', async () => {
    await app.updater.version();
    const u = (await j('/api/admin/update', { headers: ADMIN })).data.update;
    assert.equal(u.available, true);
    assert.match(u.commit, /^[0-9a-f]{7,}$/);
    assert.match(u.version, /^\d+\.\d+\.\d+$/, 'version X.X.X');
    assert.equal(u.updating, false);
  });

  await step('installation : état vérifié (Node, dépendances, modèles, cadres), rien d\'installé pendant le test', async () => {
    const su = (await j('/api/admin/setup', { headers: ADMIN })).data.setup;
    const by = Object.fromEntries(su.items.map((it) => [it.id, it]));
    assert.equal(by.node.state, 'ok');
    assert.equal(by.deps.state, 'ok', by.deps.detail);
    assert.equal(by['model-fast'].state, 'ok');
    assert.equal(by.templates.state, 'ok');
    assert.equal(by.ffmpeg.state, 'ok');
    assert.equal(su.installing, false);
    assert.ok(su.items.every((it) => ['ok', 'missing'].includes(it.state) && typeof it.label === 'string'));
  });

  await step('stockage : une fiche session.json par dossier, db.json sans les sessions, compteur = nombre de fiches', async () => {
    const fiche = JSON.parse(fs.readFileSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id, 'session.json'), 'utf8'));
    assert.equal(fiche.id, s.id);
    assert.equal(fiche.status, 'done');
    const db = JSON.parse(fs.readFileSync(process.env.BOOTH_DB_FILE, 'utf8'));
    assert.ok(!('sessions' in db), 'db.json ne porte plus les sessions');
    assert.ok(db.events && db.counters, 'db.json garde événements et compteurs');
    const onDisk = fs.readdirSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions')).filter((d) => fs.existsSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', d, 'session.json')));
    assert.equal(app.store.counters().sessionsCount, onDisk.length, 'compteur de sessions = fiches sur disque');
  });

  await step('sessions : chemins relatifs dans la fiche, dossier déplacé et fiche à chemins absolus retrouvés', async () => {
    const { Store } = await import('../server/store.js');
    const dir = path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id);
    const fiche = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    assert.equal(fiche.final.file, 'final.jpg', 'montage : chemin relatif au dossier de la session');
    assert.equal(fiche.final.thumb, 'thumb.jpg');
    assert.ok(fiche.shots.every((sh) => /^shot-\d+-\d+\.jpg$/.test(sh.file)), JSON.stringify(fiche.shots.map((sh) => sh.file)));
    assert.equal(app.store.getSession(s.id).final.file, path.join(dir, 'final.jpg'), 'en mémoire : chemin absolu');
    // Dossier des sessions copié ailleurs (projet déplacé, autre machine) : les photos suivent
    const moved = path.join(tmp, 'sessions-deplacees');
    fs.cpSync(dir, path.join(moved, s.id), { recursive: true });
    const open = () => { const st = new Store(path.join(tmp, 'db-deplacee.json'), moved); clearInterval(st.backupTimer); return st.getSession(s.id); };
    let got = open();
    assert.equal(got.final.file, path.join(moved, s.id, 'final.jpg'));
    assert.ok(fs.existsSync(got.final.file) && got.shots.every((sh) => fs.existsSync(sh.file)), 'photos retrouvées dans le dossier déplacé');
    // Fiche d'une version précédente : chemins absolus d'un autre endroit (Mac, Linux ou Windows)
    fs.writeFileSync(path.join(moved, s.id, 'session.json'), JSON.stringify({ ...fiche,
      shots: fiche.shots.map((sh) => ({ ...sh, file: `/ancien/projet/output/sessions/${s.id}/${sh.file}` })),
      final: { ...fiche.final, file: `/ancien/projet/output/sessions/${s.id}/final.jpg`, thumb: `C:\\borne\\output\\sessions\\${s.id}\\thumb.jpg` } }));
    got = open();
    assert.equal(got.final.file, path.join(moved, s.id, 'final.jpg'));
    assert.equal(got.final.thumb, path.join(moved, s.id, 'thumb.jpg'));
    assert.ok(got.shots.every((sh) => fs.existsSync(sh.file)), 'photos d\'une fiche à chemins absolus retrouvées');
    fs.rmSync(moved, { recursive: true, force: true });
  });

  await step('sessions : dossier sans fiche supprimé au démarrage, dossier à fiche illisible laissé', async () => {
    const base = path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions');
    fs.mkdirSync(path.join(base, 'orphelin-test'), { recursive: true });
    fs.writeFileSync(path.join(base, 'orphelin-test', 'shot-1.jpg'), 'x');
    fs.mkdirSync(path.join(base, 'abime-test'), { recursive: true });
    fs.writeFileSync(path.join(base, 'abime-test', 'session.json'), '{ pas du json');
    app.booth.purgeOrphanDirs();
    assert.ok(!fs.existsSync(path.join(base, 'orphelin-test')), 'dossier sans fiche supprimé');
    assert.ok(fs.existsSync(path.join(base, 'abime-test')), 'fiche illisible : dossier et photos laissés');
    fs.rmSync(path.join(base, 'abime-test'), { recursive: true, force: true });
  });

  await step('admin : refus sans PIN, état complet, réimpression, compteurs', async () => {
    assert.equal((await j('/api/admin/state')).status, 401);
    // Codes faux : 5 essais (le 5e annonce déjà l'attente), puis 429 même avec le bon code, à la connexion comme par l'en-tête
    const login = (pin) => post('/api/admin/login', { pin });
    for (let i = 0; i < 4; i++) assert.equal((await login('0000')).status, 401);
    const fifth = await login('0000');
    assert.equal(fifth.status, 429, 'le code faux qui bloque répond déjà par le délai');
    assert.match(fifth.data.message, /réessayez dans 30 s/);
    const locked = await login(ADMIN['x-admin-pin']);
    assert.equal(locked.status, 429, JSON.stringify(locked.data));
    assert.equal(locked.data.error, 'TOO_MANY_ATTEMPTS');
    assert.equal((await j('/api/admin/state', { headers: ADMIN })).status, 429, 'en-tête bloqué aussi');
    const before = await j('/api/admin/login'); // la borne demande avant d'afficher le pavé du code
    assert.equal(before.status, 429);
    assert.match(before.data.message, /réessayez dans \d+ s/);
    app.adminGuard.reset();
    assert.equal((await j('/api/admin/login')).status, 200);
    assert.equal((await j('/api/admin/state', { headers: { 'x-admin-pin': 'faux' } })).status, 401);
    // Connexion par cookie, fermée quand le code admin change (sauf pour celui qui l'a changé)
    const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];
    const res1 = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: ADMIN['x-admin-pin'] }) });
    const c1 = cookieOf(res1);
    assert.match(res1.headers.get('set-cookie'), /Max-Age=43200/);
    const other = cookieOf(await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: ADMIN['x-admin-pin'] }) }));
    assert.equal((await j('/api/admin/state', { headers: { cookie: c1 } })).status, 200);
    const res2 = await fetch(`${base}/api/admin/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: c1 }, body: JSON.stringify({ admin: { pin: '8642' } }) });
    assert.equal(res2.status, 200);
    const c2 = cookieOf(res2);
    assert.equal((await j('/api/admin/state', { headers: { cookie: other } })).status, 401, 'autre connexion fermée');
    assert.equal((await j('/api/admin/state', { headers: { cookie: c1 } })).status, 401, 'ancien cookie fermé');
    assert.equal((await j('/api/admin/state', { headers: { cookie: c2 } })).status, 200, 'nouveau cookie de celui qui a changé le code');
    assert.equal((await put('/api/admin/config', { admin: { pin: ADMIN['x-admin-pin'] } }, { 'x-admin-pin': '8642' })).status, 200);
    // Retour à la borne : la borne rouvre l'admin sans code tant que la connexion tient ; déconnexion : code redemandé
    const c3 = cookieOf(await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: ADMIN['x-admin-pin'] }) }));
    assert.equal((await j('/api/admin/login')).data.authed, false, 'sans cookie : pavé du code');
    assert.equal((await post('/api/admin/leave', {}, { cookie: c3 })).status, 200);
    assert.equal((await j('/api/admin/login', { headers: { cookie: c3 } })).data.authed, true, 'retour récent : admin sans code');
    await post('/api/admin/logout', {}, { cookie: c3 });
    assert.equal((await j('/api/admin/login', { headers: { cookie: c3 } })).data.authed, false, 'déconnecté : code redemandé');
    const st = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.ok(st.sessions.length >= 3);
    assert.ok(st.themes.length >= 3);
    const rp = await post(`/api/admin/reprint/${s.id}`, { copies: 1 }, ADMIN);
    assert.equal(rp.status, 200, JSON.stringify(rp.data));
    await waitStatus(s.id, 'done');
    const c = (await post('/api/admin/counters', { paperRemaining: 15 }, ADMIN)).data;
    assert.equal(c.lowPaper, true);
  });

  await step('logo Cheeesy par défaut aux couleurs du thème', async () => {
    const st = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.equal(st.theme.defaultLogo, true);
    assert.ok(st.theme.logo.startsWith('/logo.svg?'), st.theme.logo);
    const r = await fetch(base + st.theme.logo);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type').includes('image/svg+xml'));
    const svg = await r.text();
    assert.ok(svg.includes(`fill="${st.theme.colors.primary}"`) && svg.includes(`fill="${st.theme.colors.onPrimary}"`), 'couleurs du thème dans le SVG');
    assert.ok(!svg.includes('cls-') && !svg.includes('<style'), 'ni classe ni style global dans le SVG inséré sur la borne');
    const bad = await fetch(`${base}/logo.svg?c=rouge&t=1`); // paramètres invalides : couleurs du thème actif
    assert.equal(bad.status, 200);
    assert.ok((await bad.text()).includes(`fill="${st.theme.colors.primary}"`));
  });

  await step('motifs de fond : thème livré, thème personnalisé, image importée prioritaire', async () => {
    const st = (await j('/api/admin/state', { headers: ADMIN })).data;
    assert.ok(st.patterns.some((p) => p.id === 'snowflakes'));
    assert.match(st.themes.find((t) => t.id === 'noel').backgroundImage, /^\/pattern\.svg\?p=snowflakes&c=ffffff&o=\d+$/);
    const r = await fetch(`${base}/pattern.svg?p=checkerboard&c=1d3557&o=8`);
    assert.equal(r.status, 200);
    const svg = await r.text();
    assert.ok(svg.includes('fill="#1d3557"') && svg.includes('opacity="0.08"') && !svg.includes('<?xml'), 'motif recoloré');
    for (const q of ['p=../config&c=1d3557&o=8', 'p=checkerboard&c=rouge&o=8', 'p=inconnu&c=1d3557&o=8']) assert.equal((await fetch(`${base}/pattern.svg?${q}`)).status, 404, q);
    await put('/api/admin/config', { theme: { active: 'custom', custom: { pattern: 'spiral' } } }, ADMIN);
    const custom = (await j('/api/admin/state', { headers: ADMIN })).data.theme;
    assert.equal(custom.backgroundImage, `/pattern.svg?p=spiral&c=${custom.colors.secondary.slice(1)}&o=8`);
    await put('/api/admin/config', { booth: { backgroundImage: '/uploads/fond.jpg' } }, ADMIN);
    assert.equal((await j('/api/admin/state', { headers: ADMIN })).data.theme.backgroundImage, '/uploads/fond.jpg', 'image importée avant le motif');
    await put('/api/admin/config', { booth: { backgroundImage: '' }, theme: { active: st.config.theme.active, custom: { pattern: '' } } }, ADMIN);
  });

  await step('écran tactile et fenêtre : modes forcés depuis l\'admin, valeurs inconnues refusées', async () => {
    assert.equal((await j('/api/bootstrap')).data.booth.touch, 'auto');
    assert.equal((await put('/api/admin/config', { booth: { touch: 'touch' } }, ADMIN)).status, 200);
    assert.equal((await j('/api/bootstrap')).data.booth.touch, 'touch');
    assert.equal((await put('/api/admin/config', { booth: { touch: 'souris' } }, ADMIN)).status, 400);
    assert.equal((await put('/api/admin/config', { booth: { touch: 'auto' } }, ADMIN)).status, 200);
    // Fenêtre de l'app Electron : kiosque ou plein écran classique
    assert.equal((await j('/api/bootstrap')).data.booth.window, 'kiosk');
    assert.equal((await put('/api/admin/config', { booth: { window: 'fullscreen' } }, ADMIN)).status, 200);
    assert.equal((await j('/api/bootstrap')).data.booth.window, 'fullscreen');
    assert.equal((await put('/api/admin/config', { booth: { window: 'popup' } }, ADMIN)).status, 400);
    assert.equal((await put('/api/admin/config', { booth: { window: 'kiosk' } }, ADMIN)).status, 200);
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
    await app.booth.removing; // dossiers supprimés en arrière-plan
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

  await step('sessions : annulée ou supprimée pendant la prise ou le montage, jamais recréée', async () => {
    const dirOf = (id) => path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', id);
    const until = async (cond) => {
      for (const t0 = Date.now(); !cond();) {
        if (Date.now() - t0 > 5000) throw new Error('attente trop longue');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    // Montage en cours quand l'invité annule : supprimée à la fin, session.json pas réécrit
    const x = (await post('/api/session', { templateId: 'strip-3' })).data;
    for (let i = 0; i < 3; i++) await shot(x.id, i);
    const composing = post(`/api/session/${x.id}/compose`, {});
    await until(() => app.booth.composing.has(x.id));
    assert.equal((await post(`/api/session/${x.id}/abandon`, {})).data.deleted, true);
    assert.equal((await composing).data.error, 'SESSION_ABANDONED');
    assert.equal((await j(`/api/session/${x.id}`)).status, 404);
    assert.ok(!fs.existsSync(dirOf(x.id)), 'dossier recréé par le montage');
    if (app.booth.camera.mode !== 'server') return;
    // Photo en route (Canon : plusieurs secondes) : annulée par l'invité, puis supprimée par l'admin
    const cam = app.booth.camera;
    const cancels = [(id) => post(`/api/session/${id}/abandon`, {}), (id) => j(`/api/admin/sessions/${id}`, { method: 'DELETE', headers: ADMIN })];
    for (const cancel of cancels) {
      const y = (await post('/api/session', { templateId: 'strip-3' })).data;
      let release;
      const gate = new Promise((r) => { release = r; });
      cam.capture = async (file) => { await gate; delete cam.capture; return cam.capture(file); };
      const pending = post(`/api/session/${y.id}/shot/0`, {});
      await until(() => app.booth.capturing.has(y.id));
      assert.equal((await cancel(y.id)).status, 200);
      release();
      assert.equal((await pending).data.error, 'SESSION_ABANDONED');
      assert.equal((await j(`/api/session/${y.id}`)).status, 404);
      assert.ok(!fs.existsSync(dirOf(y.id)), 'photo arrivée après coup : effacée');
    }
    // Décompte armé puis borne quittée sans prévenir (admin) : l'entrée expire, la session redevient purgeable
    app.booth.armedTtlMs = 50;
    try {
      const z = (await post('/api/session', { templateId: 'strip-3' })).data;
      await post(`/api/session/${z.id}/arm`, { index: 0, fireInMs: 0 });
      assert.ok(!app.booth.isUnvalidated(app.store.getSession(z.id)), 'protégée pendant le décompte');
      await until(() => !app.booth.armed.has(z.id));
      assert.ok(app.booth.isUnvalidated(app.store.getSession(z.id)));
      await post(`/api/session/${z.id}/abandon`, {});
    } finally {
      app.booth.armedTtlMs = 30000;
    }
  });

  await step('événements : création, rattachement, compteurs par événement, déplacement, export ZIP, suppression', async () => {
    // Identifiants pris dans le prototype des objets : inconnus, pas d'erreur 500
    assert.equal(app.store.getEvent('constructor'), null);
    assert.equal(app.store.getSession('__proto__'), null);
    assert.equal((await j('/api/admin/events/constructor/sessions', { headers: ADMIN })).status, 404);
    assert.equal((await j('/api/session/constructor')).status, 404);
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
    // Poids de l'événement : tout le dossier de sa session (photos, montage, miniatures)
    const dirBytes = fs.readdirSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s2.id)).reduce((n, f) => n + fs.statSync(path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s2.id, f)).size, 0);
    assert.ok(dirBytes > 0 && evs.event.bytes === dirBytes, `poids de l'événement : ${evs.event.bytes} pour ${dirBytes} sur le disque`);
    assert.deepEqual([evs.page, evs.pages, evs.total], [1, 1, 1]);
    // Session en relecture pas encore validée par l'invité : jamais exportée (il peut encore la refuser)
    const pending = (await post('/api/session', { templateId: 'strip-3' })).data;
    for (let i = 0; i < 3; i++) await shot(pending.id, i);
    await post(`/api/session/${pending.id}/compose`, {});
    assert.ok(!app.booth.exportFiles(ev.id, 'both').files.some((f) => f.name.includes(pending.id)), 'session non validée exclue de l\'export');
    // Clé USB : branchée → copie automatique de l'événement en cours ; rebranchée → rien à recopier
    const key = process.env.BOOTH_USB_DIRS;
    fs.mkdirSync(key, { recursive: true });
    app.usb.tick();
    await new Promise((r) => setTimeout(r, 20));
    await app.usb.queue;
    const usbDir = path.join(key, 'Cheeesy', `${ev.date} ${ev.name}`);
    const { localStamp, localDate, safeName, writeJsonAtomic } = await import('../server/util.js');
    const stamped = `${localStamp(new Date(app.store.getSession(s2.id).createdAt))}_${s2.id}`;
    assert.match(stamped, /^\d{4}-\d{2}-\d{2}_\d{2}h\d{2}m\d{2}_/);
    assert.ok(fs.existsSync(path.join(usbDir, 'montages', `${stamped}.jpg`)), 'montage copié sur la clé, préfixé de l\'heure');
    assert.equal(fs.readdirSync(path.join(usbDir, 'originaux', stamped)).length, 3, 'trois originaux copiés');
    assert.ok(fs.existsSync(path.join(usbDir, `.cheeesy-event-${ev.id}`)), 'dossier marqué pour l\'événement');
    const src = app.store.getSession(s2.id).shots[0].file;
    assert.equal(Math.round(fs.statSync(path.join(usbDir, 'originaux', stamped, 'photo-1.jpg')).mtimeMs / 1000), Math.round(fs.statSync(src).mtimeMs / 1000), 'date de la photo gardée');
    assert.equal(app.usb.status().lastExport.copied, 4);
    // Événement renommé : même dossier sur la clé, rien de recopié
    await put(`/api/admin/events/${ev.id}`, { name: 'Mariage Léa & Tom (soirée)' }, ADMIN);
    await app.usb.export(ev.id);
    assert.deepEqual([app.usb.status().lastExport.copied, app.usb.status().lastExport.skipped], [0, 4], 'deuxième copie : tout est déjà là');
    assert.equal(app.usb.status().lastExport.dest, usbDir, 'renommé : même dossier');
    assert.deepEqual(fs.readdirSync(path.join(key, 'Cheeesy')), [path.basename(usbDir)]);
    await put(`/api/admin/events/${ev.id}`, { name: 'Mariage Léa & Tom' }, ADMIN);
    assert.equal((await post(`/api/session/${pending.id}/abandon`, {})).data.deleted, true);
    // Nom d'événement borné ; noms de fichiers valables sur une clé FAT/exFAT
    assert.equal((await put(`/api/admin/events/${ev.id}`, { name: 'x'.repeat(81) }, ADMIN)).status, 400);
    assert.equal((await post('/api/admin/events', { name: 'y'.repeat(81) }, ADMIN)).status, 400);
    assert.equal(safeName('  Soirée\u0007 a/b:c.. '), 'Soirée a-b-c');
    assert.equal(safeName('z'.repeat(300)).length, 120);
    assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(localDate(new Date(2026, 0, 2, 0, 30)), '2026-01-02', 'date locale, pas UTC');
    // Écriture sûre qui échoue : pas de .tmp laissé
    const blocked = path.join(tmp, 'bloque');
    fs.mkdirSync(path.join(blocked, 'x.json'), { recursive: true }); // un dossier à la place du fichier : rename refusé
    assert.throws(() => writeJsonAtomic(path.join(blocked, 'x.json'), { a: 1 }));
    assert.deepEqual(fs.readdirSync(blocked), ['x.json'], 'fichier temporaire retiré');
    // Export en cours : l'événement ne peut être ni vidé ni supprimé
    app.booth.beginExport(ev.id);
    const busy = await post('/api/admin/sessions/reset', { eventId: ev.id }, ADMIN);
    assert.equal(busy.status, 409);
    assert.equal(busy.data.error, 'EVENT_EXPORTING');
    assert.equal((await j(`/api/admin/sessions/${s2.id}`, { method: 'DELETE', headers: ADMIN })).status, 409);
    app.booth.endExport(ev.id);
    assert.equal((await post('/api/admin/usb/eject', {}, ADMIN)).status, 200);
    fs.rmSync(key, { recursive: true, force: true });
    app.usb.tick();
    assert.equal(app.usb.status().volume, null, 'clé retirée');
    assert.equal((await post('/api/admin/usb/export', { eventId: ev.id }, ADMIN)).status, 409, 'sans clé : refusé');
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
    assert.ok(o.every((n) => n.includes(`/originaux/${stamped}/photo-`)), o.join());
    const f = await zipNames('finals');
    assert.deepEqual(f.map((n) => n.split('/').slice(1).join('/')), [`montages/${stamped}.jpg`]);
    assert.equal((await zipNames('both')).length, 4);
    for (let i = 0; i < 50 && app.booth.exports.size; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(app.booth.exports.size, 0, 'téléchargements terminés : plus d\'export en cours');
    // Place disque au tableau de bord, journal téléchargeable
    const disk = (await j('/api/admin/state', { headers: ADMIN })).data.disk;
    assert.ok(disk.free > 0 && disk.total >= disk.free && typeof disk.low === 'boolean', JSON.stringify(disk));
    fs.mkdirSync(path.dirname(process.env.BOOTH_LOG_FILE), { recursive: true });
    fs.writeFileSync(process.env.BOOTH_LOG_FILE, 'ligne\n');
    fs.writeFileSync(`${process.env.BOOTH_LOG_FILE}.1`, 'ancienne\n');
    const logs = await fetch(`${base}/api/admin/logs`, { headers: ADMIN });
    assert.equal(logs.status, 200);
    const { default: AdmZip } = await import('adm-zip');
    assert.deepEqual(new AdmZip(Buffer.from(await logs.arrayBuffer())).getEntries().map((e) => e.entryName).sort(), ['booth.log', 'booth.log.1']);
    // Bouton Télécharger de la page Journal : l'exécution en cours seulement (ici sans fichier : les lignes en mémoire)
    console.log('[test] ligne de cette exécution');
    const run = await fetch(`${base}/api/admin/logs/run`, { headers: ADMIN });
    assert.equal(run.status, 200);
    const runText = await run.text();
    assert.ok(runText.includes('[test] ligne de cette exécution') && !runText.includes('\nancienne\n'), 'journal de l\'exécution en cours');
    // Journal en direct : lignes en mémoire classées par module, appels à l'API, puis chaque nouvelle ligne
    const { categorize, recordLog, recentLogs } = await import('../server/log.js');
    assert.equal(categorize('gphoto2', 'x'), 'camera');
    assert.equal(categorize('devices', 'imprimante : none'), 'printer');
    assert.equal(categorize('devices', 'réseau : pas de Wi-Fi'), 'network');
    assert.equal(categorize('inconnu', 'x'), 'system');
    assert.equal((await fetch(`${base}/api/admin/logs/live`)).status, 401, 'journal réservé à l\'admin');
    const ctrl = new AbortController();
    const live = await fetch(`${base}/api/admin/logs/live`, { headers: ADMIN, signal: ctrl.signal });
    assert.match(live.headers.get('content-type'), /text\/event-stream/);
    const reader = live.body.getReader();
    let sse = '';
    const until = async (re) => { while (!re.test(sse)) sse += new TextDecoder().decode((await reader.read()).value); };
    await until(/event: init\ndata: .*\n\n/);
    const init = JSON.parse(sse.match(/event: init\ndata: (.*)\n/)[1]);
    assert.ok(init.categories.some(([k]) => k === 'camera'));
    assert.ok(init.entries.some((e) => e.cat === 'apiAdmin' && /GET \/api\/admin\/state → 200/.test(e.msg)), 'appels de l\'admin notés');
    assert.ok(init.entries.some((e) => e.cat === 'api' && /\/api\/bootstrap/.test(e.msg)), 'appels de la borne notés');
    assert.ok(!init.entries.some((e) => e.cat === 'api' && /\/api\/ping/.test(e.msg)), 'ping ignoré');
    console.log('[cups] ligne de test du journal en direct');
    await until(/event: log\ndata: .*ligne de test du journal en direct.*\n/);
    const pushed = JSON.parse(sse.match(/event: log\ndata: (.*ligne de test.*)\n/)[1]);
    assert.equal(pushed.cat, 'printer');
    assert.equal(pushed.module, 'cups');
    ctrl.abort();
    // Appels HTTP gardés à part : des heures d'admin ouverte (1 appel / 5 s) ne chassent pas les événements
    recordLog('INFO', '[booth] événement à garder');
    for (let i = 0; i < 1500; i++) recordLog('INFO', 'GET /api/admin/devices → 200 · 0 ms', { module: 'admin', cat: 'apiAdmin', file: false });
    const kept = recentLogs();
    assert.ok(kept.some((e) => e.msg === 'événement à garder'), 'événement toujours en mémoire');
    assert.ok(kept.filter((e) => e.cat === 'api' || e.cat === 'apiAdmin').length <= 1000, 'appels plafonnés');
    assert.ok(kept.every((e, i) => !i || kept[i - 1].id < e.id), 'lignes dans l\'ordre');
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
  await step('uploads : seul le logo en cours est gardé, « Logo par défaut » vide le dossier', async () => {
    const up = async () => {
      const form = new FormData();
      form.append('logo', new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')], { type: 'image/svg+xml' }), 'l.svg');
      return j('/api/admin/logo', { method: 'POST', headers: ADMIN, body: form });
    };
    assert.equal((await up()).status, 200);
    await new Promise((r) => setTimeout(r, 5)); // nom horodaté : deux fichiers distincts
    assert.equal((await up()).status, 200);
    const logos = () => fs.readdirSync(process.env.BOOTH_UPLOADS_DIR).filter((f) => f.startsWith('logo-'));
    assert.equal(logos().length, 1, 'l\'ancien logo est supprimé quand il est remplacé');
    const served = await fetch(`${base}/uploads/${logos()[0]}`);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff', 'type jamais deviné sur /uploads');
    assert.equal((await put('/api/admin/config', { booth: { logo: '' }, theme: { custom: { logo: '' } } }, ADMIN)).status, 200);
    assert.equal(logos().length, 0, 'logo par défaut : plus de fichier envoyé');
    // Logo et image de fond : seulement des fichiers envoyés depuis l'admin
    for (const logo of ['javascript:alert(1)', '/uploads/../config.json', 'https://exemple.fr/logo.png', '/uploads/a.png" onerror="x', 3]) {
      assert.equal((await put('/api/admin/config', { booth: { logo } }, ADMIN)).status, 400, JSON.stringify(logo));
    }
    assert.equal((await put('/api/admin/config', { theme: { custom: { backgroundImage: 'x");background:red' } } }, ADMIN)).status, 400);
    assert.equal(app.config.get().booth.logo, '');
    // Référence vers un fichier disparu : remise à vide au démarrage
    const { missingUploadRefs } = await import('../server/uploads.js');
    assert.deepEqual(missingUploadRefs({ booth: { logo: '/uploads/logo-0.svg', backgroundImage: '' }, theme: { custom: {} } }), { booth: { logo: '' } });
    assert.equal(missingUploadRefs({ booth: { logo: '', backgroundImage: '' }, theme: { custom: {} } }), null);
  });

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

  await step('templates : image importée non utilisée supprimée au nettoyage, image utilisée gardée', async () => {
    const tplId = (await j('/api/admin/state', { headers: ADMIN })).data.templates[0].id;
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const upload = async () => {
      const form = new FormData();
      form.append('image', new Blob([png], { type: 'image/png' }), 'a.png');
      return (await j(`/api/admin/templates/${tplId}/assets`, { method: 'POST', headers: ADMIN, body: form })).data;
    };
    const used = await upload();
    await new Promise((r) => setTimeout(r, 5)); // noms horodatés distincts
    const orphan = await upload();
    const t = app.templates.get(tplId);
    assert.equal((await put(`/api/admin/templates/${tplId}`, { layers: [...t.layers, { type: 'image', src: used.src, x: 0, y: 0, width: 100, height: 100, opacity: 1 }] }, ADMIN)).status, 200);
    assert.equal(app.templates.pruneAssets(app.templates.get(tplId), { minAgeMs: 0 }), 1);
    const dir = path.join(process.env.BOOTH_TEMPLATES_DIR, tplId, 'assets');
    assert.ok(fs.existsSync(path.join(dir, path.basename(used.src))), 'image utilisée gardée');
    assert.ok(!fs.existsSync(path.join(dir, path.basename(orphan.src))), 'image non utilisée supprimée');
    // Le nettoyage ne touche que le template enregistré : une image ancienne d'un autre template reste
    const otherId = app.templates.all().find((x) => x.id !== tplId).id;
    const otherAsset = path.join(process.env.BOOTH_TEMPLATES_DIR, otherId, 'assets', 'ancienne.png');
    fs.mkdirSync(path.dirname(otherAsset), { recursive: true });
    fs.writeFileSync(otherAsset, png);
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(otherAsset, old, old);
    app.templates.reload();
    assert.equal((await put(`/api/admin/templates/${tplId}`, { name: app.templates.get(tplId).name }, ADMIN)).status, 200);
    assert.ok(fs.existsSync(otherAsset), 'image d\'un autre template gardée');
    fs.rmSync(otherAsset);
    // Version sans fond disparue : enregistrement accepté (cutSrc vidé), montage avec l'image d'origine
    const withCut = [...app.templates.get(tplId).layers, { type: 'image', src: used.src, bgRemove: 'color', cutSrc: 'assets/disparue-sansfond-12345678.png', x: 0, y: 0, width: 100, height: 100 }];
    const sv = await put(`/api/admin/templates/${tplId}`, { layers: withCut }, ADMIN);
    assert.equal(sv.status, 200, JSON.stringify(sv.data));
    assert.equal(sv.data.layers.at(-1).cutSrc, null);
    const { compose } = await import('../server/compositor.js');
    const tc = { ...app.templates.get(tplId) };
    tc.layers = tc.layers.map((l, i) => (i === tc.layers.length - 1 ? { ...l, cutSrc: 'assets/disparue-sansfond-12345678.png' } : l));
    const outCut = path.join(tmp, 'cutsrc-absent.jpg');
    await compose(tc, Array.from({ length: tc.shots }, () => path.join(SAMPLES_DIR, 'sample-1.jpg')), outCut);
    assert.ok(fs.existsSync(outCut), 'montage malgré la version sans fond absente');
    // Miniatures demandées deux fois en même temps : calculées l'une après l'autre, fichiers présents
    const { buildPreviews } = await import('../server/template-previews.js');
    const [f1, f2] = await Promise.all([buildPreviews(app.templates.get(tplId), { force: true }), buildPreviews(app.templates.get(tplId), { force: true })]);
    assert.deepEqual(f1, f2);
    for (const f of f2) assert.ok(fs.existsSync(path.join(app.templates.get(tplId).dir, f)), `miniature ${f} présente`);
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

  await step('filtres : refusés tant que désactivés, noir & blanc sur tout le montage, gardé à la reprise', async () => {
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
    const band = await px(50, 1100); assert.ok(Math.max(...band) - Math.min(...band) <= 3, `cadre en gris lui aussi (bande rouge) : ${band}`);
    // Vignettes des filtres : le montage sans filtre (bande rouge du cadre), plus petit
    assert.ok(c.final.plainUrl, 'vignette sans filtre');
    const plain = path.join(process.env.BOOTH_OUTPUT_DIR, 'sessions', s.id, 'plain.jpg');
    const pm = await sharp(plain).metadata(); assert.ok(Math.max(pm.width, pm.height) <= 360, `vignette réduite : ${pm.width}×${pm.height}`);
    const k = pm.width / (await sharp(file).metadata()).width;
    const plainBand = [...await sharp(plain).extract({ left: Math.round(50 * k), top: Math.round(1100 * k), width: 1, height: 1 }).raw().toBuffer()];
    assert.ok(plainBand[0] > 200 && plainBand[1] < 60, `vignette sans filtre : bande rouge : ${plainBand}`);
    // Argentique : du grain sur la photo, pas sur le cadre (bande rouge unie)
    await put('/api/admin/config', { booth: { filters: { enabled: true, available: ['none', 'bw', 'sepia', 'filmbw'] } } }, ADMIN);
    assert.equal((await post(`/api/session/${s.id}/compose`, { filter: 'filmbw' })).data.filter, 'filmbw');
    const spread = async (x, y) => { const { data } = await sharp(file).extract({ left: x, top: y, width: 40, height: 40 }).greyscale().raw().toBuffer({ resolveWithObject: true }); return Math.max(...data) - Math.min(...data); };
    const before = await spread(900, 500);
    assert.ok(await spread(50, 1080) <= 6, 'cadre sans grain');
    await post(`/api/session/${s.id}/compose`, { filter: 'bw' });
    assert.ok(before > (await spread(900, 500)) + 8, `grain sur la photo : écart ${before} contre ${await spread(900, 500)} sans`);
    const back = (await post(`/api/session/${s.id}/compose`, { filter: 'none' })).data;
    assert.equal(back.filter, 'none');
    const bandBack = await px(50, 1100); assert.ok(bandBack[0] > 200 && bandBack[1] < 60, `« Couleur » : bande rouge revenue : ${bandBack}`);
    // Filtre par défaut : appliqué d'emblée au premier montage ; « Couleur » peut ne pas être proposée
    await put('/api/admin/config', { booth: { filters: { enabled: true, available: ['bw', 'sepia'], default: 'sepia' } } }, ADMIN);
    const s2 = (await post('/api/session', { templateId: tplA.id })).data;
    await shot(s2.id, 0);
    assert.equal((await post(`/api/session/${s2.id}/compose`, {})).data.filter, 'sepia', 'filtre par défaut');
    assert.equal((await post(`/api/session/${s2.id}/compose`, { filter: 'none' })).data.error, 'FILTER', 'couleur non proposée');
    await put('/api/admin/config', { booth: { filters: { enabled: true, available: ['bw', 'sepia'], default: 'vivid' } } }, ADMIN);
    const s3 = (await post('/api/session', { templateId: tplA.id })).data;
    await shot(s3.id, 0);
    assert.equal((await post(`/api/session/${s3.id}/compose`, {})).data.filter, 'bw', 'défaut non proposé : le premier proposé');
    await put('/api/admin/config', { booth: { filters: { enabled: false, available: ['none', 'bw'], default: 'vintage' } } }, ADMIN);
    const s4 = (await post('/api/session', { templateId: tplA.id })).data;
    await shot(s4.id, 0);
    assert.equal((await post(`/api/session/${s4.id}/compose`, {})).data.filter, 'vintage', 'choix désactivé : défaut imposé');
    assert.equal((await post(`/api/session/${s4.id}/compose`, { filter: 'bw' })).data.error, 'FILTER', 'choix désactivé : pas d\'autre filtre');
    await put('/api/admin/config', { booth: { filters: { enabled: false, available: ['none', 'bw', 'noir', 'sepia', 'vintage', 'warm', 'cool', 'vivid'], default: 'none' } } }, ADMIN);
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
    // Page téléphone (photo validée) : lecteur vidéo, flèches lisibles, pas de numéro de session
    await post(`/api/session/${s.id}/keep`, {});
    const phone = await (await fetch(`${base}/g/${s.id}`)).text();
    if (c.final.video) {
      assert.ok(phone.includes('<video') && phone.includes('Enregistrer la vidéo'));
      // Bouton d'enregistrement : le fichier arrive en téléchargement (Safari ne propose pas d'enregistrer un MP4 ouvert)
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
    // Export des originaux : toutes les images de la vidéo, pas seulement la première
    const frames = app.store.getSession(s.id).shots[0].frames;
    const clipFiles = app.booth.exportFiles(app.store.getSession(s.id).eventId, 'originals').files.filter((f) => f.name.includes(s.id));
    assert.equal(clipFiles.length, frames.length);
    assert.ok(clipFiles.every((f) => /\/clip\/f-\d{3}\.jpg$/.test(f.name)), clipFiles.map((f) => f.name).join());
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

    // requireWifi à false : les QR ne dépendent plus du Wi-Fi de la machine de test (PC en Ethernet, VM)
    await put('/api/admin/config', { gallery: { booth: true }, share: { requireWifi: false } }, ADMIN);
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
    assert.equal((await fetch(`${base}/g/${pending}`)).status, 404, 'photo pas validée : page introuvable, comme son fichier');
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
    // Borne arrêtée pendant un tirage : au redémarrage, son suivi (en mémoire) était perdu et la photo restait
    // « en cours d'impression » pour toujours. Le suivi reprend (ici : pilote qui ne sait plus, tirage clos).
    const stuck = app.store.getSession(older);
    stuck.status = 'printing';
    stuck.printJobs.push({ jobId: 'perdu-1', copies: 1, paperTaken: 0, origin: 'guest', status: 'queued', at: new Date().toISOString() });
    app.store.saveSession(stuck);
    app.booth.jobToSession.clear();
    app.booth.resumePrintJobs();
    await waitStatus(older, 'done');
    assert.equal((await j('/api/gallery')).data.items.find((it) => it.id === older)?.printing, false, 'galerie : plus « en cours »');
    // Tirage raté (remboursé) puis réimprimé : la photo redevient terminée, la borne ne se croit plus en impression
    const failed = app.store.getSession(older);
    failed.status = 'printing';
    failed.printJobs.push({ jobId: 'rate-1', copies: 0, paperTaken: 0, origin: 'guest', status: 'queued', at: new Date().toISOString() });
    app.store.saveSession(failed);
    app.booth.jobToSession.set('rate-1', older);
    app.booth.onPrinterJob({ jobId: 'rate-1', status: 'error', message: 'Suivi de l\'impression impossible', final: true });
    assert.equal((await j(`/api/session/${older}`)).data.status, 'error');
    assert.ok(!app.booth.jobToSession.has('rate-1'), 'suivi terminé : tirage oublié');
    assert.equal((await reprint(older, { copies: 1, pin })).status, 200);
    await waitStatus(older, 'done');
    assert.equal(app.booth.printing(), false);

    await put('/api/admin/config', { gallery: { reprint: 'guest' } }, ADMIN);
    assert.equal((await reprint(newer, { copies: 3 })).data.error, 'COPIES_INVALID');
    assert.equal((await reprint(newer, { copies: 1 })).status, 200);
    await waitStatus(newer, 'done');
    await put('/api/admin/config', { limits: { eventQuota: (await j('/api/bootstrap')).data.counters.printed } }, ADMIN);
    assert.equal((await reprint(newer, { copies: 1 })).data.error, 'QUOTA_REACHED');
    await put('/api/admin/config', { limits: { eventQuota: 0 }, gallery: { booth: false, web: false, reprint: 'operator' } }, ADMIN);
    assert.equal((await reprint(newer, { copies: 1 })).status, 403, 'galerie fermée : plus de réimpression');
  });

  await step('CUPS : le suivi cherche l\'identifiant exact du tirage (DNP-4 ≠ DNP-42)', async () => {
    const { jobListed } = await import('../server/printer/cups.js');
    const out = 'DNP-42                  lucas          1024   jeu. 08 oct. 2026 10:00:00\n';
    assert.equal(jobListed(out, 'DNP-42'), true);
    assert.equal(jobListed(out, 'DNP-4'), false);
    assert.equal(jobListed('', 'DNP-4'), false);
  });

  await step('écran : détecté (simulé), luminosité et volume réglés depuis l\'admin, valeurs hors bornes refusées', async () => {
    let sc = (await j('/api/admin/state', { headers: ADMIN })).data.screen;
    assert.equal(sc.available, true);
    assert.equal(sc.display?.name, 'Écran simulé');
    assert.deepEqual([sc.brightness, sc.volume, sc.managed], [100, 0, false], JSON.stringify(sc));
    const r = await post('/api/admin/screen', { brightness: 40, volume: 20 }, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.screen.brightness, r.data.screen.volume, r.data.screen.managed], [40, 20, true]);
    assert.deepEqual(app.screen.driver.values, { brightness: 40, volume: 20 }, 'valeurs envoyées à l\'écran');
    assert.equal((await post('/api/admin/screen', { brightness: 150 }, ADMIN)).status, 400);
    assert.equal((await put('/api/admin/config', { screen: { volume: -1 } }, ADMIN)).status, 400);
    sc = (await post('/api/admin/screen', { brightness: null, volume: null }, ADMIN)).data.screen;
    assert.equal(sc.managed, false);
    sc = (await post('/api/admin/screen/refresh', {}, ADMIN)).data.screen;
    assert.equal(sc.brightness, 40, 'relu sur l\'écran : inchangé quand la borne ne gère plus');
  });

  await step('lumières : allumées au démarrage, prise de vue du template aux photos, ambiance (couleur ou blanc), calibrage, blanc chaud ou éteintes à l\'arrêt', async () => {
    const { default: WebSocket } = await import('ws');
    const L = app.lights;
    const settle = async () => { await new Promise((r) => setTimeout(r, 30)); await L.queue; };
    assert.equal((await j('/api/admin/lights', { headers: ADMIN })).data.lights.running, false, 'désactivées par défaut');
    await put('/api/admin/config', { lights: { enabled: true, idle: { mode: 'ambiance', effect: 'fixed', color: '#00ff00', brightness: 50 }, whiteLights: { idle: { mode: 'ambiance', effect: 'fixed', kelvin: 4000, brightness: 45 } } } }, ADMIN);
    await settle();
    const [gv, el] = L.drivers; // Govee et Elgato simulées
    assert.ok(gv.sent.some(([ip, cmd, d]) => ip === '10.0.0.13' && cmd === 'turn' && d.value === 1), 'démarrage : la lumière éteinte est allumée');
    const { lights } = (await j('/api/admin/lights', { headers: ADMIN })).data;
    assert.deepEqual(lights.devices.map((d) => [d.type, d.online]).sort(), [['ampoule', true], ['ampoule', true], ['ring light', true], ['tube', true]]);
    const st = () => gv.state;
    const ring = () => el.state['10.0.0.21'];
    assert.deepEqual([ring().on, ring().brightness, ring().temperature], [1, 45, 250], 'ring light : réglages de l\'ambiance des lumières blanches (45 %, 4000 K)');
    const ips = Object.keys(st());
    // Accueil : couleur fixe
    assert.ok(ips.every((ip) => st()[ip].brightness === 50 && st()[ip].color.g === 255 && st()[ip].colorTemInKelvin === 0), JSON.stringify(st()));
    // Cycle de couleurs : décalé entre les lumières, ou synchronisé (écart de couleur maximal entre deux lumières)
    const cycleSpread = async (sync) => {
      await put('/api/admin/config', { lights: { idle: { effect: 'cycle', periodSec: 600, sync } } }, ADMIN);
      await settle();
      await new Promise((r) => setTimeout(r, 1100)); // premier pas du cycle
      const cs = ips.map((ip) => st()[ip].color);
      return Math.max(...cs.flatMap((a) => cs.map((b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)))));
    };
    assert.ok(await cycleSpread(false) > 100, 'décalées : couleurs différentes');
    assert.ok(await cycleSpread(true) <= 10, 'synchronisées : même couleur');
    // Tube (sans fondu intégré) : 5 pas par seconde, ampoules H6008 (fondu) : 1 par seconde
    const sends = (ip) => gv.sent.filter(([i, cmd]) => i === ip && cmd === 'colorwc').length;
    const n0 = { bulb: sends('10.0.0.11'), tube: sends('10.0.0.13') };
    await new Promise((r) => setTimeout(r, 2000));
    const n = { bulb: sends('10.0.0.11') - n0.bulb, tube: sends('10.0.0.13') - n0.tube };
    assert.ok(n.bulb >= 1 && n.bulb <= 3 && n.tube >= 8, `pas du cycle : ${JSON.stringify(n)}`);
    await put('/api/admin/config', { lights: { idle: { effect: 'fixed' } } }, ADMIN);
    await settle();
    // La borne décrit son écran : choix du template → prise de vue
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.on('open', r));
    const screen = async (name) => { ws.send(JSON.stringify({ type: 'ui', screen: name, items: [] })); await settle(); };
    await screen('template');
    assert.ok(ips.every((ip) => st()[ip].onOff === 1 && st()[ip].brightness === 30 && st()[ip].colorTemInKelvin === 5000), 'choix du cadre : 5000 K, lumière douce 30 %');
    assert.deepEqual([ring().on, ring().brightness, ring().temperature], [1, 30, 200], 'ring light : 5000 K = 200 mireds, 30 %');
    await screen('pin'); // code opérateur par-dessus : la scène continue
    await screen('capture');
    assert.equal(st()[ips[0]].colorTemInKelvin, 5000);
    await screen('review'); // « On la garde ? » : résultat regardé dans l'ambiance
    assert.ok(ips.every((ip) => st()[ip].brightness === 50 && st()[ip].colorTemInKelvin === 0), 'relecture : ambiance');
    await screen('capture');
    // Le tube sans rôle « prise de vue » : il garde l'ambiance
    const tube = lights.devices.find((d) => d.type === 'tube');
    await put('/api/admin/config', { lights: { devices: { [tube.id]: { shooting: false } } } }, ADMIN);
    await settle();
    assert.equal(st()[tube.ip].color.g, 255, 'tube : ambiance pendant la prise de vue');
    await screen('done');
    assert.ok(ips.every((ip) => st()[ip].brightness === 50), 'retour à l\'accueil : ambiance');
    assert.equal(ring().brightness, 45, 'retour à l\'accueil : ring light à la luminosité de l\'ambiance, pas celle de la photo');
    // Calibrage : prise de vue imposée, lumières stabilisées avant de rendre la main
    const t0 = Date.now();
    assert.equal(await L.hold('calibration'), true);
    assert.ok(Date.now() - t0 >= 900, 'attente de stabilisation');
    assert.equal(st()[ips[0]].colorTemInKelvin, 5000);
    L.release('calibration');
    await settle();
    assert.equal(st()[ips[0]].brightness, 50);
    // « Laisser telles quelles » : chaque lumière retrouve son état d'avant la borne (20 / 30 / 40 %, 3000 K), allumée
    await put('/api/admin/config', { lights: { idle: { mode: 'keep' } } }, ADMIN);
    await settle();
    assert.deepEqual(ips.map((ip) => [st()[ip].onOff, st()[ip].brightness, st()[ip].colorTemInKelvin]), [[1, 20, 3000], [1, 30, 3000], [1, 40, 3000]]);
    await put('/api/admin/config', { lights: { idle: { mode: 'off' } } }, ADMIN);
    await settle();
    assert.ok(ips.every((ip) => st()[ip].onOff === 0), 'accueil : éteintes');
    // Couleur fixe en blanc (température) plutôt qu'en couleur
    await put('/api/admin/config', { lights: { idle: { mode: 'ambiance', effect: 'fixed', white: true, kelvin: 4000 } } }, ADMIN);
    await settle();
    assert.ok(ips.every((ip) => st()[ip].onOff === 1 && st()[ip].colorTemInKelvin === 4000), `accueil : blanc 4000 K (${JSON.stringify(st())})`);
    // Couleur du thème : accent, titre ou fond du thème actif, suivi quand le thème change
    const rgbOf = (ip) => [st()[ip].color.r, st()[ip].color.g, st()[ip].color.b].join();
    await put('/api/admin/config', { lights: { idle: { mode: 'ambiance', effect: 'fixed', white: false, colorSource: 'primary' } }, theme: { active: 'default-dark' } }, ADMIN);
    await settle();
    assert.ok(ips.every((ip) => rgbOf(ip) === '233,196,106'), `accent du thème #e9c46a (${rgbOf(ips[0])})`);
    await put('/api/admin/config', { lights: { idle: { colorSource: 'secondary' } } }, ADMIN);
    await settle();
    assert.ok(ips.every((ip) => rgbOf(ip) === '255,255,255'), `titre du thème #ffffff (${rgbOf(ips[0])})`);
    await put('/api/admin/config', { lights: { idle: { colorSource: 'background' } } }, ADMIN);
    await settle();
    assert.ok(ips.every((ip) => rgbOf(ip) === '15,17,21'), `fond du thème #0f1115 (${rgbOf(ips[0])})`);
    await put('/api/admin/config', { lights: { idle: { colorSource: 'primary' } }, theme: { active: 'default-light' } }, ADMIN);
    await settle();
    assert.ok(ips.every((ip) => rgbOf(ip) === '29,53,87'), `thème changé : accent #1d3557 (${rgbOf(ips[0])})`);
    // Cycle en fondu par les couleurs du thème (début de cycle : l'accent), à la place de l'arc-en-ciel
    const near = (ip, [r, g, b]) => [st()[ip].color.r - r, st()[ip].color.g - g, st()[ip].color.b - b].every((d) => Math.abs(d) <= 3);
    await put('/api/admin/config', { lights: { idle: { effect: 'cycle', cyclePalette: 'theme', periodSec: 600, sync: true } }, theme: { active: 'default-dark' } }, ADMIN);
    await settle();
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(ips.every((ip) => near(ip, [233, 196, 106])), `cycle du thème : début sur l'accent (${rgbOf(ips[0])})`);
    await put('/api/admin/config', { theme: { active: 'default-light' } }, ADMIN);
    await settle();
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(ips.every((ip) => near(ip, [29, 53, 87])), `cycle : thème changé, palette accent / fond (${rgbOf(ips[0])})`);
    await put('/api/admin/config', { lights: { idle: { effect: 'fixed', cyclePalette: 'rainbow' } } }, ADMIN);
    await settle();
    await put('/api/admin/config', { lights: { idle: { colorSource: 'custom', color: '#00ff00' } } }, ADMIN);
    await settle();
    assert.ok(ips.every((ip) => st()[ip].color.g === 255 && st()[ip].color.r === 0), 'couleur choisie');
    // Option coupée : état d'avant rendu, plus aucune commande
    await put('/api/admin/config', { lights: { enabled: false } }, ADMIN);
    await settle();
    assert.deepEqual(Object.values(gv.state).map((x) => [x.onOff, x.brightness]), [[1, 20], [1, 30], [1, 40]]);
    assert.deepEqual([ring().on, ring().brightness, ring().temperature], [1, 40, 250], 'ring light : état d\'avant rendu');
    assert.equal(L.running, false);
    // Arrêt de la borne : blanc chaud doux par défaut (2700 K, 20 %), ring light comprise, quel que soit le mode d'accueil
    await put('/api/admin/config', { lights: { enabled: true, idle: { mode: 'keep' } } }, ADMIN);
    await settle();
    const [g2, e2] = L.drivers;
    await L.stop();
    assert.ok(Object.values(g2.state).every((x) => x.onOff === 1 && x.brightness === 20 && x.colorTemInKelvin === 2700), `arrêt : blanc chaud 20 % (${JSON.stringify(g2.state)})`);
    assert.deepEqual([e2.state['10.0.0.21'].on, e2.state['10.0.0.21'].brightness], [1, 20], 'arrêt : ring light en blanc chaud 20 %');
    // Mode « éteintes » à l'arrêt
    await put('/api/admin/config', { lights: { enabled: false } }, ADMIN);
    await settle();
    await put('/api/admin/config', { lights: { enabled: true, shutdown: { mode: 'off' }, whiteLights: { shutdown: { mode: 'keep' } } } }, ADMIN);
    await settle();
    const [g3, e3] = L.drivers;
    await L.stop();
    assert.ok(Object.values(g3.state).every((x) => x.onOff === 0), 'arrêt : lumières RGB éteintes');
    assert.equal(e3.state['10.0.0.21'].on, 1, 'arrêt : ring light (réglage des blanches : comme avant) laissée allumée');
    await put('/api/admin/config', { lights: { enabled: false } }, ADMIN);
    await settle();
    await put('/api/admin/config', { lights: { enabled: true, whiteLights: { shutdown: { mode: 'off' } } } }, ADMIN);
    await settle();
    const e4 = L.drivers[1];
    await L.stop();
    assert.equal(e4.state['10.0.0.21'].on, 0, 'arrêt : ring light éteinte par le réglage des lumières blanches');
    ws.close();
  });

  await step('réglages : nombre attendu (texte numérique converti, autre valeur refusée), à l\'enregistrement comme à l\'import', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const before = app.config.get().limits.countdownSec;
    for (const bad of ['abc', '', null, true, [3]]) {
      const r = await put('/api/admin/config', { limits: { countdownSec: bad } }, ADMIN);
      assert.equal(r.status, 400, `${JSON.stringify(bad)} accepté`);
      assert.equal(r.data.error, 'NUMBER');
      assert.ok(r.data.message.includes('limits.countdownSec'), r.data.message);
    }
    assert.equal((await put('/api/admin/config', { lights: { idle: { brightness: 'fort' } } }, ADMIN)).status, 400, 'réglage imbriqué');
    // Hors bornes : refusé (0 s de décompte, 0 tirage par invité bloquaient la borne)
    for (const limits of [{ countdownSec: 0 }, { maxCopiesPerSession: 0 }, { operatorMaxCopies: 0 }, { maxRetakesPerSession: -2 }, { countdownSec: 1000 }]) {
      const r = await put('/api/admin/config', { limits }, ADMIN);
      assert.equal(r.status, 400, `${JSON.stringify(limits)} accepté`);
      assert.equal(r.data.error, 'NUMBER');
    }
    assert.equal((await put('/api/admin/config', { lights: { idle: { brightness: 300 } } }, ADMIN)).status, 400);
    assert.equal(app.config.get().limits.maxCopiesPerSession, 2);
    // Clés du prototype ignorées
    const polluted = await fetch(`${base}/api/admin/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: '{"booth":{"__proto__":{"pollue":1},"constructor":{"prototype":{"pollue":1}}}}' });
    assert.equal(polluted.status, 200);
    assert.equal({}.pollue, undefined, 'prototype des objets intact');
    assert.equal(Object.hasOwn(app.config.data.booth, 'constructor'), false);
    assert.equal(app.config.get().limits.countdownSec, before, 'valeur refusée : réglage inchangé');
    assert.equal((await put('/api/admin/config', { limits: { countdownSec: ' 4 ', maxRetakesPerSession: -1 } }, ADMIN)).status, 200);
    assert.strictEqual(app.config.get().limits.countdownSec, 4, 'texte numérique enregistré comme nombre');
    await put('/api/admin/config', { limits: { countdownSec: before, maxRetakesPerSession: 2 } }, ADMIN);
    // Export d'un seul template (menu « … » de la liste) : relu par l'import de Sauvegarde, rien d'autre dedans
    const [tplOne, tplOther] = app.templates.all();
    const one = await fetch(`${base}/api/admin/templates/${tplOne.id}/export`, { headers: ADMIN });
    assert.equal(one.status, 200);
    assert.ok(decodeURIComponent(one.headers.get('content-disposition')).endsWith(`${tplOne.name}.zip`), one.headers.get('content-disposition'));
    const oneZip = new AdmZip(Buffer.from(await one.arrayBuffer()));
    const names = oneZip.getEntries().map((e) => e.entryName);
    assert.ok(names.includes(`templates/${tplOne.id}/template.json`) && !names.includes('settings.json'), names.join(', '));
    assert.ok(!names.some((n) => n.startsWith(`templates/${tplOther.id}/`)), 'les autres templates ne sont pas exportés');
    const oneForm = new FormData();
    oneForm.append('file', new Blob([oneZip.toBuffer()]), 'template.zip');
    const onePv = await j('/api/admin/config/import/preview', { method: 'POST', headers: ADMIN, body: oneForm });
    assert.deepEqual(onePv.data.import.templates.map((t) => t.id), [tplOne.id], JSON.stringify(onePv.data));
    // Bouton Importer de la page Templates : les templates seuls, celui de même identifiant remplacé
    // Bouton Importer de la page Templates : ajouté en copie, « Nom (1) » puis « Nom (2) », l'original intact
    const countBefore = app.templates.all().length;
    for (const n of [1, 2]) {
      const fm = new FormData();
      fm.append('file', new Blob([oneZip.toBuffer()]), 'template.zip');
      const pvN = (await j('/api/admin/config/import/preview', { method: 'POST', headers: ADMIN, body: fm })).data.import;
      const apN = await post('/api/admin/config/import/apply', { id: pvN.id, templates: [tplOne.id], mode: 'copy' }, ADMIN);
      assert.equal(apN.data.done.templates, 1, JSON.stringify(apN.data));
      assert.equal(apN.data.done.sections, 0, 'aucun réglage touché');
      const copy = app.templates.all().find((t) => t.name === `${tplOne.name} (${n})`);
      assert.ok(copy && copy.id !== tplOne.id, `copie « ${tplOne.name} (${n}) » : ${app.templates.all().map((t) => `${t.id}=${t.name}`).join(', ')}`);
    }
    assert.equal(app.templates.all().length, countBefore + 2);
    assert.equal(app.templates.get(tplOne.id).name, tplOne.name, 'original intact');
    // Écraser : remplace le présent, aucun ajout
    const fr = new FormData();
    fr.append('file', new Blob([oneZip.toBuffer()]), 'template.zip');
    const pvR = (await j('/api/admin/config/import/preview', { method: 'POST', headers: ADMIN, body: fr })).data.import;
    assert.ok(pvR.templates[0].exists && pvR.templates[0].sameName, 'déjà présent signalé');
    await post('/api/admin/config/import/apply', { id: pvR.id, templates: [tplOne.id], mode: 'replace' }, ADMIN);
    assert.equal(app.templates.all().length, countBefore + 2, 'écrasé, pas ajouté');
    for (const t of app.templates.all().filter((x) => /\(\d\)$/.test(x.name))) assert.equal((await j(`/api/admin/templates/${t.id}`, { method: 'DELETE', headers: ADMIN })).status, 200);
    assert.equal(app.templates.all().length, countBefore, 'copies de test retirées');
    assert.equal((await fetch(`${base}/api/admin/templates/inconnu/export`, { headers: ADMIN })).status, 404);
    // Import d'un export retouché à la main : refusé en entier, rien d'appliqué, pas de sauvegarde créée
    const res = await fetch(`${base}/api/admin/config/export?settings=1&templates=0&secrets=0`, { headers: ADMIN });
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const settings = JSON.parse(zip.readAsText('settings.json'));
    zip.updateFile('settings.json', Buffer.from(JSON.stringify({ ...settings, booth: { ...settings.booth, name: 'Import refusé' }, limits: { ...settings.limits, countdownSec: 'abc' } })));
    const form = new FormData();
    form.append('file', new Blob([zip.toBuffer()]), 'config.zip');
    const pv = await j('/api/admin/config/import/preview', { method: 'POST', headers: ADMIN, body: form });
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    const backupsBefore = (await j('/api/admin/config/import/backup', { headers: ADMIN })).data;
    const ap = await post('/api/admin/config/import/apply', { id: pv.data.import.id, sections: ['booth', 'limits'] }, ADMIN);
    assert.equal(ap.status, 400, JSON.stringify(ap.data));
    assert.equal(ap.data.error, 'IMPORT_NUMBER');
    assert.notEqual(app.config.get().booth.name, 'Import refusé', 'aucune section appliquée');
    assert.equal(app.config.get().limits.countdownSec, before);
    assert.deepEqual((await j('/api/admin/config/import/backup', { headers: ADMIN })).data, backupsBefore, 'pas de sauvegarde pour un import refusé');
    // Même vérification qu'à l'enregistrement : valeur à choix inconnue refusée, nombre hors bornes ramené dans ses bornes,
    // cadres proposés absents de la borne retirés
    const importSettings = async (patch, sections) => {
      const z2 = new AdmZip(zip.toBuffer());
      z2.updateFile('settings.json', Buffer.from(JSON.stringify({ ...settings, ...patch })));
      const f2 = new FormData();
      f2.append('file', new Blob([z2.toBuffer()]), 'config.zip');
      const p = await j('/api/admin/config/import/preview', { method: 'POST', headers: ADMIN, body: f2 });
      return post('/api/admin/config/import/apply', { id: p.data.import.id, sections }, ADMIN);
    };
    const badTouch = await importSettings({ booth: { ...settings.booth, touch: 'souris' } }, ['booth']);
    assert.equal(badTouch.status, 400);
    assert.equal(badTouch.data.error, 'IMPORT_TOUCH');
    const badLogo = await importSettings({ booth: { ...settings.booth, logo: 'javascript:alert(1)' } }, ['booth']);
    assert.equal(badLogo.data.error, 'IMPORT_UPLOAD_URL');
    const clamped = await importSettings({ limits: { ...settings.limits, countdownSec: 0, maxCopiesPerSession: 0 }, templates: { ...settings.templates, enabled: ['absent', 'strip-3'], default: 'absent' } }, ['limits', 'templates']);
    assert.equal(clamped.status, 200, JSON.stringify(clamped.data));
    assert.equal(app.config.get().limits.countdownSec, 1);
    assert.equal(app.config.get().limits.maxCopiesPerSession, 1);
    assert.deepEqual(app.config.get().templates.enabled, ['strip-3'], 'cadre absent retiré');
    assert.equal(app.config.get().templates.default, 'strip-3');
    assert.equal((await post('/api/admin/config/import/revert', {}, ADMIN)).status, 200);
    assert.equal(app.config.get().limits.countdownSec, before);
  });

  await step('export et import de la configuration : secrets exclus, choix par section, templates, annulation', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const cfg = () => app.config.get();
    await put('/api/admin/config', { booth: { name: 'Borne A' }, limits: { operatorPin: '4321' }, share: { wifi: { enabled: true, ssid: 'Salle', password: 'secret-wifi' } } }, ADMIN);
    const exportZip = async (q) => {
      const res = await fetch(`${base}/api/admin/config/export?${q}`, { headers: ADMIN });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /zip/);
      return Buffer.from(await res.arrayBuffer());
    };
    const preview = async (buf) => {
      const form = new FormData();
      form.append('file', new Blob([buf]), 'config.zip');
      return j('/api/admin/config/import/preview', { method: 'POST', headers: ADMIN, body: form });
    };
    const apply = (body) => post('/api/admin/config/import/apply', body, ADMIN);
    // Export sans secrets : ni code opérateur ni mot de passe Wi-Fi dans le fichier
    const plain = await exportZip('settings=1&templates=1&secrets=0');
    const z = new AdmZip(plain);
    const names = z.getEntries().map((e) => e.entryName);
    assert.ok(names.includes('manifest.json') && names.includes('settings.json'));
    assert.ok(names.some((n) => /^templates\/[^/]+\/template\.json$/.test(n)), 'templates dans l\'archive');
    assert.ok(!names.some((n) => n.startsWith('themes/')), 'thèmes livrés jamais exportés');
    const exported = JSON.parse(z.readAsText('settings.json'));
    assert.equal(exported.share.wifi.password, undefined, 'mot de passe Wi-Fi exclu');
    assert.equal(exported.limits.operatorPin, undefined, 'code opérateur exclu');
    assert.equal(exported.share.wifi.ssid, 'Salle');
    assert.equal(JSON.parse(z.readAsText('manifest.json')).secrets, false);
    // Réglages changés, puis import de deux sections : les secrets actuels restent
    await put('/api/admin/config', { booth: { name: 'Borne B' }, limits: { operatorPin: '9999' }, share: { wifi: { ssid: 'Autre', password: 'autre-mdp' } } }, ADMIN);
    const p1 = await preview(plain);
    assert.equal(p1.status, 200);
    assert.ok(p1.data.import.sections.some((s) => s.key === 'booth') && p1.data.import.templates.every((t) => t.exists), JSON.stringify(p1.data.import.sections));
    assert.equal(p1.data.import.secrets, false);
    const a1 = await apply({ id: p1.data.import.id, sections: ['booth', 'share', 'limits'], secrets: false });
    assert.equal(a1.status, 200, JSON.stringify(a1.data));
    assert.equal(cfg().booth.name, 'Borne A');
    assert.equal(cfg().share.wifi.ssid, 'Salle');
    assert.equal(cfg().share.wifi.password, 'autre-mdp', 'mot de passe Wi-Fi actuel gardé');
    assert.equal(cfg().limits.operatorPin, '9999', 'code opérateur actuel gardé');
    assert.ok(a1.data.backup.name.startsWith('avant-import-'), 'sauvegarde d\'avant import');
    // Seules les sections cochées sont appliquées
    await put('/api/admin/config', { booth: { name: 'Borne C' }, lights: { enabled: true } }, ADMIN);
    const p2 = await preview(plain);
    await apply({ id: p2.data.import.id, sections: ['booth'] });
    assert.equal(cfg().booth.name, 'Borne A');
    assert.equal(cfg().lights.enabled, true, 'section non cochée : inchangée');
    // Avec secrets : appliqués seulement si l'export en contient ET si la case est cochée
    const full = await exportZip('settings=1&templates=0&secrets=1');
    assert.equal(JSON.parse(new AdmZip(full).readAsText('settings.json')).share.wifi.password, 'autre-mdp');
    await put('/api/admin/config', { share: { wifi: { password: 'encore-un-autre' } } }, ADMIN);
    const p3 = await preview(full);
    assert.equal(p3.data.import.secrets, true);
    await apply({ id: p3.data.import.id, sections: ['share'], secrets: false });
    assert.equal(cfg().share.wifi.password, 'encore-un-autre', 'case secrets décochée : mot de passe actuel gardé');
    const p4 = await preview(full);
    await apply({ id: p4.data.import.id, sections: ['share'], secrets: true });
    assert.equal(cfg().share.wifi.password, 'autre-mdp', 'secrets appliqués');
    // Template supprimé puis restauré depuis l'archive
    const tpl = app.templates.all()[0];
    app.templates.remove(tpl.id);
    assert.ok(!app.templates.all().some((t) => t.id === tpl.id));
    const p5 = await preview(plain);
    const info = p5.data.import.templates.find((t) => t.id === tpl.id);
    assert.equal(info.exists, false);
    await apply({ id: p5.data.import.id, templates: [tpl.id] });
    assert.ok(app.templates.all().some((t) => t.id === tpl.id), 'template restauré');
    // Annulation : retour à l'état d'avant le dernier import
    await put('/api/admin/config', { booth: { name: 'Avant dernier import' } }, ADMIN);
    const p6 = await preview(plain);
    await apply({ id: p6.data.import.id, sections: ['booth'] });
    assert.equal(cfg().booth.name, 'Borne A');
    assert.equal((await post('/api/admin/config/import/revert', {}, ADMIN)).status, 200);
    assert.equal(cfg().booth.name, 'Avant dernier import', 'import annulé');
    // Annulation d'un import qui a ajouté un template : il est retiré, et des cadres proposés
    const extra = new AdmZip(plain);
    for (const e of extra.getEntries().filter((x) => x.entryName.startsWith(`templates/${tpl.id}/`))) {
      const data = e.entryName.endsWith('template.json') ? Buffer.from(JSON.stringify({ ...JSON.parse(e.getData()), id: 'importe' })) : e.getData();
      extra.addFile(e.entryName.replace(`templates/${tpl.id}/`, 'templates/importe/'), data);
    }
    const p7 = await preview(extra.toBuffer());
    assert.ok(p7.data.import.templates.some((t) => t.id === 'importe' && !t.exists));
    await apply({ id: p7.data.import.id, templates: ['importe'] });
    assert.ok(app.templates.items.has('importe'));
    await put('/api/admin/config', { templates: { enabled: [...cfg().templates.enabled, 'importe'] } }, ADMIN);
    assert.equal((await post('/api/admin/config/import/revert', {}, ADMIN)).status, 200);
    assert.ok(!app.templates.items.has('importe'), 'template ajouté par l\'import retiré');
    assert.ok(!fs.existsSync(path.join(app.templates.dir, 'importe')));
    assert.ok(!cfg().templates.enabled.includes('importe'), 'retiré des cadres proposés');
    assert.ok(app.templates.items.has(tpl.id), 'template d\'avant gardé');
    assert.ok((await j('/api/admin/config/import/backup', { headers: ADMIN })).data.backup, 'sauvegarde listée');
    // Fichiers invalides ou périmés refusés
    assert.equal((await preview(Buffer.from('pas un zip'))).status, 400);
    // Fichiers de uploads/ : images et polices seulement (servis tels quels par /uploads)
    const { readBundle } = await import('../server/config-bundle.js');
    const tricked = new AdmZip(plain);
    tricked.addFile('uploads/page.html', Buffer.from('<script>alert(1)</script>'));
    tricked.addFile('uploads/logo-x.png', Buffer.from('png'));
    assert.deepEqual([...readBundle(tricked.toBuffer()).uploads.keys()].filter((n) => ['page.html', 'logo-x.png'].includes(n)), ['logo-x.png']);
    const bad = new AdmZip(); bad.addFile('hello.txt', Buffer.from('x'));
    assert.equal((await preview(bad.toBuffer())).status, 400, 'zip qui n\'est pas un export');
    assert.equal((await apply({ id: 'perime', sections: ['booth'] })).status, 409);
    assert.equal((await j('/api/admin/config/export?settings=0&templates=0', { headers: ADMIN })).status, 400);
  });

  await step('notifications d\'appareils : silence au démarrage, déconnexion immédiate, connexion confirmée', async () => {
    const { DeviceWatch } = await import('../server/device-watch.js');
    let state = { camera: true, light: false };
    const sent = [];
    const w = new DeviceWatch({ graceMs: 40, sources: () => [{ id: 'camera', label: 'Boîtier photo', connected: state.camera }, { id: 'light', label: 'Lumière', connected: state.light }, { id: 'wifi', label: 'Wi-Fi', connected: null }], notify: (m) => sent.push(m) });
    w.check(); w.check();
    assert.equal(sent.length, 0, 'déjà branché au démarrage : rien');
    state.camera = false; w.check();
    assert.deepEqual(sent.map((m) => [m.id, m.connected]), [['camera', false]], 'déconnexion annoncée dès la première lecture');
    w.check();
    assert.equal(sent.length, 1, 'une seule annonce');
    await new Promise((r) => setTimeout(r, 60));
    state.light = true; w.check(); w.check(); // jamais vue connectée avant : annoncée une fois le délai passé
    state.camera = true; w.check(); w.check();
    assert.deepEqual(sent.map((m) => [m.id, m.connected]), [['camera', false], ['light', true], ['camera', true]]);
    state.light = false; w.check();
    state.light = true; w.check(); w.check();
    assert.equal(sent.length, 5, 'déconnexion puis reconnexion de la lumière annoncées');
  });

  await step('ring light : flash interdit, calibrage à plusieurs luminosités, luminosité retenue en prise de vue', async () => {
    const { calibrate, isFlashBlocked } = await import('../server/camera/control.js');
    // Calibrage seul, boîtier simulé : chaque photo est la photo d'exemple
    const sample = fs.readFileSync(path.join(SAMPLES_DIR, 'sample-1.jpg'));
    const levels = [];
    const dir = path.join(process.env.BOOTH_OUTPUT_DIR, 'calib-ring');
    const res = await calibrate({ flashControl: true, write: async () => {}, shoot: async (file) => fs.writeFileSync(file, sample), raiseFlash: async () => { throw new Error('flash levé alors qu\'une ring light est branchée'); }, light: { set: async (b, k) => levels.push([b, k]) } }, { dir });
    assert.deepEqual(levels.slice(0, 3).map(([b]) => b), [30, 45, 60], 'trois luminosités essayées (jamais plus de 60 %)');
    assert.deepEqual(levels.slice(3).map(([, k]) => k), [4000, 5000, 6000], 'puis trois couleurs');
    assert.equal(new Set(levels.slice(3).map(([b]) => b)).size, 1, 'couleurs essayées à la luminosité retenue');
    assert.equal(res.shots.length, 6);
    assert.equal(res.profile.flash, false, 'jamais de flash');
    assert.equal(res.profile.settings.whitebalance, 'Daylight');
    assert.ok([30, 45, 60].includes(res.profile.light.brightness) && [4000, 5000, 6000].includes(res.profile.light.kelvin), JSON.stringify(res.profile));
    fs.rmSync(dir, { recursive: true, force: true });
    // Sans ring light, scène sombre : le boîtier refuse les photos sans flash (mise au point impossible), le calibrage continue avec le flash
    let calls = 0;
    const dark = await calibrate({ flashControl: true, write: async () => {}, raiseFlash: async () => {}, shoot: async (file) => { if (++calls <= 2) throw new Error('Le boîtier n\'arrive pas à déclencher (mise au point impossible)'); fs.writeFileSync(file, sample); } }, { dir });
    assert.ok(dark.shots.length >= 4, `séries avec flash faites malgré les refus sans flash (${dark.shots.length} photos : ${dark.reason})`);
    fs.rmSync(dir, { recursive: true, force: true });
    // Lumières simulées : la ring light Elgato en ligne bloque le flash ; la luminosité retenue est appliquée
    const L = app.lights;
    await put('/api/admin/config', { lights: { enabled: false } }, ADMIN); // l'étape d'avant a simulé l'arrêt de la borne
    await put('/api/admin/config', { lights: { enabled: true } }, ADMIN);
    await new Promise((r) => setTimeout(r, 30)); await L.queue;
    for (let i = 0; i < 50 && !L.hasRingLight(); i++) { await new Promise((r) => setTimeout(r, 20)); await L.queue; }
    assert.equal(L.hasRingLight(), true, JSON.stringify({ running: L.running, ids: L.onlineIds(), targets: L.targets('shooting').map((d) => d.sku), devices: app.config.get().lights.devices }));
    assert.equal(isFlashBlocked(), true, 'flash interdit avec la ring light');
    await put('/api/admin/config', { camera: { control: { mode: 'auto', auto: { profile: { flash: false, settings: { shutterspeed: '1/125', aperture: '5.6', iso: 'Auto' }, light: { brightness: 60, kelvin: 4000 } } } } } }, ADMIN);
    await L.hold('test');
    const [, el] = L.drivers;
    assert.equal(el.state['10.0.0.21'].brightness, 60, 'ring light à la luminosité du calibrage');
    assert.equal(el.state['10.0.0.21'].temperature, 250, 'et à sa couleur (4000 K = 250 mireds)');
    L.release('test');
    // Séance : lumière douce (30 %), montée pendant le décompte jusqu'à 60 %, retour à 30 % après la photo
    const settle = async (ms) => { await new Promise((r) => setTimeout(r, ms)); await L.queue; };
    L.setScreen('capture');
    await settle(60);
    assert.equal(el.state['10.0.0.21'].brightness, 30, 'attente : lumière douce');
    L.setCountdown(1);
    await settle(250);
    const mid = el.state['10.0.0.21'].brightness;
    assert.ok(mid > 30 && mid < 60, `montée en cours (${mid})`);
    await settle(600);
    assert.equal(el.state['10.0.0.21'].brightness, 60, 'au « 0 » : pleine luminosité');
    L.shotDone();
    await settle(60);
    assert.equal(el.state['10.0.0.21'].brightness, 30, 'après la photo : retour à la lumière douce');
    // Plafond : même réglée à 100 %, la ring light ne dépasse jamais 60 %
    await put('/api/admin/config', { lights: { whiteLights: { shooting: { brightness: 100 } } }, camera: { control: { mode: 'manual' } } }, ADMIN);
    await L.hold('cap');
    assert.ok(el.state['10.0.0.21'].brightness <= 60, `ring light plafonnée (${el.state['10.0.0.21'].brightness})`);
    L.release('cap');
    L.setScreen('idle');
    await settle(60);
    // Ambiance « cycle » : la ring light passe du blanc chaud au blanc froid
    await put('/api/admin/config', { lights: { whiteLights: { idle: { mode: 'ambiance', effect: 'cycle', periodSec: 2 } } } }, ADMIN);
    await settle(1200);
    const temps = new Set(el.sent.filter(([ip, f]) => ip === '10.0.0.21' && f.temperature).slice(-6).map(([, f]) => f.temperature));
    assert.ok(temps.size >= 3, `température qui varie (${[...temps]})`);
    await put('/api/admin/config', { lights: { enabled: false }, camera: { control: { mode: 'camera' } } }, ADMIN);
    await new Promise((r) => setTimeout(r, 30)); await L.queue;
    assert.equal(isFlashBlocked(), false, 'lumières coupées : flash de nouveau possible');
  });

  await step('Philips Hue : pont trouvé, associé, ampoules pilotées (couleur et blanc), dissocié', async () => {
    const L = app.lights;
    await put('/api/admin/config', { lights: { enabled: false } }, ADMIN);
    await put('/api/admin/config', { lights: { enabled: true, idle: { mode: 'ambiance', effect: 'fixed', color: '#ff0000', white: false, brightness: 50 } } }, ADMIN);
    for (let i = 0; i < 50 && !L.running; i++) { await new Promise((r) => setTimeout(r, 20)); await L.queue; }
    const { bridges } = (await post('/api/admin/lights/hue/discover', {}, ADMIN)).data;
    assert.equal(bridges[0]?.id, 'MOCKBRIDGE');
    const pr = await post('/api/admin/lights/hue/pair', { ip: bridges[0].ip, name: bridges[0].name }, ADMIN);
    assert.equal(pr.status, 200, JSON.stringify(pr.data));
    assert.equal(app.config.get().lights.hue.username, 'mock-user');
    const hueDevs = pr.data.lights.devices.filter((d) => /^Hue /.test(d.sku));
    assert.equal(hueDevs.length, 2, 'deux ampoules Hue listées');
    assert.deepEqual(hueDevs.map((d) => d.name).sort(), ['Entrée', 'Salon'], 'nom repris du pont');
    L.scene = null; await L.enqueue(() => L.applyWanted()); await new Promise((r) => setTimeout(r, 30));
    const hue = L.drivers[2];
    assert.equal(hue.lights[1].state.on, true, 'ampoule couleur allumée');
    assert.equal(hue.lights[1].state.bri, 127, '50 % = 127 sur 254');
    assert.equal(hue.lights[1].state.colormode, 'xy', 'couleur de l\'ambiance en xy');
    assert.ok(hue.lights[1].state.xy[0] > 0.6, 'rouge');
    assert.equal(hue.lights[2].state.colormode, 'ct', 'ampoule blanche : reste en blanc');
    assert.equal((await post('/api/admin/lights/hue/forget', {}, ADMIN)).status, 200);
    assert.equal(app.config.get().lights.hue.username, '');
    assert.ok(!Object.values(app.config.get().lights.devices).some((d) => /^Hue /.test(d?.sku || '')), 'ampoules oubliées');
    await put('/api/admin/config', { lights: { enabled: false } }, ADMIN);
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
