# Packs d'installation

Un **pack** décrit une installation type du catalogue GAMR-DIGITALE (une villa « Essentiel », un appartement « Confort », le « pack standard 4 caméras et 2 détecteurs de fumée »…). Il s'installe dans le PSIM **en une commande**, sans rien oublier ni rien saisir deux fois, et s'accompagne de **sa recette** : les contrôles et la fiche à signer qui prouvent que tout ce qui était prévu fonctionne.

Ce guide s'adresse à l'installateur. Il suppose le PSIM installé (voir [MISE-EN-SERVICE.md](MISE-EN-SERVICE.md), étapes 1 à 3) et démarré **une première fois** (c'est ce premier démarrage qui crée la base et les comptes).

En bref :

```
npm run pack -- check packs/villa-essentiel          # le pack est-il bien écrit ?
npm run pack -- plan  packs/villa-essentiel          # que va-t-il se passer ? (rien n'est écrit)
# arrêter le PSIM
npm run pack -- apply packs/villa-essentiel --allow-unqualified --by "Nom de l'installateur"
# redémarrer le PSIM
npm run commission -- --pack packs/villa-essentiel   # recette : « le pack est complet »
```

En production, remplacer `pack` par `pack:prod` et `commission` par `commission:prod` (ils lisent `.env.production`).

---

## 1. Anatomie d'un pack

Un pack est un **dossier** :

```
packs/villa-essentiel/
  pack.json          la description (format ci-dessous)
  plans/rdc.svg      plans d'étage, facultatifs (PNG, JPEG, WEBP ou SVG, 10 Mo au plus)
  plans/etage.svg
```

`pack.json` contient, dans l'ordre où le PSIM les applique :

| Clé | Contenu |
|---|---|
| `packVersion` | Toujours `1` (version du format). |
| `id`, `name`, `version` | Identifiant (`villa-essentiel` : minuscules, chiffres, tirets), nom lisible, version du pack (`1.0.0`). L'identifiant et la version sont inscrits au journal et sur la fiche de recette. |
| `segment`, `level` | Segment du catalogue (`villa`, `appartement`, `boutique`, `pharmacie`, `entrepot`, `bureau`, `restaurant`, `hotel`, `ecole`, `sante`, `industrie`, `chantier`, `autre`) et niveau (`essentiel`, `confort`, `renforce`). |
| `description` | Texte libre : ce que le pack apporte, ce qui est à prévoir en plus. **Jamais de prix.** |
| `floors` | Étages, du plus bas au plus haut : `id` (court, pour s'y référer dans le pack), `name` (affiché), `plan` (chemin du plan dans le dossier du pack, facultatif). |
| `zones` | Zones et leur étage : `{ "name": "Séjour", "floor": "rdc" }`. Une zone appartient à **un seul** étage (comme dans le PSIM). Chaque zone doit contenir au moins un équipement. |
| `devices` | Équipements (voir ci-dessous). |
| `links` | Caméras affichées à l'alarme de chaque détecteur : `{ "F-01": ["CAM-01", "CAM-02"] }`. |
| `arming` | Planning d'armement des zones d'**intrusion** : `{ "zone": "Portail", "schedule": [ { "days": [0,1,2,3,4,5,6], "from": "22:00", "to": "06:00" } ] }` (0 = dimanche ; une plage peut passer minuit). |
| `risk` | Évaluation de risque par zone : `probability` (1 à 3), `defenses` (`extincteurs`, `consignes`, `personnel`, `compartimentage`, `desenfumage`), `impacts` `{ image, economy, human }` (1 à 5), `notes`. |
| `recipients` | Destinataires **en gabarit** : `channel` (`email`, `telegram`, `whatsapp`, `webhook`), `level` (1 ou 2), `label`, `address` (toujours une question, voir § 2), `zones` (facultatif : seulement les alarmes de ces zones). |
| `gateway` | `accounts` : comptes de passerelle nécessaires (`name` + identifiants ou préfixes `F-*` des détecteurs qu'elle transmet) ; `modules` : modules conseillés (`heartbeat`, `zigbee`, `modbus`, `ups`, `sia`, `lorawan`) avec une note de réglage. |

### Un équipement

```json
{ "id": "F-SEJOUR", "kind": "detector", "name": "Fumée séjour", "zone": "Séjour", "x": 40, "y": 40,
  "model": "tuya-smoke-wifi", "qualification": "qualified",
  "category": "fire",
  "source": { "type": "tuya", "tuyaId": { "$ask": "Identifiant Tuya du détecteur du séjour" }, "sensorType": "smoke" } }
```

| Clé | Contenu |
|---|---|
| `id` | Identifiant dans le PSIM : lettres, chiffres, `-` et `_`, 32 caractères au plus. C'est lui que les détecteurs publient (`psim/detectors/<id>/state`). |
| `kind` | `detector` ou `camera`. |
| `name`, `zone`, `floor` | Nom affiché, zone (déclarée dans `zones`) ; l'étage se déduit de la zone (`floor` seulement pour un équipement sans zone). |
| `x`, `y` | Position sur le plan de l'étage, en % (50 par défaut). |
| `model` | **Identifiant du modèle au registre de qualification** (`qualification/registry.json` : `dahua-hac-hfw1500th-i8`, `heiman-hs1sa-e`, `tuya-smoke-wifi`…) ; un alias du registre est accepté. Un modèle absent du registre est traité comme à qualifier. |
| `qualification` | `qualified` ou `to_qualify` : indication seulement, **le registre de qualification fait foi** (une contradiction est signalée). Voir § 5. |
| `category` | Détecteurs : `fire`, `intrusion`, `access`, `environment`, `energy`, `people` (`fire` par défaut). |
| `unit`, `warnAt`, `alarmAt`, `direction` | Capteurs à mesure : unité, seuils de préalarme et d'alarme, `above` (alarme au-dessus) ou `below`. |
| `heartbeatS` | Délai de silence avant « hors ligne », en secondes ; `null` = délai général du PSIM, `0` = non supervisé. Par défaut : délai général pour l'incendie, non supervisé pour le reste. |
| `source` | Facultatif ; sans source, le détecteur parle lui-même (MQTT, HTTP, ou par la passerelle). |

Sources possibles :

| `type` | Pour | Champs |
|---|---|---|
| `rtsp` | caméra | `host`, `port` (554), `path` (`/cam/realmonitor?channel=1&subtype=1` pour une voie d'enregistreur Dahua), `aspect` (`auto`, `16:9`, `4:3`, `source`), `credentials` `{ username, password }` (questions) |
| `onvif` | caméra | `host`, `port` (80), `aspect`, `credentials` |
| `dahua` | détecteur d'**intrusion** avec zone | `camera` (une caméra du pack avec identifiants), `channel` (voie), `events` (`SmartMotionHuman`, `SmartMotionVehicle`, `VideoMotion`, `CrossLineDetection`, `CrossRegionDetection`), `httpPort` (80). Supervision : 120 s au moins. |
| `tuya` | détecteur `fire`, `intrusion`, `access`, `environment` ou `people` | `tuyaId` (identifiant de l'appareil dans la console Tuya), `sensorType` (`smoke`, `door`, `motion`, `water`, `temperature`, `gas`, `co`, `sos` ou `auto`). Supervision : 300 s au moins. Le compte Tuya reste dans le `.env`. |
| `network` | équipement `environment` (routeur, enregistreur, switch) | `host`, `port` : le PSIM vérifie qu'il répond. Pas de délai de silence (0). |

Le format est **strict** : une clé inconnue, une faute de frappe, une référence vers un équipement ou une zone qui n'existe pas, un doublon, font refuser le pack, avec le chemin exact de l'erreur, par exemple :

```
Pack refuse : 2 erreur(s)
  - devices[1] « CAM-02 ».marque : cle inconnue (cles possibles : id, kind, name, model, qualification, zone, floor, x, y, source)
  - links.F-01[0] : camera inconnue dans le pack (« CAM-9 »)
```

Les règles du PSIM sont vérifiées dès la validation (une source Dahua n'alimente qu'un détecteur d'intrusion, un capteur Tuya est supervisé au moins 300 s, etc.) : un pack valide s'applique sans surprise.

---

## 2. Jamais de secret dans un pack

Un pack se copie, s'envoie, se range dans le dépôt : il ne contient **aucun** mot de passe, identifiant de caméra, clé, jeton, ni adresse réelle de destinataire. À leur place, un **marqueur** :

- `{"$ask": "Mot de passe de l'enregistreur"}` : question posée à l'installateur au moment de l'application (saisie masquée pour un mot de passe). **Même libellé = même réponse** : les quatre voies d'un enregistreur partagent sa question « Adresse IP de l'enregistreur ».
- `{"$env": "PSIM_PACK_NVR_PASSWORD"}` : valeur lue dans une variable d'environnement.

Les marqueurs sont **obligatoires** pour les identifiants des caméras (`credentials.username` et `credentials.password`) et pour l'adresse des destinataires ; ils sont possibles pour l'adresse d'une caméra ou d'un équipement réseau et pour l'identifiant d'un appareil Tuya (valeurs propres à chaque site).

Le PSIM **refuse le pack entier**, avant toute autre vérification, s'il y trouve un secret en clair :

- une clé qui désigne un secret (`password`, `token`, `secret`, `pin`, `apiKey`…) avec une valeur ;
- des identifiants dans une adresse (`rtsp://admin:motdepasse@...`) ou dans un chemin (`?password=...`) ;
- un texte du type « mot de passe : ... », un jeton reconnaissable (jeton Telegram, clé hexadécimale de 32 caractères comme un secret Tuya, clé d'équipement `psk_...`, clé privée).

```
devices[0].source.credentials.password : secret en clair interdit dans un pack ; utiliser {"$ask": "libelle"} ou {"$env": "NOM"}
```

Les réponses ne sont **jamais** écrites dans le pack, ni au journal, ni dans le plan affiché (un e-mail apparaît masqué : `r***@exemple.ci`). Le mot de passe d'une caméra est chiffré en base, comme depuis l'interface.

### Fournir les réponses sans clavier

Pour une installation préparée à l'avance, ou par un assistant :

```
npm run pack -- apply packs/villa-essentiel --answers reponses.json --yes --allow-unqualified
```

`reponses.json` : `{ "libellé de la question": "valeur", ... }`. **Ce fichier contient des secrets** : le garder hors du dépôt, le supprimer après usage. Une question sans réponse dans le fichier est posée au clavier ; sans terminal, l'application est refusée avec la liste des questions manquantes. Une adresse de destinataire laissée **vide** = destinataire laissé de côté (à ajouter plus tard dans *Notifications*).

---

## 3. Fabriquer un pack pour un client

1. **Partir d'un pack proche** : copier `packs/villa-essentiel/` en `packs/villa-kouame/` (ou exporter un site déjà installé, voir plus bas), changer `id`, `name`, `version`.
2. **Adapter au site** : étages et plans (le plan du logement, en SVG ou en image), zones (nommées par niveau si deux niveaux ont une pièce du même nom : « Étage - Chambre 1 »), équipements, positions.
3. **Choisir les modèles du catalogue** et leur statut (§ 5). Un modèle non essayé reste `to_qualify`, même s'il « devrait marcher ».
4. **Seuils et supervision** : un capteur qui n'émet qu'aux changements (contact de porte Zigbee) est soit non supervisé (`0`), soit maintenu en vie par la passerelle (`staleAfterS`, voir [gateway/docs/zigbee.md](../gateway/docs/zigbee.md)) avec `heartbeatS` à environ 3 fois la cadence.
5. **Destinataires** : un niveau 1 au moins (la personne qui réagit), un niveau 2 (escalade si personne n'acquitte). Libellé = rôle (« Propriétaire », « Gardien »), pas un nom.
6. **Vérifier** : `npm run pack -- check packs/villa-kouame`.

### Reproduire un site existant

```
npm run pack -- export --out packs/site-abidjan --id site-abidjan --name "Agence Abidjan" --segment bureau --level confort
```

Le pack exporté reprend étages et plans, zones, équipements (avec leur modèle s'ils ont été posés par un pack, sinon `a-renseigner` / `to_qualify`), sources, liens, armement, risque et destinataires actifs. Les identifiants des caméras deviennent des questions (une par appareil : « Mot de passe de l'appareil 192.168.1.108 »), les adresses des destinataires aussi. L'export est **refusé** s'il restait un secret dans une donnée du PSIM (par exemple un mot de passe écrit dans le chemin RTSP d'une caméra : le corriger d'abord). Comptes de passerelle : noms et équipements seulement, jamais leur mot de passe.

---

## 4. Appliquer un pack

### Le plan (simulation)

```
npm run pack -- plan packs/villa-essentiel [--answers reponses.json]
```

Le plan déroule **exactement** l'application, sur une **copie** de la base, puis la jette : la base du PSIM n'est pas modifiée d'un octet, et le plan peut se faire PSIM en marche. Il dit, élément par élément :

```
Equipements
  + a creer       CAM-PORTAIL  -  camera « Caméra portail », zone Portail ; modele dahua-hac-hfw1500th-i8 (a qualifier)
  = deja conforme F-SEJOUR  -  configuration identique
  ! CONFLIT       T-1  -  nom « Sonde renommee » -> « Temperature baie » ; alarme 45 -> 40
Destinataires
  - ignore        Propriétaire (whatsapp, niveau 1)  -  canal whatsapp non configure dans le .env
```

puis les avertissements (modèles à qualifier, compte de passerelle à créer avec la ligne exacte à ajouter au `.env`, compte Tuya non configuré, modules de passerelle conseillés) et les questions qui seront posées. Sans réponses, la simulation utilise des valeurs fictives.

### L'application

```
npm run pack -- apply packs/villa-essentiel --allow-unqualified --by "Kone Ibrahim"
```

1. **Arrêter le PSIM** : `apply` refuse d'agir pendant qu'il tourne (il garde la configuration en mémoire et ne verrait pas les changements). Pendant l'application, le dossier de données est verrouillé : le PSIM ne peut pas démarrer.
2. Les questions sont posées (ou lues dans `--answers`).
3. Le **plan est affiché**, calculé avec les vraies réponses. S'il y a un conflit ou une erreur, rien n'est fait.
4. **Confirmation** : taper `oui` (ou `--yes`, après avoir lu le plan).
5. Application **tout ou rien**, en une seule transaction : si quoi que ce soit échoue (adresse refusée, zone déjà utilisée à un autre étage…), la base reste exactement comme avant, et aucun fichier de plan n'est laissé.
6. **Redémarrer le PSIM**, puis faire la recette (§ 6).

Chaque élément passe par la même fonction que dans l'interface (mêmes contrôles, même journal) ; l'application est inscrite au journal infalsifiable : `pack_applique villa-essentiel@1.0.0 (villa, essentiel, empreinte …) : 23 cree(s), … ; par Kone Ibrahim`.

### Réappliquer, et les conflits

Réappliquer le même pack ne crée **aucun doublon** et ne change rien : tout est « déjà conforme ». C'est sans risque, et c'est la façon de compléter une installation (nouveau détecteur ajouté au pack, destinataire dont le canal vient d'être configuré).

Si le site a été modifié depuis (pastille déplacée, seuil changé, autre caméra liée), l'élément est en **conflit** et, par défaut, **rien n'est appliqué**. Trancher :

- `--update` : les valeurs du pack remplacent l'existant ;
- `--keep-existing` : l'existant est gardé, le reste du pack est appliqué.

Ce qui existe dans le PSIM et n'est pas dans le pack n'est **jamais** touché. Un équipement du même identifiant mais d'un autre type (caméra / détecteur) est irréconciliable : changer l'identifiant dans le pack.

---

## 5. Qualification : bonnes pratiques

Seuls deux matériels réels ont été validés avec le PSIM : **une voie d'enregistreur Dahua** (image RTSP et événements de détection, sur un `DH-XVR5108HS-I3/T`) et **un détecteur de fumée WiFi Tuya** (catégorie Tuya `ywbj`). Tout le reste a été éprouvé avec des équipements simulés.

- Un modèle est `qualified` **seulement** après une recette en atelier avec le PSIM : déclenchement, retour à la normale, coupure (pile, réseau, alimentation) et détection du silence, image, notification reçue. Noter le résultat (modèle, version de micrologiciel, date, technicien).
- Le **registre de qualification** (`qualification/registry.json`, tenu par `npm run qualify`, voir [QUALIFICATION.md](QUALIFICATION.md)) fait foi : l'importeur l'interroge par son API (`checkPackModels`). Seul un modèle `qualified` au registre est qualifié ; le statut déclaré dans le pack n'est qu'une indication (une contradiction est signalée) et c'est le statut du registre qui est enregistré à l'application. Un modèle absent du registre est à qualifier. Un modèle `rejected` au registre, ou un registre absent, illisible ou invalide, fait **refuser** le pack (check, plan et apply) : échec fermé.
- Contrôle croisé : `npm run qualify -- check-pack packs/<pack>/pack.json` liste chaque modèle avec son statut et sa portée.
- Un pack avec des modèles `to_qualify` se **planifie** normalement (avertissement visible) ; l'**appliquer** exige `--allow-unqualified` : c'est un engagement à faire, sur site, la recette renforcée de ces modèles, et c'est inscrit au journal (« N équipement(s) de modèle à qualifier accepté(s) »).
- Ne jamais passer un modèle en `qualified` dans un pack pour « faire passer » l'application : la fiche de recette affiche le modèle et son statut devant le client.
- Même modèle, autre version (enregistreur 4 voies au lieu de 8, autre micrologiciel) : `to_qualify` tant que l'atelier ne l'a pas vu.

---

## 6. La recette du pack

Après l'application, **PSIM redémarré** :

```
npm run commission -- --pack packs/villa-essentiel
npm run commission -- watch --pack packs/villa-essentiel --until-all
npm run commission -- sheet --pack packs/villa-essentiel --out recette-villa-essentiel.html
```

1. **Contrôles** : la mise en service habituelle, plus « le pack est complet » : chaque équipement du pack est présent, chaque source prévue est enregistrée, chaque caméra liée a une vraie source (pas une caméra simulée), aucun détecteur hors ligne (et la liste de ceux jamais entendus), au moins un destinataire de niveau 1, comptes de passerelle présents et suffisants, modèles à qualifier rappelés, et application de cette version du pack trouvée au journal.
2. **Écoute** des seuls détecteurs du pack : déclencher chacun (bouton test, fumée de test, ouverture de porte) jusqu'à ce que tous aient parlé. Les messages sont traités comme de vraies alarmes : prévenir les destinataires.
3. **Fiche de recette** limitée aux équipements du pack, avec leur modèle (et « à qualifier »), qui **cite le pack, sa version, la date d'application et l'installateur** (d'après le journal). L'imprimer, cocher, faire signer l'installateur et le responsable du site. Sans `--pack`, la fiche du site entier cite les packs appliqués.

`apply ... --recette` lance le premier contrôle juste après l'application (utile en atelier ; sur site, redémarrer d'abord le PSIM).

---

## 7. Exemple complet commenté

Extrait de `packs/pack-standard-4cam-2fumee/pack.json` (le format JSON n'admet pas de commentaires : ils sont ici après `//` pour l'explication seulement).

```jsonc
{
  "packVersion": 1,
  "id": "pack-standard-4cam-2fumee",            // identifiant, inscrit au journal et sur la fiche
  "name": "Pack standard : 4 caméras et 2 détecteurs de fumée",
  "segment": "autre", "level": "essentiel", "version": "1.0.0",
  "floors": [ { "id": "rdc", "name": "Rez-de-chaussée", "plan": "plans/rdc.svg" } ],
  "zones": [ { "name": "Entrée", "floor": "rdc" }, { "name": "Séjour", "floor": "rdc" } /* ... */ ],
  "devices": [
    { "id": "CAM-01", "kind": "camera", "name": "Caméra entrée", "zone": "Entrée", "x": 50, "y": 8,
      "model": "dahua-hac-hfw1500th-i8", "qualification": "to_qualify",      // caméra : à qualifier
      "source": { "type": "rtsp",
        "host": { "$ask": "Adresse IP de l'enregistreur" },                   // demandée UNE fois pour les 4 voies
        "port": 554, "path": "/cam/realmonitor?channel=1&subtype=1",          // voie 1, flux secondaire
        "credentials": { "username": { "$ask": "Identifiant de l'enregistreur (compte en lecture seule)" },
                         "password": { "$ask": "Mot de passe de l'enregistreur" } } } },   // jamais en clair
    { "id": "NVR-01", "kind": "detector", "name": "Enregistreur vidéo", "zone": "Local technique",
      "model": "dahua-xvr5104hs-i3", "qualification": "to_qualify", "category": "environment",
      "source": { "type": "network", "host": { "$ask": "Adresse IP de l'enregistreur" }, "port": 80 } },  // l'enregistreur répond-il ?
    { "id": "I-ENTREE", "kind": "detector", "name": "Personne détectée à l'entrée", "zone": "Entrée",
      "model": "dahua-xvr5104hs-i3", "qualification": "to_qualify",           // événements de l'enregistreur : à qualifier (seule une voie de XVR5108HS-I3/T a été essayée)
      "category": "intrusion",
      "source": { "type": "dahua", "camera": "CAM-01", "channel": 1, "events": ["SmartMotionHuman"] } },
    { "id": "F-01", "kind": "detector", "name": "Fumée séjour", "zone": "Séjour",
      "model": "heiman-hs1sa-e", "qualification": "to_qualify",               // Zigbee, par la passerelle
      "category": "fire", "heartbeatS": 180 }                                 // maintenu en vie par la passerelle (staleAfterS)
    /* CAM-02 à CAM-04, F-02, GW-01 (signe de vie de la passerelle) ... */
  ],
  "links": { "F-01": ["CAM-02", "CAM-01"], "I-ENTREE": ["CAM-01"] },         // images montrées à l'alarme
  "arming": [ { "zone": "Entrée", "schedule": [ { "days": [0,1,2,3,4,5,6], "from": "22:00", "to": "06:00" } ] } ],
  "risk": [ { "zone": "Séjour", "probability": 2, "defenses": ["extincteurs", "consignes"],
              "impacts": { "image": 2, "economy": 3, "human": 4 } } ],
  "recipients": [
    { "channel": "whatsapp", "level": 1, "label": "Responsable du site",
      "address": { "$ask": "Numéro WhatsApp du responsable du site (+225...)" } },   // gabarit : adresse à l'installation
    { "channel": "whatsapp", "level": 2, "label": "Second contact (gardien, voisin)",
      "address": { "$ask": "Numéro WhatsApp du second contact (+225...)" } }
  ],
  "gateway": {
    "accounts": [ { "name": "gw1", "devices": ["GW-01", "F-*"] } ],          // à créer dans PSIM_MQTT_GATEWAYS (.env)
    "modules": [ { "module": "heartbeat", "note": "deviceId GW-01, everyS 60" },
                 { "module": "zigbee", "note": "F-01 et F-02 de type smoke ; staleAfterS 7200" } ]
  }
}
```

À l'application, l'installateur répond à six questions (adresse, identifiant et mot de passe de l'enregistreur ; trois adresses de destinataires), crée le compte `gw1` de la passerelle avec la ligne affichée par le plan, configure la passerelle (modules `heartbeat` et `zigbee`, voir [PASSERELLE.md](PASSERELLE.md)), puis fait la recette.

Les autres packs livrés :

- `packs/villa-essentiel` : villa à étage, 2 caméras sur un enregistreur Dahua, détection de personnes au portail armée la nuit, 2 détecteurs de fumée WiFi Tuya (qualifiés), sans passerelle ;
- `packs/appartement-confort` : caméra IP ONVIF à l'entrée, contact de porte et mouvement Zigbee armés en journée de semaine, détecteur de fumée WiFi Tuya, deux capteurs de fuite d'eau Zigbee, passerelle.

---

## 8. Ce que le pack ne fait pas (limites)

- Il ne crée **ni le compte de passerelle** (son mot de passe vit dans le `.env`), **ni la configuration de la passerelle**, **ni le compte Tuya** : le plan dit exactement quoi ajouter.
- Un destinataire dont le canal n'est pas configuré (SMTP, WhatsApp, Telegram) est laissé de côté avec un avertissement ; réappliquer le pack une fois le canal configuré.
- Il ne supprime jamais rien du PSIM ; retirer un équipement se fait dans l'interface.
- Le nom du site, les comptes des utilisateurs et les réglages du `.env` ne font pas partie d'un pack.
- Les modèles et leur statut sont gardés en base (table `pack_device`) pour l'export et la fiche de recette ; un équipement ajouté à la main n'a pas de modèle.
