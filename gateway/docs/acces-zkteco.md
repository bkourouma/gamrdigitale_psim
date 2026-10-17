# Module acces-zkteco : raccorder un contrôle d'accès ZKTeco à la Passerelle GAMR

Le module `acces-zkteco` fait de la Passerelle GAMR le **serveur** du protocole « push » de ZKTeco (aussi appelé
iclock / ADMS) : les centrales de contrôle d'accès et les terminaux ZKTeco **appellent la passerelle** par HTTP,
lui envoient leurs passages et leurs états de porte en temps réel, et viennent y chercher les ordres éventuels
(ouverture à distance). La passerelle traduit chaque événement en message PSIM.

> **Important : aucun matériel ZKTeco réel n'a encore été essayé.** Le module est testé contre un appareil simulé
> (`gateway/test/fake-zkteco.ts`) construit d'après les sources publiques du protocole. Tout ce qui touche au
> format exact des trames est marqué « à qualifier » : faites la recette décrite en section 10 avant toute mise
> en service.

## 1. À quoi ça sert

**Équipements visés** :

- les **centrales de contrôle d'accès** ZKTeco **C3** et **inBio** (1 à 4 portes) : réglage `"kind": "controller"` ;
- les **terminaux** ZKTeco (pointeuses, lecteurs autonomes à une porte) : réglage `"kind": "terminal"`.

Aucun modèle précis n'est qualifié (voir section 10).

**Un détecteur PSIM de catégorie `access` par porte.** Chaque porte de l'appareil que l'on veut surveiller est
rattachée, dans la configuration, à un détecteur PSIM (son identifiant). Les passages, les ouvertures, les alarmes
et le signe de vie de cette porte arrivent sur ce détecteur.

**Ce que le module fait** :

- reçoit les passages (badge, code, empreinte, visage, bouton de sortie, ouverture à distance), acceptés **et** refusés ;
- suit l'état des portes (ouverte, refermée, forcée, maintenue ouverte) et le sabotage du boîtier ;
- signale la contrainte (alarme silencieuse `panic`), les refus répétés, l'horloge déréglée, l'appareil muet ou hors ligne ;
- rapporte le mode d'une porte (toujours ouverte, retour au mode normal) quand l'appareil le laisse entendre (section 7) ;
- récupère les passages manqués après une coupure du réseau (section 6) ;
- exécute, si on le déclare, les ordres d'ouverture à distance venus du canal de commande signé du PSIM ;
- écrit dans une **centrale**, seulement si la clé `syncKey` de l'appareil est renseignée, les titulaires, les horaires et
  les jours fériés que le PSIM lui envoie par le canal de synchronisation signé (section 9).

**Ce que le module ne fait pas** :

- **le contrôleur décide, pas le PSIM.** L'ouverture par badge se joue entièrement dans l'appareil : si la
  passerelle ou le PSIM est arrêté, les portes continuent de fonctionner. Le PSIM ne prend **jamais** part à
  l'ouverture par badge ;
- il n'écrit **rien** dans l'appareil de lui-même : sans `syncKey`, il ne crée, ne modifie ni ne supprime aucun badge,
  utilisateur, horaire ou jour férié ; avec `syncKey`, il n'écrit que sur un ordre signé du PSIM (section 9), et jamais de
  code PIN, d'empreinte, de visage ni de photo. Il **ne demande jamais** à l'appareil ses utilisateurs ni ses gabarits
  biométriques (ils restent dans l'appareil) ; un terminal de pointage ne reçoit aucun titulaire ;
- il n'ouvre jamais une porte de lui-même : seule une commande signée du PSIM, déclarée dans `actuators`, peut le faire ;
- il ne sait pas verrouiller une porte « en permanence » (voir section 6).

## 2. Prérequis réseau et sécurité

### La faiblesse, en termes simples

Le protocole « push » de ZKTeco circule **en clair** (HTTP, pas de chiffrement) et **sans mot de passe** : seul le
**numéro de série** de l'appareil l'identifie. Or ce numéro est imprimé sur l'étiquette, affiché par l'appareil et
facile à deviner. Quiconque peut envoyer des paquets vers la passerelle sur ce port, ou se placer entre l'appareil
et la passerelle, peut donc :

- **inventer de faux passages** (falsifier le journal des accès) ou de **fausses alarmes** (porte forcée, sabotage) ;
- **espionner** le trafic : numéros de badge et heures de passage sont lisibles ;
- **falsifier l'accusé d'une commande** (faire croire qu'une porte s'est ouverte ou refermée) ou, en répondant à
  la place de la passerelle, envoyer un faux ordre à l'appareil.

Le module ne peut pas supprimer cette faiblesse : elle est dans le protocole du constructeur. Il la **réduit** ;
le reste dépend de l'installation.

### Mesures obligatoires

1. **Réseau dédié** (VLAN ou câblage séparé) entre les appareils et la passerelle, sans aucun autre poste ni prestataire branché dessus.
2. **Pare-feu** : n'ouvrir le port du module que depuis les adresses des appareils.
3. **`allowFrom`** : toujours renseigner la liste des adresses (ou plages) autorisées. Une connexion venant d'ailleurs est fermée dès l'ouverture. Sans `allowFrom`, le module accepte toutes les adresses sources (il le dit au démarrage).
4. **Liste blanche de numéros de série** : seuls les appareils déclarés dans `controllers` sont servis. Tout numéro inconnu, tout chemin ou méthode non prévu reçoit la **même réponse neutre** (404) : un intrus n'apprend rien. Le numéro de série est comparé **exactement** (majuscules et minuscules comprises).
5. **Interface d'écoute explicite** : `listen.host` est obligatoire et n'a pas de valeur par défaut. `0.0.0.0` ou `::` sont refusés, sauf `"allowAnyInterface": true` (à éviter).
6. **Jamais exposé à Internet**, ni par redirection de port ni autrement. Pour un site distant, passer par un VPN.
7. À une échelle supérieure : VPN ou reverse proxy TLS devant le port (tous les modèles ne savent pas faire TLS).

Le module limite aussi de lui-même : connexions simultanées, taille des corps, débit par adresse, délais de lecture
courts. Ses journaux ne contiennent ni numéro de badge, ni nom, ni texte venu du réseau.

## 3. Configuration de la passerelle

Section `config` du module `acces-zkteco` dans la configuration de la passerelle (exemple complet : une centrale à 2 portes avec ouverture à distance, un
terminal à 1 porte) :

```json
{
  "stateDir": "data/acces-zkteco",
  "listen": {
    "host": "192.168.10.10",
    "port": 8088
  },
  "allowFrom": [
    "192.168.10.0/24"
  ],
  "controllers": [
    {
      "id": "C3-ENTREE",
      "serial": "CGXH123456789",
      "kind": "controller",
      "utcOffsetMin": 0,
      "epoch": 0,
      "syncKey": { "$file": "secrets/acces-zkteco-c3-entree-sync.key" },
      "doors": {
        "1": "porte-principale",
        "2": "porte-stock"
      },
      "actuators": {
        "serrure-principale": {
          "door": 1,
          "type": "lock",
          "pulseS": 5
        }
      }
    },
    {
      "id": "TERM-ATELIER",
      "serial": "AEYK987654321",
      "kind": "terminal",
      "utcOffsetMin": 0,
      "doors": {
        "1": "porte-atelier"
      }
    }
  ],
  "thresholds": {
    "deniedCount": 3,
    "deniedWindowS": 60,
    "heartbeatS": 60,
    "clockDriftMs": 120000,
    "silenceMs": 90000,
    "offlineGraceMs": 15000,
    "longUnlockS": 60,
    "deferredAfterS": 120,
    "commandTimeoutS": 30
  },
  "limits": {
    "maxBodyBytes": 262144,
    "perAddressPerMinute": 600,
    "maxConnections": 64,
    "maxConnectionsPerAddress": 8,
    "requestTimeoutS": 10
  },
  "push": {
    "delayS": 3,
    "errorDelayS": 30,
    "transFlag": "1000000000",
    "controlFormat": "hex"
  },
  "timezones": {
    "min": 2,
    "max": 50,
    "always": 1
  },
  "sync": {
    "userExtras": true,
    "fullCodes": []
  }
}
```

Toute clé inconnue ou toute valeur hors bornes est refusée au démarrage, avec **toutes** les erreurs listées d'un coup (la
clé de synchronisation n'apparaît jamais dans un message d'erreur). Les valeurs des sections `thresholds`, `limits`, `push`,
`timezones` et `sync` ci-dessus sont les valeurs par défaut : on peut les omettre, de même que `epoch` (0 par défaut) et
`syncKey` (facultative). Dans le bloc, la clé de synchronisation est donnée par `{"$file": ...}` : le socle la remplace par
le contenu du fichier avant que le module ne voie sa configuration (`{"$env": "NOM"}` est accepté de la même façon). Le
terminal de l'exemple (`TERM-ATELIER`) n'a ni `epoch` ni `syncKey`.

