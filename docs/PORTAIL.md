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

Ouvrir http://127.0.0.1:4301. Comptes `prestataire`, `diallo` (direction, 4 sites), `kaloum` (un seul site), `autre` (autre client) ; le mot de passe est affiché dans le terminal. La démo recrée une base vierge (`portal-demo-data/`) avec cinq sites dans des états différents (alarme, injoignable, équipement hors service, tout va bien).

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
| `director` | tous les sites de son organisation |
| `site_manager` | un seul site |

Un compte reçoit un **mot de passe provisoire**, affiché une seule fois ; il ne voit rien tant qu'il ne l'a pas changé. Un site hors du périmètre d'un compte est « introuvable » (404), jamais « interdit » : on ne révèle pas qu'il existe.

## Brancher le PSIM d'un site

`add-site` affiche trois lignes à copier dans le `.env.production` **de ce site**, puis redémarrer son PSIM :

```
PSIM_PORTAL_URL=https://suivi.exemple.com/api/ingest
PSIM_PORTAL_SITE_ID=entrepot-kaloum
PSIM_PORTAL_KEY=<clé propre à ce site>
```

`npm run check-config:prod` contrôle la configuration. L'état de l'envoi figure dans l'écran système du PSIM (`/api/system`, champ `portal`) ; trois échecs de suite déclenchent un avertissement. La clé d'un site n'est pas stockée : elle se dérive de la clé maîtresse. `rotate-site-key <site>` en produit une nouvelle (l'ancienne cesse de marcher) ; `site-env <site>` réaffiche les lignes.

## Ce qui part du site, ce qui n'en part jamais

Part : équipements (nom, zone, étage, état), disponibilité et périodes d'arrêt, incidents (heures, gravité, qualification), nombre de notifications, **indice de sécurité GAMR** (celui du site, celui de chaque zone, et un point par jour pour la tendance).

Ne part **jamais** : adresses ou identifiants des caméras, images, comptes et noms d'opérateurs, commentaires d'incident, journal, destinataires de notification, notes d'évaluation des risques et nom de l'évaluateur. C'est vérifié par des tests.

## Comment lire les chiffres

- **Disponibilité** = temps où les équipements suivis (détecteurs et caméras réelles) étaient en service ÷ temps observé. Une alarme est un détecteur qui *fonctionne* : elle ne compte pas comme une panne.
- **Temps non surveillé** : quand le PSIM d'un site était arrêté, on ne sait pas ce qui s'est passé. Ce temps n'est compté ni disponible ni indisponible ; il est montré à part (« Surveillance interrompue »).
- **Caméras** : le PSIM teste chaque minute (`PSIM_CAMERA_CHECK_S`) la connexion réseau de chaque caméra réelle, sans identifiants ni image. « Hors ligne » après 3 échecs de suite (daté du premier), « en service » au premier succès. Cela prouve que **l'appareil répond**, pas que l'image est bonne ; derrière un enregistreur, toutes les voies partagent son adresse et tombent ensemble. Une caméra simulée, ou pas encore testée, reste « Non mesuré », sans pourcentage. Une caméra injoignable apparaît dans le journal du PSIM (« Caméra injoignable ») et dans son écran Système ; elle n'ouvre pas d'incident et ne prévient personne.
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
