/**
 * Noms des titulaires dans le détail d'un incident.
 *
 * Le détail d'un incident de règle d'accès ne contient que l'identifiant « H<id> » du titulaire : le texte part aussi dans les
 * SMS et les courriels, où aucun nom ne doit figurer. À l'écran, pour un utilisateur connecté, on remplace chaque « H12 »
 * par « NOM Prénom (H12) » après lecture de la fiche (GET /api/access/holders/12).
 *
 * Règles tenues ici :
 *  - la substitution est faite pour l'AFFICHAGE seulement : le nom n'est jamais écrit ailleurs (ni stockage du navigateur, ni
 *    adresse, ni journal) et reste en mémoire de la page ;
 *  - un échec (droit refusé, fiche absente, réseau coupé) laisse « H12 » tel quel, sans message d'erreur ;
 *  - motif strict : « H » suivi de 1 à 9 chiffres, bornes de mot comprises (« H12abc », « SH12 » et « H1234567890 » restent
 *    intacts) ;
 *  - le cache est borné et expire (un nom change, une fiche disparaît) ; un échec est retenu peu de temps pour ne pas
 *    interroger le serveur à chaque rafraîchissement de la fiche d'incident ;
 *  - un texte hostile (des centaines de « H<n> ») ne lance pas des centaines de lectures : MAX_REFS par texte.
 *
 * Ce fichier n'importe rien (il se teste sans navigateur) : la lecture d'une fiche et l'identité de l'utilisateur lui sont données.
 */

/** Motif d'un identifiant de titulaire dans un texte (à recréer pour chaque usage : un motif global garde un état). */
const REF_SOURCE = String.raw`\bH\d{1,9}\b`;
const refPattern = () => new RegExp(REF_SOURCE, 'g');

/** Identifiants « H<n> » d'un texte, sans doublon, dans l'ordre d'apparition. */
export function holderRefsIn(text) {
  return [...new Set(String(text ?? '').match(refPattern()) ?? [])];
}

/** Nombre d'identifiants lus par texte (le reste du texte garde son « H<n> »). */
export const MAX_REFS = 10;
/** Durée de validité d'un nom lu, d'un échec, et taille du cache. */
export const NAME_TTL_MS = 5 * 60_000;
export const FAILURE_TTL_MS = 60_000;
export const MAX_CACHE = 500;
/** Un nom plus long n'est pas celui d'un titulaire (63 caractères au plus côté serveur) : on ne l'affiche pas. */
const MAX_NAME = 120;
// Caractères de commande et de mise en forme invisible : jamais dans un nom affiché.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f  \p{Cf}]/u;

/** Le nom à afficher d'une fiche lue, ou null si la fiche ne ressemble pas à celle demandée. */
export function nameOfHolder(data, ref) {
  if (data === null || typeof data !== 'object') return null;
  if (data.ref !== undefined && data.ref !== ref) return null; // une réponse qui n'est pas celle du titulaire demandé
  const name = typeof data.displayName === 'string' ? data.displayName.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
  if (name === '' || name.length > MAX_NAME || INVISIBLE.test(name)) return null;
  return name;
}

/**
 * Le cache des noms. `fetchHolder(id)` lit la fiche (promesse du JSON, ou erreur) ; `now()` donne l'heure (injectée).
 * Rien n'est jamais levé hors de ce module : `load` termine toujours.
 */
export function createHolderNames({ fetchHolder, now = Date.now }) {
  const cache = new Map(); // « H12 » -> { name: string | null, at }
  const pending = new Map(); // « H12 » -> promesse en cours (une seule lecture à la fois par titulaire)
  let generation = 0; // change à chaque effacement : une lecture arrivée après est jetée

  const entry = (ref) => cache.get(ref);
  const fresh = (e) => e !== undefined && now() - e.at < (e.name === null ? FAILURE_TTL_MS : NAME_TTL_MS);

  function remember(ref, name) {
    cache.delete(ref); // ré-insérer : le plus ancien reste en tête pour l'éviction
    cache.set(ref, { name, at: now() });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }

  /** « H<n> » dont le nom est à lire (jamais lu, périmé, ou échec assez ancien pour qu'on réessaie). Une lecture en cours compte : `load` la partage. */
  function missing(text) {
    return holderRefsIn(text)
      .slice(0, MAX_REFS)
      .filter((ref) => !fresh(entry(ref)));
  }

  /** Le texte avec les noms déjà connus (même périmés : on garde l'ancien nom pendant qu'on relit, sans clignotement). */
  function textWith(text) {
    const raw = String(text ?? '');
    const allowed = new Set(holderRefsIn(raw).slice(0, MAX_REFS));
    return raw.replace(refPattern(), (ref) => {
      const name = allowed.has(ref) ? entry(ref)?.name : null;
      return name ? `${name} (${ref})` : ref;
    });
  }

  /** Lit les fiches manquantes d'un texte. Ne lève jamais ; une lecture en cours est partagée. */
  async function load(text) {
    const wanted = holderRefsIn(text).slice(0, MAX_REFS);
    const mine = generation;
    await Promise.all(
      wanted.map(async (ref) => {
        if (fresh(entry(ref))) return;
        let read = pending.get(ref);
        if (!read) {
          read = (async () => {
            let name = null;
            try {
              name = nameOfHolder(await fetchHolder(ref.slice(1)), ref);
            } catch {
              name = null; // droit refusé, 404, réseau : « H12 » reste tel quel, sans message
            }
            if (mine === generation) remember(ref, name);
          })();
          pending.set(ref, read);
          read.finally(() => {
            if (pending.get(ref) === read) pending.delete(ref);
          });
        }
        await read;
      }),
    );
  }

  /** Oublie tout (changement de compte). Les lectures en cours sont jetées à leur arrivée. */
  function clear() {
    generation++;
    cache.clear();
    pending.clear();
  }

  return { missing, textWith, load, clear, size: () => cache.size };
}

/**
 * Le point d'accroche de l'écran des incidents : `show(element, texte)` écrit le texte dans l'élément (avec les noms déjà
 * connus, sans clignotement) puis, si des noms manquent, les lit et réécrit le texte une fois — sauf si l'élément a reçu
 * un autre texte entre-temps. `whoAmI()` donne le compte connecté : à un autre compte, rien du précédent ne reste en mémoire.
 */
export function holderNamesView(fetchHolder, whoAmI = () => null, now = Date.now) {
  const names = createHolderNames({ fetchHolder, now });
  const shown = new WeakMap(); // élément -> dernier texte brut demandé
  let owner = whoAmI();
  return function show(el, text) {
    const current = whoAmI();
    if (current !== owner) {
      owner = current;
      names.clear();
    }
    const raw = String(text ?? '');
    shown.set(el, raw);
    el.textContent = names.textWith(raw);
    if (names.missing(raw).length === 0) return;
    names.load(raw).then(() => {
      if (shown.get(el) !== raw) return; // l'élément montre déjà autre chose
      const next = names.textWith(raw);
      if (el.textContent !== next) el.textContent = next;
    });
  };
}