### Clés du module

| Clé | Défaut | Rôle |
|---|---|---|
| `stateDir` | `data/acces` (relatif à `gateway/`) | Dossier d'état du module : curseurs de récupération (section 6, `acces-curseurs.json`), numéros de fuseaux horaires attribués aux horaires du PSIM (`acces-plages.json`) et jours fériés écrits par le module (`acces-zkteco-feries.json`), section 9. Chemin absolu accepté. |
| `listen.host` | aucun, **obligatoire** | Adresse IP de l'interface d'écoute. |
| `listen.port` | aucun, **obligatoire** | Port d'écoute HTTP (1 à 65535). |
| `listen.allowAnyInterface` | `false` | Autorise `0.0.0.0` / `::`. À éviter (section 2). |
| `allowFrom` | absent (toutes adresses) | Liste de 1 à 256 adresses IPv4 ou plages (`192.168.10.0/24`, préfixe de 8 à 32). **À renseigner.** |
| `controllers` | aucun, **obligatoire** | 1 à 64 appareils (voir plus bas). |
| `thresholds.deniedCount` | 3 (1 à 100) | Nombre de refus qui déclenchent la pré-alarme « refus répétés ». |
| `thresholds.deniedWindowS` | 60 (1 à 3600) | Fenêtre de ces refus, en secondes, sur l'heure de l'appareil. |
| `thresholds.heartbeatS` | 60 (5 à 3600) | Période du signe de vie envoyé au PSIM, par porte. |
| `thresholds.clockDriftMs` | 120000 (1000 à 86 400 000) | Écart d'horloge appareil / passerelle au-delà duquel on signale une dérive. |
| `thresholds.silenceMs` | 90000 (5000 à 3 600 000) | Silence de l'appareil au-delà duquel il est traité comme coupé. Doit valoir au moins 3 fois `push.delayS` (en ms). |
| `thresholds.offlineGraceMs` | 15000 (0 à 300 000) | Délai de grâce avant de déclarer « hors ligne ». |
| `thresholds.longUnlockS` | 60 (1 à 3600) | Au-delà de cette durée demandée, `unlock` devient « ouverte en continu ». |
| `thresholds.deferredAfterS` | 120 (1 à 86 400) | Un passage plus ancien que cela est marqué « différé ». |
| `thresholds.commandTimeoutS` | 30 (2 à 300) | Temps accordé à une commande, de sa mise en file à la confirmation de l'appareil. |
| `limits.maxBodyBytes` | 262144 (1024 à 4 194 304) | Taille maximale d'un corps de requête. |
| `limits.perAddressPerMinute` | 600 (1 à 100 000) | Requêtes par minute et par adresse. |
| `limits.maxConnections` | 64 (1 à 1000) | Connexions simultanées au total. |
| `limits.maxConnectionsPerAddress` | 8 (1 à 1000) | Connexions simultanées par adresse. |
| `limits.requestTimeoutS` | 10 (0,2 à 60) | Délai de lecture d'une requête. |
| `push.delayS` | 3 (1 à 30) | Délai d'interrogation demandé à l'appareil (secondes). Plus il est court, plus l'ouverture à distance est rapide. |
| `push.errorDelayS` | 30 (5 à 600) | Délai de nouvelle tentative demandé à l'appareil après une erreur. |
| `push.transFlag` | `1000000000` | Ce que l'appareil doit envoyer. Par défaut le seul journal des passages : jamais utilisateurs, empreintes ni visages. À qualifier. |
| `push.controlFormat` | `hex` | Écriture de la commande d'ouverture : `hex` (`CONTROL DEVICE 01010105`) ou `spaced` (`CONTROL DEVICE 1 1 1 5`). À qualifier (section 4). |
| `timezones.min`, `timezones.max` | 2 et 50 (entiers de 1 à 254, `max` ≥ `min`) | Numéros de fuseaux horaires (`TimezoneId`) que le module peut attribuer aux horaires du PSIM (section 9). À restreindre si l'installateur a déjà des fuseaux à lui. Capacité de la centrale : **à qualifier**. |
| `timezones.always` | 1 (entier de 1 à 254) | Fuseau « toujours » (toute la semaine), **déjà présent** dans la centrale : utilisé pour un titulaire sans horaire. Doit être **hors** de l'intervalle `min` à `max` ; le module ne l'écrit ni ne le supprime jamais. À qualifier. |
| `sync.userExtras` | `true` | Envoyer aussi `Name` et `Privilege=0` avec l'utilisateur (champs de la famille inBio et des terminaux, absents de la table `user` du SDK C3). **Mettre `false`** si la centrale refuse l'utilisateur à cause de ces champs. |
| `sync.fullCodes` | `[]` (16 entiers négatifs au plus) | Codes `Return` de l'appareil qui veulent dire « capacité pleine ». Le code réel est inconnu : à relever sur matériel puis à déclarer ici ; tant qu'il n'est pas déclaré, une centrale pleine donne une simple erreur (`io`). |

### Clés de chaque appareil (`controllers[]`)

