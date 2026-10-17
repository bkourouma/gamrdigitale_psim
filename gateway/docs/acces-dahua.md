# Module acces-dahua : raccorder un contrôle d'accès Dahua à la Passerelle GAMR

Le module `acces-dahua` fait de la Passerelle GAMR un **client** des contrôleurs d'accès Dahua : pour chaque contrôleur,
elle ouvre le flux d'événements HTTP du constructeur (authentification Digest), lit les passages (badge, code, empreinte,
visage, bouton de sortie, ouverture à distance), acceptés **et** refusés, suit l'état des portes et traduit chaque événement
en message PSIM. Elle peut aussi, si on le déclare, exécuter une ouverture à distance demandée par le PSIM.

> **Important : aucun matériel Dahua réel n'a encore été essayé.** Le module est testé contre un contrôleur simulé, construit
> d'après la documentation publique du constructeur et des échanges publiés par des intégrateurs. Tout ce qui n'est pas
> confirmé par ces sources est marqué `A QUALIFIER` dans le code et « à qualifier » ci-dessous : faites la recette décrite
> en section 8 avant toute mise en service.

## 1. À quoi ça sert

**Équipements visés** :

- les **contrôleurs d'accès** Dahua de la famille **ASC** (par exemple ASC1204, ASC2xxx : 1 à 4 portes) ;
- les **terminaux** Dahua de la famille **ASI** (lecteurs autonomes à une porte, avec ou sans visage).

Aucun modèle précis n'est qualifié (voir section 8).

**Un détecteur PSIM de catégorie `access` par porte.** Chaque porte que l'on veut surveiller est rattachée, dans la
configuration, à un détecteur PSIM (son identifiant, par exemple `P-ENTREE`). Les passages, les ouvertures, les alarmes et le
signe de vie de cette porte arrivent sur ce détecteur. Le format du message de passage est décrit dans
`docs/CONTROLE-ACCES.md` § 2.

**Ce que le module fait** :

- reçoit les passages, acceptés **et** refusés, et l'état des portes (ouverte, refermée, forcée, maintenue ouverte) ;
- signale le sabotage du boîtier, les refus répétés, l'horloge déréglée, le contrôleur muet ou hors ligne ;
- récupère les passages manqués après une coupure du réseau (section 5) ;
- exécute, si on le déclare, les ordres d'ouverture à distance venus du canal de commande signé du PSIM (section 7).

**Ce que le module ne fait pas** :

- **le contrôleur décide, pas le PSIM.** L'ouverture par badge se joue entièrement dans le contrôleur : si la passerelle ou le
  PSIM est arrêté, les portes continuent de fonctionner. Le PSIM ne prend **jamais** part à l'ouverture par badge ;
- il ne crée, ne modifie ni ne supprime aucun badge, utilisateur, empreinte ou visage ; il ne lit jamais les gabarits
  biométriques ni les codes PIN (les enregistrements lus ne conservent que quelques champs, le reste est écarté dès la lecture) ;
- il n'ouvre jamais une porte de lui-même : seule une commande signée du PSIM, déclarée dans `actuators`, peut le faire ;
- il ne sait pas verrouiller une porte « en permanence » (voir section 7).

## 2. Prérequis

### Sur le contrôleur

