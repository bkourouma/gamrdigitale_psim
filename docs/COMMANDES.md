# Canal de COMMANDE des équipements (actionneurs)

Jusqu'ici le PSIM **écoute** : il reçoit des états (MQTT, HTTP, Dahua, Tuya) et n'envoie jamais d'ordre à un équipement.
Ce document décrit le canal par lequel le PSIM **agit** : déclencher une sirène, allumer un projecteur, fermer un relais,
ouvrir une gâche ou une barrière, diffuser un message sur un haut-parleur.

Une faille ici n'est plus une fausse alarme : c'est une porte ouverte, une barrière levée sur un véhicule, une sirène
coupée pendant un feu. Chaque décision ci-dessous est prise **en se plaçant du côté de l'attaquant**.

Statut : conception validée (phase 1), cœur côté PSIM implémenté (phase 2), **revue de sécurité indépendante faite et
correctifs appliqués** (section 8), **pilote côté passerelle implémenté** (`gateway/src/actuators.ts`, usage dans
`docs/PASSERELLE.md` section 8, sections 5.1 à 5.3 ci-dessous), essai de bout en bout avec le processus PSIM complet et une
passerelle réelle (`test/e2e-pilote-passerelle.test.ts`).

---

## 1. Usages visés

| Type (`type`) | Exemples | Actions | Durée | Retour automatique à l'état sûr |
|---|---|---|---|---|
| `siren` | sirène intérieure / extérieure | `on`, `off` | `on` : 1 à 120 s par défaut (plafond 600 s) | `off` |
| `light` | flash, projecteur | `on`, `off` | `on` : 1 à 600 s par défaut (plafond 3 600 s) | `off` |
| `relay` | relais IP 4 à 8 sorties (une sortie = un actionneur) | `on`, `off`, `pulse` | `on` : 600 s (plafond 3 600 s) ; `pulse` : 1 à 10 s | `off` |
| `lock` | serrure, gâche électrique, ventouse | `unlock`, `lock` | `unlock` : impulsion 1 à 10 s (plafond 3 600 s) | `lock` (jamais pour une issue de secours) |
| `gate` | portail, barrière levante | `open`, `close`, `stop` | `open` / `close` : impulsion 1 à 10 s | aucun (voir 4.8) |
| `speaker` | haut-parleur IP, message préenregistré | `play`, `stop` | `play` : 1 à 60 s (plafond 300 s), `clip` obligatoire | `stop` |

**Prévus, hors périmètre de cette étape** : fumigène (`smoke`), tourelle PTZ, station d'accueil de drone (dock). Le
modèle les accueillera (nouveau `type`, nouvelles actions), mais **aucun n'est accepté aujourd'hui** : le type est refusé à
la création. Le fumigène exigera au minimum : raison, ré-authentification, deux personnes (« quatre yeux »), et jamais de
déclenchement automatique.

Chaque actionneur est configuré par un administrateur : identifiant, nom, type, zone, étage, transport (MQTT ou HTTP),
**actions autorisées** (sous-ensemble du tableau, avec durée maximale ≤ plafond du type et rôles autorisés), état sûr,
niveau de confirmation, issue de secours, délai d'accusé, actif / inactif.

---

## 2. Modèle de menaces

Pour chaque menace : ce que l'attaquant veut, ce qui l'en empêche, ce qui reste.

