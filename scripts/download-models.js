/**
 * Télécharge les modèles d'IA trop lourds pour le dépôt (une fois, avec internet) : npm run models
 * Même chose que le bouton de l'admin (Templates → Détourage précis).
 */
import { MODELS, modelStatus, downloadModel } from '../server/models.js';

for (const key of Object.keys(MODELS)) {
  const st = modelStatus(key);
  if (st.installed) { console.log(`${st.name} : déjà installé`); continue; }
  console.log(`${st.name} : téléchargement (${Math.round(st.size / 1e6)} Mo)…`);
  const tick = setInterval(() => process.stdout.write(`\r  ${Math.round((modelStatus(key).received / st.size) * 100)} %`), 1000);
  try {
    await downloadModel(key, { log: () => {} });
    console.log(`\r  terminé`);
  } catch (e) {
    console.error(`\r  échec : ${e.message}`);
    process.exitCode = 1;
  } finally {
    clearInterval(tick);
  }
}