| Clé | Défaut | Rôle |
|---|---|---|
| `id` | **obligatoire** | Identifiant PSIM de l'appareil (lettres, chiffres, `_`, `-`, 32 caractères au plus). Unique. |
| `serial` | **obligatoire** | Numéro de série relevé sur l'étiquette (lettres et chiffres, 4 à 32 caractères). Unique. |
| `kind` | `controller` | `controller` (centrale C3 / inBio, 1 à 4 portes) ou `terminal` (une seule porte, la numéro 1). |
| `utcOffsetMin` | 0 (-720 à 840) | Écart de l'**heure locale de l'appareil** à l'heure universelle, en minutes (0 à Abidjan). Doit correspondre au réglage de l'appareil, sinon tous ses horaires sont décalés. |
| `epoch` | 0 (entier de 0 à 999 999 999 999) | Époque de l'appareil. **À augmenter de 1 quand la centrale ou le terminal est remplacé** (sa mémoire est vide, ses numéros d'enregistrement repartent de zéro) ; ne **jamais** la diminuer. Procédure complète en section 8. |
| `syncKey` | absent | Clé de synchronisation des titulaires de cet appareil : **64 caractères hexadécimaux minuscules** (0-9, a-f), donnée **une seule fois** par le PSIM à la création du contrôleur. Toujours par `{"$file": "secrets/..."}` (une ligne) ou `{"$env": "NOM"}`. **Facultative : sans elle, la synchronisation est inactive** (le journal le dit à chaque démarrage) et l'appareil est surveillé normalement. Un secret comme les autres (section 9). |
| `doors` | **obligatoire** | `{ "<n° de porte 1 à 4>": "<id du détecteur PSIM>" }`. Un détecteur ne sert qu'à une porte. |
| `actuators` | aucun | Ouverture à distance : `{ "<id actionneur>": { "door": 1, "type": "lock", "pulseS": 5 } }`. `type` : `lock` (serrure) ou `gate` (barrière, portail) ; `pulseS` : durée de l'impulsion, 1 à 254 s (5 par défaut). Sans `actuators`, surveillance seule. |

## 4. Programmation de l'appareil ZKTeco

Ce que les sources confirment : l'appareil est un **client** qui appelle `GET /iclock/cdata?SN=<numéro de série>`
(poignée de main), envoie ses données en `POST /iclock/cdata?SN=...&table=...`, vient chercher les ordres en
`GET /iclock/getrequest?SN=...` et annonce leur résultat en `POST /iclock/devicecmd?SN=...`. À la poignée de main, la
passerelle lui répond sa configuration d'envoi (temps réel activé, délai d'interrogation `push.delayS`, journal des
passages seulement).

Il faut donc programmer, dans le menu réseau de l'appareil (ou dans le logiciel de configuration du constructeur,
rubrique « serveur cloud », « ADMS » ou « communication push » selon le modèle) :

| Réglage appareil | Valeur |
|---|---|
| Adresse du serveur | adresse IP **fixe** de la passerelle (`listen.host`) |
| Port du serveur | `listen.port` |
| Numéro de série | à **relever sur l'étiquette** de l'appareil (ou dans son menu d'informations) et à recopier à l'identique dans `serial` |
| Adresse IP de l'appareil | **fixe**, comprise dans `allowFrom` |
| Heure | à l'heure locale, NTP si possible ; reporter l'écart dans `utcOffsetMin` |

À qualifier sur chaque modèle : le nom exact des menus, la présence d'une case « HTTPS » (la laisser **désactivée**,
le module parle en HTTP simple), la version minimale du micrologiciel, l'écriture exacte de la commande
d'ouverture (`push.controlFormat`), et les noms de champs réellement envoyés.

## 5. Correspondance événement ZKTeco vers message PSIM

Le numéro d'événement (`event`) du journal temps réel `rtlog` d'une centrale est traduit ainsi. Les **noms** des
événements sont issus des manuels du constructeur ; leurs **numéros** viennent du SDK C3 et n'ont pas pu être relus en
source libre : **toute la table est à qualifier** sur appareil réel.

| N° | Événement ZKTeco | Message PSIM | Statut |
|---|---|---|---|
| 0, 1, 2, 3 | Passage normal, plage d'ouverture permanente, première carte, multi-cartes | `badge_granted` | à qualifier |
| 4 | Ouverture par code d'urgence | `badge_granted`, méthode `code` | à qualifier |
| 8 | Ouverture à distance | `badge_granted`, méthode `remote` | à qualifier |
| 14 à 19 | Ouvertures par empreinte, carte et empreinte | `badge_granted`, `fingerprint` ou `badge` | à qualifier |
| 202 | Bouton de sortie | `badge_granted`, méthode `exit_button` | à qualifier |
| 203 | Multi-cartes carte et empreinte | `badge_granted` | à qualifier |
| 208 | Super utilisateur | `badge_granted` | à qualifier |
| 20, 23, 25, 31 | Intervalle trop court, accès refusé, verrouillage mutuel | `badge_denied`, motif `other` | à qualifier |
| 21, 22, 35, 36 | Porte inactive à cette heure, plage horaire illégale | `badge_denied`, motif `out_of_schedule` | à qualifier |
| 24 | Anti-retour | `badge_denied`, motif `antipassback` | à qualifier |
| 27, 34 | Carte inconnue, empreinte inconnue | `badge_denied`, motif `unknown_credential` | à qualifier |
| 29, 33 | Carte expirée, empreinte expirée | `badge_denied`, motif `expired` | à qualifier |
| 30 | Mauvais mot de passe | `badge_denied`, motif `wrong_pin` | à qualifier |
| 38, 39 | Carte perdue, accès désactivé | `badge_denied`, motif `disabled` | à qualifier |
| 200 / 201 | Porte ouverte / fermée | `door_opened` / `door_closed` | à qualifier |
| 28 | Porte restée ouverte trop longtemps | `door_held_open` (pré-alarme) | à qualifier |
| 102 | Porte ouverte de force | `door_forced` (alarme) | à qualifier |
| 100 | Sabotage | `tamper` (alarme) | à qualifier |
| 101, 103 | Ouverture sous contrainte (code, empreinte) | `badge_granted` **et** alarme silencieuse (`panic`) | à qualifier |
| 9, 10, 204 | Fermeture à distance ; plage d'ouverture permanente désactivée pour la journée ; fin de la plage d'ouverture permanente | `door_mode` `normal` (section 7) | noms confirmés, sens déduit : à qualifier |
| 205 | Ouverture permanente à distance | `door_mode` `always_open` (section 7) | noms confirmés, sens déduit : à qualifier |
| 5, 6, 7, 11, 12, 13, 26, 32, 37, 206, 220, 221 | États et informations sans conséquence (liaison, plage réactivée, démarrage...) | aucun message (journalisé une fois) | à qualifier |
| autre, de 20 à 99 | Numéro inconnu dans la bande des échecs | `badge_denied`, motif `other` | à qualifier |
| autre | Numéro inconnu | aucun message (journalisé une fois) | à qualifier |

Principes sûrs : **un numéro inconnu n'est jamais une alarme**. Le sens du passage vient de `inoutstatus` (0 entrée,
1 sortie, 2 aucun : confirmé par le SDK C3). La méthode vient de `verifytype` (1 empreinte, 3 code, 4 / 10 / 11 badge,
6 badge ou empreinte : confirmés ; 15 visage : à qualifier). Le numéro de badge et l'identifiant du titulaire sont
transmis au PSIM, jamais un code PIN ; le nom du titulaire n'est pas transmis par ce module.