1. **Un compte dédié à la passerelle**, créé dans l'interface du contrôleur (par exemple `psim`). Ne jamais utiliser le
   compte administrateur. Droits minimaux : **consulter les événements** et **lire les enregistrements de passage**
   (menu de gestion des comptes du contrôleur) ; ajouter le droit de **commande des portes** seulement si le contrôleur
   déclare des `actuators` (ouverture à distance) ; le droit de lire la configuration des portes est aussi nécessaire pour
   l'ordre `lock` (retour au mode normal, voir section 7). Le nom exact des droits varie selon le modèle : à qualifier.
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
    "longUnlockS": 60
  },
  "reconnect": {
    "minMs": 1000,
    "maxMs": 60000
  }
}
```

Toute clé inconnue ou toute valeur hors bornes est refusée au démarrage, avec **toutes** les erreurs listées d'un coup (le
mot de passe n'apparaît jamais dans un message d'erreur). Les sections `thresholds` et `reconnect` ci-dessus montrent les
valeurs par défaut : on peut les omettre. Dans le bloc, le mot de passe est donné par `{"$file": ...}` : le socle le remplace
par le contenu du fichier avant que le module ne voie sa configuration (`{"$env": "NOM"}` est accepté de la même façon).

### Clés du module

| Clé | Défaut | Rôle |
|---|---|---|
| `stateDir` | `data/acces` (relatif à `gateway/`) | Dossier des curseurs de récupération (section 5). Chemin absolu accepté. **À régler si `dataDir` change** (le contexte des modules n'expose pas encore `dataDir`). Un dossier par module est conseillé (ici `data/acces-dahua`) : le fichier de curseurs porte le même nom pour tous les modules d'accès. |
| `controllers` | aucun, **obligatoire** | 1 à 16 contrôleurs (voir plus bas). |
| `thresholds.deniedCount` | 3 (1 à 100) | Nombre de refus qui déclenchent la pré-alarme « refus répétés ». |
| `thresholds.deniedWindowS` | 60 (1 à 86 400) | Fenêtre de ces refus, en secondes. |
| `thresholds.heartbeatS` | 60 (1 à 3600) | Période du signe de vie envoyé au PSIM, par porte. |
| `thresholds.clockDriftMs` | 120000 (1000 à 86 400 000) | Écart d'horloge contrôleur / passerelle au-delà duquel on signale une dérive. |
| `thresholds.silenceMs` | 30000 (500 à 600 000) | Silence du flux au-delà duquel le contrôleur est traité comme coupé et la connexion refaite. |
| `thresholds.offlineGraceMs` | 15000 (0 à 600 000) | Délai de grâce avant de déclarer « hors ligne ». |
| `thresholds.longUnlockS` | 60 (1 à 86 400) | Au-delà de cette durée demandée, `unlock` devient « ouverte en continu ». |
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
| `Duress` (contrainte) | **aucun message** : journalisé « alarme de contrainte reçue ... ignorée » | non prévu au contrat |
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
  porte absente de `doors` est ignorée, avec un avertissement dans le journal ;
- en mode `code`, aucun numéro n'est transmis ; sinon le numéro de carte (`CardNo`) l'est, jamais un code PIN ;
- le nom du titulaire vient de `CardName` seulement (`Name` est le nom de l'action, pas celui d'une personne) ;
- l'heure vient de `UTC` (secondes), sinon `CreateTime`, sinon `LocaleTime` (convertie avec `utcOffsetMin`), sinon l'heure de
  réception ; une heure à plus de 24 h dans le futur est écartée ;
- l'identifiant d'événement est le `RecNo` du contrôleur ; sans `RecNo` (certains terminaux), le module le complète avec la
  mémoire du contrôleur et, à défaut, au bout de quelques secondes, fabrique un identifiant déterministe (à qualifier).

## 5. Récupération des passages manqués (F8)

Après une coupure du réseau ou un redémarrage de la passerelle, le module relit la mémoire du contrôleur
(`recordFinder.cgi`, enregistrements `AccessControlCardRec`) et rejoue les passages manqués, marqués **différés** côté PSIM :

- **Déclenchement** : à chaque (re)connexion du flux, puis chaque fois qu'un passage du flux est refusé par la passerelle
  (file pleine) ou qu'un événement du flux n'a pas de numéro d'enregistrement.
- **Curseur** : le dernier `RecNo` traité est gardé dans `stateDir` (fichier `acces-curseurs.json`, un curseur par
  contrôleur). Il n'avance **jamais** au-delà d'un passage que le socle a refusé : rien n'est perdu, et la passe repart du
  dernier curseur sûr. Les doublons sont écartés par numéro d'enregistrement.
- **Fenêtre** : lecture par fenêtres de temps et par pages de 200 enregistrements, à partir de l'heure du curseur moins
  10 minutes de marge, en ordre croissant de numéro.
- **Premier démarrage** (aucun curseur) : on ne rejoue **pas** tout l'historique, seulement les **24 dernières heures**
  (valeur à qualifier).
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
- À qualifier : l'indice de la porte dans la table de configuration et la présence de la clé `State` selon le modèle.

## 8. A qualifier : équipements testés

**Aucun matériel réel n'a été essayé : tout est « à qualifier ».** Points marqués `A QUALIFIER` dans le code du module :

- numérotation des portes dans les événements (`doorBase`, 0 ou 1) ;
- valeurs de `Method` 4 (ouverture à distance) et 5 (bouton de sortie) ;
- table des `ErrorCode` (motifs de refus) et motif d'un refus sans code lors d'une saisie de code ;
- identifiant synthétique d'un événement sans `RecNo` ;
- format des événements `DoorStatus`, `DoorNotClosed`, `BreakIn`, `ChassisIntruded` sur ASC et ASI ;
- commande `getDoorStatus` (lecture de l'état d'une porte) ;
- écriture du mode de la porte (`configManager.cgi`, indice de la table, clé `State`) ;
- fenêtre de 24 h du premier démarrage de la récupération.

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
- les **identifiants refusés** : une seule tentative puis 5 minutes de pause, sans blocage du compte.

Un recueil d'échanges réels doit être joint au compte rendu ; les entrées du registre ne passent à « qualifié » qu'après
cette recette.

## 9. Dépannage

Messages du journal de la passerelle (un même message ne paraît qu'une fois par minute au plus).

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
| « alarme de contrainte recue (non prevue au contrat) : ignoree » | Un utilisateur a utilisé le code de contrainte | Le PSIM n'a pas d'événement pour cela : voir l'alarme sur le contrôleur |
| « actionneur ... : le canal de commande n'est pas installe » ou « ouverture a distance indisponible » | Passerelle sans canal de commande signé | Surveillance seule ; configurer le canal de commande |
| « ordre unlock refuse par le controleur (porte N) : refused_by_device » | Réponse non `OK`, droits insuffisants du compte, mode de la porte introuvable | Vérifier les droits du compte ; relever la réponse (à qualifier) |
| Même message, code `timeout` ou `unreachable` | Contrôleur muet ou injoignable | Ne pas croire la porte ouverte ; aucun accusé de réussite n'est donné |
| Même message, code `not_supported` | Ordre non prévu pour ce type (`lock` / `unlock` pour une serrure, `open` / `close` pour une barrière, jamais `stop`) | Utiliser l'ordre adapté au `type` |
