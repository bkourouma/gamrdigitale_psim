# Portail de suivi à distance

Un tableau de bord **pour le client**, sans vidéo en direct : état de chaque site, équipements, temps d'arrêt, incidents, statistiques. Il complète le PSIM, il ne le remplace pas : le PSIM reste sur chaque site et décide seul des alarmes ; le portail ne lui envoie **aucune commande**.

```
 Site A (PSIM)  ──┐
 Site B (PSIM)  ──┼── résumé signé, toutes les 5 min (HTTPS, sortant) ──▶  Portail  ◀── client (navigateur, téléphone)
 Site C (PSIM)  ──┘
```

Le site appelle le portail, jamais l'inverse : **rien n'est ouvert sur le réseau du client**.

## Essayer tout de suite

```bash
npm run portal:demo
```

Ouvrir http://127.0.0.1:4301. Comptes `prestataire`, `diallo` (direction, 4 sites), `kaloum` (un seul site), `autre` (autre client) ; le mot de passe est affiché dans le terminal. La démo recrée une base vierge (`portal-demo-data/`) avec treize sites dans des états différents (alarme, injoignable, équipement hors service, tout va bien). Elle montre aussi **une banque à deux régions** (« Banque du Fouta ») : `dg-banque` voit toute la banque, `dir-conakry` et `dir-haute-guinee` ne voient que leur région (un site muet et un site qui n'a jamais rien envoyé en Haute-Guinée ; une alerte énergie à Ratoma ; un incident « personne » à Kankan).

## Installer le portail

1. Créer `.env.portal` (jamais versionné) :

   ```
   PORTAL_ENV=production
   PORTAL_HOST=127.0.0.1             # le proxy HTTPS écoute dehors, le portail reste local
   PORTAL_PORT=4300
   PORTAL_TRUST_PROXY=1              # derrière le proxy : adresse réelle du client, cookie « Secure »
   PORTAL_MASTER_KEY=<64 caractères hexadécimaux>
   PORTAL_PUBLIC_URL=https://suivi.exemple.com
   # PORTAL_STALE_AFTER_S=900        silence au-delà duquel un site est « injoignable »
   ```

   Générer la clé : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

2. Placer un **proxy HTTPS** devant (IIS, nginx, Caddy). Sans HTTPS, mots de passe et sessions circulent en clair : le portail le dit au démarrage.
3. `npm run portal`.

## Ajouter un client, un site, des comptes

Tout se fait en ligne de commande : l'interface web est en lecture seule, il n'y a aucune page d'administration à attaquer depuis internet.

```bash
npm run portal:admin -- add-org "Groupe Diallo"
npm run portal:admin -- add-site "Groupe Diallo" entrepot-kaloum "Entrepôt Kaloum"
npm run portal:admin -- add-user diallo director --org "Groupe Diallo" --name "M. Diallo"
npm run portal:admin -- add-user kaloum site_manager --site entrepot-kaloum
npm run portal:admin -- list
```

| Rôle | Voit |
|---|---|
| `admin` (vous) | tous les clients et tous les sites |
| `director` | tous les sites de son organisation, ou seulement ceux de ses groupes (voir plus bas) |
| `site_manager` | un seul site |

### Clients à plusieurs sites : groupes, régions, agences

Pour une banque, une microfinance, une chaîne de boutiques : **organisation → groupes → sites**. Un groupe (région, agence, branche) peut avoir des **sous-groupes**, sur **deux niveaux au plus** (groupe puis sous-groupe). Un groupe a un **code** (minuscules, chiffres, tirets, 3 à 40 caractères) qui sert dans les commandes, et un nom affiché. Un site est dans **un seul** groupe ou dans aucun (« Sans groupe »), toujours de sa propre organisation.

