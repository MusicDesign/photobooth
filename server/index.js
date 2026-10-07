import fs from 'node:fs';
import https from 'node:https';
import { installFileLog } from './log.js';
import { createApp } from './app.js';

installFileLog();
import { lanIp } from './util.js';

// Code de sortie 0 : le lanceur de la borne comprend « arrêt volontaire » et ne relance pas.
// Code RESTART_CODE : « redémarrage » demandé depuis l'admin, le lanceur Linux (BOOTH_LAUNCHER) relance aussitôt.
const RESTART_CODE = 75;
const onRestart = process.env.BOOTH_LAUNCHER ? () => process.exit(RESTART_CODE) : null;
const { app, server, port, config, close } = await createApp({ onShutdown: () => process.exit(0), onRestart });

server.listen(port, () => {
  const cfg = config.get();
  console.log(`\n  ${cfg.booth.name}`);
  console.log(`  Borne   : http://localhost:${port}`);
  console.log(`  Admin   : http://localhost:${port}/admin.html  (PIN ${cfg.admin.pin})`);
  console.log(`  Réseau  : http://${lanIp()}:${port}  (partage QR)`);
  console.log(`  Caméra  : ${cfg.camera.driver}   Imprimante : ${cfg.printer.driver}\n`);
});

// Adresse publique en HTTPS sur le Wi-Fi de la borne : certificat du domaine (TUTORIEL.md, étape 10.8).
// Les téléphones y arrivent sur le port 443, redirigé vers BOOTH_HTTPS_PORT par le pare-feu.
if (process.env.BOOTH_TLS_CERT && process.env.BOOTH_TLS_KEY) {
  const httpsPort = Number(process.env.BOOTH_HTTPS_PORT) || 3443;
  const tls = { cert: fs.readFileSync(process.env.BOOTH_TLS_CERT), key: fs.readFileSync(process.env.BOOTH_TLS_KEY) };
  https.createServer(tls, app).listen(httpsPort, () => console.log(`  HTTPS   : port ${httpsPort} (certificat ${process.env.BOOTH_TLS_CERT})`));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} reçu, arrêt…`);
    await close();
    process.exit(0);
  });
}
