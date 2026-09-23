import { createApp } from './app.js';
import { lanIp } from './util.js';

const { server, port, config, close } = await createApp();

server.listen(port, () => {
  const cfg = config.get();
  console.log(`\n  ${cfg.booth.name}`);
  console.log(`  Borne   : http://localhost:${port}`);
  console.log(`  Admin   : http://localhost:${port}/admin.html  (PIN ${cfg.admin.pin})`);
  console.log(`  Réseau  : http://${lanIp()}:${port}  (partage QR)`);
  console.log(`  Caméra  : ${cfg.camera.driver}   Imprimante : ${cfg.printer.driver}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} reçu, arrêt…`);
    await close();
    process.exit(0);
  });
}
