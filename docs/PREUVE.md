# Dossier de preuve d'un incident

Ce guide s'adresse au **gestionnaire du site** (pas besoin d'être développeur). Il explique comment sortir, pour un incident, un **dossier unique** à remettre à un assureur, à une banque, à la police ou à un tribunal, comment le faire **vérifier**, et ce qu'il prouve **vraiment** (et ce qu'il ne prouve pas).

## 1. Exporter un dossier

1. Connectez-vous au PSIM avec votre compte (opérateur ou administrateur).
2. Ouvrez l'incident : le bouton **« Dossier de preuve »** se trouve dans la fiche de l'alarme (alarme en cours) et sur chaque ligne des alarmes clôturées.
3. Le navigateur télécharge un fichier nommé `dossier-preuve-incident-<n°>-<date>-<heure>.zip` (dossier *Téléchargements*). Le nom est donné par le PSIM : ne le renommez pas avant de l'avoir remis (renommer ne change rien au contenu, mais gardez le nom d'origine pour pouvoir retrouver l'export dans le journal).

Vous pouvez exporter un incident **même clos**, et même un incident **encore ouvert**. Au plus quelques exports par minute et par compte sont acceptés (protection : la préparation lit les images sur le disque).

**Chaque export est inscrit au journal du PSIM** (action « Dossier de preuve exporté » : qui, quel incident, empreinte du fichier) *avant* que le fichier ne vous soit remis. Il n'existe donc pas de dossier « hors journal ». Le portail de suivi à distance n'a **jamais** accès à ce dossier ni aux images.

## 2. Que contient le dossier ?

Un seul fichier `.zip`, qui s'ouvre avec l'Explorateur Windows (clic droit, *Extraire tout*) :