| # | Menace | Parade | Reste |
|---|---|---|---|
| M1 | **Broker MQTT compromis** (ou réseau du broker écouté) : forger un ordre « ouvrir », rejouer un ordre capturé | Chaque ordre est **signé** HMAC-SHA256 avec une **clé propre à l'actionneur**, que le broker ne connaît pas. Ordre daté (`ts`) et à durée de vie courte (`ttlS` ≤ 30 s) ; identifiant unique `cmdId` de 128 bits, mémorisé par le récepteur (anti-rejeu). | Un broker compromis peut **supprimer** des ordres (déni de service) : il ne peut pas en fabriquer. L'absence d'accusé est alors affichée « échec ». |
| M2 | **Passerelle compromise** | Son compte MQTT ne peut s'abonner **qu'aux** ordres de **ses** actionneurs (identifiants listés, jamais `*`) et ne publier que **leurs** accusés. Les clés des autres actionneurs ne sont pas sur elle. | Elle peut actionner **ses** actionneurs (elle détient leurs clés) et mentir sur leurs accusés. Limiter le périmètre de chaque passerelle est une décision d'installation. |
| M3 | **Compte opérateur volé** | Rôles par action ; `confirm:true` ; raison obligatoire pour `lock` / `gate` / actionneur déclaré « sensible » ; **mot de passe redemandé** pour toute action non sûre de ceux-ci (l'action sûre, dont le `stop` du portail, reste immédiate : sans raison ni mot de passe) ; 4 commandes / minute / utilisateur / actionneur ; tout est journalisé (journal infalsifiable). | Le voleur qui a aussi le mot de passe peut ouvrir ce que le rôle permet. Le code 2FA n'est pas redemandé (voir 7). |
| M4 | **Rejeu** d'une commande (réseau, broker, sauvegarde de trames) | `cmdId` aléatoire + `ts` + `ttlS` signés ; le récepteur refuse un ordre hors fenêtre et un `cmdId` déjà vu. Côté PSIM, un accusé n'est accepté que pour un `cmdId` **en attente** de CET actionneur, signé, et daté de façon plausible. | — |
| M5 | **Commande forgée en interne** (bogue d'un autre module, ligne insérée en base) | Un seul chemin d'envoi : le service des commandes, qui journalise **avant** d'envoyer. Les lignes de `actuator_command` ne sont **jamais** relues pour être envoyées (pas de file persistante, pas de rejeu au démarrage). La clé n'est déchiffrée qu'au moment de signer. | Un attaquant qui exécute du code dans le processus du PSIM a la clé de chiffrement : hors modèle. |
| M6 | **Déni de service par rafale** (opérateur, script, double-clic tenu) | 4 commandes / minute / utilisateur / actionneur (en base, survit au redémarrage) ; dédoublonnage des commandes identiques en vol ; messages bornés (1 Ko) ; accusés invalides comptés et journalisés une fois par minute au plus. | Le broker reste exposé aux rafales d'un client authentifié (limite générale de connexions de `mqtt.ts`). |
| M7 | **Commande « fantôme » après perte de liaison** (ordre mis en file pendant la coupure puis exécuté des minutes plus tard) | Aucun ordre n'est mis en file : abonnements aux ordres forcés en **QoS 0** par le broker (pas de file hors ligne), jamais `retain` ; TTL ≤ 30 s vérifié par le récepteur ; commande **refusée** si aucune passerelle autorisée n'écoute l'actionneur ; HTTP : un seul essai, jamais rejoué pour une commande manuelle (seul le **retour automatique** à l'état sûr est réessayé : toutes les 5 s, 5 envois au plus, puis avertissement visible `returnUnconfirmed`). | — |
| M8 | **Double-clic / double envoi** | Commande identique (même actionneur, action, paramètres) déjà en vol : la requête du **même compte** renvoie la commande existante (`deduplicated:true`), rien n'est réémis ; pour un **autre compte**, 409 sans rien révéler (raison, auteur). Le dédoublonnage vient APRÈS la ré-authentification. | — |
| M9 | **Opérateur sans droit** | Rôles par action, vérifiés côté serveur ; configuration réservée à l'administrateur ; session restreinte refusée. | — |
| M10 | **État incohérent après redémarrage** | Au démarrage, toute commande `pending` / `sent` passe `expired` (journalisée), **aucune n'est réémise**. Seuls les **retours à l'état sûr** prévus et non faits sont replanifiés (envoyer `off` à une sirène est toujours sûr). | Le PSIM ne connaît pas l'état physique réel tant qu'aucun état n'est remonté (hors périmètre). |
| M11 | **CSRF** (page piégée qui fait cliquer l'opérateur) | Contrôle d'origine (`Sec-Fetch-Site`, `Origin`) commun à toutes les routes mutantes ; cookie `SameSite=Strict` ; le corps JSON `confirm:true` impose `Content-Type: application/json`, qu'un formulaire inter-sites ne peut pas envoyer sans prévol CORS. | — |
| M12 | **SSRF par le transport HTTP** (un admin malveillant ou trompé fait viser le PSIM vers une adresse interne) | Hôte vérifié **à la connexion** (après résolution DNS) : adresses de métadonnées cloud, lien local, boucle locale, multidiffusion et non spécifiées toujours refusées ; par défaut seuls les réseaux privés (RFC 1918, IPv6 ULA) sont acceptés ; liste d'hôtes autorisés configurable ; redirections jamais suivies ; délai court ; réponse jamais journalisée. | Un admin peut viser n'importe quel équipement du réseau privé : c'est le cas d'usage. |
| M13 | **Issue de secours verrouillée** | Un `lock` marqué `emergencyExit` ne reçoit **jamais** l'ordre `lock` : l'action est refusée à la configuration et à l'exécution, et n'est jamais l'état sûr. | — |
| M14 | **Ordre exécuté sans le savoir** (accusé perdu) | Jamais « fait » par supposition : sans accusé avant `ackTimeoutS`, la commande est `failed` (« exécution incertaine »), avertissement visible et journalisé. Un accusé arrivé trop tard est **journalisé et affiché** (« accusé tardif : fait »), sans réécrire l'histoire. | — |
| M15 | **Fuite de secret** | Clé de l'actionneur chiffrée en base (AES-256-GCM, `server/secrets.ts`), affichée **une seule fois** (création, renouvellement) ; secret HTTP chiffré, jamais renvoyé ; ni clé, ni signature, ni secret dans le journal. | — |

---

## 3. Décisions de conception (chiffrées)

| Sujet | Décision |
|---|---|
| Identifiant d'actionneur | `[A-Za-z0-9_-]{1,32}` (même alphabet que les détecteurs : sûr dans un topic MQTT, une URL, un journal) |
| `cmdId` | 128 bits aléatoires (`crypto.randomBytes(16)`), 32 hexadécimaux minuscules |
| Clé de signature | 256 bits aléatoires par actionneur, 64 hexadécimaux ; HMAC-SHA256 ; chiffrée en base ; montrée une fois |
| `ttlS` | 10 s par défaut, borné 2 à 30 s |
| Tolérance d'horloge | 5 s (un ordre daté de plus de 5 s dans le futur est refusé) |
| Délai d'accusé `ackTimeoutS` | 5 s par défaut, borné 1 à 30 s ; HTTP : c'est aussi le délai de la requête |
| Limite | 4 commandes / minute / utilisateur / actionneur (hors retours automatiques) ; l'action sûre (`off`, `lock`, `stop` du haut-parleur, `stop` du portail) a sa propre limite de 12 / minute pour ne jamais empêcher d'arrêter une sirène ou un portail |
| Taille | message ≤ 1 024 octets (même borne que les détecteurs) ; raison ≤ 200 caractères |
| Durées | toute action temporisée exige `durationS` entier dans [min, max] ; max ≤ plafond du type ; **sans durée = refus**, sauf action déclarée `unbounded:true` par un administrateur (possible seulement pour `siren.on`, `light.on`, `relay.on`, `lock.unlock`), journalisé |
| Retour à l'état sûr | planifié côté PSIM à `envoi + durationS + 1 s` (même sans accusé : l'équipement a pu exécuter), ET porté par le message (`durationS`) pour que l'équipement s'arrête seul si la liaison tombe |
| Confirmation | `confirm:true` toujours exigé ; `lock` / `gate` / actionneur « sensible » : raison obligatoire et mot de passe redemandé (sauf pour leur action sûre — `lock` pour une serrure, `stop` pour un portail — qui doit rester immédiate) ; un admin peut exiger le mot de passe pour tout actionneur (`confirm:"reauth"`), jamais l'abaisser pour ceux-ci |
| Ré-authentification | mot de passe du compte dans la requête (`password` pour une commande, `reauth` pour la gestion des comptes et la configuration des actionneurs, voir `server/reauth.ts`), vérifié avec `auth.ts` (`checkCredentials`). Le compteur d'échecs est **celui de la connexion** (5 par minute au total, pas 5 + 5) ; au 5e échec, les sessions du compte sont fermées ; échecs journalisés. Le code 2FA n'est pas redemandé (voir 7) |
| Verrou global | « mode maintenance / sans commandes » (admin) : refuse toute commande SAUF l'**action sûre demandée à la main** (arrêter une sirène, reverrouiller une serrure, arrêter un portail) et l'arrêt anticipé d'une commande en cours (faire cesser une action ne doit jamais être impossible, même « sans limite ») ; les retours automatiques sont annulés et journalisés à l'activation ; les équipements s'arrêtent seuls grâce à `durationS` |
| Liaison | MQTT : commande refusée si aucun compte de passerelle autorisé pour l'actionneur n'est **abonné** à son topic d'ordres ; HTTP : pas d'état de liaison (la requête répond ou non) |
| Incident | une commande peut citer un incident (`incidentId`) ; refusée si l'incident est clos ; à la clôture, les commandes en attente sont annulées et les commandes temporisées en cours ramenées à l'état sûr |
| Désactivation | actionneur désactivé : plus aucune commande ; commandes en attente annulées ; retours à l'état sûr en cours envoyés quand même (ils sont sûrs) |
| Suppression | refusée tant qu'une commande est en vol ; l'historique (`actuator_command`) est conservé |
| Annulation | `pending` → `cancelled` (jamais envoyée) ; `sent` / `acked` avec durée en cours → **arrêt anticipé** : l'action sûre part tout de suite, le retour planifié est retiré, l'état de la commande d'origine n'est pas réécrit |
| HTTP | un seul essai, jamais rejoué ; redirections refusées ; accusé = code 2xx ; délai dépassé = `failed` « exécution incertaine » ; corps de réponse lu au plus 4 Ko et jamais journalisé |
| SSRF | refus permanent : `169.254.0.0/16`, `fe80::/10`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`, `0.0.0.0/8`, `127.0.0.0/8`, `::1`, multidiffusion, diffusion ; acceptés par défaut : `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` ; `PSIM_ACTUATOR_HTTP_HOSTS` (liste d'hôtes ou d'adresses) remplace ce défaut — la boucle locale n'est possible que nommée explicitement (essais) ; la vérification porte sur l'adresse **résolue** (pas de contournement par DNS) ; les adresses IPv6 qui embarquent une IPv4 (IPv4 inscrite, y compris en hexadécimal, IPv4-compatible, NAT64 `64:ff9b::/96`) sont ramenées à l'IPv4 avant la décision ; un **nom** autorisé ne rend pas acceptable n'importe quelle adresse résolue : elle doit rester privée, sauf si l'entrée de la liste est elle-même cette adresse |
| Compte de passerelle | `PSIM_MQTT_GATEWAYS=[{"user":"gw1","password":"...","detectors":["D-*"],"actuators":["SIR-01","R-*"]}]` ; un compte réservé aux actionneurs peut omettre `detectors` |
| MQTT, droits | compte principal : ni abonnement ni publication sur `psim/actuators/...` ; compte de passerelle : abonnement exact à `psim/actuators/<id>/command` pour SES ids (liste `actuators` de `PSIM_MQTT_GATEWAYS`, préfixes `X-*` admis, `*` seul refusé), publication de `psim/actuators/<id>/ack` pour ces mêmes ids, rien d'autre ; filtres `+` / `#` refusés ; abonnements forcés en QoS 0 ; `retain` toujours retiré ; seul le PSIM (publication interne) publie des ordres |

---

## 4. Modèle de données

### 4.1 `actuator`

`id`, `name`, `type`, `zone`, `floor_id`, `transport` (`mqtt` | `http`), `transport_config` (JSON non secret : requêtes
HTTP), `transport_secret` (en-tête secret HTTP, **chiffré**), `actions` (JSON : `{ "<action>": { "maxS", "minS", "roles",
"unbounded" } }`), `safe_action`, `confirm` (`simple` | `reauth`), `emergency_exit`, `ack_timeout_s`, `ttl_s`, `key_sealed`
(clé HMAC **chiffrée**), `key_version`, `sensitive` (0/1 : actionneur déclaré sensible), `active`, dates et auteurs.

### 4.2 `actuator_command`

`id` (= `cmdId`), `actuator_id` (sans clé étrangère : l'historique survit à la suppression), `action`, `params` (JSON
canonique), `duration_s`, `requested_by`, `reason`, `incident_id`, `auto` (retour automatique), `parent_id`, `state`
(`pending` | `sent` | `acked` | `refused` | `failed` | `expired` | `cancelled`), `requested_at`, `sent_at`, `acked_at`,
`finished_at`, `ts`, `ttl_s`, `ack` (résultat ou motif), `ack_kind` (`signed` | `http`), `late_ack`, `late_ack_at`,
`off_due_at`, `off_cmd_id`, `cancelled_by`, `cancelled_at`.

### 4.3 `actuator_lock`

Une ligne : verrou global (mode maintenance), auteur, date, raison.

Migrations : `CREATE TABLE IF NOT EXISTS` ; une base ancienne rouverte gagne les trois tables. Seule exception : la colonne
`sensitive` de `actuator`, ajoutée par un `ALTER TABLE` protégé (vérification de `table_info`) pour une base de développement
qui aurait déjà la table.

### 4.4 États d'une commande

```
            journalisee (commande_demandee)
 requete ──► pending ──envoi──► sent ──accuse signe "done"──► acked
                │                 │  ──accuse "refused"/"error"──► refused / failed
                │                 │  ──pas d'accuse avant ackTimeoutS──► failed (execution incertaine)
                │                 └─ redemarrage du PSIM ──► expired
                └─ annulation / incident clos / actionneur desactive / redemarrage ──► cancelled / expired
```

### 4.5 à 4.8 Règles par type

- **4.5 sirène, projecteur, relais** : `on` temporisé ; `off` = état sûr, toujours permis à `operator` + `admin` (rôles imposés à la configuration).
- **4.6 serrure / gâche** : `unlock` est une impulsion (1 à 10 s par défaut) ; l'état sûr est `lock` ; issue de secours :
  `lock` interdit, pas de retour automatique (la gâche se referme seule à la fin de `durationS`, côté équipement).
- **4.7 haut-parleur** : `play` exige `clip` (identifiant de message préenregistré sur l'équipement, jamais un texte libre ni
  une URL) ; `stop` = état sûr.
- **4.8 portail / barrière** : **aucun retour automatique** : fermer automatiquement une barrière sur un véhicule ou une
  personne est plus dangereux que la laisser ouverte ; les cellules de sécurité de l'automatisme gèrent la fermeture. `stop` est l'**action sûre immédiate** du portail : ni raison ni
  mot de passe, limite de 12 / minute à part, permise à `operator` + `admin`, y compris sous verrou global.

---

## 5. Spécification du message (à implémenter par le pilote côté passerelle)

### 5.1 Ordre : PSIM → équipement

Topic MQTT : `psim/actuators/<id>/command` (QoS 0, jamais `retain`). Corps : JSON UTF-8, ≤ 1 024 octets.

```json
{"v":1,"cmdId":"0123456789abcdef0123456789abcdef","action":"on","params":{"durationS":30},"ts":1760000000000,"ttlS":10,"sig":"6093f1a2a2059ef774346df9dde1becae2176df72ffcdee8e4778d504845c7f5"}
```

| Champ | Format |
|---|---|
| `v` | `1` exactement (toute autre valeur : refus) |
| `cmdId` | `^[0-9a-f]{32}$` |
| `action` | `^[a-z_]{1,16}$` |
| `params` | objet ; clés possibles : `durationS` (entier 1 à 86 400), `clip` (`^[A-Za-z0-9_-]{1,32}$`) ; toute autre clé : refus |
| `ts` | heure d'émission, millisecondes depuis 1970 (entier) |
| `ttlS` | entier 2 à 30 |
| `sig` | `^[0-9a-f]{64}$` = HMAC-SHA256(clé, chaîne canonique), en hexadécimal minuscule |

**Chaîne canonique** (UTF-8, champs séparés par `|`, aucun espace, champ absent = vide) :

```
psim-cmd-v1|<id>|<cmdId>|<action>|<durationS>|<clip>|<ts>|<ttlS>
```

`<id>` est l'identifiant **du topic auquel le récepteur s'est abonné** (jamais une valeur lue dans le message). Tous les
champs ont un alphabet sans `|` : la chaîne est sans ambiguïté. **Clé** : les 32 octets obtenus en décodant les 64
hexadécimaux affichés à la création de l'actionneur.

**Règles du récepteur (normatives, dans cet ordre)** :

1. Taille ≤ 1 024 octets, JSON objet, chaque champ au format ci-dessus ; sinon ignorer (pas d'accusé).
2. Recalculer la signature ; comparaison **en temps constant** ; fausse : ignorer **sans accuser** (pas d'oracle), compter.
3. Fraîcheur : accepter seulement si `ts - 5000 ≤ maintenant ≤ ts + ttlS × 1000`. Sinon : accusé `refused`, code `stale`.
4. Anti-rejeu : `cmdId` déjà vu dans les 120 dernières secondes : ne rien exécuter (réémettre le même accusé est permis).
5. Action absente de la liste locale de l'équipement, ou `durationS` au-delà du plafond local : accusé `refused`, code
   `not_allowed`. Le pilote garde **ses propres plafonds** (défense en profondeur : un PSIM compromis ne doit pas pouvoir
   tenir une gâche ouverte une heure).
6. Exécuter. Si `durationS` est présent : revenir **localement** à l'état de repos au bout de `durationS`, **quoi qu'il
   arrive** (liaison perdue, PSIM arrêté). Sans `durationS` (action `unbounded` configurée par l'admin) : tenir jusqu'à
   l'ordre contraire. Un nouvel ordre sur le même actionneur **remplace** la temporisation en cours (le PSIM fait de
   même : le retour automatique prévu pour l'ordre précédent est retiré).
7. Accuser dans le délai (`ackTimeoutS`, 5 s par défaut) ; ne jamais réessayer un ordre qui a échoué.

### 5.2 Accusé : équipement → PSIM

Topic : `psim/actuators/<id>/ack` (QoS 0 ou 1, jamais `retain`).

```json
{"v":1,"cmdId":"0123456789abcdef0123456789abcdef","result":"done","ts":1760000000850,"sig":"255db3b9fa4c4c174c08f66202c5d6e31ff30d5bb17aafb51e928a807f59b3d4"}
```

`result` : `done` | `refused` | `error` ; `code` facultatif (`^[a-z0-9_]{1,32}$`, ex. `stale`, `not_allowed`, `io`).

```
psim-ack-v1|<id>|<cmdId>|<result>|<code>|<ts>
```

Le préfixe différent (`psim-ack-v1` / `psim-cmd-v1`) empêche de renvoyer un ordre comme accusé (et l'inverse).

Le PSIM accepte un accusé seulement si : topic autorisé pour ce compte ; JSON et formats valides ; signature valide
avec la clé de **cet** actionneur ; `cmdId` d'une commande de **cet** actionneur à l'état `sent` ; `ts` entre
`ts de l'ordre - 5 s` et `maintenant + 5 s`. Accusé valide pour une commande déjà `failed` / `expired` : **accusé
tardif**, journalisé et affiché, état inchangé. Tout le reste est ignoré (signatures fausses comptées, journalisées une
fois par minute au plus).

### 5.3 Vecteurs de test

Clé : `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`

| Chaîne canonique | `sig` |
|---|---|
| `psim-cmd-v1\|SIR-01\|0123456789abcdef0123456789abcdef\|on\|30\|\|1760000000000\|10` | `6093f1a2a2059ef774346df9dde1becae2176df72ffcdee8e4778d504845c7f5` |
| `psim-ack-v1\|SIR-01\|0123456789abcdef0123456789abcdef\|done\|\|1760000000850` | `255db3b9fa4c4c174c08f66202c5d6e31ff30d5bb17aafb51e928a807f59b3d4` |
| `psim-cmd-v1\|GACHE-1\|fedcba9876543210fedcba9876543210\|unlock\|5\|\|1760000000000\|10` | `600b7c96c85b2c774d2e382e8a7dc9ab38bb1ff785322eb330dd2824fcf83f8f` |

(Dans le tableau, `\|` est l'échappement Markdown de `|`.) Ces vecteurs sont vérifiés par `test/actuators.test.ts`.

### 5.4 Transport HTTP (relais IP sans pilote)

Pour un relais IP qui ne parle que HTTP, le PSIM appelle directement l'équipement. Configuration par action :
`{ "method": "GET|POST|PUT", "url": "http://192.168.1.50/relay/0?turn=on&timer={durationS}", "body": "..." }`, mêmes
hôte et port pour toutes les actions. Variables remplacées (valeurs encodées pour l'URL) : `{action}`, `{durationS}`,
`{clip}`, `{cmdId}`, `{ts}`, `{sig}` (signature de la section 5.1, pour un équipement capable de la vérifier). Un en-tête
secret facultatif (`Authorization: Basic ...`, jeton) est chiffré en base. Accusé = code 2xx ; un code 2xx ne prouve que
la réception par le relais (`ack_kind = http`), ce qui est affiché comme tel. Une action temporisée qui n'est pas `unbounded` **doit**
contenir `{durationS}` (URL ou corps) : sinon le relais ne s'éteindrait pas seul, et la configuration est refusée. Le transport HTTP est
**interdit** pour une serrure, un portail et tout actionneur sensible (requête en clair, rejouable) : ils passent par le canal MQTT signé
et une passerelle.

---

## 6. Contrat d'API

Toutes les routes : session obligatoire ; routes mutantes soumises au contrôle d'origine (anti-CSRF) commun.

| Méthode et route | Rôle | Effet |
|---|---|---|
| `GET /api/actuators` | opérateur, admin | Liste (sans clé ni secret), verrou global, actions permises pour l'utilisateur, liaison |
| `POST /api/actuators` | admin | Crée ; renvoie `{ actuator, key }` (clé montrée une seule fois) |
| `PATCH /api/actuators/:id` | admin | Modifie (le type et l'identifiant ne changent pas) ; désactiver annule les commandes en attente |
| `DELETE /api/actuators/:id` | admin | Supprime (refus si une commande est en vol) ; l'historique reste |
| `POST /api/actuators/:id/key` | admin | Nouvelle clé (renvoyée une fois) ; l'ancienne cesse aussitôt |
| `PUT /api/actuator-lock` | admin | `{ locked, reason }` : mode maintenance (aucune commande) |
| `POST /api/actuators/:id/commands` | selon l'action | `{ action, params, reason, confirm:true, incidentId?, password? }` → `201 { command }`, ou `200 { command, deduplicated:true }` |
| `GET /api/actuators/:id/commands` | opérateur, admin | Historique (100 dernières) |
| `POST /api/actuators/commands/:cmdId/cancel` | rôle de l'action d'origine | Annulation / arrêt anticipé (voir 3) |

Les routes de configuration (comptes, actionneurs, clé, mode maintenance) exigent le champ `reauth` (mot de passe du compte
connecté). Pour un non-administrateur, les URL HTTP des relais sont renvoyées sans identifiants ni chaîne de requête. La vue d'une
commande porte `returnUnconfirmed` (vrai si le retour automatique à l'état sûr n'a pas été confirmé après ses 5 envois).

Codes : `400` (paramètres, y compris une action `lock` absente de la configuration d'une issue de secours), `403` (rôle, issue de secours, mot de passe faux), `404`, `409` (verrou global, actionneur
inactif, liaison coupée, incident clos, commande non annulable), `428` (sans `confirm:true`, raison ou mot de passe
manquants), `429` (limite).

Journal (scellé, sans secret) : `commande_demandee` (**avant** l'envoi), `commande_envoyee`, `commande_accusee`,
`commande_refusee`, `commande_echec`, `commande_expiree`, `commande_annulee`, `commande_accuse_tardif`,
`commande_accuse_invalide`, `commande_reauth_echec`, `actionneur_cree`, `actionneur_modifie`, `actionneur_supprime`,
`actionneur_cle_renouvelee`, `commandes_verrouillees`, `commandes_deverrouillees`.

---

## 7. Hors périmètre et menaces non couvertes (pour la revue de sécurité)

- **Pilote côté passerelle** : implémenté (voir section 8) ; reste à qualifier sur matériel réel avec un module d'accès.
- **Fumigène, PTZ, dock** : seulement prévus.
- **État physique réel** : le PSIM sait ce qu'il a ordonné et ce qui a été accusé, pas la position réelle d'une porte
  (contact de position à remonter comme un détecteur d'accès).
- **2FA non redemandée** à la ré-authentification (mot de passe seul) ; pas de règle « quatre yeux ».
- **Équipement qui détient la clé** : peut forger des accusés pour lui-même. Pas de clé asymétrique (l'équipement ne
  peut pas prouver qu'il a agi, seulement qu'il détient la clé).
- **Horloge** : la fraîcheur suppose des horloges synchronisées à quelques secondes (NTP sur la passerelle).
- **HTTP en clair sur le réseau local** (relais non sensibles seulement ; serrures et portails ne passent plus par HTTP) :
  l'en-tête secret circule en clair si le relais ne parle pas HTTPS ; réseau dédié recommandé. HTTPS vers une adresse IP exige
  un certificat valable pour cette adresse.
- **Notification** des commandes sensibles (porte ouverte) : journalisées et visibles en direct, pas envoyées par e-mail.
- **Processus du PSIM compromis** : hors modèle (il détient la clé de chiffrement des secrets).

---

## 8. Pilote côté passerelle et revue de sécurité

### 8.1 Pilote implémenté

`gateway/src/actuators.ts` applique la section 5.1 : formats, signature HMAC en temps constant sans accusé en cas d'échec,
anti-rejeu (120 s, mémoire sur disque qui survit à un redémarrage), fraîcheur, plafonds locaux (`maxS`, action absente de la liste,
durée obligatoire ou interdite), refus de `lock` sur une issue de secours, exécution par le module (`ModuleContext.onActuator`),
**retour local au repos** à la fin de `durationS` quoi qu'il arrive (liaison perdue, PSIM arrêté ; réessais toutes les 5 s, 20 au
plus ; repris après un redémarrage de la passerelle), accusé signé non bloquant. Écarts voulus par rapport à l'ordre de 5.1 :
(a) le rejeu (règle 4) est vérifié **avant** la fraîcheur, pour qu'un ordre déjà exécuté puis périmé ne reçoive pas un accusé
`stale` qui contredirait le premier accusé ; (b) règle ajoutée : un ordre dont le `ts` est antérieur au dernier ordre accepté est
refusé (`out_of_order`) ; (c) la passerelle garde en mémoire aussi les ordres signés et frais qu'elle refuse. Configuration, démarrage
et dépannage : `docs/PASSERELLE.md` section 8. Essais : `gateway/test/actuators.test.ts` (unitaires et contre le vrai broker),
`test/e2e-pilote-passerelle.test.ts` (processus PSIM complet + passerelle réelle + module factice).

### 8.2 Correctifs de la revue de sécurité

Faits (garde-fous durables dans `test/garde-commandes.test.ts`, `test/garde-mqtt-commandes.test.ts`,
`test/garde-e2e-commandes.test.ts` ; chacun échoue si le défaut revient) : **M3** (abonnement joker mémorisé dans une session
persistante : `authorizeForward` + seuls les abonnements accordés sont mémorisés), **M1** (abonnements aux ordres bornés à 200 par
connexion), **A6** (ré-authentification, `server/reauth.ts`), **H2** (HTTP interdit pour serrure, portail, sensible), **S1** (`stop`
du portail immédiat), **S2** (verrou global et action sûre manuelle), **S3** (`{durationS}` obligatoire, retour réessayé,
avertissement), **S4** (retour échu gardé jusqu'au retour de la liaison), **S5** (rôles de l'action sûre imposés), **S6** (issue de
secours revérifiée à l'envoi et au retour automatique), **A1** (clés héritées de `Object.prototype`), **A2** (dédoublonnage après
la ré-authentification, jamais pour un autre compte), **A3** (compteur de ré-authentification partagé avec la connexion, sessions
fermées au 5e échec), **A4** (URL des relais masquées aux non-admins), **A5** (drapeau « sensible »), **H1** (SSRF : IPv6 ramenées
à l'IPv4, nom autorisé limité aux adresses privées), `catch` sur l'envoi HTTP.

**Restants** : **AAD** sur la clé chiffrée (lier le chiffrement à l'identifiant de l'actionneur, `server/secrets.ts` partagé) ;
**M2** (le SUBACK annonce la QoS demandée alors que l'abonnement est ramené à 0 : sans effet, documenté dans `server/mqtt.ts`).
Pas de reprise automatique d'une serrure après un « retour au repos ABANDONNE » du pilote (20 échecs) : le journal le dit, un humain
vérifie sur place.
