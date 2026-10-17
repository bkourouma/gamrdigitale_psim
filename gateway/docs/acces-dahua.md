# Module acces-dahua : raccorder un contrôle d'accès Dahua à la Passerelle GAMR

Le module `acces-dahua` fait de la Passerelle GAMR un **client** des contrôleurs d'accès Dahua : pour chaque contrôleur,
elle ouvre le flux d'événements HTTP du constructeur (authentification Digest), lit les passages (badge, code, empreinte,
visage, bouton de sortie, ouverture à distance), acceptés **et** refusés, suit l'état des portes et traduit chaque événement
en message PSIM. Elle peut aussi, si on le déclare, exécuter une ouverture à distance demandée par le PSIM.

> **Important : aucun matériel Dahua réel n'a encore été essayé.** Le module est testé contre un contrôleur simulé, construit
> d'après la documentation publique du constructeur et des échanges publiés par des intégrateurs. Tout ce qui n'est pas
> confirmé par ces sources est marqué `A QUALIFIER` dans le code et « à qualifier » ci-dessous : faites la recette décrite
> en section 11 avant toute mise en service.

## 1. À quoi ça sert

**Équipements visés** :

- les **contrôleurs d'accès** Dahua de la famille **ASC** (par exemple ASC1204, ASC2xxx : 1 à 4 portes) ;
- les **terminaux** Dahua de la famille **ASI** (lecteurs autonomes à une porte, avec ou sans visage).

Aucun modèle précis n'est qualifié (voir section 11).

**Un détecteur PSIM de catégorie `access` par porte.** Chaque porte que l'on veut surveiller est rattachée, dans la
configuration, à un détecteur PSIM (son identifiant, par exemple `P-ENTREE`). Les passages, les ouvertures, les alarmes et le
signe de vie de cette porte arrivent sur ce détecteur. Le format du message de passage est décrit dans
`docs/CONTROLE-ACCES.md` § 2.

**Ce que le module fait** :

- reçoit les passages, acceptés **et** refusés, et l'état des portes (ouverte, refermée, forcée, maintenue ouverte) ;
- signale le sabotage du boîtier, la contrainte (alarme silencieuse `panic`), les refus répétés, l'horloge déréglée, le
  contrôleur muet ou hors ligne ;
- rapporte le **mode de chaque porte** (normal, toujours ouverte, toujours fermée), au PSIM qui l'affiche (section 8) ;
- récupère les passages manqués après une coupure du réseau (section 5) ;
- exécute, si on le déclare, les ordres d'ouverture à distance venus du canal de commande signé du PSIM (section 7) ;
- écrit dans le contrôleur, **seulement** si la clé `syncKey` du contrôleur est renseignée, les titulaires (cartes), les
  horaires et les jours fériés que le PSIM lui envoie, par le canal de synchronisation signé (section 10).

**Ce que le module ne fait pas** :

- **le contrôleur décide, pas le PSIM.** L'ouverture par badge se joue entièrement dans le contrôleur : si la passerelle ou le
  PSIM est arrêté, les portes continuent de fonctionner. Le PSIM ne prend **jamais** part à l'ouverture par badge ;
- il n'écrit **rien** dans le contrôleur de lui-même : sans `syncKey`, il ne crée, ne modifie ni ne supprime aucun badge,
  utilisateur, horaire ou jour férié ; avec `syncKey`, il n'écrit que sur un ordre signé du PSIM (section 10). Dans tous les
  cas, il **ne lit jamais** les gabarits biométriques ni les codes PIN (les enregistrements lus ne conservent que quelques
  champs, le reste est écarté dès la lecture), **n'écrit jamais** de code PIN, d'empreinte, de visage ni de photo, et ne
  **supprime** pas un titulaire dont l'accès est suspendu (la carte est gelée, section 10) ;
- il n'ouvre jamais une porte de lui-même : seule une commande signée du PSIM, déclarée dans `actuators`, peut le faire ;
- il ne sait pas verrouiller une porte « en permanence » (voir section 7).

## 2. Prérequis

### Sur le contrôleur

1. **Un compte dédié à la passerelle**, créé dans l'interface du contrôleur (par exemple `psim`). Ne jamais utiliser le
   compte administrateur. Droits minimaux : **consulter les événements** et **lire les enregistrements de passage**
   (menu de gestion des comptes du contrôleur) ; ajouter le droit de **commande des portes** seulement si le contrôleur
   déclare des `actuators` (ouverture à distance) ; le droit de lire la configuration des portes est aussi nécessaire pour
   le mode de porte (section 8) et pour l'ordre `lock` (retour au mode normal, voir section 7). Si le contrôleur reçoit les
   titulaires du PSIM (`syncKey`, section 10), le compte doit en plus pouvoir **écrire** les enregistrements de cartes
   (`recordUpdater`) et la configuration des horaires et des jours fériés. Le nom exact des droits varie selon le modèle :
   à qualifier.
2. **Un mot de passe long et propre à ce compte**, rangé dans un fichier de la passerelle (`{"$file": "secrets/..."}`, voir
   `docs/PASSERELLE.md` § 3), jamais dans la configuration en clair.
3. **Une adresse IP fixe** pour le contrôleur, sur un réseau dédié aux équipements d'accès. Le module parle en HTTP simple
   (port 80 par défaut, réglage `port`) avec authentification Digest : n'importe qui sur le même réseau peut lire le
   trafic, d'où le réseau dédié et le pare-feu entre ce réseau et le reste.
4. **L'heure du contrôleur** : à l'heure locale du site, **synchronisée par NTP** si le contrôleur sait le faire. Reporter
   l'écart avec l'heure universelle dans `utcOffsetMin` (0 à Abidjan). Sans cela, tous les horaires des passages sont
   décalés (section 6).
5. **Le service d'événements activé** et la mémoire des passages (enregistrements) non désactivée : sans elle, la récupération
   après coupure (section 5) est impossible.

### Sur la passerelle

Le module **ne reçoit aucune connexion** : c'est lui qui appelle les contrôleurs. Aucun port à ouvrir dans le pare-feu de la
passerelle ; il faut seulement qu'elle atteigne chaque contrôleur sur son port HTTP.

## 3. Configuration de la passerelle

Section `config` du module `acces-dahua` dans la configuration de la passerelle (exemple complet : un contrôleur à 2 portes
avec ouverture à distance d'une serrure et d'une barrière, un terminal à 1 porte) :

