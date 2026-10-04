/**
 * Enregistre le numero expediteur WhatsApp sur la Cloud API de Meta : etape OBLIGATOIRE, une fois, apres l'ajout du
 * numero dans WhatsApp Manager (sinon chaque alerte echoue : « numero non enregistre », code 133010).
 *
 *   npm run whatsapp-register:prod -- 123456
 *
 * Le code PIN (6 chiffres, a choisir) active la verification en deux etapes du numero : le conserver, Meta le redemandera
 * pour un nouvel enregistrement. Le jeton n'est jamais affiche.
 */
import { config } from '../server/config.ts';
import { registerWhatsappNumber } from './commission/checks.ts';

const pin = process.argv[2] ?? '';
const result = await registerWhatsappNumber(config.notify.whatsapp, pin);
console[result.ok ? 'log' : 'error'](result.message);
process.exitCode = result.ok ? 0 : 1;
