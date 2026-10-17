/**
 * Re-authentification de l'administrateur : avant une operation sensible (comptes, configuration des actionneurs, mode
 * maintenance), le serveur redemande le mot de passe du compte DEJA connecte (cle `reauth` du corps JSON). Un cookie de
 * session vole ne suffit donc plus. Ce module affiche la demande dans le dialogue commun (account.js, `ask`) : focus
 * piege, Entree valide, Echap annule, erreur du serveur affichee sur place sans fermer la boite (403 : mot de passe
 * incorrect, on peut retaper ; 429 : trop d'essais ; session fermee : le message du serveur).
 */
import { h } from './core.js';
import { createDialogs, field } from './account.js';

/**
 * Demande le mot de passe du compte connecte. Renvoie le mot de passe saisi, ou null si l'utilisateur annule.
 * Avec `onSubmit(motDePasse)`, l'operation part PENDANT que la boite est ouverte : son erreur (« Mot de passe
 * incorrect »...) s'affiche dans la boite, qui reste ouverte pour une nouvelle saisie ; elle ne se ferme qu'au succes.
 */
export function askReauth(what, onSubmit = null) {
  return createDialogs({ h }).ask({
    heading: 'Confirmer avec votre mot de passe',
    message: `Pour des raisons de sécurité, saisissez le mot de passe de votre compte pour ${what}.`,
    label: 'Votre mot de passe',
    confirmLabel: 'Confirmer',
    autocomplete: 'current-password',
    onSubmit,
  });
}

/**
 * Execute `run(motDePasse)` apres re-authentification. Renvoie `{ value }` (resultat de `run`) ou `null` si annule :
 * dans ce cas rien n'a ete envoye au serveur.
 */
export async function withReauth(what, run) {
  let value;
  const password = await askReauth(what, async (pw) => {
    value = await run(pw);
  });
  return password === null ? null : { value };
}

/**
 * Champ « mot de passe » a integrer dans un formulaire qui occupe deja la boite de dialogue commune (la boite etant
 * unique, une seconde boite ferait perdre la saisie). Renvoie { el, input }.
 */
export function reauthField(what) {
  const input = h('input', { type: 'password', autocomplete: 'current-password', spellcheck: 'false', autocapitalize: 'none', required: true, 'data-reauth': true });
  return { input, el: field(h, 'Votre mot de passe (redemandé par sécurité)', input, `Pour des raisons de sécurité, saisissez le mot de passe de votre compte pour ${what}.`) };
}
