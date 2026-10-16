# Reconnaissance faciale : guide de mise en service

Ce guide accompagne l'installateur pour mettre en service la reconnaissance des visages sur l'enregistreur Dahua de la **Résidence KOUROUMA**, puis la relier au PSIM. Il complète le [guide de mise en service général](MISE-EN-SERVICE.md) et s'appuie sur le contrat de conception [PRESENCE-REGLES.md](PRESENCE-REGLES.md).

> **Ce document n'est pas un avis juridique.** Les visages sont des données biométriques. Leur emploi est encadré par la loi ivoirienne (voir la section 5). Faites relire la section 5 et les modèles de documents par un juriste ou par l'ARTCI **avant** d'enregistrer le moindre visage.

> **Honnêteté sur ce qui est validé.** Rien de ce qui suit n'a encore été essayé sur le vrai enregistreur de la résidence. Les points tirés de la fiche constructeur ou d'un texte de loi sont indiqués avec leur source (section 8). Tout ce qui n'a pas pu être confirmé est marqué **[à vérifier]** et repris en liste à la fin du document. Le manuel utilisateur officiel du XVR n'a pas pu être téléchargé pour la rédaction : les chemins de menu cités viennent de guides d'installateurs tiers et doivent être contrôlés sur l'écran de l'appareil.

## Sommaire

1. À quoi ça sert, et ce que ça ne fait pas
2. Mise en service sur l'enregistreur
3. Placer les caméras « visage »
4. Essai de fiabilité avant d'activer les alarmes
5. Cadre légal et confiance (Côte d'Ivoire)
6. Ce que fait le PSIM
7. Liste de contrôle finale et questions à l'utilisateur
8. Sources
9. Points à vérifier

---

## 1. À quoi ça sert, et ce que ça ne fait pas

### 1.1 Les trois usages visés

| N° | Cas | Ce qui se passe | Gravité proposée |
|---|---|---|---|
| 1 | Présence dans une zone | Quelqu'un est vu, à certaines heures ou trop longtemps (n'utilise pas les visages, mais dépend de la détection de personne : voir 2.2) | Au choix de l'utilisateur |
| 2 | Personne interdite | Un visage de la base **« Interdits »** est reconnu | Signalement d'abord ; alarme critique seulement après les essais de la section 4 |
| 3 | Inconnu en zone réservée | Un visage **absent** de la base **« Résidents et personnel »** est vu dans une zone réservée | Signalement d'abord ; alarme critique seulement après les essais |

### 1.2 Ce que ça ne fait pas

- Le système ne dit jamais « c'est lui ». Il dit « ce visage **ressemble** à tel pourcentage à une photo enregistrée ». C'est une **présomption**, pas une preuve.
- Il se trompe, dans les deux sens : il peut **rater** quelqu'un qui est dans la base, et **confondre** deux personnes qui se ressemblent.
- Il se trompe plus souvent la nuit, en contre-jour, de profil, avec une casquette ou des lunettes sombres, et sur des images de faible résolution.
- Il ne remplace pas un agent. **Aucune action contre une personne** (l'interpeller, la chasser, appeler la police) ne doit reposer sur une seule reconnaissance. Un humain compare d'abord les images des caméras liées et décide.
- Le PSIM ne décide pas non plus. Une règle écrite par l'assistant IA est proposée, vérifiée, puis validée par une personne (contrat, section « Objectif »).

> **Règle d'or.** Une reconnaissance faciale = un signalement à confirmer par un humain. Jamais une preuve, jamais une décision automatique.

---

## 2. Mise en service sur l'enregistreur

Enregistreur : **Dahua DH-XVR5108HS-I3/T**, 8 voies analogiques, logiciel 4.000 du 5 juillet 2025. Voies choisies : **voie 5 « Avant cour »** (D05) et **voie 8 « Escalier »** (D08).

### 2.1 Ce que dit la fiche constructeur

| Point | Ce que la fiche indique | Statut |
|---|---|---|
| Voies avec reconnaissance faciale | 2 voies analogiques au maximum | Confirmé (fiche) |
| Détection de visage | 2 voies, jusqu'à 8 images de visage par seconde et par voie ; 6 attributs (sexe, tranche d'âge, lunettes, expression, masque, barbe) | Confirmé (fiche) |
| Bases de visages | Jusqu'à 10 bases, 10 000 photos au total ; nom, sexe, date de naissance, adresse, type et numéro de pièce, pays et région peuvent être ajoutés à chaque photo | Confirmé (fiche) |
| Mode d'analyse « AI Mode » | La reconnaissance faciale « prend effet quand *Face* est choisi dans AI Mode » ; SMD Plus « prend effet quand *SMD* ou *IVS&SMD* est choisi » | Confirmé (fiche du DH-XVR5108HS-I3) |
| Lecture des enregistrements | Passe en affichage 1 ou 4 images quand *Face* ou *IVS&SMD* est choisi | Confirmé (fiche) |
| Voies IP ajoutées | Si l'on ajoute des voies IP au-delà des voies existantes, les fonctions d'analyse (IVS, SMD, FACE) sont désactivées | Confirmé (fiche) : **ne convertissez pas** les voies analogiques en voies IP |
| Fiche d'une série voisine (XVR5000-4KL-I3) | « La reconnaissance faciale est en conflit avec SMD Plus et la protection de périmètre » | Confirmé pour cette série voisine ; non retrouvé mot pour mot sur la fiche du XVR5108HS-I3 |
| Réduction de débit « Encode Enhancement » | Relevé sur la fiche de la version V3 : l'activer interdit la reconnaissance et la détection de visage | **[à vérifier]** sur votre appareil |
| Version matérielle | La fiche du -I3 ne s'applique qu'à la version matérielle 3.0 ; la page du « /T » n'indique pas la même mention | **[à vérifier]** : relever la version sur l'étiquette et dans le menu d'information du XVR |

### 2.2 Le risque principal : la voie 8 peut perdre la détection de personne

Aujourd'hui, la détection de personne (SMD Plus, événement `SmartMotionHuman`) est active sur les 8 voies. Le détecteur **P-D08 « Présence Escalier »** s'appuie dessus.

La fiche dit que la reconnaissance faciale « prend effet quand *Face* est choisi dans AI Mode » et que SMD Plus « prend effet quand *SMD* ou *IVS&SMD* est choisi ». Ce sont **trois modes qui s'excluent** (*Face*, *SMD*, *IVS&SMD*) : avec *Face*, SMD Plus ne « prend pas effet ». Il est donc **très probable** que choisir *Face* coupe SMD Plus.

**Point non établi, et c'est le plus important : ce réglage « AI Mode » est-il propre à chaque voie, ou commun à tout l'enregistreur ?** La fiche ne le dit pas. Deux indices vont dans des sens différents :

- la fiche limite la reconnaissance à **2 voies** : cela laisse penser que *Face* est attribué voie par voie ;
- la fiche écrit que la lecture des enregistrements « passe en affichage 1 ou 4 images quand *Face* ou *IVS&SMD* est choisi dans AI Mode » : une conséquence qui touche tout l'appareil, ce qui laisse penser que le réglage pourrait être global.

**Si le réglage est global, choisir *Face* pourrait couper SMD Plus sur les 8 voies**, donc aussi la présence sur toutes les caméras du PSIM, pas seulement la voie 8. **Ne rien changer tant que ce point n'est pas constaté sur l'écran du XVR** (la procédure 2.3, étape A, commence par relever l'écran du plan intelligent : regarder si le choix du mode se fait pour une voie ou pour l'ensemble **[à vérifier]**). Aucun texte consulté ne tranche pour ce modèle précis.

Conséquences si SMD est bien coupé sur les voies 5 et 8 :