```json
{
  "stateDir": "data/acces-dahua",
  "controllers": [
    {
      "id": "ASC-ENTREE",
      "host": "192.168.10.20",
      "port": 80,
      "username": "psim",
      "password": { "$file": "secrets/acces-dahua-asc-entree.txt" },
      "utcOffsetMin": 0,
      "doorBase": 0,
      "remoteUserId": 9001,
      "epoch": 0,
      "syncKey": { "$file": "secrets/acces-dahua-asc-entree-sync.key" },
      "doors": {
        "1": "P-ENTREE",
        "2": "P-PARKING"
      },
      "actuators": {
        "SERRURE-ENTREE": { "door": 1, "type": "lock" },
        "BARRIERE-PARKING": { "door": 2, "type": "gate" }
      }
    },
    {
      "id": "ASI-ATELIER",
      "host": "192.168.10.21",
      "username": "psim",
      "password": { "$file": "secrets/acces-dahua-asi-atelier.txt" },
      "doors": {
        "1": "P-ATELIER"
      }
    }
  ],
  "thresholds": {
    "deniedCount": 3,
    "deniedWindowS": 60,
    "heartbeatS": 60,
    "clockDriftMs": 120000,
    "silenceMs": 30000,
    "offlineGraceMs": 15000,
    "longUnlockS": 60,
    "modeCheckS": 60
  },
  "schedules": {
    "min": 1,
    "max": 127
  },
  "reconnect": {
    "minMs": 1000,
    "maxMs": 60000
  }
}
```

Toute clé inconnue ou toute valeur hors bornes est refusée au démarrage, avec **toutes** les erreurs listées d'un coup (le
mot de passe et la clé de synchronisation n'apparaissent jamais dans un message d'erreur). Les sections `thresholds`,
`schedules` et `reconnect` ci-dessus montrent les valeurs par défaut : on peut les omettre, de même que `epoch` (0 par
défaut) et `syncKey` (facultative). Dans le bloc, le mot de passe et la clé de synchronisation sont donnés par
`{"$file": ...}` : le socle les remplace par le contenu du fichier avant que le module ne voie sa configuration
(`{"$env": "NOM"}` est accepté de la même façon). Le second contrôleur de l'exemple (`ASI-ATELIER`) n'a ni `epoch` ni
`syncKey` : il est surveillé comme les autres, mais il ne reçoit pas les titulaires du PSIM.

### Clés du module

| Clé | Défaut | Rôle |
|---|---|---|
| `stateDir` | `data/acces` (relatif à `gateway/`) | Dossier d'état du module : curseurs de récupération (section 5, fichier `acces-curseurs.json`) et numéros de plages horaires attribués aux horaires du PSIM (section 10, fichier `acces-plages.json`). Chemin absolu accepté. **À régler si `dataDir` change** (le contexte des modules n'expose pas encore `dataDir`). Un dossier par module est conseillé (ici `data/acces-dahua`) : ces fichiers portent le même nom pour tous les modules d'accès. |
| `controllers` | aucun, **obligatoire** | 1 à 16 contrôleurs (voir plus bas). |
| `thresholds.deniedCount` | 3 (1 à 100) | Nombre de refus qui déclenchent la pré-alarme « refus répétés ». |
| `thresholds.deniedWindowS` | 60 (1 à 86 400) | Fenêtre de ces refus, en secondes. |
| `thresholds.heartbeatS` | 60 (1 à 3600) | Période du signe de vie envoyé au PSIM, par porte. |
| `thresholds.clockDriftMs` | 120000 (1000 à 86 400 000) | Écart d'horloge contrôleur / passerelle au-delà duquel on signale une dérive. |
| `thresholds.silenceMs` | 30000 (500 à 600 000) | Silence du flux au-delà duquel le contrôleur est traité comme coupé et la connexion refaite. |
| `thresholds.offlineGraceMs` | 15000 (0 à 600 000) | Délai de grâce avant de déclarer « hors ligne ». |
| `thresholds.longUnlockS` | 60 (1 à 86 400) | Au-delà de cette durée demandée, `unlock` devient « ouverte en continu ». |
| `thresholds.modeCheckS` | 60 (0 à 86 400) | Période, en secondes, de la relecture du mode des portes (section 8). **0** : plus de relecture périodique (le mode reste lu à chaque connexion et mis à jour après un ordre du module). |
| `schedules.min`, `schedules.max` | 1 et 127 (entiers de 0 à 254, `max` ≥ `min`) | Numéros de plages horaires (`AccessTimeSchedule`) que le module peut attribuer aux horaires du PSIM (section 10). Le contrôleur en offre 128 (numéros 0 à 127, **à qualifier**) ; le 0 reste celui d'usine ; 255 est réservé à « toutes les heures » et refusé ici. À restreindre si l'installateur a déjà des plages à lui sur le contrôleur. |
| `reconnect.minMs` | 1000 (50 à 600 000) | Première attente avant de rouvrir le flux après une coupure ; elle double à chaque échec. |
| `reconnect.maxMs` | 60000 (50 à 3 600 000) | Attente maximale ; doit être supérieure ou égale à `minMs`. |

### Clés de chaque contrôleur (`controllers[]`)