| Fichier | Rôle |
|---|---|
| `LISEZ-MOI.txt` | Ce que prouve et ne prouve pas le dossier, comment le vérifier |
| `rapport.html` | Compte rendu lisible et imprimable (à ouvrir dans le navigateur, fonctionne hors connexion ; *Imprimer → Enregistrer au format PDF* pour un document papier) |
| `incident.json` | Identité de l'incident, équipement, zone, étage, catégorie, motif, états successifs avec dates, ouverture, acquittement, qualification, clôture, commentaire, **noms des personnes intervenues**, liste des images avec leurs empreintes |
| `journal-extrait.json` | Les entrées du journal liées à l'incident et à l'équipement (et aux caméras liées) dans une fenêtre autour de l'incident (10 min avant l'ouverture, 10 min après la clôture), chacune avec son empreinte, plus l'« ancre » du journal au moment de l'export |
| `images/` | Les **originaux** des images (caméras liées ou envoyées par l'équipement), sans aucune retouche |
| `notifications.json` | Qui a été prévenu, quand, par quel canal, avec quel résultat (sans mot de passe ni adresse secrète) |
| `MANIFEST.sha256` | L'empreinte SHA-256 de chacun des autres fichiers |

Le dossier contient des **données personnelles** (noms d'opérateurs, adresses de personnes prévenues, images de personnes). Ne le diffusez qu'à la personne qui en a besoin, et conservez-le comme une pièce sensible.

Si une image est **manquante** ou **modifiée** sur le disque du PSIM, le dossier est produit quand même et l'écrit **en clair** (bandeau rouge dans le rapport, mention dans le LISEZ-MOI et dans `incident.json`). Aucune anomalie n'est cachée.

## 3. Quoi remettre, à qui

- **Assureur ou banque** : le fichier `.zip` tel quel (par courriel sécurisé, clé USB ou dépôt sur leur plateforme). Joignez, si vous l'avez, le **rapport reçu par e-mail le jour de l'incident** (il porte en pied l'empreinte du journal : l'« ancre »).
- **Police / gendarmerie / justice** : le `.zip` **sur support non modifiable** (clé USB neuve ou CD), plus une impression du `rapport.html` et du `LISEZ-MOI.txt`. Notez le **nom du fichier** et son **empreinte SHA-256** (donnée par la vérification, voir plus bas) sur le procès-verbal ou le courrier de remise.
- Conservez **votre propre copie** du `.zip`, sans l'ouvrir ni le modifier, dans un endroit séparé du PSIM.

## 4. Faire vérifier un dossier

La vérification se fait **hors ligne**, sans accès au PSIM ni à sa base de données, sur n'importe quel poste où le logiciel est installé (Node.js 24 ou plus). Elle ne modifie rien et n'extrait rien sur le disque.

```
npm run verify-proof -- chemin\vers\dossier-preuve-incident-12-20260210-093000.zip
```

Elle contrôle :
- l'empreinte de **chaque fichier** contre `MANIFEST.sha256` (fichier modifié, ajouté ou supprimé) ;
- la **chaîne du journal** : chaque entrée est recalculée à partir de l'empreinte précédente ; une ligne modifiée ou une liaison cassée est signalée ;
- chaque **image** contre l'empreinte **scellée dans le journal** au moment où elle a été enregistrée ;
- la cohérence entre `incident.json` et le journal.

Le verdict est écrit en français :
- **CONFORME** : rien n'a été modifié depuis l'export, le journal est bien chaîné, les images correspondent (code de sortie 0) ;
- **DOSSIER ALTÉRÉ** : un fichier ou une entrée a été modifié, ajouté ou retiré (code 1) ;
- **ANOMALIES SIGNALÉES** : le dossier n'a pas été modifié, mais l'export lui-même signalait un problème (image manquante, image modifiée sur le disque…). La preuve est fragilisée sur ces points (code 1) ;
- **DOSSIER REFUSÉ** : le fichier n'est pas un dossier exploitable (zip tronqué, piégé, trop volumineux).

Deux contrôles **complémentaires**, qui renforcent beaucoup la valeur du dossier :
- **Comparer à une ancre conservée ailleurs** : `npm run verify-proof -- dossier.zip --anchor 1234:<64 caractères>` avec l'empreinte « du journal » imprimée en pied d'un rapport reçu par e-mail ou notée dans une sauvegarde copiée hors du PSIM. L'ancre doit correspondre à une entrée de l'extrait (son numéro doit y figurer) ou à l'ancre de l'export, sinon le résultat est « non concluant ».
- **Comparer à l'inscription au journal du PSIM** : l'empreinte SHA-256 du `.zip` livré est inscrite au journal du PSIM (action « Dossier de preuve exporté »). Relevez-la dans le journal, puis : `npm run verify-proof -- dossier.zip --sha256 <empreinte>`. Cela prouve que le fichier est **bien celui que le PSIM a produit**.

## 5. Ce que le dossier prouve, et ses limites (à dire tel quel)

**Il prouve** :
- qu'aucun fichier du dossier n'a été modifié depuis l'export ;
- que les entrées du journal présentées sont enchaînées : en modifier une rompt la chaîne ;
- que chaque image est **celle dont l'empreinte a été scellée** au moment de son enregistrement ;
- avec une ancre externe ou l'empreinte du `.zip` relevée au journal : que le dossier n'a pas été refabriqué.

**Il ne prouve pas** :
- **L'heure exacte.** Les heures sont celles de l'**horloge du serveur** du PSIM. Il n'y a **pas d'horodatage certifié** par un tiers. Un serveur mal réglé date mal ; l'horloge de la machine peut être modifiée par quelqu'un qui en a l'accès.
- **La réalité des faits.** Le dossier prouve ce que le PSIM a *enregistré* : un détecteur peut se tromper, une caméra montre ce qu'elle voyait, pas ce qui s'est passé hors champ.
- **Que le journal ne peut pas être réécrit** par quelqu'un qui a un **accès complet à la base de données et connaît le mécanisme** : il peut tout recalculer, y compris fabriquer un dossier cohérent. Seules deux choses le révèlent : une **ancre conservée hors du PSIM** (rapports e-mail, sauvegardes copiées ailleurs) et l'**empreinte du `.zip` inscrite dans le journal** (qu'il faudrait aussi réécrire). Sans l'une d'elles, ce cas n'est pas détecté.
- **Que l'extrait est complet.** Seules les entrées liées à l'incident et à l'équipement, dans la fenêtre indiquée, y figurent. Le dossier seul ne permet pas de voir si une entrée ordinaire en a été retirée ; l'administrateur peut faire contrôler le **journal complet** du PSIM (`npm run verify-journal`) et comparer l'empreinte du `.zip`.
- Les **entrées antérieures** à l'activation du journal chaîné, et les images antérieures au scellement, ne sont pas protégées ; elles sont signalées en « remarque ».
- Un opérateur ne reçoit pas les entrées d'administration du journal (réglages, sécurité) qu'il ne voit pas non plus dans le PSIM ; l'administrateur les reçoit.

En résumé : le dossier est une **pièce solide de cohérence interne**, utile pour un assureur ou un enquêteur ; devant un tribunal, sa valeur dépend de l'ancre conservée ailleurs, de la chaîne de conservation (qui a eu le fichier, quand) et, si besoin, d'une expertise.

## 6. Bonnes pratiques

- Gardez les **rapports envoyés par e-mail** (ils portent l'ancre du journal) dans une boîte dont vous seul avez la maîtrise.
- Faites des **sauvegardes** copiées hors de la machine (leur manifeste contient aussi l'ancre).
- Vérifiez régulièrement que l'**horloge du serveur** est juste.
- Exportez le dossier **tout de suite** après un incident grave : les images sont supprimées par la purge de conservation passé le délai configuré (la purge est journalisée, et signalée dans le dossier).
