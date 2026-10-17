# Module acces-zkteco : raccorder un contrôle d'accès ZKTeco à la Passerelle GAMR

Le module `acces-zkteco` fait de la Passerelle GAMR le **serveur** du protocole « push » de ZKTeco (aussi appelé
iclock / ADMS) : les centrales de contrôle d'accès et les terminaux ZKTeco **appellent la passerelle** par HTTP,
lui envoient leurs passages et leurs états de porte en temps réel, et viennent y chercher les ordres éventuels
(ouverture à distance). La passerelle traduit chaque événement en message PSIM.

> **Important : aucun matériel ZKTeco réel n'a encore été essayé.** Le module est testé contre un appareil simulé
> (`gateway/test/fake-zkteco.ts`) construit d'après les sources publiques du protocole. Tout ce qui touche au
> format exact des trames est marqué « à qualifier » : faites la recette décrite en section 7 avant toute mise
> en service.

## 1. À quoi ça sert

**Équipements visés** :

- les **centrales de contrôle d'accès** ZKTeco **C3** et **inBio** (1 à 4 portes) : réglage `"kind": "controller"` ;
- les **terminaux** ZKTeco (pointeuses, lecteurs autonomes à une porte) : réglage `"kind": "terminal"`.

Aucun modèle précis n'est qualifié (voir section 7).

**Un détecteur PSIM de catégorie `access` par porte.** Chaque porte de l'appareil que l'on veut surveiller est
rattachée, dans la configuration, à un détecteur PSIM (son identifiant). Les passages, les ouvertures, les alarmes
et le signe de vie de cette porte arrivent sur ce détecteur.

**Ce que le module fait** :

- reçoit les passages (badge, code, empreinte, visage, bouton de sortie, ouverture à distance), acceptés **et** refusés ;
- suit l'état des portes (ouverte, refermée, forcée, maintenue ouverte) et le sabotage du boîtier ;
- signale les refus répétés, l'horloge déréglée, l'appareil muet ou hors ligne ;
- récupère les passages manqués après une coupure du réseau (section 6) ;
- exécute, si on le déclare, les ordres d'ouverture à distance venus du canal de commande signé du PSIM.

**Ce que le module ne fait pas** :

- **le contrôleur décide, pas le PSIM.** L'ouverture par badge se joue entièrement dans l'appareil : si la
  passerelle ou le PSIM est arrêté, les portes continuent de fonctionner. Le PSIM ne prend **jamais** part à
  l'ouverture par badge ;
- il ne crée, ne modifie ni ne supprime aucun badge, utilisateur, empreinte ou visage. Il **ne demande jamais**
  à l'appareil ses utilisateurs ni ses gabarits biométriques (ils restent dans l'appareil) ;
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
  }
}
```

Toute clé inconnue ou toute valeur hors bornes est refusée au démarrage, avec **toutes** les erreurs listées d'un coup.
Les valeurs des sections `thresholds`, `limits` et `push` ci-dessus sont les valeurs par défaut : on peut les omettre.

### Clés du module

| Clé | Défaut | Rôle |
|---|---|---|
| `stateDir` | `data/acces` (relatif à `gateway/`) | Dossier des curseurs de récupération (section 6). Chemin absolu accepté. |
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

### Clés de chaque appareil (`controllers[]`)

| Clé | Défaut | Rôle |
|---|---|---|
| `id` | **obligatoire** | Identifiant PSIM de l'appareil (lettres, chiffres, `_`, `-`, 32 caractères au plus). Unique. |
| `serial` | **obligatoire** | Numéro de série relevé sur l'étiquette (lettres et chiffres, 4 à 32 caractères). Unique. |
| `kind` | `controller` | `controller` (centrale C3 / inBio, 1 à 4 portes) ou `terminal` (une seule porte, la numéro 1). |
| `utcOffsetMin` | 0 (-720 à 840) | Écart de l'**heure locale de l'appareil** à l'heure universelle, en minutes (0 à Abidjan). Doit correspondre au réglage de l'appareil, sinon tous ses horaires sont décalés. |
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
| 203, 205 | Multi-cartes carte et empreinte ; ouverture permanente à distance | `badge_granted` | à qualifier |
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
| 5, 6, 7, 9 à 13, 26, 32, 37, 204, 206, 220, 221 | États et informations sans conséquence (liaison, fin de plage, démarrage...) | aucun message (journalisé une fois) | à qualifier |
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
sert à mesurer la dérive d'horloge.

## 6. Comportement en exploitation

### Récupération des passages manqués (F8)

La passerelle ne répond `OK` à l'appareil que lorsque **tous** les passages du lot sont en file chez elle. Sinon elle
répond 503 et l'appareil conserve ses enregistrements pour les renvoyer. À chaque poignée de main, elle indique à
l'appareil la dernière estampille acquittée (curseur gardé dans `stateDir`) : après une coupure du réseau ou un
redémarrage, l'appareil rejoue ce qu'il a en mémoire. Les doublons sont écartés, et les passages plus vieux que
`thresholds.deferredAfterS` sont marqués **différés** (affichés « en différé » côté PSIM). À qualifier : combien
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

## 7. Équipements testés / à qualifier

**Aucun matériel réel n'a été essayé : tout est « à qualifier ».**

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
- la **tenue réseau** : appareil non déclaré, adresse hors `allowFrom`, flot de requêtes : aucune fuite d'information, aucune panne.

Un recueil de trames réelles doit être joint au compte rendu ; les entrées du registre (une par modèle) ne passent à
« qualifié » qu'après cette recette.

## 8. Dépannage

Messages du journal de la passerelle (un même message ne paraît qu'une fois par minute au plus).

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
| « actionneur ... non enregistre : cette passerelle n'a pas de canal de commande » | Passerelle sans canal de commande signé | Surveillance seule ; configurer le canal de commande de la passerelle |
| « ordre unlock refuse par le controleur (porte N) : offline » | Appareil muet à ce moment | Attendre le retour de l'appareil ; aucun accusé de réussite n'est donné |
| Même message, code `timeout` | L'appareil n'a pas confirmé en `commandTimeoutS` | Vérifier `push.delayS` et le réseau ; la commande est retirée, ne pas la croire exécutée |
| Même message, code `refused_by_device` | L'appareil a répondu un code d'erreur | Essayer `push.controlFormat: "spaced"` ; relever le code (à qualifier) |
| Même message, code `not_supported` | Ordre non prévu pour ce type (`lock` / `unlock` pour une serrure, `open` / `close` pour une barrière) | Utiliser l'ordre adapté au `type` |