**Terminaux** (`kind: "terminal"`) : ils envoient leurs pointages en `ATTLOG` (PIN, heure, statut, mode de
vérification). Chaque pointage devient un `badge_granted` (une pointeuse ne trace que des succès) ; statut 0, 3, 4 =
entrée, 1, 2, 5 = sortie ; mode 0 code, 1 empreinte, 2 carte, 15 visage. L'ordre des champs est confirmé, les valeurs
sont à qualifier.

**État des portes** (`rtstate`) : le contact de chaque porte est lu (hypothèse à qualifier : un chiffre par porte,
1 = fermée, 2 = ouverte) et un changement d'état devient `door_opened` / `door_closed`. L'heure actuelle de l'appareil
sert à mesurer la dérive d'horloge. **`rtstate` ne donne pas le mode de la porte** : aucune source consultée ne décrit de
champ de mode dans cette ligne, et l'état du relais (`relay`) s'active aussi pour une simple impulsion d'ouverture ; le mode
vient donc des seuls événements du journal temps réel (section 7).

**Identifiant d'événement** : l'`index` de l'enregistrement de l'appareil (à défaut, un identifiant fabriqué de façon
déterministe) ; avec une `epoch` supérieure à 0, il devient `<epoch>.<index>` (section 8).

## 6. Comportement en exploitation

### Récupération des passages manqués (F8)