| Clé | Défaut | Rôle |
|---|---|---|
| `id` | **obligatoire** | Identifiant PSIM du contrôleur (lettres, chiffres, `_`, `-`, 32 caractères au plus). Unique. |
| `host` | **obligatoire** | Adresse IP ou nom de machine du contrôleur, **sans** `http://`, sans chemin, sans espace. |
| `port` | 80 (1 à 65535) | Port HTTP du contrôleur. |
| `username` | **obligatoire** | Compte dédié (1 à 64 caractères ASCII imprimables, sans guillemet ni barre oblique inverse). |
| `password` | **obligatoire** | Mot de passe (1 à 128 caractères). Toujours par `{"$file": ...}` ou `{"$env": ...}`. |
| `utcOffsetMin` | 0 (-840 à 840) | Écart de l'**heure locale du contrôleur** à l'heure universelle, en minutes (0 à Abidjan). Doit correspondre au réglage du contrôleur. |
| `doorBase` | 0 (0 ou 1) | Numérotation des portes **dans les événements et enregistrements** du contrôleur : 0 = la première porte est la numéro 0 (vu sur un terminal ASI) ; 1 = elle est la numéro 1. **À qualifier.** N'agit pas sur la commande d'ouverture, dont le canal est toujours le numéro de la porte à partir de 1. |
| `remoteUserId` | absent (0 à 99 999 999) | Identifiant d'utilisateur transmis avec l'ordre d'ouverture à distance, pour que le contrôleur l'inscrive dans son journal. Facultatif. |
| `epoch` | 0 (entier de 0 à 999 999 999 999) | Époque du contrôleur. **À augmenter de 1 quand le contrôleur est remplacé** (sa mémoire est vide, ses numéros d'enregistrement repartent de zéro) ; ne **jamais** la diminuer. Procédure complète en section 9. |
| `syncKey` | absent | Clé de synchronisation des titulaires de ce contrôleur : **64 caractères hexadécimaux minuscules** (0-9, a-f), donnée **une seule fois** par le PSIM à la création du contrôleur. Toujours par `{"$file": "secrets/..."}` (une ligne) ou `{"$env": "NOM"}`. **Facultative : sans elle, la synchronisation est inactive** pour ce contrôleur (le journal le dit à chaque démarrage) et le module le surveille normalement. Un secret comme le mot de passe (section 10). |
| `doors` | **obligatoire** | `{ "<n° de porte 1 à 4>": "<id du détecteur PSIM>" }`. Un détecteur ne sert qu'à une porte. |
| `actuators` | aucun | Ouverture à distance : `{ "<id actionneur>": { "door": 1, "type": "lock" } }`. `door` : une porte déclarée dans `doors` ; `type` : `lock` (serrure) ou `gate` (barrière, portail). Sans `actuators`, surveillance seule. La durée de l'impulsion est celle réglée dans le contrôleur (pas de `pulseS` pour Dahua). |

## 4. Correspondance événement Dahua vers message PSIM

Les événements arrivent dans le flux du contrôleur sous la forme `Code=<nom>;action=<Start|Stop|Pulse>;index=<n>;data={...}`.
La colonne « Statut » dit si le format est confirmé par la documentation ou les échanges publiés (sources [A] documentation
Dahua « Access Control Products Integration Instruction », [B] protocole d'intégration Dahua, [C] échanges réels publiés
pour un terminal ASI), ou **à qualifier** sur matériel réel.

| Événement Dahua | Message PSIM | Statut |
|---|---|---|
| `AccessControl`, `Status` absent ou 1 | `badge_granted` | confirmé ([B], [C]) |
| `AccessControl`, `Status` 0 | `badge_denied`, motif selon `ErrorCode` (tableau ci-dessous) | confirmé pour `Status` ; motifs à qualifier |
| `Type` `Entry` / `Exit` | sens `in` / `out` ; autre ou absent : sens inconnu | confirmé ([C]) |
| `DoorStatus` `Status` Open / Close | `door_opened` / `door_closed` | à qualifier (format vu sur un interphone) |
| `DoorNotClosed` (Start, Pulse) / (Stop) | `door_held_open` (pré-alarme) / fin | à qualifier (nom du code non publié) |
| `BreakIn` (Start, Pulse) | `door_forced` (alarme) ; le `Stop` est sans objet | à qualifier |
| `ChassisIntruded` (Start) / (Stop) | `tamper` (alarme) / fin du sabotage | à qualifier |
| `Duress` (contrainte), toute action sauf `Stop` | `panic` (alarme silencieuse, toujours active) sur la porte (`Door`, sinon l'index du flux) ; le `Stop` est sans objet (une contrainte n'a pas de fin) | à qualifier (champs non publiés) |
| `AccessControl` d'une carte de contrainte (`CardType` 5) | le passage (`badge_granted` ou `badge_denied`) **et** `panic` sur la même porte | à qualifier (`CardType` vu seulement à 0 sur un ASI) |
| mode de la porte (`AccessControl[i].State`), pas un événement du flux | `door_mode` (section 8) | à qualifier |
| `RepeatEnter` (anti-retour) | aucun message (le refus est déjà signalé par le passage) | à qualifier |
| tout autre code | aucun message | sans objet |

**Méthode** (`Method`, numérotation de l'interface HTTP) :

| Valeur | Méthode PSIM | Statut |
|---|---|---|
| 0 | `code` | confirmé |
| 1, 2, 3 | `badge` (carte ; carte puis code ; code puis carte) | confirmé |
| 6 | `fingerprint` | confirmé |
| 15 | `face` | confirmé |
| 4 | `remote` | à qualifier (déduit) |
| 5 | `exit_button` | à qualifier (déduit) |
| autre | `unknown`, jamais une supposition | |

**Motifs de refus** (`ErrorCode`, pour un `Status` à 0) : **aucune table n'est publiée** dans la documentation. Les valeurs
ci-dessous viennent de la mémoire du kit de développement du constructeur et sont **toutes à qualifier** ; une valeur
absente de la table donne `other`.

| `ErrorCode` | Motif PSIM |
|---|---|
| 0x10 | `unknown_credential` |
| 0x11, 0x12 | `disabled` |
| 0x14 | `expired` |
| 0x15 | `antipassback` |
| 0x17 | `door_locked` |
| 0x20, 0x21 | `out_of_schedule` |
| 0x65 (température), 0x66 (sans masque) | `other` (confirmé par [B]) |
| autre, ou absent | `other` ; un refus sans code lors d'une saisie de code donne `wrong_pin` (à qualifier) |

**Principes sûrs** :

- une valeur de `Status` autre que 1 est traitée comme un **refus** (jamais un accès « accepté » supposé) ;
- un numéro de porte illisible ou hors plage donne **aucun message** (jamais un passage attribué à la mauvaise porte) ; une
  porte absente de `doors` est ignorée, avec un avertissement dans le journal ; une contrainte qui ne peut pas être
  attribuée à une porte n'est pas transmise, et le journal le dit (jamais en silence) ;
- en mode `code`, aucun numéro n'est transmis ; sinon le numéro de carte (`CardNo`) l'est, jamais un code PIN ;
- le nom du titulaire vient de `CardName` seulement (`Name` est le nom de l'action, pas celui d'une personne) ;
- l'heure vient de `UTC` (secondes), sinon `CreateTime`, sinon `LocaleTime` (convertie avec `utcOffsetMin`), sinon l'heure de
  réception ; une heure à plus de 24 h dans le futur est écartée ;
- l'identifiant d'événement est le `RecNo` du contrôleur (`epoch` à 0) ou `<epoch>.<RecNo>` (`epoch` supérieure à 0, voir
  section 9) ; sans `RecNo` (certains terminaux), le module le complète avec la mémoire du contrôleur et, à défaut, au bout
  de quelques secondes, fabrique un identifiant déterministe (à qualifier).

## 5. Récupération des passages manqués (F8)

Après une coupure du réseau ou un redémarrage de la passerelle, le module relit la mémoire du contrôleur
(`recordFinder.cgi`, enregistrements `AccessControlCardRec`) et rejoue les passages manqués, marqués **différés** côté PSIM :

- **Déclenchement** : à chaque (re)connexion du flux, puis chaque fois qu'un passage du flux est refusé par la passerelle
  (file pleine) ou qu'un événement du flux n'a pas de numéro d'enregistrement.
- **Curseur** : le dernier `RecNo` traité est gardé dans `stateDir` (fichier `acces-curseurs.json`, un curseur par
  contrôleur). Il n'avance **jamais** au-delà d'un passage que le socle a refusé : rien n'est perdu, et la passe repart du
  dernier curseur sûr. Les doublons sont écartés par numéro d'enregistrement. **Chaque époque a son propre curseur** (clé
  `<id>` pour l'époque 0, `<id>~e<epoch>` ensuite) : après un remplacement du contrôleur (section 9), la récupération
  repart de zéro sans jamais comparer un numéro du nouveau contrôleur à celui de l'ancien.
- **Fenêtre** : lecture par fenêtres de temps et par pages de 200 enregistrements, à partir de l'heure du curseur moins
  10 minutes de marge, en ordre croissant de numéro.
- **Premier démarrage** (aucun curseur, y compris le premier démarrage d'une nouvelle époque) : on ne rejoue **pas** tout
  l'historique, seulement les **24 dernières heures** (valeur à qualifier).
- **Bornes** : au plus 5 000 enregistrements examinés par passe (la passe suivante continue), 200 par page ; si plus de 200
  enregistrements partagent la même seconde, le module avance d'une seconde et le dit dans le journal.
- **Pendant la passe** : les passages du flux arrivés entre-temps sont gardés puis émis ensuite, dans l'ordre des numéros ;
  tant que la récupération n'est pas complète, ils partent sans curseur.
- **Non pris en charge** : si le contrôleur répond 404 ou 400, le module le consigne une fois et continue sans récupération.
- À qualifier : taille de la mémoire du contrôleur, ordre des enregistrements, et si le numéro `RecNo` repart de zéro après
  une remise à zéro du contrôleur.

## 6. Comportement en exploitation

### Dérive d'horloge

Au démarrage du flux, puis lorsqu'une dérive est suspectée, le module lit l'heure du contrôleur
(`global.cgi?action=getCurrentTime`, heure locale) et la compare à celle de la passerelle. Au-delà de
`thresholds.clockDriftMs` (2 minutes), le détecteur reçoit `clock_drift` (« Horloge de l'équipement déréglée »), répété
toutes les 5 minutes tant que dure l'écart ; le retour sous 1 minute le rétablit. Vérifier `utcOffsetMin` avant d'accuser le
contrôleur.

### Hors ligne et signes de vie

Chaque partie reçue du flux (y compris le signe de vie du contrôleur) est une preuve de vie. En ligne, chaque porte reçoit un
`heartbeat` toutes les `thresholds.heartbeatS` secondes. Si le flux se ferme, ou reste **muet** plus de `silenceMs` (30 s), la
connexion est refaite (attente croissante de `reconnect.minMs` à `reconnect.maxMs`, remise à zéro après une connexion
stable) et chaque porte reçoit `{"state":"offline"}` **une seule fois**, après le délai de grâce `offlineGraceMs`. Jamais
« fermée » à tort. Au retour, un `heartbeat` immédiat est envoyé, puis l'heure et l'état des portes sont relus et les
passages manqués récupérés. La lecture d'état d'une porte (`getDoorStatus`) est à qualifier : si le contrôleur ne la
connaît pas, le module le consigne et les signes de vie suffisent.

### Refus répétés

Un refus n'est jamais une alarme à lui seul. `deniedCount` refus (3) en `deniedWindowS` secondes (60) sur une même porte
déclenchent `badge_denied_repeated` (pré-alarme), puis le compteur de la porte repart de zéro.

### Identifiants refusés : pause de 5 minutes

Un compte Dahua se bloque après quelques échecs. Dès que le contrôleur refuse les identifiants, le module n'essaie **plus
rien pendant 5 minutes** (flux et requêtes compris, la barrière est commune), puis réessaie une seule fois. Corriger le mot
de passe ou le compte sur le contrôleur, puis redémarrer la passerelle pour reprendre sans attendre.

## 7. Ouverture à distance

Elle n'existe que si le contrôleur déclare `actuators` **et** que la passerelle a le canal de commande signé (sinon le
journal dit « ouverture à distance indisponible ... »). Le socle vérifie signature, fraîcheur et plafonds ; le module exécute :

| Ordre | Effet sur le contrôleur |
|---|---|
| `unlock` (serrure), `open` (barrière) | Impulsion d'ouverture (`openDoor`) : la porte s'ouvre pour la durée réglée dans le contrôleur. Si une durée supérieure à `longUnlockS` est demandée : mode « toujours ouverte » (`OpenAlways`) ; le socle rappelle `lock` à la fin de la durée. |
| `lock` (serrure), `close` (barrière) | Retour au **mode normal** (`Normal`) **puis** refermeture immédiate (`closeDoor`) : les badges fonctionnent de nouveau. |
| `stop`, et tout autre ordre | Refusé (`not_supported`) : un contrôleur de portes ne sait pas arrêter une barrière en mouvement. |

- **Jamais « toujours fermée »** : « verrouiller » ne coupe pas les badges (une porte qui refuserait tous les badges
  enfermerait ou exclurait du monde, issue de secours comprise).
- **Accusé seulement après réponse `OK` du contrôleur.** Chaque appel n'est considéré réussi que si le contrôleur a répondu
  `OK` ; toute autre réponse est un échec. Les codes d'accusé : `refused_by_device` (réponse refusée, identifiants refusés,
  réponse inattendue, mode de la porte introuvable), `timeout` (pas de réponse), `unreachable` (contrôleur injoignable),
  `not_supported`.
- Pour changer le mode d'une porte, le module **lit d'abord** la configuration d'accès et n'écrit que la clé `State` de la
  porte visée ; rien n'est écrit si le mode est déjà le bon. Les ordres visant la même porte sont exécutés l'un après l'autre.
  Dès que le contrôleur a confirmé le nouveau mode, le module le signale au PSIM (`door_mode`, section 8) sans attendre la
  relecture périodique.
- À qualifier : l'indice de la porte dans la table de configuration et la présence de la clé `State` selon le modèle.

## 8. Mode de porte (F19)

Le PSIM affiche, pour chaque porte, son **mode** : `normal` (les badges décident), `always_open` (toujours ouverte) ou
`always_closed` (toujours fermée). Le module le lit dans le contrôleur et l'envoie sur le détecteur de la porte :

```
{"event":"door_mode","doorMode":"normal"}      (ou "always_open", "always_closed")
```

- **Lecture** : `configManager.cgi?action=getConfig&name=AccessControl`, clé `AccessControl[i].State` où `i` est le numéro
  de la porte moins 1 (une seule requête pour toutes les portes du contrôleur). Valeurs reconnues : `Normal`, `OpenAlways`,
  `CloseAlways`. Toute autre valeur, une clé absente ou une réponse illisible **n'émet rien** (jamais un mode deviné) ; le
  journal le dit au plus une fois par minute.
- **Quand** : à chaque (re)connexion du contrôleur, puis toutes les `thresholds.modeCheckS` secondes (60 ; **0** supprime la
  relecture périodique), et **tout de suite après un ordre** `unlock` de longue durée ou `lock` exécuté par le module : le
  contrôleur vient de confirmer le mode, il est signalé sans attendre.
- **Pas de bruit** : un mode identique au dernier mode envoyé n'est pas renvoyé. En revanche, à chaque **retour en ligne**
  le dernier mode connu est renvoyé une fois (le PSIM voit la porte revenir).
- **Signe de vie** : `door_mode` compte comme un signe de vie pour le PSIM, donc il ne part **jamais** tant que le contrôleur
  n'est pas joignable (il est gardé et envoyé au retour), et jamais pour un mode ancien lu en différé.
- **Jamais « toujours fermée » par le module** : il ne l'écrit jamais (section 7) ; il se contente de la rapporter si
  quelqu'un l'a réglée sur le contrôleur.
- **A QUALIFIER** sur matériel : l'indice de la porte dans la table `AccessControl` (0 ou 1 pour la première porte), la
  présence et l'orthographe de la clé `State`, et la liste complète de ses valeurs selon le modèle.

## 9. Remplacement d'un contrôleur (`epoch`)

Quand un contrôleur est remplacé par un neuf (ou remis à zéro en usine), sa mémoire de passages est vide et ses numéros
d'enregistrement (`RecNo`) **repartent de zéro**. Sans précaution, un nouveau passage n° 12 serait pris pour l'ancien
passage n° 12 déjà connu du PSIM (rejeté comme doublon), et le curseur de récupération, resté très en avance, ferait
ignorer les passages manqués. La clé `epoch` du contrôleur sépare l'ancien du nouveau.

**Quand l'augmenter** : seulement quand la mémoire du contrôleur a été effacée ou que le matériel a été changé. Pas pour un
simple redémarrage, une coupure de courant ou un changement d'adresse IP.

**Ce qui se passe** : avec `epoch` supérieure à 0 (valeur `E`),

- l'identifiant d'événement de chaque passage devient `E.<n° d'enregistrement>` (par exemple `1.12`) au lieu de `12` : un
  passage du nouveau contrôleur ne peut plus être confondu avec un ancien ; l'identifiant de message est
  `acc:<contrôleur>:E.<n°>` ;
- le curseur de récupération est **propre à l'époque** (clé `<id>~eE`) : il repart de zéro ;
- au premier démarrage de l'époque, la récupération (section 5) rejoue **au plus les 24 dernières heures** de la mémoire du
  contrôleur, marquées « différées » ; elle ne relit jamais tout l'historique ;
- l'ancien curseur n'est plus consulté.

**Ce que voit le PSIM** : les passages de l'ancien contrôleur gardent leur identifiant (`12`) ; ceux du nouveau portent
`E.<n°>`. Le journal des accès est donc continu et sans doublon rejeté. Les passages rejoués du nouveau contrôleur
apparaissent « en différé ».

**Procédure pas à pas (installateur)** :

1. Installer le nouveau contrôleur à la même adresse IP (ou noter la nouvelle), le régler comme l'ancien : compte dédié et
   droits (section 2), heure locale et NTP, numérotation des portes, service d'événements activé. L'**heure** doit être
   juste avant de continuer : elle sert à dater les passages.
2. Dans `config.json`, pour **ce** contrôleur seulement, passer `epoch` de sa valeur actuelle à la valeur **suivante** (0
   devient 1, 1 devient 2, etc.). Si l'adresse IP ou le mot de passe ont changé, les corriger dans la même modification.
   Ne toucher à aucune autre clé.
3. Si le contrôleur reçoit les titulaires du PSIM (`syncKey`), prévenir l'administrateur du PSIM : le nouveau contrôleur est
   **vide** (ni cartes, ni horaires, ni jours fériés). La clé de synchronisation et les numéros de plages du module ne
   changent pas, mais c'est au PSIM de renvoyer l'ensemble des titulaires (section 10).
4. **Redémarrer le module** : `.\scripts\gateway-service.ps1 -Action Restart` (la configuration n'est lue qu'au
   démarrage). Le module relit sa configuration ; une `epoch` invalide est refusée avec la liste des erreurs.
5. **Vérifier** dans le journal de la passerelle : « de nouveau joignable » pour le contrôleur, puis, si la mémoire du
   nouveau contrôleur contenait des passages des dernières 24 heures, « N passage(s) recupere(s) dans la memoire du
   controleur ». Faire passer un badge : dans le PSIM, le passage doit apparaître avec un identifiant d'événement de la forme
   `E.<n°>`, sur la bonne porte, à l'heure exacte. Vérifier aussi le mode des portes (section 8) et, si besoin, l'ouverture
   à distance (section 7).
6. Noter l'opération (date, ancienne et nouvelle valeur de `epoch`, numéro de série du nouveau contrôleur) dans le dossier
   d'installation : cela évite de restaurer plus tard une ancienne copie de `config.json` avec l'ancienne valeur.

**Ne JAMAIS diminuer `epoch`** (ni la remettre à 0) : les passages reprendraient les identifiants d'une époque passée,
seraient rejetés comme doublons par le PSIM, et le module réutiliserait un curseur périmé. Si une erreur a été faite en
l'augmentant (valeur trop haute), la laisser telle quelle : une époque inutilisée ne coûte rien. Si on oublie de l'augmenter,
les symptômes sont : passages du nouveau contrôleur absents du PSIM ou récupération qui ne rejoue rien ; augmenter alors
`epoch` et redémarrer (les passages des dernières 24 heures sont rejoués sous la nouvelle époque ; quelques passages déjà
reçus sous l'ancien identifiant peuvent alors apparaître deux fois).

## 10. Synchronisation des titulaires (PSIM vers contrôleur)

**Principe.** Le PSIM tient la liste des titulaires (nom, badges, validité, portes, horaires) et la pousse vers chaque
contrôleur, **une opération à la fois**, par un ordre signé que la passerelle vérifie puis remet au module (contrat :
`docs/CONTROLE-ACCES.md` § 7 ; côté passerelle : `docs/PASSERELLE.md`, section « Synchronisation des titulaires »). Le
module traduit chaque opération en appels HTTP vers le contrôleur et ne répond « fait » que si le contrôleur a répondu.

**Activation par contrôleur.** Elle se fait par la clé `syncKey` du contrôleur :

1. dans le PSIM, créer le contrôleur : le PSIM affiche sa **clé de synchronisation** (64 caractères hexadécimaux) **une
   seule fois** ;
2. l'écrire dans un fichier de la passerelle, **sur une seule ligne**, par exemple
   `gateway\secrets\acces-dahua-asc-entree-sync.key`, protégé comme le mot de passe du contrôleur (`icacls`, voir
   `docs/PASSERELLE.md` § 2) ;
3. la référencer dans la configuration du contrôleur : `"syncKey": { "$file": "secrets/acces-dahua-asc-entree-sync.key" }` ;
4. redémarrer la passerelle. Journal attendu : aucun « synchronisation des titulaires inactive pour ... (pas de syncKey) ».

**Sans `syncKey` la synchronisation est inactive** : le module surveille le contrôleur normalement, mais ne lui écrit rien.
Le socle de la passerelle ne s'abonne même pas aux ordres de ce contrôleur.

**Jamais de PIN, d'empreinte, de visage ni de photo.** Aucun ordre ne peut en porter (tout champ de ce nom est refusé) et le
module n'appelle ni `FaceInfoManager.cgi` ni `AccessUser.cgi`. Le code PIN d'un titulaire reste dans le contrôleur : une mise
à jour de sa fiche laisse intacts les champs que le module n'envoie pas. Dans les journaux, jamais de nom, de numéro de
badge ni de référence de titulaire : seulement le type d'opération, le résultat et les 8 premiers caractères de l'identifiant
d'opération.

### Plages horaires

Chaque horaire du PSIM reçoit un **numéro de plage** du contrôleur (`AccessTimeSchedule[n]`), choisi dans l'intervalle
`schedules.min` à `schedules.max` (1 à 127 par défaut) : le plus petit numéro libre. La correspondance est gardée dans
`acces-plages.json` (dossier `stateDir`) et survit aux redémarrages ; une attribution n'est jamais conservée si le contrôleur
n'a pas confirmé l'écriture. Plus aucun numéro libre : refus `full`. Un titulaire « sans horaire » reçoit la plage 255
(« toutes les heures »).

Un horaire du PSIM est une liste de plages hebdomadaires. Conversion : 7 jours (0 = dimanche) de **4 segments** chacun ; une
plage qui passe minuit est coupée en deux (fin de journée, début du lendemain) ; les segments qui se touchent ou se
chevauchent sont fusionnés ; les 28 segments sont **toujours** écrits (l'ancien contenu est remplacé, jamais complété). Plus
de 4 segments distincts dans un même jour : refus `not_supported`.

**Horaire « fermé les jours fériés »** : le contrôleur n'a, à notre connaissance, aucune correspondance documentée pour cela.
Plutôt que d'ouvrir l'accès un jour que le PSIM croit fermé, le module **refuse** l'horaire (`not_supported`, **A QUALIFIER**
sur matériel). L'administrateur du PSIM doit alors utiliser un horaire sans cette option. Les jours fériés eux-mêmes sont
bien écrits (voir plus bas) mais ne ferment aucune plage.

### Correspondance opération PSIM vers appels Dahua

Tous les appels sont des requêtes HTTP GET (Digest) vers le contrôleur ; chaque écriture n'est réussie que sur la réponse
attendue (`OK`, ou `RecNo=<n>` pour une insertion). Au plus 400 requêtes par opération.

| Opération PSIM | Appels Dahua | Statut |
|---|---|---|
| `upsert_holder` (créer ou mettre à jour un titulaire) | `recordFinder.cgi?action=find&name=AccessControlCard&condition.UserID=<réf>` (cartes déjà connues du titulaire) ; pour chaque badge : `recordUpdater.cgi?action=update&...&recno=<RecNo>` si la carte existe, sinon `action=insert` (un badge déjà connu du contrôleur sous un autre titulaire est repris par une recherche `condition.CardNo`) ; puis `action=remove` des cartes que le PSIM ne connaît plus pour ce titulaire | `insert` confirmé ; `find`, `update`, `remove` à qualifier |
| `delete_holder` | `find` par `UserID`, puis `remove` de **chaque** carte du titulaire | à qualifier |
| `upsert_schedule` | `configManager.cgi?action=setConfig&AccessTimeSchedule[n].Name=PSIM <réf>&AccessTimeSchedule[n].TimeSchedule[jour][segment]=...` (28 segments) | à qualifier |
| `delete_schedule` | même `setConfig` avec les 28 segments désactivés et un nom vide ; la plage est libérée | à qualifier |
| `set_holidays` | `recordFinder.cgi?action=find&name=AccessControlHoliday`, puis `recordUpdater.cgi` `insert` / `update` (un enregistrement par date, numéro `PSIM-AAAA-MM-JJ`, journée entière, toutes les portes déclarées) et, avec `replace`, `remove` des dates retirées | à qualifier |

Conversions de la fiche carte : la référence du titulaire (`H<n>`) devient `UserID` **telle quelle** (le `H` est conservé ;
un firmware qui n'accepte qu'un identifiant numérique refusera l'opération, `refused_by_device`, visible) ; le nom est tronqué
à 32 caractères ; `Doors[k]` = numéro de porte moins 1 et `TimeSections[k]` = numéro de plage (ou 255) ; `ValidDateStart`
et `ValidDateEnd` sont **toujours** envoyées (valeurs larges, 2000 à 2037, quand le PSIM n'a pas de limite) pour qu'une mise à
jour efface une ancienne limite ; les dates sont écrites en heure locale du contrôleur (`utcOffsetMin`). Seuls les jours
fériés `PSIM-...` écrits par le module sont gérés : ceux que l'installateur a saisis à la main ne sont jamais touchés.

### Suspension au lieu de suppression

Un titulaire **inactif**, dont la validité est **dépassée**, ou qui n'a **aucune porte** n'est jamais supprimé : sa carte
est **gelée** (`CardStatus=4`), réversible. Elle redevient normale (`CardStatus=0`, `IsValid=true`) à la prochaine mise à jour
active. Seule l'opération `delete_holder` supprime les cartes.

### Résultats

Le module répond au PSIM par l'un des résultats suivants (le socle les signe et les accuse) :

| Résultat | Code | Cas |
|---|---|---|
| `done` | | opération faite, confirmée par le contrôleur |
| `refused` | `full` | plus de numéro de plage libre, ou contrôleur plein (réponse contenant « full », « no space », « capacity »... ; **A QUALIFIER** : aucun texte n'est publié) |
| `refused` | `not_supported` | horaire « fermé les jours fériés », plus de 4 segments dans un jour, ou fonction absente du contrôleur (HTTP 404) |
| `refused` | `invalid` | ordre mal formé (champ inconnu, champ interdit, date impossible...), porte absente de `doors`, horaire inconnu pour un titulaire (le PSIM doit d'abord envoyer l'horaire), numéro de plage hors limites |
| `error` | `refused_by_device`, `timeout`, `unreachable`, `busy`, `io` | le contrôleur a refusé (identifiants, droits, champ refusé), n'a pas répondu, est injoignable, ou le module a plus de 32 opérations en attente ; le PSIM réessaie avec attente croissante |

Un refus (`refused`) ne se rejoue pas tel quel : la demande est inacceptable. Une erreur (`error`) se réessaie. Ces résultats
sont visibles dans l'écran de synchronisation du PSIM.

## 11. A qualifier : équipements testés

**Aucun matériel réel n'a été essayé : tout est « à qualifier ».** Points marqués `A QUALIFIER` dans le code du module :

- numérotation des portes dans les événements (`doorBase`, 0 ou 1) ;
- valeurs de `Method` 4 (ouverture à distance) et 5 (bouton de sortie) ;
- table des `ErrorCode` (motifs de refus) et motif d'un refus sans code lors d'une saisie de code ;
- identifiant synthétique d'un événement sans `RecNo` ;
- format des événements `DoorStatus`, `DoorNotClosed`, `BreakIn`, `ChassisIntruded` sur ASC et ASI ;
- commande `getDoorStatus` (lecture de l'état d'une porte) ;
- lecture et écriture du mode de la porte (`configManager.cgi`, `AccessControl[i].State` : indice de la table, présence de la
  clé, valeurs possibles) ;
- événement `Duress` (champs, porte) et valeur `CardType` 5 d'une carte de contrainte ;
- numérotation des enregistrements : le `RecNo` repart-il de zéro après une remise à zéro du contrôleur ? (c'est ce que
  l'`epoch` de la section 9 suppose) ;
- fenêtre de 24 h du premier démarrage de la récupération ;
- synchronisation des titulaires (section 10) : lecture `find` par `condition.UserID` / `condition.CardNo`, `update` et
  `remove` par `recno` sur `AccessControlCard` ; `UserID` qui accepte le `H` du PSIM ; `CardStatus=4` (carte gelée) qui bloque
  bien l'accès sans supprimer la carte, et `IsValid=true` à la remise en service ; `TimeSections[i]` / `Doors[i]` comme
  indices des tableaux de portes et de plages (255 = toutes les heures) ;
- plages horaires : `AccessTimeSchedule` (128 plages, numéro 0 d'usine, 7 jours de 4 segments, jour 0 = dimanche) et son
  format `<actif> hh:mm:ss-hh:mm:ss` ;
- jours fériés : `AccessControlHoliday` (champs `HolidayNo`, `StartTime`, `EndTime`, `Enable`, portes) et leur effet sur les
  plages ; **un horaire « fermé les jours fériés » est refusé** (`not_supported`) tant que ce comportement n'est pas
  qualifié ;
- texte de la réponse d'un contrôleur plein (code `full`) ;
- modèle accepté pour le nom (32 caractères) et la validité 2000-2037 d'une fiche carte.

| Famille (registre `qualification/registry.json`) | Équipement | Statut |
|---|---|---|
| `generic-acces-dahua-asc` | Contrôleurs ASC (flux d'événements HTTP) | à qualifier |
| `generic-acces-dahua-asi` | Terminaux ASI (flux d'événements HTTP) | à qualifier |

Ce que la recette sur site doit constater (fiche `docs/qualification/controle-acces.md`, profils « contrôleur » et
« terminal ») :

- le **flux** : connexion avec le compte dédié, premier signe de vie, `doorBase` réel ;
- des **passages réels** (accepté, inconnu, expiré, hors horaire, bouton de sortie, sabotage, porte forcée, maintenue
  ouverte, contrainte) avec leur méthode, leur sens et leur motif ;
- la **mémoire hors ligne** : couper le réseau, passer des badges, rétablir, constater les passages « différés » sans doublon
  ni trou, y compris après redémarrage de la passerelle ;
- la **dérive d'horloge** et la justesse de `utcOffsetMin` ;
- la **coupure de liaison** (hors ligne une seule fois, jamais « fermée »), le rétablissement et le « muet » ;
- l'**ouverture à distance** : impulsion, ouverture continue, retour au normal, accusé seulement après `OK` ;
- le **mode de porte** : lecture à la connexion, changement du mode au panneau du contrôleur puis relecture, et mise à jour
  après un ordre du PSIM ;
- la **contrainte** : code ou carte de contrainte, alarme `panic` sur la bonne porte ;
- le **remplacement d'un contrôleur** : procédure de la section 9 sur un contrôleur réellement remplacé (ou remis à zéro),
  vérifier les identifiants `E.<n°>` dans le PSIM ;
- la **synchronisation** : créer, modifier, suspendre (carte gelée), réactiver et supprimer un titulaire ; un horaire, un
  titulaire sans horaire, un titulaire à plusieurs portes ; des jours fériés ; un contrôleur plein ; vérifier à chaque fois
  sur le contrôleur lui-même (et par un passage de badge) que l'accès est bien celui attendu ;
- les **identifiants refusés** : une seule tentative puis 5 minutes de pause, sans blocage du compte.

Un recueil d'échanges réels doit être joint au compte rendu ; les entrées du registre ne passent à « qualifié » qu'après
cette recette.

## 12. Dépannage

Messages du journal de la passerelle (un même message ne paraît qu'une fois par minute au plus). Les lignes de la
synchronisation commencent par `[synchro]` quand elles viennent du socle de la passerelle (voir aussi `docs/PASSERELLE.md`).

| Symptôme | Cause probable | Action |
|---|---|---|
| Le module refuse de démarrer, « Module acces-dahua : configuration invalide » | Clé inconnue, valeur hors bornes, `host` avec `http://`, mot de passe absent | Lire la liste des erreurs, corriger la configuration |
| « flux d'evenements ferme (...) ; nouvel essai dans N s » | Contrôleur éteint, câble, mauvaise adresse ou port, coupure | Contrôler alimentation et réseau ; le module réessaie seul avec attente croissante |
| « requete ... en echec (connexion refusee (port HTTP du controleur ferme ?)) » | Mauvais `port`, service HTTP du contrôleur arrêté | Vérifier le port sur le contrôleur |
| « identifiants refuses » (requête en échec ou flux fermé) puis plus rien pendant 5 min | Mot de passe ou compte faux, ou compte bloqué | Corriger le compte sur le contrôleur, redémarrer la passerelle ; la pause évite de bloquer le compte |
| « flux muet : aucun signe de vie » | Le flux ne donne plus rien depuis `silenceMs` | Vérifier le réseau ; ajuster `silenceMs` seulement si le contrôleur est légitimement silencieux |
| « muet depuis plus de N s, traite comme une coupure » puis « portes declarees hors ligne » | Contrôleur injoignable | Le retour est journalisé « de nouveau joignable » |
| « evenement pour une porte non declaree (N), ignore » | Numérotation des portes décalée (`doorBase`) ou porte absente de `doors` | Essayer `doorBase: 1`, ou déclarer la porte |
| « porte hors plage ou inconnue » (aucun passage) | Idem | Idem |
| « horloge deregle de N s » | Heure du contrôleur fausse, ou `utcOffsetMin` erroné | Régler l'heure (NTP), vérifier `utcOffsetMin` |
| « heure du controleur illisible » | Réponse inattendue à la lecture de l'heure | Relever la réponse réelle (à qualifier) |
| « lecture de l'etat des portes non prise en charge, les signes de vie suffisent » | Le modèle ne connaît pas `getDoorStatus` | Sans gravité |
| « un passage a ete refuse par la passerelle, il sera relu dans la memoire du controleur » | File de la passerelle pleine | Vérifier le lien vers le PSIM ; rien n'est perdu |
| « recuperation des passages incomplete (...) ; nouvel essai dans N s » | Réseau, ou passerelle pleine | Attendre ; le curseur ne bouge pas tant que la passe n'est pas complète |
| « memoire du controleur illisible ... les passages manques pendant une coupure ne pourront pas etre rejoues » | Le modèle ne propose pas la lecture de sa mémoire (HTTP 404 ou 400) | Surveillance en direct seule ; à qualifier |
| « N passage(s) recupere(s) dans la memoire du controleur » | Information : reprise après coupure | Aucune |
| « plus d'enregistrements dans une meme seconde que la taille d'une page » | Rafale de passages | Certains peuvent manquer ; signaler |
| « aucun signe de vie depuis le demarrage, traite comme une coupure » | Contrôleur jamais joint depuis le démarrage de la passerelle | Contrôler adresse, port, compte et réseau |
| « alarme de contrainte sur la porte N » (ou « ... (carte de contrainte) ») | Un utilisateur a utilisé le code ou la carte de contrainte : l'alarme `panic` part vers le PSIM | Information ; agir selon la procédure du site |
| « contrainte non transmise » (porte hors plage ou inconnue) | Une contrainte ne peut pas être attribuée à une porte déclarée | Vérifier `doorBase` et `doors` : une contrainte non transmise est une alarme perdue |
| « mode des portes illisible (HTTP N) » | Le contrôleur refuse la lecture de sa configuration `AccessControl` (droits du compte, modèle) | Vérifier les droits du compte ; à qualifier |
| « mode de la porte N absent ou inconnu, rien n'est signale » | La clé `AccessControl[N-1].State` est absente, ou sa valeur n'est pas `Normal`, `OpenAlways` ou `CloseAlways` | Aucun mode n'est affiché pour cette porte ; relever la réponse réelle (à qualifier), éventuellement `doors` mal numérotées |
| « porte N : mode X -> Y » | Information : l'ordre du PSIM a changé le mode de la porte | Aucune |
| « mode pour une porte inconnue (N), ignore » / « mode de porte inconnu, ignore » | Mode lu pour une porte hors `doors`, ou valeur hors contrat | Vérifier `doors` |
| Les passages d'un contrôleur remplacé n'arrivent pas dans le PSIM, ou la récupération ne rejoue rien | `epoch` pas augmentée après le remplacement (section 9) | Augmenter `epoch` de 1 pour ce contrôleur, redémarrer la passerelle ; ne jamais la diminuer |
| « Module acces-dahua : configuration invalide » avec « epoch » | `epoch` négative, décimale ou trop grande | Entier de 0 à 999999999999 |
| « synchronisation des titulaires inactive pour ... (pas de syncKey) » | Information : le contrôleur n'a pas de `syncKey` | Ajouter la clé donnée par le PSIM (section 10) pour activer la synchronisation |
| « Module acces-dahua : configuration invalide » avec « syncKey » | La clé n'est pas 64 hexadécimaux minuscules (copie incomplète, majuscules, espace ou saut de ligne en trop dans le fichier) | Recopier la clé telle que le PSIM l'a donnée, sur une seule ligne ; si elle est perdue, en faire créer une nouvelle au PSIM |
| « configuration invalide » avec « schedules » | `min` ou `max` hors de 0 à 254, ou `max` inférieur à `min` | Corriger les numéros de plages |
| « controleur ... : synchronisation des titulaires non enregistree, surveillance des portes seule (...) » | Le socle a refusé la clé ou l'identifiant, ou un autre module suit déjà ce contrôleur | Lire la cause entre parenthèses ; la surveillance des portes continue |
| « synchronisation des titulaires indisponible, le socle de cette passerelle n'a pas de canal de synchronisation des titulaires » | Passerelle plus ancienne que le module | Mettre la passerelle à jour |
| « controleur ... : synchronisation <type> -> refused (not_supported) » | Horaire « fermé les jours fériés », plus de 4 plages dans un jour, ou fonction absente du contrôleur | Dans le PSIM, simplifier l'horaire (sans l'option jours fériés) ; sinon à qualifier |
| « ... -> refused (invalid) » | Ordre mal formé, porte absente de `doors`, ou horaire pas encore envoyé au contrôleur | Déclarer la porte dans `doors` ; laisser le PSIM envoyer l'horaire avant le titulaire |
| « ... -> refused (full) » | Plus de numéro de plage dans `schedules.min` à `schedules.max`, ou contrôleur plein | Supprimer des horaires inutiles dans le PSIM, ou élargir `schedules` ; sinon vider le contrôleur |
| « ... -> error (refused_by_device) » | Droits d'écriture insuffisants, `UserID` non numérique refusé, champ refusé par le micrologiciel | Vérifier les droits du compte ; relever la réponse (à qualifier) |
| « ... -> error (timeout) » ou « (unreachable) » | Contrôleur muet ou injoignable | Le PSIM réessaie ; contrôler le réseau |
| « ... -> error (busy) » | Plus de 32 opérations en attente dans le module | Le PSIM réessaie plus tard |
| « attribution des plages non ecrite sur le disque (nouvel essai plus tard) » | Dossier `stateDir` en lecture seule ou plein | Donner au compte de service le droit d'écrire dans `stateDir` |
| « fichier des plages horaires d'acces illisible : etat vide » | `acces-plages.json` corrompu | Le module repart sans correspondance : le PSIM doit renvoyer ses horaires (une plage déjà écrite sur le contrôleur n'est plus rattachée) |
| « actionneur « X » non enregistre : ouverture a distance indisponible, surveillance seule (...) » | L'actionneur n'est pas déclaré dans la section `actuators` de la passerelle pour ce module, ou la passerelle n'a pas de canal de commande | Les passages continuent d'être rapportés ; déclarer l'actionneur (`docs/PASSERELLE.md`, section 8) ou ignorer si la surveillance seule suffit |
| « ordre unlock refuse par le controleur (porte N) : refused_by_device » | Réponse non `OK`, droits insuffisants du compte, mode de la porte introuvable | Vérifier les droits du compte ; relever la réponse (à qualifier) |
| Même message, code `timeout` ou `unreachable` | Contrôleur muet ou injoignable | Ne pas croire la porte ouverte ; aucun accusé de réussite n'est donné |
| Même message, code `not_supported` | Ordre non prévu pour ce type (`lock` / `unlock` pour une serrure, `open` / `close` pour une barrière, jamais `stop`) | Utiliser l'ordre adapté au `type` |