- P-D08 ne recevrait plus `SmartMotionHuman` : il resterait muet **sans panne apparente**. Vérifiez si le PSIM le signale (un détecteur qui n'émet qu'aux changements est souvent réglé « non supervisé »).
- Les règles de **présence** (cas 1) ne verraient plus personne sur ces deux voies, car elles lisent `SmartMotionHuman`.
- Une piste à étudier avec le chef de projet : utiliser l'événement `FaceDetection` comme signe de présence sur ces voies. Il ne se déclenche que si un visage est visible. Ce n'est **pas prévu** au contrat actuel.

**Ne pas activer sur la voie 8 sans l'accord de l'utilisateur.** La procédure 2.3 sert à constater avant de décider.

### 2.3 Procédure de vérification avant d'activer (voie 8, puis voie 5)

Commencez par la **voie 5** : aucun détecteur nommé ne s'appuie dessus. **Attention :** si le réglage « AI Mode » est global (voir 2.2), l'essai sur la voie 5 peut quand même couper P-D08. Faites donc l'essai à un moment où une coupure de quelques minutes est acceptable, avec P-D08 sous les yeux, et revenez en arrière dès qu'il se tait. Refaites ensuite la procédure pour la voie 8.

**A. Relever l'état avant.**

- [ ] Prévenir les destinataires des alertes qu'un essai commence (les détections d'essai sont de vraies alarmes).
- [ ] Sauvegarder la configuration du XVR (export de configuration) **[à vérifier : emplacement du menu]**.
- [ ] Photographier l'écran du réglage d'analyse intelligente de la voie. Chemin cité par des guides tiers : *Menu principal → AI → Paramètres → Plan intelligent* (en anglais : *Main Menu → AI → Parameters → Smart Plan*). **[à vérifier sur l'écran du XVR]**
- [ ] Noter l'état de SMD Plus (humain, véhicule) sur la voie, **et sur les 7 autres voies** (pour constater si le choix du mode touche une voie ou toutes).
- [ ] Passer devant la caméra : constater dans le PSIM que **P-D08 se déclenche** (pour la voie 8). Pour une écoute sans alarme : `npm run commission -- watch`, ou, dans la fiche du détecteur, *Écouter 20 secondes* (voir [MISE-EN-SERVICE.md](MISE-EN-SERVICE.md), sections 3 et 4). Noter l'heure et le nom de l'événement vu : `SmartMotionHuman`.

**B. Activer la reconnaissance faciale sur la voie.**

- [ ] Dans le plan intelligent de la voie, choisir le mode **Face**. Appliquer.
- [ ] Activer ensuite « détection de visage » puis « reconnaissance de visage » pour la voie (guides tiers : *AI → Paramètres → Détection de visage*, puis *→ Reconnaissance de visage*, interrupteur *Activer*). **[à vérifier sur l'écran du XVR]**
- [ ] Relire l'écran du plan intelligent : SMD Plus est-il resté coché, grisé, ou décoché ? **Relire aussi les 7 autres voies** : ont-elles changé de mode ? Si oui, le réglage est global : marche arrière immédiate.

**C. Revérifier.**

- [ ] Passer devant la caméra, plusieurs fois, à des allures différentes (marche, arrêt, dos tourné).
- [ ] Dans le PSIM, P-D08 s'est-il déclenché ? Avec `npm run commission -- watch`, voit-on `SmartMotionHuman` Start/Stop ?
- [ ] Voit-on aussi `FaceDetection` et, avec un visage enregistré, `FaceRecognition` ? Noter le texte exact reçu (c'est le lot V4 : voir la section 6).

**D. Décider (avec l'utilisateur, pas seul).**

| Résultat | Que faire |
|---|---|
| `SmartMotionHuman` arrive toujours | Parfait. Noter la version du logiciel du XVR pour l'avenir (une mise à jour peut changer le comportement) et passer à la suite. |
| `SmartMotionHuman` ne vient plus sur la voie | **Marche arrière** : remettre le mode d'avant (SMD ou IVS&SMD) et vérifier que P-D08 se redéclenche. Puis présenter les choix à l'utilisateur (question 1 de la section 7). |
| Résultat flou (un événement sur deux...) | Marche arrière, ne rien activer, noter ce qui a été vu, en parler au chef de projet. |

Choix possibles si SMD est coupé (c'est à l'utilisateur d'arbitrer) :

1. **Garder SMD sur la voie 8** et mettre les visages sur la voie 5 et sur une autre voie sans détecteur important. La voie « Escalier » perd alors la reconnaissance, mais garde sa détection.
2. **Accepter de perdre SMD sur la voie 8** : P-D08 est désactivé ou remplacé par une règle fondée sur `FaceDetection` (couverture partielle, il faut voir le visage).
3. **Planifier par heures** (visages la nuit, détection le jour) si le XVR le permet **[à vérifier : fonction de plan intelligent par horaires]**.

### 2.4 Créer les deux bases

- [ ] *AI → Base de données → Bibliothèque de visages* (guides tiers : *AI → Database → Face Library*, type **Local** pour stocker sur l'enregistreur, bouton *Ajouter*). **[à vérifier sur l'écran du XVR]**
- [ ] Créer **exactement** ces deux noms, sans faute ni espace en trop :

| Base | Contenu | Utilisée pour |
|---|---|---|
| `Résidents et personnel` | Résidents, personnel de maison, gardiens, personnes de confiance | Cas 3 : tout visage **absent** de cette base est un inconnu |
| `Interdits` | Personnes dont l'accès est refusé | Cas 2 : un visage **présent** dans cette base déclenche le signalement |

- [ ] Vérifier comment le XVR affiche le nom (accent sur « é », espaces). Le PSIM lit ces noms par `faceRecognitionServer.cgi?action=findGroup` et les compare au caractère près. Si le XVR refuse ou déforme l'accent, noter le nom réel obtenu et le communiquer au chef de projet. **[à vérifier]**
- [ ] Ne créer **aucune** autre base tant que les deux premières ne sont pas validées.
- [ ] Ne pas enregistrer de visage avant d'avoir terminé les démarches de la section 5.

### 2.5 Enregistrer des visages

Deux façons : à partir de photos (clé USB ou envoi depuis le navigateur) ou **directement depuis la caméra** (photo prise par la caméra de la voie). Chemin cité par des guides tiers : *AI → Base de données → Base de visages*, double-clic sur la base, *Détails*, *Enregistrer un identifiant* (une photo) ou *Enregistrement par lot* ; photos au format JPEG. **[à vérifier sur l'écran du XVR]**

**Bonnes photos**

| Critère | Consigne |
|---|---|
| Nombre | 2 à 3 photos différentes par personne **si le XVR en accepte plusieurs par identifiant** **[à vérifier]** ; sinon, la meilleure seule, ou plusieurs entrées liées au même nom |
| Angles | Une de **face**, une de **trois quarts** (visage tourné d'environ 30 degrés), éventuellement une de profil léger. La fiche Dahua des caméras tolère une rotation gauche-droite de 30 degrés |
| Visage | Découvert : pas de casquette, pas de lunettes de soleil, pas de masque, cheveux et monture hors des yeux |
| Lunettes | Si la personne en porte tous les jours, **une photo avec** et une **sans** |
| Éclairage | Lumière douce et égale, pas de contre-jour, pas d'ombre dure sur la moitié du visage |
| Fond | Uni et clair |
| Cadrage | Visage net, qui occupe une bonne partie de l'image (un guide tiers indique 30 à 60 % de l'image) |
| Format | JPEG. Un guide tiers indique 50 à 150 Ko ; la taille exacte exigée par le XVR n'est pas confirmée **[à vérifier]** : si le XVR refuse la photo, la réduire |
| Photo ancienne | À éviter : une photo de plus de 2 ou 3 ans, ou d'avant un changement de barbe ou de coiffure, dégrade le résultat |
| Depuis la caméra | La meilleure option si possible : la personne se place où elle passera vraiment, de jour puis de nuit. L'image a alors la même qualité que celles qui seront comparées |

- [ ] Remplir pour chaque photo le nom, et le sexe (champs facultatifs : ne saisir que le strict nécessaire, voir la section 5 sur la minimisation).
- [ ] Noter dans le registre papier : nom, base, date d'enregistrement, date de l'accord signé.
- [ ] Après enregistrement, **effacer** les fichiers photo de la clé USB et de tout ordinateur ou téléphone qui a servi.

### 2.6 Régler le seuil de ressemblance

Le **seuil de ressemblance** est le pourcentage à partir duquel l'appareil dit « c'est lui ». Attention : 80 % ne veut **pas** dire « 80 % de chances que ce soit la bonne personne ». C'est une note interne de l'appareil, qui dépend de l'algorithme, des photos et de la lumière.

- La valeur par défaut de l'écran de reconnaissance est de **80** (échelle de 1 à 100), d'après un guide d'installateur tiers. **[à vérifier]**
- Un autre guide tiers recommande 70 à 85 pour l'usage courant et 90 ou plus pour la haute sécurité. C'est un avis, pas une norme.
- Plus le seuil est **haut** : moins de fausses reconnaissances, mais plus de personnes **ratées**. Plus il est **bas** : l'inverse.

**Valeurs de départ proposées (à ajuster par l'essai de la section 4)**

| Base | Seuil de départ | Pourquoi |
|---|---|---|
| `Interdits` | **85** | Une fausse reconnaissance ici accuse un innocent. On part prudent. Un humain confirme de toute façon. |
| `Résidents et personnel` | **80** (valeur par défaut) | Un résident raté déclenche une fausse alerte « inconnu » ; un inconnu pris pour un résident est une intrusion manquée. On part du réglage du constructeur, puis on mesure. |

Pour affiner, utilisez la colonne « similarité relevée » du tableau d'essai :

1. Prenez la **plus haute** similarité obtenue par des **inconnus** (ou par un faux « interdit ») : le seuil doit être **au-dessus**.
2. Prenez les similarités des **vrais passages** de résidents, surtout les plus basses : le seuil doit être **au-dessous** de la plupart d'entre elles.
3. S'il n'y a aucun seuil qui sépare les deux groupes, **ne pas activer l'alarme** (section 4.5).

Seuils distincts par base : le réglage se fait dans « Base de visages cible » de l'écran de reconnaissance (guides tiers). Savoir s'il existe **un seuil par base** ou **un seuil par voie** n'est pas confirmé **[à vérifier]**.

### 2.7 Modes de l'enregistreur et actions

D'après les guides tiers, l'écran de reconnaissance propose deux modes :

| Mode | Principe | Usage ici |
|---|---|---|
| Mode commun (*Common Mode*) | Compare le visage aux photos de la base choisie et signale une correspondance au-dessus du seuil | Base `Interdits` (cas 2) |
| Alarme « étranger » (*Stranger Alarm*) | Signale un visage qui n'est dans **aucune** des bases cochées | Base `Résidents et personnel` (cas 3) |

- [ ] Ne pas laisser l'enregistreur envoyer ses propres e-mails, sirènes ou sorties d'alarme pour ces événements, sauf décision contraire de l'utilisateur : le PSIM s'en charge, avec escalade et journal. **[à décider : question 6]**
- [ ] Vérifier l'événement qui sort réellement du XVR pour chaque mode (nom, contenu) : c'est la tâche du lot V4 (section 6).

---

## 3. Placer les caméras « visage »

Le meilleur réglage de l'enregistreur ne rattrape pas une caméra mal placée. Les consignes ci-dessous viennent du guide d'installation de Dahua pour ses caméras intelligentes (section 8). Le XVR analyse des caméras analogiques, mais les contraintes de l'image sont les mêmes.

### 3.1 Les chiffres à respecter

| Critère | Valeur du guide Dahua | Remarque |
|---|---|---|
| Angle de la caméra par rapport à l'horizontale | de 0 à 30 degrés | Voir le calcul ci-dessous |
| Rotation du visage gauche-droite | de -30 à +30 degrés | Les gens doivent arriver **de face ou presque** |
| Inclinaison du visage (baisse ou lève la tête) | de -15 à +15 degrés | Dans un escalier, on regarde ses pieds : voir 3.4 |
| Rotation dans le plan (tête penchée) | de -15 à +15 degrés | |
| Taille du visage | plus de **100 x 100 pixels** | Largeur **et** hauteur, mesurées sur l'image réelle |
| Accessoires | pas de lunettes de soleil, masque, casquette ; monture et cheveux hors des yeux | |
| Lumière | pas de contre-jour, pas de reflet marqué, lumière uniforme sans ombre | |

Ces chiffres sont écrits pour des caméras de Dahua, pas pour ce XVR. Les garder comme point de départ. L'exigence exacte de l'algorithme du XVR n'est pas confirmée **[à vérifier]**. On trouve des valeurs du même ordre chez d'autres fabricants **[à vérifier]**.

### 3.2 Hauteur, distance, angle

Hypothèse de calcul : un visage à environ **1,6 m** du sol. L'angle vaut arctan((hauteur de la caméra - 1,6) / distance).

| Hauteur de la caméra | Distance au visage | Angle | Verdict (limite : 30 degrés ; confort : 15) |
|---|---|---|---|
| 2,2 m | 3 m | 11 degrés | Bon |
| 2,5 m | 3 m | 17 degrés | Bon |
| 2,5 m | 2 m | 24 degrés | Acceptable |
| 3,0 m | 4 m | 19 degrés | Acceptable |
| 3,0 m | 3 m | 25 degrés | Limite |
| 3,0 m | 2 m | 35 degrés | **Trop fort** |

Conseil : environ **2,2 à 2,5 m** de haut et **2,5 à 4 m** du point où l'on regarde la caméra. La bonne distance dépend de l'objectif (3.3). Mieux vaut une caméra un peu trop basse (hors de portée de la main : voir la protection contre le vandalisme) qu'une caméra trop haute qui ne voit que le sommet des têtes.

### 3.3 Taille du visage en pixels : le calcul pour votre caméra

Un visage d'adulte mesure environ 16 cm de large (estimation courante, pas une mesure). Il doit occuper **au moins 100 pixels de large**. La largeur de scène couverte, à la distance du visage, ne doit donc pas dépasser :

| Résolution réelle de la voie | Largeur de l'image | Largeur de scène maximale |
|---|---|---|
| 720p | 1 280 pixels | environ **2 m** |
| 1080p | 1 920 pixels | environ **3 m** |
| 4 Mpx | 2 560 pixels | environ **4 m** |
| 5 Mpx | environ 2 600 pixels | environ **4 m** |

- [ ] Relever la **résolution réelle** de chaque voie choisie (menu d'information ou de réglage de caméra). La fiche du XVR accepte des caméras de 720p à 5 Mpx, mais la caméra de la voie 5 et celle de la voie 8 peuvent être plus modestes. **[à relever sur place]**
- [ ] Vérifier que l'enregistreur n'analyse pas une version réduite du flux. Il enregistre à une cadence parfois basse selon le mode (la fiche donne par exemple 1 à 12 images/s en 5M-N). Si le visage est plus petit que 100 pixels **dans l'image analysée**, la reconnaissance échoue. **[à vérifier]**
- [ ] Mesurer sur une capture : prendre l'image au moment où une personne passe à la distance voulue et compter la largeur du visage en pixels (un éditeur d'images le fait).

La voie analogique a une image moins nette qu'une caméra réseau de même résolution (compression, câble, bruit la nuit). Ne comptez pas sur le « zoom numérique » : si le visage est trop petit, il faut un **objectif plus serré** ou un rapprochement, pas un traitement d'image.

### 3.4 Le lieu : un passage obligé où l'on regarde la caméra

- **Portillon, sas, bas d'escalier, entrée** : les gens ralentissent et regardent devant eux. C'est idéal.
- **Cour ouverte** : les gens passent n'importe où, en regardant leurs pieds ou leur téléphone. Mauvais pour les visages.
- **Escalier (voie 8)** : on regarde ses pieds en descendant, tête baissée. Placez la caméra **en bas, face à la montée**, pour filmer les gens qui montent (tête relevée), et non au sommet qui les voit baisser la tête.
- **Avant cour (voie 5)** : choisir le point où tout le monde passe de face (portail, seuil), pas la cour entière.
- Le but n'est pas de filmer toute la zone : c'est de **forcer un cadrage** utile à un seul endroit.

### 3.5 Contre-jour et lumière

- [ ] **Ne jamais filmer face à une porte ouverte au soleil, ni face à une lampe, ni vers le ciel.** Le visage devient une silhouette sombre.
- [ ] Orienter la caméra pour que le soleil soit **derrière elle** ou de côté, jamais derrière la personne.
- [ ] Si l'on ne peut pas éviter la lumière forte derrière : essayer les réglages de compensation de contre-jour de la caméra (BLC, HLC, WDR) **[à vérifier : disponibles sur vos caméras analogiques ?]**. Ils aident, ils ne font pas de miracle.
- [ ] Un guide tiers recommande d'activer l'option d'exposition sur les visages quand elle existe. **[à vérifier]**

### 3.6 La nuit

- [ ] Installer un **éclairage blanc d'appoint** fixe, orienté vers le lieu où l'on regarde la caméra, uniforme et sans ombre dure (le guide Dahua demande une lumière uniforme et sans ombre).
- [ ] Le même guide (section sur l'analyse de comportement) conseille de placer un éclairage d'appoint à plus de **2 m** de la caméra et de le répartir de façon égale ; une lampe trop proche attire insectes et pluie dans le champ. Appliquez-le par prudence.
- [ ] L'**infrarouge** donne une image grise, avec des visages « plats » ; on estime qu'il dégrade la reconnaissance. Ce point n'est pas confirmé par une source pour ce XVR **[à vérifier par l'essai de nuit]**.
- [ ] Si les caméras ont deux éclairages (infrarouge et lumière blanche), tester le mode **lumière blanche** : la fiche du XVR mentionne cette fonction (« Smart Dual Illuminators ») **[à vérifier : vos caméras sont-elles de ce type ?]**. Attention : d'après la fiche, la lumière blanche s'allume sur détection de SMD Plus ou de protection de périmètre. Si SMD est coupé sur la voie, elle pourrait ne plus s'allumer d'elle-même **[à vérifier]**.
- [ ] Éviter les lampes qui scintillent ou qui s'éteignent par intermittence (minuterie).

### 3.7 Protection de la caméra

- [ ] Hors de portée de la main (voir la hauteur), boîtier résistant, câble protégé.
- [ ] Verre propre : une toile d'araignée ou de la poussière suffit à gâcher la nuit.
- [ ] Ne pas déplacer la caméra après les essais : tout changement de cadrage **impose de refaire les essais de la section 4**.

---

## 4. Essai de fiabilité avant d'activer les alarmes

**Les alarmes liées aux visages ne sont activées qu'après cet essai.** Il se fait sur les **vraies personnes du site**, **de jour et de nuit**, à l'endroit réel.

### 4.1 Pourquoi un essai obligatoire

L'institut américain NIST a mesuré (rapport NISTIR 8280, décembre 2019) l'effet de l'origine, du sexe et de l'âge sur des algorithmes de reconnaissance. Ses constats principaux :

- Dans la plupart des algorithmes testés, les taux de **fausses reconnaissances** (prendre quelqu'un pour un autre) varient d'un groupe de personnes à l'autre, souvent d'un facteur 10 à plus de 100.
- Ces fausses reconnaissances sont **les plus élevées pour les personnes d'Afrique de l'Ouest et de l'Est et d'Asie de l'Est** (avec des exceptions selon l'origine de l'algorithme), et plus élevées chez les femmes (de 2 à 5 fois) que chez les hommes.
- Les **ratés** (une personne connue non reconnue) varient moins, souvent d'un facteur inférieur à 3, selon l'algorithme.
- Les écarts dépendent beaucoup de l'algorithme. Le NIST a testé des algorithmes de fournisseurs ; **je n'ai trouvé aucune mesure publique de l'algorithme du XVR Dahua** **[à vérifier]**.

Ce qu'il faut en retenir pour la résidence : nous sommes en Côte d'Ivoire, avec des personnes à peau foncée, souvent en contre-jour ou de nuit, avec une caméra analogique. Le risque principal est une **fausse reconnaissance** : prendre un visiteur innocent pour une personne « interdite », ou un intrus pour un résident. Seul l'essai sur place permet de savoir si cela arrive ici.

### 4.2 Préparation

- [ ] Accords écrits signés de **toutes** les personnes d'essai (section 5.5).
- [ ] Les deux bases créées, seuils de départ réglés (2.6), caméras fixées (section 3).
- [ ] **Alarmes désactivées** sur le PSIM (aucune règle visage active) : on ne mesure que ce que voit le XVR.
- [ ] Un moyen de lire pour chaque passage ce que le XVR a reconnu : l'écran de recherche des événements de visage du XVR **[à vérifier : menu]**, ou `npm run commission -- watch` côté PSIM.
- [ ] Un chronomètre, un cahier ou le tableau ci-dessous, un téléphone pour l'heure.

### 4.3 Qui, combien, quand

| Groupe | Qui | Nombre minimum proposé |
|---|---|---|
| R : résidents et personnel enregistrés | **Tous** ceux qui seront dans la base | tous (au moins 5 si possible) |
| U : inconnus | Volontaires **non enregistrés**, de morphologies et teintes variées (famille élargie, voisins, collègues) | au moins 10 |
| F : faux « interdit » | 1 ou 2 volontaires **inscrits temporairement** dans `Interdits` (avec leur accord) | 1 à 2 |

| Condition | Passages par personne |
|---|---|
| Jour, plein soleil ou contre-jour | au moins 5 |
| Jour, ombre ou intérieur | au moins 5 |
| Nuit, avec l'éclairage d'appoint | au moins 5 |
| Nuit, sans l'éclairage d'appoint (pour savoir ce qui se passe si l'éclairage est en panne) | au moins 3 |
| Avec lunettes / sans (si la personne en porte) | au moins 3 chacun |
| Avec casquette ou foulard (un passage) | 1 |
| En marchant normalement, **sans** chercher la caméra | tous les passages |

Exemple de volume : 6 résidents x 20 passages + 10 inconnus x 20 passages + 2 faux interdits x 20 passages = environ 360 passages, soit 2 à 3 soirées. C'est un minimum **proposé** : plus il y a de passages, plus les conclusions sont solides.

### 4.4 Tableau d'essai à remplir

Un passage = une ligne. Copiez le tableau pour chaque séance.

| N° | Personne (nom ou « U3 ») | Groupe (R / U / F) | Date, heure | Jour / nuit, éclairage | Distance (m) | Lunettes / casquette | Résultat | Similarité relevée (%) | Reconnu comme... | Remarque |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | reconnu / pas reconnu / confondu | | | |
| 2 | | | | | | | | | | |
| 3 | | | | | | | | | | |

Légende :

- **reconnu** : le XVR a trouvé la bonne personne.
- **pas reconnu** : le XVR n'a rien trouvé alors que la personne est dans la base (ou l'a classée « étranger »).
- **confondu** : le XVR a donné le nom d'**une autre personne**. Noter laquelle. C'est le résultat le plus grave.
- Un passage où aucun visage n'a été détecté s'écrit « pas détecté » : c'est un échec de **placement ou de lumière**, pas un échec de la base.

Calculs à faire après chaque séance :

| Mesure | Comment la calculer |
|---|---|
| Taux de reconnaissance (R) | passages « reconnu » / passages de R |
| Taux d'oubli (R) | passages « pas reconnu » / passages de R |
| Taux de confusion avec un résident (U) | passages de U classés comme un résident / passages de U |
| Taux de confusion avec `Interdits` (U et R) | passages classés comme un interdit / passages de U et de R |
| Taux de détection du faux interdit (F) | passages de F « reconnu » / passages de F |
| Similarité des vrais passages | la plus basse, la médiane |
| Similarité des inconnus | la plus haute |

### 4.5 Critères d'acceptation proposés

> **Ces chiffres sont des propositions de départ, pas des normes.** C'est à l'utilisateur (et à son juriste) de les valider ou de les modifier. Aucune loi ni aucun texte de Dahua ne les impose.

| Critère | Seuil proposé pour le « signalement » (gravité moyenne) | Seuil proposé pour l'« alarme critique » |
|---|---|---|
| Résidents reconnus **de jour** | au moins 85 % des passages | au moins 90 % |
| Résidents reconnus **de nuit** | au moins 70 % | au moins 85 % |
| Aucun résident ne descend sous | 50 % des passages (sinon : ré-enregistrer ses photos, revoir la lumière) | 70 % |
| Inconnus pris pour un résident | au plus 2 % | au plus 1 % (cas 3) |
| Inconnus ou résidents pris pour un « interdit » | au plus 1 % | **zéro** sur au moins 200 passages d'inconnus (cas 2) |
| Faux « interdit » reconnu | au moins 70 % de nuit et de jour | au moins 85 % |

À savoir sur ces chiffres :

- « Zéro confusion sur 200 passages » ne prouve pas que l'erreur n'arrivera jamais. Une règle statistique simple (« règle de trois ») dit que, sans aucune erreur sur 200 essais, le vrai taux d'erreur peut quand même atteindre environ 1,5 % (3 divisé par 200). Avec le nombre de passages de tous les jours sur une année, cela fait plusieurs fausses alertes possibles. **C'est pourquoi une confirmation humaine reste toujours nécessaire.**
- Le groupe « inconnus » ne contient pas forcément de personne qui **ressemble** à un interdit réel. L'essai ne mesure que ce qu'il contient.
- Faites l'essai à nouveau après toute modification : caméra, éclairage, version du logiciel du XVR, nouveaux visages enregistrés en grand nombre.

### 4.6 Si les résultats sont insuffisants

| Constat | Action |
|---|---|
| Visages « pas détectés » | Retoucher le placement : angle, hauteur, taille du visage (3.2 et 3.3), lumière (3.5, 3.6) |
| Résidents trop souvent « pas reconnus » la nuit | Plus de lumière blanche ; ajouter des photos prises **de nuit, depuis la caméra** ; baisser un peu le seuil de `Résidents et personnel` et refaire l'essai |
| Une personne précise est mal reconnue | Ré-enregistrer avec de meilleures photos, ou depuis la caméra ; si cela ne marche pas, l'exclure de la règle « inconnu » et prévoir un autre moyen de contrôle (badge, présentation à l'agent) |
| Une confusion avec `Interdits`, même une seule | **Pas d'alarme critique.** Monter le seuil de `Interdits` ; refaire l'essai ; ne l'utiliser que pour un signalement |
| Résultats insuffisants malgré les réglages | N'activer que le **signalement de gravité moyenne** (`face_noticed`, section 6). **Ne pas activer** `face_banned` ni `face_unknown` en critique |

**Principe permanent.** Même avec de bons résultats, une alarme critique de reconnaissance faciale ne se fonde **jamais sur une seule reconnaissance** sans confirmation humaine par les caméras liées. L'agent compare l'image de la caméra avec la photo de la base, puis décide (section 5.8).

---

## 5. Cadre légal et confiance (Côte d'Ivoire)

> **AVERTISSEMENT. Ce document n'est pas un avis juridique.** Ce qui suit résume ce que l'auteur a pu lire dans le texte de la loi. Les lois, leurs décrets et la position de l'autorité évoluent. **Tout ce qui suit est à faire confirmer par un juriste** avant d'enregistrer un visage. Les modèles de documents (5.5 et 5.6) sont des points de départ, pas des textes validés.

### 5.1 Les textes

- **Loi n° 2013-450 du 19 juin 2013 relative à la protection des données à caractère personnel**, publiée au Journal officiel du 8 août 2013.
- L'**ARTCI** (Autorité de Régulation des Télécommunications/TIC de Côte d'Ivoire) exerce la mission d'**Autorité de protection** des données (article 46 de la loi). Son site dédié est autoritedeprotection.ci.
- Le 20 juin 2024, l'ARTCI a publiquement rappelé aux structures publiques, privées **et aux particuliers** que l'emploi de la biométrie exige son **autorisation préalable**, sous peine de sanctions (article de presse consulté).

### 5.2 Ce que dit la loi (articles lus dans le texte)

| Sujet | Article | Contenu en bref |
|---|---|---|
| Image d'une personne | 1 | L'**image** d'une personne identifiable est une donnée à caractère personnel. Le consentement doit être exprès, sans ambiguïté, **libre**, spécifique et informé. |
| Biométrie | 7 | Le traitement de données **biométriques** est soumis à l'**autorisation préalable** de l'Autorité de protection, avant toute mise en œuvre. |
| Déclaration | 5 | Tout traitement de données est soumis à **déclaration préalable** à l'Autorité (récépissé). |
| Délai de réponse | 11 | L'Autorité répond en un mois, prorogeable d'un mois. **Pas de réponse = rejet.** |
| Usage personnel | 4 et 6 | La loi exclut les traitements d'une personne physique « dans le cadre exclusif de ses activités personnelles ou domestiques », à condition que les données ne soient pas destinées à une communication systématique à des tiers. L'article 6 dispense de **déclaration** (pas mentionné pour l'autorisation de l'article 7) les usages « personnels, domestiques ou familiaux ». |
| Consentement | 14 | Le traitement est légitime si la personne donne son consentement préalable ; des exceptions existent (obligation légale, contrat...). |
| Finalité et durée | 16 | Finalités déterminées et légitimes ; données adéquates, non excessives ; conservation **limitée** à la durée nécessaire. |
| Exactitude | 17 | Données exactes, mises à jour, effacées ou rectifiées si inexactes. |
| Information | 18 et 28 | Information claire, **au plus tard à la collecte** : identité du responsable, finalités, catégories de données, destinataires, **possibilité de refuser de figurer dans le fichier**, droits d'accès et de rectification, durée de conservation, transferts vers l'étranger. |
| Décision automatique | 25 | Aucune décision administrative ou privée appréciant un comportement humain ne peut avoir pour **seul fondement** un traitement automatisé. |
| Accès | 29 | Toute personne peut demander si elle est fichée, quelles données, pourquoi, qui les reçoit. |
| Opposition | 30 | Droit de s'opposer, pour des motifs légitimes, au traitement de ses données. |
| Rectification, suppression | 31, 33, 35, 36 | Droit d'obtenir la rectification ou la suppression ; effacement quand les données ne sont plus nécessaires ou quand le **consentement est retiré**. |
| Confidentialité, sécurité | 19, 39, 40, 41 | Traitement confidentiel, accès réservé aux personnes autorisées ; protections détaillées à l'article 41 : accès aux installations, aux supports, journal permettant de savoir **qui a lu, modifié, effacé quoi et quand**, copies de sécurité protégées. |
| Durée de conservation | 43 | La durée est **fixée par l'Autorité** selon les finalités, conformément aux textes en vigueur. |
| Données qui révèlent l'origine | 21 | Interdit de collecter ou traiter des données qui révèlent l'origine raciale, ethnique ou régionale... avec des exceptions. Cet article est cité par prudence : une image de visage peut laisser voir une origine apparente. **À poser au juriste.** |

Ce qui est **à vérifier** :

- L'exception de l'article 4 (usage « exclusivement » personnel ou domestique) peut-elle couvrir une résidence privée **qui emploie du personnel et qui envoie des alertes à d'autres personnes** (gardiens, famille) ? L'auteur pense que **non, ou pas sûrement**, et que l'ARTCI s'adresse expressément aux particuliers. **[à vérifier par un juriste]**
- La loi ne définit pas le mot « biométrique » dans la liste de définitions lue. Un visage comparé à une photo est-il une donnée biométrique au sens de l'article 7 ? Probablement oui. **[à vérifier]**
- Un article de presse (digitalbusiness.africa, octobre 2024) cite aussi un **décret n° 2018-454 du 9 mai 2018** qui donnerait à l'Office national d'identification (ONI) une compétence exclusive sur l'authentification biométrique et interdirait à d'autres entités de constituer des bases biométriques. **Texte non lu.** **[à vérifier par un juriste]** : si cela s'applique ici, cela pourrait suffire à interdire le projet.
- Le **consentement du personnel est-il « libre »** quand la personne dépend de son employeur ? C'est une question classique. Prévoir une **solution alternative** sans visage pour qui refuse (badge, présentation à l'agent). **[à vérifier]**
- L'usage de la **vidéosurveillance** elle-même (caméras, affichage, durée des enregistrements) relève aussi de la loi et d'éventuelles règles de l'ARTCI. **[à vérifier]**

### 5.3 Démarches avant de commencer

- [ ] Consulter un **juriste** (ou contacter directement l'ARTCI, Autorité de protection) sur : la nécessité d'une **demande d'autorisation (art. 7)**, la déclaration (art. 5), le décret 2018-454, l'exception personnelle (art. 4 et 6).
- [ ] Si une autorisation est nécessaire : **ne pas enregistrer de visages ni activer la reconnaissance avant de l'avoir reçue**. Le silence de l'Autorité vaut rejet (art. 11).
- [ ] Désigner un **responsable du traitement** (le propriétaire de la résidence, ou la personne qu'il désigne) et un référent pour les demandes des personnes.
- [ ] Afficher l'information aux visiteurs (5.4).
- [ ] Ouvrir un **registre des décisions** (5.9).

### 5.4 Affichage pour les visiteurs

Un panneau lisible à l'entrée de chaque zone filmée par une caméra « visage » (au minimum le portail et le bas de l'escalier). Texte proposé :

> **Zone sous vidéosurveillance avec reconnaissance faciale.**
> Pour la sécurité de la résidence, les visages peuvent être comparés à une liste de personnes autorisées ou interdites. Responsable : [nom, adresse, téléphone]. Les images sont conservées [durée]. Vous pouvez demander l'accès à vos données, ou vous opposer à leur traitement, auprès de [contact].

### 5.5 Note d'information au personnel (modèle court)

> **Information sur la reconnaissance faciale à la Résidence KOUROUMA**
>
> **Qui ?** [Nom du propriétaire ou responsable], responsable de la résidence, [téléphone / e-mail].
> **Quoi ?** Des caméras à l'entrée et dans l'escalier comparent les visages à une liste de personnes connues. Votre photo (et votre nom) sera enregistrée dans la liste « Résidents et personnel » si vous y consentez.
> **Pourquoi ?** Pour la sécurité de la maison : savoir qu'une personne inconnue entre dans une zone réservée. **Pas** pour surveiller votre travail, ni vos horaires, ni vos déplacements.
> **Qui y a accès ?** [Noms ou fonctions] seulement, avec un compte personnel. Rien n'est partagé avec d'autres personnes, sauf obligation légale (police, justice).
> **Combien de temps ?** Votre photo reste enregistrée tant que vous travaillez à la résidence, et est **effacée dans les 7 jours** après votre départ. Les détections sont gardées 30 jours.
> **Vos droits.** Vous pouvez : demander à voir vos données, les faire corriger, **refuser** de figurer dans la liste (sans conséquence sur votre emploi), ou **retirer votre accord à tout moment**, sans avoir à vous justifier.
> **Qui contacter ?** [Nom, téléphone]. Vous pouvez aussi saisir l'ARTCI, Autorité de protection des données personnelles.
>
> Date : ....................

### 5.6 Formulaire d'accord individuel (modèle)

> **Accord pour l'enregistrement de mon visage**
>
> Je soussigné(e) ................................................, fonction ......................................, déclare avoir reçu et compris la note d'information.
>
> - [ ] J'accepte que ma photo soit enregistrée dans la liste « Résidents et personnel ».
> - [ ] J'accepte que la caméra compare mon visage à cette liste.
> - [ ] Je ne suis **pas** d'accord (je choisis une autre méthode de contrôle, sans conséquence pour moi).
>
> Mon accord est donné librement. Je peux le **retirer à tout moment** en le disant à ........................ ; ma photo sera alors supprimée (voir la note d'information).
>
> Fait à ................ le ................   Signature : ..............................
> Un exemplaire est remis à la personne ; l'autre est conservé par le responsable.

Pour les **mineurs**, l'accord est donné par le représentant légal (la loi définit le mineur comme toute personne de moins de dix-huit ans). Pour la base `Interdits`, les personnes inscrites ne signent pas d'accord : leur inscription est une décision grave, qui doit se justifier par écrit (5.9) et relever d'un avis du juriste.

### 5.7 Durées de conservation proposées

Ce sont des **propositions**. La durée légale est fixée par l'Autorité (article 43) : à confirmer par un juriste.

| Donnée | Durée proposée | Remarque |
|---|---|---|
| Photo de référence (résident, personnel) | Tant que la personne est dans la maison ; **effacée sous 7 jours** après son départ | Départ, fin de contrat, retrait de l'accord |
| Photo de référence (`Interdits`) | À réexaminer **tous les 6 mois** par le responsable ; effacée quand le motif disparaît | Inscription motivée par écrit |
| Événements de reconnaissance (PSIM) | **30 jours** | À décider ; le module de présence du PSIM purge à 30 jours par défaut (contrat). Durée propre aux événements visage **[à vérifier]** |
| Images du XVR (disque) | Selon la capacité du disque ; écrasement automatique | La durée réelle dépend du disque **[à relever]** |
| Vidéo de preuve d'un incident | Pendant l'incident et les suites nécessaires, puis effacement | Notée au registre des décisions |
| Fichiers de photos de travail (clé USB, téléphone) | **Effacés le jour de l'enregistrement** | |
| Accords signés | Pendant la durée de la présence, puis selon l'avis du juriste | |

### 5.8 Droit de retrait : supprimer une personne

À faire dès que la personne retire son accord, quitte la maison, ou demande l'effacement.

- [ ] Supprimer son entrée de la base du XVR (*AI → Base de données → Base de visages → Détails → supprimer*) **[à vérifier sur l'écran du XVR]**.
- [ ] Supprimer ses photos de tous les supports : clé USB, ordinateur, téléphone, messagerie, sauvegarde du XVR (fichier d'export de configuration qui contiendrait la base). **Chercher partout.**
- [ ] Vérifier qu'aucun export de preuve ne la contient inutilement. Les vidéos d'incident à conserver pour une procédure sont une exception, notée au registre.
- [ ] Contrôler ensuite : la liste de la base ne la contient plus ; un passage devant la caméra ne produit plus de reconnaissance à son nom.
- [ ] Les captures de visage déjà enregistrées sur le disque du XVR s'effacent par écrasement ; leur suppression ciblée n'est pas confirmée **[à vérifier]**.
- [ ] Noter la suppression au registre (date, qui l'a faite) et répondre à la personne dans un délai raisonnable (proposé : 7 jours).

### 5.9 Qui a accès, sécurité, registre

**Comptes et accès**

- [ ] Limiter l'accès à l'écran de gestion des bases du XVR (mot de passe administrateur) à **une ou deux personnes nommées**.
- [ ] **Changer le mot de passe** du XVR (jamais celui d'usine) : long, unique, noté dans un coffre ou un gestionnaire, pas sur un papier collé à la machine.
- [ ] **Ne pas exposer l'enregistreur sur internet** (pas de redirection de port, pas de P2P ouvert si l'on peut s'en passer). Le PSIM l'interroge sur le réseau local de la résidence. L'article 41 de la loi demande d'empêcher l'accès non autorisé.
- [ ] Au PSIM, seuls les administrateurs configurent les règles et listes ; chaque modification est inscrite au journal (qui, quand, quoi).
- [ ] Sauvegardes du XVR protégées (la base de visages s'y trouve peut-être).
- [ ] Heure du XVR exacte (synchronisation NTP) : sans heure juste, le journal est sans valeur.

**Une reconnaissance est une présomption à confirmer**

Avant toute action contre une personne, l'agent applique ces étapes :

1. Regarder le **direct** et l'**enregistrement** des caméras liées à l'événement.
2. Comparer ce qu'il voit avec la photo de la base (si l'alarme vient de `Interdits`).
3. S'il y a un doute, **ne rien faire contre la personne** : surveiller, appeler le responsable.
4. Noter la décision au registre.
5. Qualifier l'incident dans le PSIM : *événement réel* ou *fausse alarme* (les fausses alarmes servent à régler le seuil).

**Registre des décisions** (papier ou tableur protégé)

| Date, heure | Événement (base, personne, similarité) | Qui a décidé | Images consultées | Décision | Motif | Suite |
|---|---|---|---|---|---|---|
| | | | | | | |

---

## 6. Ce que fait le PSIM

Cette section décrit ce que le contrat [PRESENCE-REGLES.md](PRESENCE-REGLES.md) prévoit. Rien de plus n'est promis.

**Ce que le PSIM fera**

- **Lire les événements du XVR** : `FaceRecognition` et `FaceDetection` arrivent par le même flux que `SmartMotionHuman` (flux `eventManager.cgi?action=attach&codes=[All]`). Le module `server/faces.ts` (lot V1) les transforme en observations : reconnu, inconnu ou détecté, avec le nom de la personne, le nom de la base et la similarité quand l'événement les donne.
- **Lire les noms des bases** par `faceRecognitionServer.cgi?action=findGroup`, pour reconnaître `Résidents et personnel` et `Interdits`. Au 16 octobre 2026, cette lecture répond « vide » : il n'existe encore aucune base.
- **Règles d'identité** (lot V3, à venir) : une règle pourra dire « si un visage de la liste Interdits est vu » ou « si un visage inconnu est vu dans la zone réservée », avec ses plages horaires, sa gravité et son délai de repos.
- **Alarmes** : une règle est un détecteur virtuel `R-<id>`, lié aux caméras de sa portée. Le moteur existant ouvre l'incident, affiche les caméras liées, joue le son, prévient les personnes et escalade. Événements prévus : `face_banned` (personne interdite reconnue, critique), `face_unknown` (visage inconnu en zone réservée, critique), `face_noticed` (visage signalé, gravité moyenne).
- **Gravité** : une règle de gravité « avertissement » produit `face_noticed` (préalarme) ; une règle de gravité « critique » produit l'événement précis. **Le choix par défaut recommandé ici est l'avertissement.**
- **Essai sur le passé** (bouton « Essayer sur les 7 derniers jours ») : disponible pour les règles de présence ; pour les visages, seulement ce que le lot V3 prévoira.
- **Assistant IA** : il propose une règle à partir d'une phrase, il n'envoie que des **noms** (caméras, zones, listes), jamais d'image ni d'empreinte, et il ne décide jamais d'une alarme.

**Ce que le PSIM ne fera pas**

- Il ne compare pas les visages : c'est l'enregistreur qui le fait, le PSIM ne reçoit que le résultat.
- Le contrat ne prévoit pas qu'il garde les photos de référence : elles restent dans le XVR.
- Il ne déclenche aucune action contre une personne.

**Ce qui reste à confirmer sur le vrai XVR (lot V4)**

- Le **format exact** des événements `FaceRecognition` et `FaceDetection` (champs, noms, similarité, base, personne). Les jeux d'essai viennent pour l'instant de la documentation Dahua.
- Le comportement de `SmartMotionHuman` quand *Face* est choisi (section 2.3).
- Le nom exact des bases tel que le XVR le renvoie (accents).
- Ce que le XVR envoie pour une alarme « étranger » et pour une correspondance dans `Interdits`.
- Ces étapes se font **avec l'accord de l'utilisateur, par le chef de projet**.

---

## 7. Liste de contrôle finale et questions à l'utilisateur

### 7.1 Liste de contrôle

**Avant tout**

- [ ] Avis du juriste obtenu sur la section 5 ; autorisation de l'ARTCI demandée ou dispense confirmée par écrit.
- [ ] Accord écrit signé de chaque personne qui sera enregistrée ; solution alternative pour qui refuse.
- [ ] Panneau d'information affiché.
- [ ] Registre des décisions ouvert.

**Matériel et placement**

- [ ] Résolution réelle de la voie 5 et de la voie 8 relevée.
- [ ] Caméras placées (hauteur, angle, distance) : visage de plus de 100 pixels de large sur une capture réelle.
- [ ] Pas de contre-jour ; éclairage blanc d'appoint de nuit installé.
- [ ] Mot de passe du XVR changé ; XVR non exposé sur internet ; heure exacte.

**Enregistreur**

- [ ] Configuration sauvegardée avant tout changement.
- [ ] État de SMD Plus voie 5 et voie 8 relevé avant, puis après (2.3).
- [ ] Décision de l'utilisateur sur SMD voie 8 notée.
- [ ] Bases `Résidents et personnel` et `Interdits` créées avec les noms exacts.
- [ ] Visages enregistrés (photos de qualité) ; fichiers de travail effacés.
- [ ] Seuils de départ réglés (85 et 80).
- [ ] Actions propres au XVR (e-mail, sirène) désactivées ou volontairement conservées.

**Essai**

- [ ] Essai de jour et de nuit fait (section 4), tableau rempli et conservé.
- [ ] Critères d'acceptation validés par l'utilisateur.
- [ ] Seuils ajustés ; essai refait après réglage.
- [ ] Niveau d'alerte choisi : signalement seulement, ou critique pour tel cas.

**PSIM**

- [ ] P-D08 se déclenche toujours (ou décision prise s'il ne le fait plus).
- [ ] Format des événements visage constaté et transmis au chef de projet (V4).
- [ ] Règles d'identité créées en **gravité moyenne** d'abord (V3).
- [ ] Agents formés à la règle d'or : on confirme avec les caméras avant d'agir.

**Après la mise en service**

- [ ] Contrôle des fausses alarmes après 2 semaines et ajustement des seuils.
- [ ] Procédure de retrait testée une fois.
- [ ] Revue des inscriptions de `Interdits` tous les 6 mois.
- [ ] Essai refait après toute mise à jour du XVR.

### 7.2 Questions pour l'utilisateur

Ces décisions ne sont pas à prendre par l'installateur.

1. **SMD voie 8.** Si choisir *Face* coupe la détection de personne sur la voie 8 (ou sur toutes les voies, si le réglage est global à l'enregistreur) : garder SMD sur l'escalier et déplacer les visages ailleurs ? Ou accepter de perdre P-D08 (et la présence sur la voie 5) ? Utiliser `FaceDetection` comme signe de présence ?
2. **Cadre légal.** Qui consulte le juriste et l'ARTCI, et avant quelle date ? Quel responsable de traitement ?
3. **Personnel.** Qui explique la démarche et recueille les accords ? Que fait-on pour ceux qui refusent ?
4. **Seuils.** Les valeurs de départ (85 pour `Interdits`, 80 pour `Résidents et personnel`) vous conviennent-elles ?
5. **Critères d'acceptation** de la section 4.5 : les valider, ou les modifier ?
6. **Qui reçoit les alarmes** de reconnaissance (signalement et critique), de jour et de nuit ? Qui est joint en cas de non-réponse ?
7. **Alarme critique** : l'autorisez-vous, ou seulement le signalement de gravité moyenne tant que l'essai n'est pas concluant ?
8. **Actions du XVR** (e-mail, sirène, sortie d'alarme) : les laisser actives en plus du PSIM ?
9. **Durées de conservation** de la section 5.7 : les valider (7 jours après départ, 30 jours pour les événements, 6 mois pour revoir `Interdits`) ?
10. **Base `Interdits`** : qui peut y inscrire quelqu'un, sur quel motif écrit, avec l'avis de qui ?
11. **Éclairage de nuit** : accord pour installer l'éclairage blanc d'appoint ?
12. **Bases supplémentaires** (ex. visiteurs réguliers) : oui ou non ? Elles ajoutent des données à protéger.

---

## 8. Sources

Toutes les adresses ci-dessous ont été consultées pour la rédaction (octobre 2026). Le **manuel utilisateur officiel** du XVR n'a pas pu être obtenu (téléchargements refusés par les sites qui l'hébergent) : téléchargez-le sur le site de Dahua pour le DH-XVR5108HS-I3/T et reportez les menus exacts.

**Enregistreur Dahua**

1. Fiche technique Dahua DH-XVR5108HS-I3 (Rev 002.000, 2023, version matérielle 3.0), notamment : reconnaissance faciale 2 voies, 10 bases et 10 000 photos, « prend effet quand Face est choisi dans AI Mode », « SMD Plus prend effet quand SMD ou IVS&SMD est choisi dans AI Mode » : https://download.securityrussia.com/XVR5108HS-I3_V3_datasheet_20230720.pdf
2. Page constructeur Dahua du XVR5108HS-I3/T (version française) : https://www.dahuasecurity.com/fr/products/hdcvi-products/hdcvi-recorders/5mp-value-1080p-series/xvr5108hs-i3/t
3. Page constructeur Dahua du XVR5108HS-I3=V3 (version Australie), pour les mentions sur le mode d'analyse et « Encode Enhancement » : https://www.dahuasecurity.com/au/products/HDCVI-Recorders/5MP-Value1080p-Series/XVR5108HS-I3=V3
4. Fiche technique de la série voisine XVR5108HS-4KL-I3 (« Face Recognition conflicts with SMD Plus and Perimeter Protection ») : https://www.tssgroup.cz/buxus/docs/datasheety/Dahua%20XVR5108HS-4KL-I3%20en%20datasheet.pdf
5. Dahua, « Smart IPC Installation and Configuration Guide » (section 2.3.2, installation pour la détection de visage) : http://download.asm.cz/inshop/prod/Dahua/Dahua%20Smart%20IPC%20Installation%20and%20Function%20User%20Manual-Public%20version.pdf

**Guides d'installateurs (tiers, non officiels : chemins de menu et valeurs à contrôler)**

6. Ameta Group, « How to setup Dahua Face Recognition on XVR » : https://ametawiki.ametagroup.com/docs/how-to-setup-dahua-face-recognition-on-xvr
7. Ameta Group, « How to setup Dahua Face Recognition » (NVR) : https://ametawiki.ametagroup.com/docs/how-to-setup-dahua-face-recognition
8. SecurityCamCenter, « How to use Dahua Face Recognition » : https://securitycamcenter.com/dahua-face-recognition/
9. SecurityCamCenter, « How to setup Face Detection on Dahua recorder » : https://securitycamcenter.com/setup-face-detection-dahua-new-interface/
10. CCTV-Mall, « How to Set Up Dahua Face Recognition & Face Database Correctly » : https://www.cctv-mall.com/blogs/news/how-to-set-up-dahua-face-recognition-face-database-correctly

**Droit**

11. Loi n° 2013-450 du 19 juin 2013 relative à la protection des données à caractère personnel, Journal officiel de la République de Côte d'Ivoire du 8 août 2013 (texte lu : articles 1, 4 à 7, 11, 14 à 19, 21, 25, 28 à 31, 33, 35, 36, 39 à 41, 43, 46) : https://lexterra.ci/data/civil/Data_perso/2013-06-19_Loi_2013-450_Protection_donn%C3%A9es_personnelles.pdf
12. Site de l'Autorité de protection (ARTCI), page des lois : https://www.autoritedeprotection.ci/lois/
13. Koaci, 20 juin 2024, mise en garde de l'ARTCI sur l'utilisation de la biométrie : https://www.koaci.com/article/2024/06/20/cote-divoire/technologie/cote-divoire-utilisation-abusive-de-la-biometrie-dans-les-services-publics-et-prives-lartci-met-en-garde-contre-le-non-respect-des-donnees-a-caractere-personnelles_178842.html
14. Digital Business Africa, « Ce qu'il faut savoir du cadre réglementaire de la biométrie en Côte d'Ivoire » (octobre 2024 ; source de la mention du décret 2018-454, non vérifiée dans le texte) : https://www.digitalbusiness.africa/ce-quil-faut-savoir-du-cadre-reglementaire-de-la-biometrie-en-cote-divoire/

**Fiabilité des algorithmes**

15. NIST, NISTIR 8280, « Face Recognition Vendor Test (FRVT) Part 3: Demographic Effects », décembre 2019 : https://nvlpubs.nist.gov/nistpubs/ir/2019/NIST.IR.8280.pdf

**Dans ce dépôt** : [PRESENCE-REGLES.md](PRESENCE-REGLES.md) (contrat), [MISE-EN-SERVICE.md](MISE-EN-SERVICE.md), `PRODUCT.md`.

---

## 9. Points à vérifier

| N° | Point | Section |
|---|---|---|
| 1 | Choisir *Face* coupe-t-il SMD Plus, pour ce XVR et ce logiciel 4.000 ? (très probable d'après la fiche, non confirmé) **Le réglage « AI Mode » est-il par voie ou global à l'enregistreur ?** La fiche ne le dit pas ; s'il est global, SMD Plus pourrait être coupé sur les 8 voies | 2.2, 2.3 |
| 2 | Le plan intelligent permet-il des horaires (visage la nuit, détection le jour) ? | 2.3 |
| 3 | Chemins de menu du XVR (plan intelligent, détection et reconnaissance de visage, bibliothèque, base de visages, export de configuration) : vus seulement dans des guides tiers | 2.3 à 2.5, 4.2, 5.8 |
| 4 | « Encode Enhancement » interdit-il la reconnaissance sur ce XVR ? | 2.1 |
| 5 | Version matérielle du XVR (fiche pour version 3.0, page du « /T » différente) | 2.1 |
| 6 | Le XVR accepte-t-il les accents dans le nom des bases, et plusieurs photos par personne ? | 2.4, 2.5 |
| 7 | Exigences de taille et de poids des photos de l'XVR | 2.5 |
| 8 | Valeur par défaut du seuil (80), existence d'un seuil par base ou par voie | 2.6 |
| 9 | Valeurs d'installation propres à l'algorithme du XVR (taille minimale du visage, angles) : celles citées viennent de caméras Dahua | 3.1 |
| 10 | Résolution réelle des voies 5 et 8 ; résolution et cadence de l'image réellement analysée | 3.3 |
| 11 | Compensation de contre-jour disponible sur les caméras ; option d'exposition sur visage | 3.5 |
| 12 | Effet de l'infrarouge sur la reconnaissance ; caméras à double éclairage | 3.6 |
| 13 | Aucune mesure publique de l'algorithme du XVR sur les écarts selon l'origine, le sexe, l'âge | 4.1 |
| 14 | Application de l'exception « usage personnel ou domestique » (art. 4 et 6) à cette résidence | 5.2 |
| 15 | Statut biométrique d'un visage comparé à une photo ; article 21 et visage ; autorisation de l'article 7 | 5.2 |
| 16 | Décret n° 2018-454 et rôle de l'ONI (texte non lu) | 5.2 |
| 17 | Validité du consentement du personnel dépendant de l'employeur ; solution alternative | 5.2 |
| 18 | Règles de vidéosurveillance (affichage, durées) | 5.2 |
| 19 | Durées de conservation acceptables (art. 43 : fixées par l'Autorité) | 5.7 |
| 20 | Suppression ciblée des captures de visage sur le disque du XVR | 5.8 |
| 21 | Format exact des événements `FaceRecognition` / `FaceDetection` (lot V4) | 6 |