```bash
npm run portal:admin -- add-group region-conakry Région Conakry --org "Banque du Fouta"
npm run portal:admin -- add-group agences-kaloum Agences de Kaloum --parent region-conakry
npm run portal:admin -- assign-site agence-kaloum-centre agences-kaloum
npm run portal:admin -- unassign-site agence-kaloum-centre           # retour à « Sans groupe »
npm run portal:admin -- rename-group region-conakry Région de Conakry
npm run portal:admin -- remove-group agences-kaloum                  # refusé si le groupe n'est pas vide
npm run portal:admin -- add-user dir-conakry director --org "Banque du Fouta" --groups region-conakry
npm run portal:admin -- limit-user dir-conakry region-conakry region-kankan   # limite (ou change la limite) d'un directeur
npm run portal:admin -- unlimit-user dir-conakry                     # il revoit toute son organisation
```

**Périmètre d'un compte.** Un `director` sans limite voit toute son organisation (siège « Sans groupe » compris). Un `director` **limité à des groupes** (directeur régional) ne voit que ces groupes et leurs sous-groupes, y compris ceux créés plus tard ; limité à un sous-groupe, il ne voit ni son groupe parent (même pas son nom) ni ses voisins. Les sites « Sans groupe » ne sont vus que d'un directeur non limité. Un compte marqué limité mais **sans aucun groupe ne voit rien** (jamais « toute l'organisation » par défaut). Un `site_manager` garde un seul site et ne voit aucun groupe ; `admin` voit tout. La limite est relue **à chaque requête** (changer le périmètre ou déplacer un site agit aussitôt, sans reconnexion) ; un groupe ou un site hors périmètre est « introuvable » (404), identique à un identifiant inexistant.

**Refus de la ligne de commande.** `remove-group` refuse un groupe qui contient des sites (même désactivés) ou des sous-groupes, et un groupe qui limite encore un compte (le supprimer élargirait en silence le périmètre de ce compte : changer d'abord sa limite). La base elle-même refuse trois niveaux, un site rangé dans le groupe d'une autre organisation, et une limite vers un groupe d'une autre organisation. Chaque geste (création, renommage, suppression, rattachement, limite) est écrit dans le journal du portail (`audit`).

**Ce que voit la direction.** Pour une organisation à groupes, l'accueil est un tableau de bord : groupes classés **du plus préoccupant au plus serein**, puis chaque groupe, sous-groupe et site, avec fil d'Ariane (organisation › groupe › site). Un directeur régional limité à un seul groupe arrive directement sur son groupe ; un prestataire qui suit plusieurs clients arrive sur la liste de ses clients. Par groupe :

- **états** des sites (alarme, muet, à surveiller, incident récent, sans mesure, en bon état) ; le pire état classe le groupe ; un groupe vide dit « Aucun site » ;
- **disponibilité du mois** : temps en service ÷ temps observé, **sur les sites mesurés seulement** (un site non mesuré ou muet depuis plus de 30 jours ne compte pas comme 100 %) ; l'écran dit sur combien de sites elle repose ;
- **sites muets** (plus de résumé récent) et sites **qui n'ont jamais rien envoyé**, nommés dans « À vérifier » ; leurs incidents encore ouverts sont des « derniers états connus », comptés à part des incidents confirmés ;
- **incidents ouverts** par catégorie (incendie, intrusion, accès, environnement, **énergie**, **personnes**) ;
- **indice de sécurité GAMR** : moyenne des sites évalués et site le plus exposé ; un site sans indice n'entre pas dans la moyenne (jamais compté pour 0), un site muet y compte avec son dernier indice connu, dit ;
- **contrôle d'accès** : nombre de portes des sites équipés et, parmi elles, celles **hors ligne** ou **en défaut** (sites qui répondent seulement). Les portes d'un site muet sont leur dernier état connu : elles figurent à part, dans « À vérifier », jamais dans le compte confirmé. Un groupe sans porte n'a pas cette ligne.

Un client sans groupe garde exactement l'écran d'avant.

Un compte reçoit un **mot de passe provisoire**, affiché une seule fois ; il ne voit rien tant qu'il ne l'a pas changé. Un site hors du périmètre d'un compte est « introuvable » (404), jamais « interdit » : on ne révèle pas qu'il existe.

## Mise à jour : le portail AVANT les PSIM

Le portail se met à jour **avant** les PSIM des sites : les groupes et le contrôle d'accès ne changent pas le format du résumé (`v: 1` ; le bloc `access` est un champ en plus, facultatif), donc les PSIM déjà déployés continuent d'envoyer sans rien changer, et un portail à jour accepte aussi les catégories `energy` et `people` envoyées par les PSIM de l'étape 2. L'inverse n'est pas vrai : un portail ancien refuserait ces catégories. Ordre : sauvegarder `portal-data/`, arrêter le portail, déployer le nouveau code, relancer (`npm run portal`), puis mettre à jour les PSIM site par site.

**Compatibilité du bloc `access` dans les deux sens.** Un portail ancien reçoit un résumé de PSIM récent sans erreur : il ne rejette pas les champs qu'il ne connaît pas, il ne garde que les siens et ignore `access` (HTTP 200, site affiché). Un PSIM ancien envoie un résumé sans bloc à un portail récent : accepté, la carte dit « Non transmis » s'il a des détecteurs d'accès et rien du tout sinon. Ces deux cas ont été essayés pour de vrai en faisant tourner le code d'avant (extrait de l'historique) contre le code récent, dans les deux sens. Un portail récent refuse en revanche un bloc `access` mal formé (type, borne, liste trop longue) avec une erreur 400 précise, comme il le fait pour l'indice de sécurité : le PSIM le voit comme un échec d'envoi (écran système, `portal.lastError`) et l'erreur précise est dans la réponse du portail.

À la première ouverture, le portail **migre sa base tout seul** (ajout de `site.group_id`, `portal_user.group_limited` et des tables de groupes) : opération unique, atomique, sans perte, notée dans le journal (`schema_migrated`) ; tous les sites existants restent « Sans groupe » et tous les comptes gardent leur périmètre d'avant. La ligne de commande `portal:admin` fait la même migration si elle ouvre la base la première. Revenir à l'ancien code après migration est possible (les colonnes ajoutées sont ignorées) mais les groupes et limites ne seraient plus appliqués : un directeur limité verrait alors toute son organisation. Ne pas revenir en arrière sur un portail qui sert des directeurs régionaux sans d'abord lever leurs limites.

## Brancher le PSIM d'un site

`add-site` affiche trois lignes à copier dans le `.env.production` **de ce site**, puis redémarrer son PSIM :

```
PSIM_PORTAL_URL=https://suivi.exemple.com/api/ingest
PSIM_PORTAL_SITE_ID=entrepot-kaloum
PSIM_PORTAL_KEY=<clé propre à ce site>
```

`npm run check-config:prod` contrôle la configuration. L'état de l'envoi figure dans l'écran système du PSIM (`/api/system`, champ `portal`) ; trois échecs de suite déclenchent un avertissement. La clé d'un site n'est pas stockée : elle se dérive de la clé maîtresse. `rotate-site-key <site>` en produit une nouvelle (l'ancienne cesse de marcher) ; `site-env <site>` réaffiche les lignes.

## Ce qui part du site, ce qui n'en part jamais

Part : équipements (nom, zone, étage, état), disponibilité et périodes d'arrêt, incidents (heures, gravité, qualification), nombre de notifications, **indice de sécurité GAMR** (celui du site, celui de chaque zone, et un point par jour pour la tendance), et, si le site a des portes, un **bloc `access`** de simples comptes (voir ci-dessous).

Le bloc `access` (champ facultatif du résumé, absent d'un site sans porte déclarée) contient : `doors` (nombre de portes déclarées), `states` (nombre de portes par état du moment : hors ligne, en défaut, forcée, maintenue ouverte, ouverte, fermée, inconnu), `availability` (`upS`, `downS`, `unmonitoredS`, `pct` : disponibilité cumulée des portes sur la fenêtre de 35 jours, `pct` à `null` si rien n'a été observé) et `incidents` (sur la fenêtre : `total`, `forced`, `heldOpen`, `repeatedDenials`, `tamper`, `other`, plus `openNow` : ceux qui sont encore ouverts, et `byDay` : un compte par jour local, les jours sans incident omis). Il est calculé en lecture seule (`server/accessportal.ts`) ; l'état affiché d'une porte suit la même priorité que dans le PSIM : hors ligne, en défaut, forcée, maintenue ouverte, ouverte, fermée, inconnu.

Ne part **jamais** : adresses ou identifiants des caméras, images, comptes et noms d'opérateurs, commentaires d'incident, journal, destinataires de notification, notes d'évaluation des risques et nom de l'évaluateur. **Contrôle d'accès** : aucun nom de titulaire, aucun numéro de badge, aucune référence de titulaire, aucun identifiant ni adresse de contrôleur, aucun nom de porte dans le bloc (les détecteurs-portes figurent dans la liste des équipements comme n'importe quel détecteur), et **aucun nombre de passages**, même agrégé : le portail ne reçoit que des comptes de portes, d'états et d'incidents. C'est vérifié par des tests (`test/portal-access-privacy.test.ts` : un site avec contrôleur, passages nominatifs, refus répétés et porte forcée ; tous les envois et toutes les réponses du portail pour chaque rôle, plus la base du portail, sont fouillés).

## Comment lire les chiffres

- **Disponibilité** = temps où les équipements suivis (détecteurs et caméras réelles) étaient en service ÷ temps observé. Une alarme est un détecteur qui *fonctionne* : elle ne compte pas comme une panne.
- **Temps non surveillé** : quand le PSIM d'un site était arrêté, on ne sait pas ce qui s'est passé. Ce temps n'est compté ni disponible ni indisponible ; il est montré à part (« Surveillance interrompue »).
- **Caméras** : le PSIM teste chaque minute (`PSIM_CAMERA_CHECK_S`) la connexion réseau de chaque caméra réelle, sans identifiants ni image. « Hors ligne » après 3 échecs de suite (daté du premier), « en service » au premier succès. Cela prouve que **l'appareil répond**, pas que l'image est bonne ; derrière un enregistreur, toutes les voies partagent son adresse et tombent ensemble. Une caméra simulée, ou pas encore testée, reste « Non mesuré », sans pourcentage. Une caméra injoignable apparaît dans le journal du PSIM (« Caméra injoignable ») et dans son écran Système ; elle n'ouvre pas d'incident et ne prévient personne.
- **Contrôle d'accès** (carte de la Synthèse d'un site ; pas de carte pour un site sans porte) : nombre de portes, **états du moment** (un mot et une forme pour chaque : jamais la couleur seule), **disponibilité des portes** sur les 35 derniers jours (même méthode que ci-dessus : une porte hors ligne ou en défaut est comptée en panne, une porte jamais observée ne donne aucun pourcentage), **incidents d'accès** de la fenêtre par type (porte forcée, maintenue ouverte, série de refus de badge, sabotage, autre) et combien sont encore ouverts. Un site injoignable montre ses portes « au dernier signal ». Un site dont le PSIM est plus ancien (ou dont les portes ne sont pas déclarées dans le contrôle d'accès) mais qui a des détecteurs d'accès affiche « Non transmis » : le portail n'invente rien. L'historique long des incidents d'accès est celui des incidents du portail (catégorie « accès »), pas le bloc, qui ne porte que la fenêtre du dernier envoi.
- Moyennes sur plusieurs jours **pondérées par le temps observé** ; délais en **médiane**.
- Aucun jour manquant n'est inventé : un site récent affiche « mesures disponibles depuis le… ».
- Le portail conserve les jours qui sortent de la fenêtre de 35 jours envoyée par le site : c'est lui qui garde l'historique long.
- **Indice de sécurité GAMR** (de 1 à 60) : calculé par le PSIM du site (probabilité × vulnérabilité × répercussions, zone par zone ; l'indice du site est celui de sa zone la plus exposée), avec les mêmes seuils partout : Faible ≤ 8, Modéré ≤ 20, Élevé ≤ 36, Critique ≤ 60. Le portail ne recalcule rien : il affiche ce que le site envoie, daté. Une zone non évaluée est « à évaluer », sans note ; un site dont le PSIM est plus ancien n'envoie pas d'indice et le portail le dit (« non transmis ») ; un site injoignable garde son dernier indice connu, avec sa date. Le portail garde un point par jour au-delà des 35 jours envoyés.

## Sécurité

- Chaque envoi est signé (HMAC-SHA256 du corps, identifiant du site et horodatage) avec la clé du site. Horodatage hors de ±10 min refusé (rejeu), signature fausse, site inconnu ou désactivé : **même réponse**, rien ne révèle quels sites existent.
- Contenu reçu validé champ par champ (types, bornes, caractères de contrôle) ; seuls les champs connus sont conservés. Un résumé plus ancien que le dernier reçu est ignoré.
- Mots de passe hachés (scrypt), 12 caractères minimum, 5 échecs par minute et par adresse/compte, sessions de 12 h dont seule l'empreinte est stockée, coupées aussitôt qu'un compte est désactivé ou son mot de passe changé.
- Cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` derrière HTTPS), origine vérifiée sur les écritures, politique de sécurité de contenu stricte (aucun script ni style en ligne).
- **Sauvegarder `portal-data/`** : elle contient la base et, si `PORTAL_MASTER_KEY` n'est pas défini, `master.key`. Perdre la clé maîtresse oblige à reconfigurer **tous** les sites.

## Ce que le portail ne fait pas encore

- **Il n'alerte personne** quand un site devient injoignable : il l'affiche, c'est tout. Un site mort ne prévient pas ; c'est au portail de le faire (e-mail ou WhatsApp au prestataire).
- Pas de mode « maintenance annoncée » : une intervention planifiée compte comme un arrêt.
- Pas de rapport mensuel PDF par client.
- Pas de mesure de la qualité de l'image des caméras ni de l'état des enregistreurs (disques, jours de vidéo conservés) : seulement « l'appareil répond-il ? ».

## Tests

`npm test` couvre l'historique des états, le résumé, la signature, la réception, les accès et le périmètre. Les tests de périmètre ont été vérifiés par mutation : en cassant volontairement le filtre par organisation, cinq d'entre eux échouent.

Contrôle d'accès (F28) : `test/portal/accesssummary.test.ts` (bloc absent sans porte, chiffres sur un jeu connu, disponibilité, incidents par type, porte retirée, validation hostile, périmètre et groupes, vieux résumés sans bloc), `test/portal-access-privacy.test.ts` (aucun marqueur nominatif nulle part ; vérifié par mutation : ajouter volontairement une adresse de contrôleur au bloc du PSIM fait échouer le test sur le résumé et sur le corps envoyé, et la conserver côté portail le fait échouer sur la base du portail) et `test/e2e-portal-access.test.ts` (vrai PSIM, vrai portail, vrais messages de passage).

Niveau groupe (`test/portal/groups-*.test.ts`) : migration d'une base ancienne (schéma exact d'avant, copié dans `test/portal/fixtures/`), périmètre (un compte limité à un groupe ne lit aucune donnée d'un autre groupe par aucune route, identifiants de groupe et de site devinés compris), agrégats avec sites muets et non mesurés, commandes d'administration (fonctions et processus réel), catégories énergie et personnes. Vérifié par mutation : retirer le filtre de groupe de `visibleSites` ou de `visibleGroups`, ignorer la limite dans `principalFor`, rendre « limité sans groupe » ouvert, laisser passer un groupe hors périmètre sur `/api/groups/:id`, compter un site non mesuré comme 100 % ou un site muet parmi les incidents confirmés : à chaque fois des tests échouent.