La passerelle ne répond `OK` à l'appareil que lorsque **tous** les passages du lot sont en file chez elle. Sinon elle
répond 503 et l'appareil conserve ses enregistrements pour les renvoyer. À chaque poignée de main, elle indique à
l'appareil la dernière estampille acquittée (curseur gardé dans `stateDir`) : après une coupure du réseau ou un
redémarrage, l'appareil rejoue ce qu'il a en mémoire. Les doublons sont écartés, et les passages plus vieux que
`thresholds.deferredAfterS` sont marqués **différés** (affichés « en différé » côté PSIM). Le curseur est **propre à
l'époque** de l'appareil (clé `<id>` pour l'époque 0, `<id>~e<epoch>` ensuite, section 8). À qualifier : combien
d'enregistrements l'appareil garde en mémoire, et si son numéro d'enregistrement (`index`) repart de zéro après une
remise à zéro de la centrale.

### Dérive d'horloge

L'heure actuelle de l'appareil (lue dans les états `rtstate`) est comparée à celle de la passerelle. Au-delà de
`thresholds.clockDriftMs` (2 minutes), le détecteur reçoit `clock_drift` (« Horloge de l'équipement déréglée »), répété
toutes les 5 minutes tant que dure l'écart ; le retour sous 1 minute le rétablit. Un enregistrement daté du futur est
aussi une preuve d'horloge en avance. Vérifier `utcOffsetMin` avant d'accuser l'appareil.

### Hors ligne et signe de vie

Toute requête valide d'un appareil déclaré est une preuve de vie. En ligne, chaque porte reçoit un `heartbeat` toutes
les `thresholds.heartbeatS` secondes. Un appareil **muet** depuis `thresholds.silenceMs` (90 s), ou jamais joint 90 s
après le démarrage, est traité comme coupé : chaque porte reçoit `{"state":"offline"}` **une seule fois**, après le
délai de grâce `offlineGraceMs`. Jamais « fermée » à tort. Au retour, un `heartbeat` immédiat est envoyé.

### Refus répétés

Un refus n'est jamais une alarme à lui seul. `deniedCount` refus (3) en `deniedWindowS` secondes (60) sur une même
porte déclenchent `badge_denied_repeated` (pré-alarme), puis le compteur de la porte repart de zéro.

### Ouverture à distance

Elle n'existe que si l'appareil déclare `actuators` **et** que la passerelle a le canal de commande signé (sinon le
journal dit « ouverture à distance indisponible, surveillance seule »). Le socle vérifie signature, fraîcheur et
plafonds ; le module exécute :

| Ordre | Effet sur l'appareil |
|---|---|
| `unlock` (serrure), `open` (barrière) | Impulsion de `pulseS` secondes. Si une durée supérieure à `longUnlockS` est demandée : ouverture en continu (durée spéciale 255) ; le socle rappelle `lock` à la fin de la durée. |
| `lock` (serrure), `close` (barrière) | Retour au **mode normal** : la porte se referme et les badges fonctionnent de nouveau (durée 0). |
| `stop`, et tout autre ordre | Refusé (`not_supported`). |

- **Jamais « toujours fermée »** : « verrouiller » ne coupe pas les badges (une porte qui refuserait tous les badges
  enfermerait ou exclurait du monde, issue de secours comprise).
- **Accusé seulement après confirmation de l'appareil.** Le protocole est « tiré » : la commande attend dans une file
  que l'appareil vienne la chercher (au rythme de `push.delayS`), puis le résultat (`Return=0` = succès) revient en
  `devicecmd`. Sans confirmation dans `commandTimeoutS` (30 s), la commande est **retirée** et l'accusé est un échec
  (`timeout`) ; un appareil muet donne `offline`, un autre code de retour `refused_by_device`. Une commande n'est remise
  qu'une fois, une seule à la fois par appareil, et un résultat tardif est ignoré.
- **Délai d'interrogation** : l'ouverture à distance ne part qu'à la prochaine interrogation de l'appareil, donc
  jusqu'à `push.delayS` secondes plus tard (3 s par défaut).
- À qualifier : l'écriture exacte de `CONTROL DEVICE` (`hex` ou `spaced`) et les durées spéciales 255 et 0.

## 7. Mode de porte (F19)

Le PSIM affiche, pour chaque porte, son **mode** : `normal`, `always_open` (toujours ouverte) ou `always_closed` (toujours
fermée). Avec ZKTeco, le module ne peut **pas interroger** ce mode : il le **déduit des événements** du journal temps réel et
envoie sur le détecteur de la porte :

```
{"event":"door_mode","doorMode":"normal"}      (ou "always_open")
```

| N° d'événement | Événement ZKTeco | Mode envoyé |
|---|---|---|
| 205 | Ouverture permanente à distance | `always_open` |
| 9 | Fermeture à distance | `normal` |
| 10 | Plage d'ouverture permanente désactivée pour la journée | `normal` |
| 204 | Fin de la plage d'ouverture permanente | `normal` |
| 11 | Plage d'ouverture permanente réactivée | **rien** : la porte n'est en ouverture continue que si l'heure est dans la plage, ce que le message ne dit pas |
| tout autre | | rien |

Ce qui **n'est pas émis** :

- `always_closed` (toujours fermée) : aucun événement connu ne la signale, elle n'est donc **jamais** envoyée ;
- un mode **ancien** : un enregistrement récupéré en différé après une coupure (section 6) est de l'histoire ; il ne change
  pas le mode courant ;
- un mode avant le premier changement observé : le mode reste **inconnu** (rien n'est affiché) tant qu'aucun de ces événements
  n'a été vu depuis le démarrage de la passerelle. Il n'y a **pas de lecture à la connexion**, et `rtstate` ne donne pas le
  mode (section 5) ;
- l'ouverture normale par impulsion, les ouvertures par badge, et les événements 1, 2, 16, 18, 19 (passages pendant ou
  ouvrant une plage d'ouverture permanente) : ce sont des passages, pas des changements de mode.

`door_mode` compte comme un signe de vie pour le PSIM : il ne part jamais tant que l'appareil n'est pas joignable (il est
gardé et envoyé au retour), un mode identique n'est pas renvoyé, et à chaque **retour en ligne** le dernier mode connu est
renvoyé une fois. Un ordre `unlock` de longue durée ou `lock` du PSIM ne met pas le mode à jour par lui-même : il le sera
quand l'événement correspondant arrivera dans le journal temps réel.

**A QUALIFIER** sur matériel : les numéros 9, 10, 11, 204 et 205 (noms confirmés par la liste d'événements d'une
bibliothèque tierce du SDK C3, sens déduit), le fait que 9 annule bien une ouverture continue, et l'existence d'un champ ou
d'un paramètre (par exemple `Door<N>Drivertime` à 255) qui donnerait le mode directement.

## 8. Remplacement d'une centrale ou d'un terminal (`epoch`)

Quand un appareil est remplacé par un neuf (ou remis à zéro en usine), sa mémoire est vide et ses numéros d'enregistrement
(`index`) **repartent de zéro**. Sans précaution, un nouveau passage n° 12 serait pris pour l'ancien passage n° 12 déjà connu
du PSIM (rejeté comme doublon) et le curseur de récupération, resté en avance, serait comparé à l'estampille d'un appareil
différent. La clé `epoch` de l'appareil sépare l'ancien du nouveau.

**Quand l'augmenter** : seulement quand la mémoire de l'appareil a été effacée ou que le matériel a été changé. Pas pour un
simple redémarrage, une coupure de courant ou un changement d'adresse IP.

**Ce qui se passe** : avec `epoch` supérieure à 0 (valeur `E`),

- l'identifiant d'événement de chaque passage devient `E.<index>` (par exemple `1.12`) au lieu de `12` ; l'identifiant de
  message est `acc:<contrôleur>:E.<index>` ;
- le curseur de récupération est **propre à l'époque** (clé `<id>~eE`) : il repart de zéro. À la poignée de main suivante,
  la passerelle n'impose plus de point de reprise : c'est l'estampille annoncée par l'appareil qui fait foi, et il renvoie
  ce que contient sa mémoire. **Contrairement au module Dahua, le module ZKTeco ne limite pas lui-même l'historique rejoué à
  24 heures** : une centrale de remplacement ne contient que ce qui s'est passé depuis son installation ; un appareil remis
  à zéro sans effacer ses enregistrements les renverrait tous, marqués « différés » ;
- l'ancien curseur n'est plus consulté.

**Ce que voit le PSIM** : les passages de l'ancien appareil gardent leur identifiant (`12`) ; ceux du nouveau portent
`E.<index>`. Le journal des accès est donc continu et sans doublon rejeté.

**Procédure pas à pas (installateur)** :

1. Installer le nouvel appareil et le régler comme l'ancien (section 4) : adresse du serveur et port de la passerelle,
   adresse IP fixe comprise dans `allowFrom`, **heure juste** (elle sert à dater les passages). Relever son **numéro de série**
   sur l'étiquette : il est **différent** de celui de l'ancien.
2. Dans `config.json`, pour **cet** appareil seulement : corriger `serial` (numéro de série exact, casse comprise) **et**
   passer `epoch` de sa valeur actuelle à la valeur **suivante** (0 devient 1, 1 devient 2, etc.). Ne toucher à aucune autre
   clé.
3. Si l'appareil est une centrale qui reçoit les titulaires du PSIM (`syncKey`), prévenir l'administrateur du PSIM : la
   nouvelle centrale est **vide** (ni utilisateurs, ni droits, ni fuseaux, ni jours fériés). La clé de synchronisation et les
   numéros de fuseaux du module ne changent pas, mais c'est au PSIM de renvoyer l'ensemble des titulaires (section 9). Le
   fichier des jours fériés déjà écrits (`acces-zkteco-feries.json`) décrit l'**ancienne** centrale.
4. **Redémarrer le module** : `.\scripts\gateway-service.ps1 -Action Restart` (la configuration n'est lue qu'au
   démarrage). Une `epoch` ou un `serial` invalide est refusé avec la liste des erreurs.
5. **Vérifier** dans le journal de la passerelle : « premier contact » pour l'appareil, puis aucune ligne « requete refusee
   depuis ... (appareil, chemin ou methode non reconnus) » (signe d'un `serial` mal recopié). Faire passer un badge : dans le
   PSIM, le passage doit apparaître avec un identifiant d'événement de la forme `E.<index>`, sur la bonne porte, à l'heure
   exacte. Vérifier aussi l'ouverture à distance (section 6) et, après l'envoi des titulaires par le PSIM, un passage réel.
6. Noter l'opération (date, ancien et nouveau `serial`, ancienne et nouvelle valeur de `epoch`) dans le dossier
   d'installation : cela évite de restaurer plus tard une ancienne copie de `config.json`.

**Ne JAMAIS diminuer `epoch`** (ni la remettre à 0) : les passages reprendraient les identifiants d'une époque passée,
seraient rejetés comme doublons par le PSIM, et le module réutiliserait un curseur périmé. Si une valeur trop haute a été
écrite par erreur, la laisser telle quelle : une époque inutilisée ne coûte rien. Si on oublie de l'augmenter, les symptômes
sont : passages du nouvel appareil absents du PSIM ; augmenter alors `epoch` et redémarrer (quelques passages déjà reçus
sous l'ancien identifiant peuvent alors apparaître deux fois).

## 9. Synchronisation des titulaires (PSIM vers centrale)

**Principe.** Le PSIM tient la liste des titulaires (nom, badge, validité, portes, horaires) et la pousse vers chaque
centrale, **une opération à la fois**, par un ordre signé que la passerelle vérifie puis remet au module (contrat :
`docs/CONTROLE-ACCES.md` § 7 ; côté passerelle : `docs/PASSERELLE.md`, section « Synchronisation des titulaires »). Le module
traduit chaque opération en commandes `DATA UPDATE` / `DATA DELETE` placées dans la file de l'appareil (même mécanisme
« tiré » que l'ouverture à distance, section 6) et ne répond « fait » que si l'appareil a confirmé chaque commande
(`Return=0`).

**Centrales seulement.** Un **terminal** (`"kind": "terminal"`) ne reçoit aucun titulaire : toute opération reçue pour lui est
refusée (`not_supported`), même s'il a une `syncKey`.

**Activation par appareil.** Elle se fait par la clé `syncKey` :

1. dans le PSIM, créer le contrôleur : le PSIM affiche sa **clé de synchronisation** (64 caractères hexadécimaux) **une
   seule fois** ;
2. l'écrire dans un fichier de la passerelle, **sur une seule ligne**, par exemple
   `gateway\secrets\acces-zkteco-c3-entree-sync.key`, protégé comme les autres secrets (`icacls`, voir `docs/PASSERELLE.md`
   § 2) ;
3. la référencer dans la configuration de l'appareil : `"syncKey": { "$file": "secrets/acces-zkteco-c3-entree-sync.key" }` ;
4. redémarrer la passerelle. Journal attendu : aucun « synchronisation des titulaires inactive pour ... (pas de syncKey) ».

**Sans `syncKey` la synchronisation est inactive** : le module surveille l'appareil normalement, mais ne lui écrit rien. Le
socle de la passerelle ne s'abonne même pas aux ordres de cet appareil.

**Jamais de PIN, d'empreinte, de visage ni de photo.** Aucun ordre ne peut en porter (tout champ de ce nom est refusé) ; le
champ `Password` n'est **jamais** envoyé (le code PIN reste dans la centrale ; on ignore si une mise à jour sans `Password`
conserve ou remet à zéro le code existant : **à qualifier**) ; le champ `Group` n'est pas envoyé non plus. Dans les journaux,
jamais de nom, de numéro de badge ni de référence de titulaire.

### Correspondance opération PSIM vers commandes ZKTeco

Tables du SDK C3 (mêmes noms dans le protocole push). Les champs d'une commande sont séparés par une tabulation. Chaque
commande n'est envoyée qu'après la confirmation de la précédente.

| Opération PSIM | Commandes envoyées, dans l'ordre | Statut |
|---|---|---|
| `upsert_holder` (titulaire actif) | `DATA UPDATE user CardNo=<carte> Pin=<n> StartTime=<AAAAMMJJ ou 0> EndTime=<AAAAMMJJ ou 0> [Name=<nom> Privilege=0]` ; puis `DATA DELETE userauthorize Pin=<n>` (efface les droits précédents) ; puis, **une commande par fuseau distinct** : `DATA UPDATE userauthorize Pin=<n> AuthorizeTimezoneId=<fuseau> AuthorizeDoorId=<masque des portes>` | tables et champs confirmés ; fusion ou remplacement de la ligne, `Name`, `Privilege`, `EndTime` inclus : à qualifier |
| `upsert_holder` (titulaire inactif ou échu : **suspension**) | d'abord `DATA DELETE userauthorize Pin=<n>` (retire l'accès), puis `DATA UPDATE user ...` | idem |
| `delete_holder` | `DATA DELETE userauthorize Pin=<n>`, puis `DATA DELETE user Pin=<n>` | `DATA DELETE` d'une ligne absente : à qualifier |
| `upsert_schedule` | `DATA UPDATE timezone TimezoneId=<n> SunTime1..3 MonTime1..3 ... SatTime1..3 Hol1Time1..3 Hol2Time1..3 Hol3Time1..3` | table confirmée ; jours fériés (type 1) à qualifier |
| `delete_schedule` | même commande avec tous les segments à 0 (fuseau **vidé**, pas supprimé : la table est de taille fixe) ; le numéro est libéré | à qualifier |
| `set_holidays` | `DATA UPDATE holiday Holiday=<AAAAMMJJ> HolidayType=1 Loop=2` (une commande par date) ; avec `replace`, `DATA DELETE holiday Holiday=<AAAAMMJJ>` pour les dates retirées | confirmé ; effacement d'une date : à qualifier |

### Règles de conversion

- **`Pin`** = les **chiffres** de la référence `H<chiffres>` du titulaire (`H42` donne `Pin=42`) : 1 à 9 chiffres, **sans zéro
  de tête** (`H0042` est refusé : l'appareil pourrait confondre 42 et 042). Une référence non convertible est refusée
  (`invalid`).
- **Un seul badge par titulaire** : la table `user` de la centrale n'en connaît qu'un. Un titulaire qui en a **plusieurs**
  est refusé (`not_supported`) ; sans badge, `CardNo` est vide. Un numéro de badge doit avoir 1 à 10 chiffres, non nul, et ne
  pas dépasser 4 294 967 295 (sinon `invalid`).
- **Droits** : `AuthorizeDoorId` est le masque des portes (porte 1 = 1, porte 2 = 2, porte 3 = 4, porte 4 = 8, additionnés) ;
  `AuthorizeTimezoneId` est le fuseau de l'horaire du titulaire, ou `timezones.always` (1) s'il n'a pas d'horaire. Les portes
  qui partagent le même fuseau sont regroupées dans une seule commande.
- **Dates de validité** : `StartTime` et `EndTime` au format `AAAAMMJJ`, `0` = sans limite, calculées en **heure locale de
  l'appareil** (`utcOffsetMin`), **au jour près** : une fin de validité à 14 h vaut la fin de la journée (le PSIM retire de
  toute façon le titulaire à l'échéance). Plage acceptée : 2001 à 2099.
- **Nom** : tronqué à 24 octets UTF-8, sans caractère de contrôle ; supprimé avec `sync.userExtras: false`.
- **Horaires** : **3 plages par jour** au plus (un fuseau a 3 segments par jour) ; plus de 3 plages distinctes dans un même
  jour est refusé (`not_supported`). Une plage qui passe minuit déborde sur le jour suivant ; les plages qui se touchent sont
  fusionnées ; la fin d'un segment est la **dernière minute accordée** (jamais une minute de plus que l'horaire du PSIM). Un
  segment s'écrit `(HHMM du début) × 65536 + (HHMM de la fin)` ; 0 = segment inutilisé.
- **Jours fériés et horaires** : les jours fériés écrits sont de type 1 (donc `Hol1Time1..3` du fuseau). Un horaire **sans**
  l'option « fermé les jours fériés » reçoit, pour ces jours, la plage commune aux sept jours (jamais plus large que
  l'horaire du PSIM) ; **avec** l'option, ces segments sont à 0 (fermé). Types 2 et 3 : toujours fermés. **A QUALIFIER.**
  (Contrairement au module Dahua, l'horaire « fermé les jours fériés » est accepté.)
- **Jours fériés ecrits par le module** : un jour férié n'est retiré (`replace`) que s'il a été écrit par ce module : la liste
  est gardée dans `acces-zkteco-feries.json` (dossier `stateDir`). Plage acceptée : 2001 à 2099.
- **Suspension, jamais suppression** : un titulaire inactif ou dont la validité est dépassée perd ses droits (`DATA DELETE
  userauthorize`) mais **reste** dans la centrale ; seul `delete_holder` le supprime. Un titulaire pas encore valide garde ses
  droits : `StartTime` l'empêche d'entrer jusqu'à sa date.

### Ce que cela implique pour l'exploitation

- **Fenêtre sans accès** : entre `DATA DELETE userauthorize` et le dernier `DATA UPDATE userauthorize`, le titulaire n'a
  **aucun droit** dans la centrale. Elle dure autant de cycles d'interrogation que de commandes restantes, l'effacement
  compris : environ trois cycles (9 s par défaut) pour un titulaire à deux fuseaux. Un titulaire sans porte n'a, à la fin,
  aucun droit. À éviter en heure de pointe : modifier un titulaire à un moment où il ne passe pas.
- **Latence** : chaque commande attend que l'appareil vienne la chercher (`getrequest`), donc **un cycle de `push.delayS`
  par commande** (3 s par défaut). Un titulaire = 2 à 6 commandes (la suspension en demande 2), soit de 6 à 18 s par défaut ;
  un lot de jours fériés = une commande par date. Une ouverture à distance demandée entre-temps n'attend jamais plus d'une
  commande de synchronisation.
- **Délais** : chaque commande a `thresholds.commandTimeoutS` (30 s) pour être confirmée ; une commande non confirmée est
  retirée de la file (jamais remise en retard) et l'opération se termine en erreur ; le socle borne l'opération entière à 300 s.

### Résultats

| Résultat | Code | Cas |
|---|---|---|
| `done` | | opération faite, chaque commande confirmée (`Return=0`) |
| `refused` | `not_supported` | terminal, plusieurs badges, plus de 3 plages dans un jour, ou `Return` = -1002 (syntaxe non prise en charge) |
| `refused` | `invalid` | ordre mal formé, référence non convertible en `Pin`, badge ou date inutilisable, horaire inconnu pour un titulaire (le PSIM doit d'abord l'envoyer), ou `Return` = -30 (valeur refusée) |
| `refused` | `full` | plus de numéro de fuseau libre dans `timezones.min` à `timezones.max`, ou `Return` listé dans `sync.fullCodes` |
| `error` | `io` | autre code `Return` non nul de l'appareil (non listé ci-dessus), ou erreur interne ; le PSIM réessaie |
| `error` | `timeout` | commande non confirmée en `commandTimeoutS` |
| `error` | `unreachable` | appareil muet ou jamais venu (aucune interrogation récente) |
| `error` | `busy` | plus de 32 opérations en attente dans le module |

Un refus (`refused`) ne se rejoue pas tel quel : la demande est inacceptable. Une erreur (`error`) se réessaie, avec
attente croissante, côté PSIM.

## 10. Équipements testés / à qualifier

**Aucun matériel réel n'a été essayé : tout est « à qualifier ».** Points marqués `A QUALIFIER` dans le code du module :

- noms de champs des lignes du journal temps réel (`rtlog`) et des états (`rtstate`) ; table **entière** des numéros
  d'événement (section 5) ; l'`index` des enregistrements repart-il de zéro après une remise à zéro (c'est ce que l'`epoch`
  de la section 8 suppose) ;
- modes de vérification (`verifytype`), en particulier 15 (visage), et sens/mode des pointages d'un terminal (`ATTLOG`) ;
- `rtstate` : un chiffre par porte, 1 fermée et 2 ouverte ; absence de champ de mode (section 7) ;
- sens des événements 9, 10, 11, 204 et 205 pour le mode de porte, et existence d'un moyen de lire le mode (section 7) ;
- écriture de la commande d'ouverture (`push.controlFormat`), durées 255 (ouverture continue) et 0 (retour au normal) ;
- `push.transFlag` par défaut (journal des passages seul) et configuration renvoyée à la poignée de main ;
- synchronisation (section 9) : séparateur de champs (tabulation) ; noms de champs `Name` et `Privilege` de la table `user`
  (`sync.userExtras`) ; effet d'un `DATA UPDATE` sur une ligne existante (fusion ou remplacement) ; effet d'une mise à jour sans
  `Password` sur le code existant ; `DATA DELETE` d'une ligne absente ; `EndTime` inclus ; fuseau « toujours » (n° 1) et
  capacité en fuseaux (`timezones`) ; jours fériés de type 1 et leur effet sur le fuseau ; effacement d'un jour férié ; code
  `Return` d'une capacité pleine (`sync.fullCodes`) ; limite de 24 octets du nom.

| Famille (registre `qualification/registry.json`) | Équipement | Statut |
|---|---|---|
| `generic-acces-zkteco-controleur` | Centrales C3 / inBio (protocole push) | à qualifier |
| `generic-acces-zkteco-terminal` | Terminaux ZKTeco (protocole push) | à qualifier |

Ce que la recette sur site doit constater (fiche `docs/qualification/controle-acces.md`, profils « contrôleur » et
« terminal ») :

- la **poignée de main** : l'appareil appelle bien la passerelle avec le numéro de série relevé, et le premier contact est journalisé ;
- les **noms de champs** et les **numéros d'événement** de la section 5, sur de vrais passages (accepté, inconnu, expiré, hors horaire, bouton de sortie, sabotage, porte forcée, maintenue ouverte, contrainte) ;
- le **sens** entrée / sortie et la **méthode** de vérification (badge, code, empreinte, visage) ;
- la **dérive d'horloge** et la justesse de `utcOffsetMin` ;
- la **mémoire hors ligne** : couper le réseau, passer des badges, rétablir, constater les passages « différés » sans doublon ni trou, y compris après redémarrage de la passerelle ;
- la **coupure de liaison** (hors ligne une seule fois, jamais « fermée »), le rétablissement et le « muet » ;
- l'**ouverture à distance** : écriture de `CONTROL DEVICE` (`hex` ou `spaced`), impulsion, ouverture continue (255), retour au normal (0), accusé seulement après confirmation, délai mesuré ;
- que **seuls les passages** sont envoyés (aucun utilisateur ni gabarit) avec `push.transFlag` par défaut ;
- le **mode de porte** : ouverture permanente à distance (205), fermeture à distance (9), fin de plage (204), désactivation
  de la plage du jour (10) : le mode affiché dans le PSIM suit-il l'état réel de la porte ?
- la **contrainte** : code et empreinte de contrainte (101, 103), passage accepté **et** alarme `panic` ;
- le **remplacement d'un appareil** : procédure de la section 8 sur un appareil réellement remplacé, identifiants `E.<index>` ;
- la **synchronisation** (centrale) : créer, modifier, suspendre, réactiver et supprimer un titulaire ; titulaire sans
  horaire, à plusieurs portes, avec horaire ; jours fériés (horaire avec et sans l'option « fermé les jours fériés ») ;
  centrale pleine (relever le code `Return` pour `sync.fullCodes`) ; durée de la fenêtre sans accès ; vérification à chaque
  fois sur la centrale et par un passage de badge ;
- la **tenue réseau** : appareil non déclaré, adresse hors `allowFrom`, flot de requêtes : aucune fuite d'information, aucune panne.

Un recueil de trames réelles doit être joint au compte rendu ; les entrées du registre (une par modèle) ne passent à
« qualifié » qu'après cette recette.

## 11. Dépannage

Messages du journal de la passerelle (un même message ne paraît qu'une fois par minute au plus). Les lignes du socle de
synchronisation commencent par `[synchro]` (voir aussi `docs/PASSERELLE.md`).

| Symptôme | Cause probable | Action |
|---|---|---|
| Le module refuse de démarrer, « Configuration acces-zkteco invalide » | Clé inconnue, valeur hors bornes, `listen` absent | Lire la liste des erreurs, corriger la configuration |
| « ecoute sur TOUTES les interfaces » | `listen.host` vaut `0.0.0.0` ou `::` | Mettre l'adresse de l'interface dédiée (ne pas utiliser `allowAnyInterface`) |
| « thresholds.silenceMs ... doit valoir au moins 3 fois push.delayS » | Silence trop court par rapport à l'interrogation | Augmenter `silenceMs` ou réduire `delayS` |
| Aucun passage, journal : « requete refusee depuis ... (appareil, chemin ou methode non reconnus) » | Numéro de série inconnu ou mal recopié (casse comprise), mauvaise URL, appareil non déclaré | Comparer `serial` à l'étiquette, vérifier la configuration de l'appareil |
| « connexion refusee depuis ... (adresse hors de allowFrom) » | Adresse de l'appareil hors liste | Ajouter l'adresse, ou chercher qui d'autre émet vers le port |
| Pas de « premier contact » | Appareil mal réglé (adresse, port), pare-feu, VLAN | Vérifier adresse et port du serveur sur l'appareil, tester le chemin réseau |
| « debit trop eleve depuis ... » ou « trop de connexions simultanees » | Appareil bavard, ou attaque | Vérifier la source ; ajuster `limits` seulement si l'appareil est légitime |
| « corps trop gros refuse depuis ... » | Corps supérieur à `maxBodyBytes` | Vérifier la source ; l'appareil envoie peut-être autre chose que les passages |
| « N ligne(s) illisible(s) ignoree(s) » | Format de trame différent de celui prévu | Relever une trame réelle et la comparer à la section 5 (à qualifier) |
| « evenement N inconnu du module » | Numéro absent de la table | Relever l'événement réel, compléter la table après qualification |
| « passage pour une porte non declaree, ignore » | L'appareil signale une porte absente de `doors` | Déclarer la porte (1 à 4) avec son détecteur |
| « donnees non acquittees ... l'appareil les renverra » | Le socle de la passerelle n'a pas pu mettre en file (file pleine) | Vérifier le socle et le lien vers le PSIM ; rien n'est perdu, l'appareil renvoie |
| « donnees d'une table non exploitee recues, ignorees » | L'appareil pousse utilisateurs, opérations... | Vérifier `push.transFlag` ; ces données ne sont jamais lues |
| « muet depuis plus de N s, traite comme une coupure » puis « portes declarees hors ligne » | Appareil éteint, câble, réseau, adresse changée | Contrôler alimentation et réseau ; le retour est journalisé « de nouveau joignable » |
| « horloge deregle de N s » | Heure de l'appareil fausse, ou `utcOffsetMin` erroné | Régler l'heure (NTP), vérifier `utcOffsetMin` |
| « actionneur « X » non enregistre : ouverture a distance indisponible, surveillance seule (...) » | L'actionneur n'est pas déclaré dans la section `actuators` de la passerelle pour ce module, ou la passerelle n'a pas de canal de commande | Les passages continuent d'être rapportés ; déclarer l'actionneur (`docs/PASSERELLE.md`, section 8) ou ignorer si la surveillance seule suffit |
| « alarme de contrainte pour une porte non declaree, ignoree » | Une contrainte (101 ou 103) vient d'une porte absente de `doors` | Déclarer la porte : une contrainte ignorée est une alarme perdue |
| Les passages d'un appareil remplacé n'arrivent pas dans le PSIM | `epoch` pas augmentée, ou `serial` pas corrigé (section 8) | Corriger `serial` et augmenter `epoch` de 1, redémarrer la passerelle ; ne jamais diminuer `epoch` |
| « Configuration acces-zkteco invalide » avec « epoch » | `epoch` négative, décimale ou trop grande | Entier de 0 à 999999999999 |
| « synchronisation des titulaires inactive pour ... (pas de syncKey) » | Information : l'appareil n'a pas de `syncKey` | Ajouter la clé donnée par le PSIM (section 9) pour activer la synchronisation |
| « Configuration acces-zkteco invalide » avec « syncKey » | La clé n'est pas 64 hexadécimaux minuscules (copie incomplète, majuscules, espace ou saut de ligne en trop) | Recopier la clé telle que le PSIM l'a donnée, sur une seule ligne ; si elle est perdue, en faire créer une nouvelle au PSIM |
| « Configuration acces-zkteco invalide » avec « timezones » | `min` > `max`, ou `always` dans l'intervalle `min` à `max` | Choisir un fuseau « toujours » hors de l'intervalle attribuable |
| « Configuration acces-zkteco invalide » avec « sync.fullCodes » | Liste de plus de 16 codes, ou code non entier négatif | Corriger la liste |
| « controleur ... : synchronisation des titulaires non enregistree, surveillance des portes seule (...) » | Le socle a refusé la clé ou l'identifiant, ou un autre module suit déjà ce contrôleur | Lire la cause entre parenthèses ; la surveillance des portes continue |
| « synchronisation des titulaires indisponible, le socle de cette passerelle n'a pas de canal de synchronisation des titulaires » | Passerelle plus ancienne que le module | Mettre la passerelle à jour |
| « controleur ... : synchronisation <type> -> refused (not_supported) » | Terminal, plusieurs badges pour un titulaire, plus de 3 plages dans un jour, ou `Return` = -1002 | Simplifier côté PSIM (un seul badge, horaire plus simple) ; un terminal ne reçoit pas de titulaires |
| « ... -> refused (invalid) » | Référence non convertible (`H0042`, `H` suivi de plus de 9 chiffres), badge ou date inutilisable, horaire pas encore envoyé, ou `Return` = -30 | Corriger côté PSIM ; laisser le PSIM envoyer l'horaire avant le titulaire |
| « ... -> refused (full) » | Plus de fuseau libre dans `timezones.min` à `max`, ou `Return` de `sync.fullCodes` | Supprimer des horaires inutiles, ou élargir `timezones` |
| « ... -> error (io) » | Code `Return` inattendu de l'appareil (par exemple un champ `Name` ou `Privilege` refusé), ou erreur interne | Essayer `sync.userExtras: false` ; relever le code (à qualifier) |
| « ... -> error (timeout) » ou « (unreachable) » | Commande non confirmée en `commandTimeoutS`, ou appareil muet | Vérifier `push.delayS`, le réseau et l'appareil ; le PSIM réessaie |
| « ... -> error (busy) » | Plus de 32 opérations en attente dans le module | Le PSIM réessaie plus tard |
| « attribution des plages non ecrite sur le disque (nouvel essai plus tard) » | Dossier `stateDir` en lecture seule ou plein | Donner au compte de service le droit d'écrire dans `stateDir` |
| « fichier des jours feries ecrits illisible : liste vide » ou « ecriture des jours feries ecrits impossible (...) » | `acces-zkteco-feries.json` corrompu, ou dossier non inscriptible | Corriger le dossier ; les anciens jours fériés écrits ne seront plus retirés par `replace` |
| « ordre unlock refuse par le controleur (porte N) : offline » | Appareil muet à ce moment | Attendre le retour de l'appareil ; aucun accusé de réussite n'est donné |
| Même message, code `timeout` | L'appareil n'a pas confirmé en `commandTimeoutS` | Vérifier `push.delayS` et le réseau ; la commande est retirée, ne pas la croire exécutée |
| Même message, code `refused_by_device` | L'appareil a répondu un code d'erreur | Essayer `push.controlFormat: "spaced"` ; relever le code (à qualifier) |
| Même message, code `not_supported` | Ordre non prévu pour ce type (`lock` / `unlock` pour une serrure, `open` / `close` pour une barrière) | Utiliser l'ordre adapté au `type` |
