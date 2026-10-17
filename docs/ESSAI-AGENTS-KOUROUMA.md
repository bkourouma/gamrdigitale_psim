# Essai réel de l'application des agents — Résidence KOUROUMA

Guide pour le propriétaire et administrateur du PSIM. Il se lit sur place, dans l'ordre, sans connaissance technique.
Il a été écrit à partir de l'application telle qu'elle est aujourd'hui : les noms de boutons et de messages sont ceux
que vous verrez à l'écran.

Documents liés : `docs/AGENTS-RONDES.md` (contrat de conception), `docs/PRD-APPLICATION-AGENTS.md` (objectifs),
`docs/MISE-EN-SERVICE.md` (installation du PSIM, relance, pare-feu).

## Sommaire

1. À quoi sert l'essai
2. Matériel à réunir
3. Préparer le PSIM (ce qui change en production)
4. Installer le certificat sur le téléphone
5. Créer les points, le circuit, les agents et le téléphone
6. Fabriquer et poser les étiquettes
7. Appairer le téléphone et le régler
8. Check-liste d'essai
9. Cadre légal et note d'information aux agents
10. Que faire si...
11. Retour d'essai

---

## 1. À quoi sert l'essai

Jusqu'ici, l'application des agents a été éprouvée avec des téléphones simulés. **Elle n'a jamais été essayée sur un vrai
téléphone Android.** Cet essai vérifie, sur le site réel, ce que la simulation ne peut pas montrer : l'installation du
certificat, la lecture des étiquettes NFC et des QR codes, le son et la vibration, la batterie, le Wi-Fi de la résidence.

**Durée prévue**

- Une soirée de préparation (environ 3 à 4 heures) : réglages du PSIM, certificat, points, circuit, étiquettes, appairage.
- Une nuit d'essai (de 20 h à 6 h, avec un ou deux agents volontaires) : le déroulé de la check-liste du chapitre 8.

**Ce que l'on mesure**

| Mesure | Objectif |
|---|---|
| Alarme reçue sur le téléphone | moins de 10 secondes |
| SOS reçu au poste de garde | moins de 5 secondes dans 99 % des cas, aucun SOS perdu sans avertissement |
| Une nuit de 12 heures de service | sans recharge du téléphone |
| Formation d'un agent | moins de 15 minutes |
| Lecture des étiquettes (NFC, QR, saisie du code) | chaque méthode fonctionne sur le terrain |

> **Avertissement : de vraies alarmes partiront.** Un SOS, une alarme de détecteur ou une ronde non faite ouvrent de
> vrais incidents et préviennent les vraies personnes (e-mail, Telegram, appels). Avant la nuit d'essai, prévenez toutes
> les personnes prévues pour recevoir les alertes. Le lendemain, clôturez les incidents d'essai en « fausse alarme »
> avec le commentaire « essai ».

---

## 2. Matériel à réunir

| Matériel | Précision |
|---|---|
| Téléphone Android | Android 10 ou plus, avec NFC, **Chrome à jour**, batterie d'au moins 4 000 mAh, étui de protection. Un code ou un schéma de verrouillage d'écran doit être réglé (Android l'exige pour installer le certificat). |
| Étiquettes NFC | Modèle NTAG213 ou NTAG215, autocollantes. Pour un point posé sur du métal (portail, armoire, local technique), prendre des étiquettes « anti-métal ». Si vous n'en avez pas : QR codes seuls, l'essai reste valable. |
| QR codes imprimés | Imprimante, papier A4, pochettes de plastification (de préférence mates), plastifieuse |
| Fixation | Ruban adhésif double face |
| Un second téléphone ou le PC du poste de garde | Pour voir l'essai « côté poste » (ce que voit le chef de poste) |
| Un chronomètre | Celui d'un téléphone convient |
| Cette check-liste imprimée | Chapitre 8, une copie par nuit d'essai |

Le téléphone et le PC du PSIM doivent être sur **le même Wi-Fi** de la résidence (pas le Wi-Fi invité : il isole souvent
les appareils les uns des autres).

---

## 3. Préparer le PSIM (ce qui change en production)

> **Avertissement : ces changements touchent le PSIM de production.** Ils ne sont **pas faits** : chacun se fait
> **avec votre accord**, un par un. Redémarrer le PSIM interrompt la surveillance quelques secondes : faites-le hors
> période critique et prévenez l'équipe avant. Ne partagez jamais les fichiers `key.pem` et `ca-key.pem` : ce sont des
> secrets.

### 3.1 Ce qui change, en un coup d'oeil

| Élément | Aujourd'hui | Après la préparation | Pourquoi |
|---|---|---|---|
| `PSIM_HOST` (dans `.env.production`) | `127.0.0.1` : le PSIM n'écoute que sur le PC lui-même, aucun téléphone ne peut s'y connecter | `0.0.0.0` : il écoute sur le réseau de la résidence | Le téléphone doit pouvoir l'atteindre. Tout appareil du réseau pourra alors le contacter (il faudra toujours un compte pour agir) : le Wi-Fi doit être protégé par mot de passe. |
| `PSIM_PUBLIC_URL` | `https://<NOM-DU-PC>:3033` | `https://<ADRESSE-IP-FIXE-DU-PC>:3033` | Beaucoup de téléphones Android ne savent pas retrouver un nom de PC Windows du type `DESKTOP-XXXX`. Cette adresse est celle qui est écrite dans les QR codes. |
| Adresse IP du PC | peut changer | **fixe** | Réservez-la dans le routeur (réservation d'adresse, aussi appelée « bail statique »). Sinon, un jour l'adresse change et tout s'arrête. |
| Certificat HTTPS | ancien certificat auto-signé | certificat signé par une petite « autorité locale » du PSIM | Le téléphone fait confiance à l'autorité (une seule installation), puis à tous les certificats qu'elle signe. |
| Pare-feu Windows | port 3033 fermé aux autres appareils | port 3033 ouvert sur le réseau privé | Sans cela, le téléphone n'atteint pas le PSIM. |
| Redémarrage du PSIM | en marche | redémarré une fois | Pour prendre en compte les réglages. |

`PSIM_TLS_CERT` et `PSIM_TLS_KEY` pointent déjà vers `data-prod\tls\cert.pem` et `data-prod\tls\key.pem` : ne les
changez pas.

### 3.2 Pas à pas

Notez d'abord l'adresse IP du PC (par exemple `192.168.1.50`) et son nom. Dans la suite, remplacez
`<ADRESSE-IP-FIXE-DU-PC>` et `<NOM-DU-PC>` par vos valeurs. Les adresses données en exemple sont fictives.

1. **Réserver l'adresse IP du PC dans le routeur** (menu « DHCP » ou « Réservation d'adresse » du routeur, selon la
   marque). Vérifiez que l'adresse ne change plus après un redémarrage du PC.

2. **Créer le nouveau certificat** (avec votre accord : en production, cela **remplace** le certificat actuel). Dans le
   dossier du PSIM, ouvrez un terminal et tapez :

   ```
   npm run make-cert:prod -- --force <ADRESSE-IP-FIXE-DU-PC> <NOM-DU-PC>
   ```

   Résultat, dans le dossier `tls` de `data-prod` :

   | Fichier | Contenu | Partage |
   |---|---|---|
   | `cert.pem` | certificat du serveur, avec l'autorité | public |
   | `key.pem` | clé du serveur | **secret** |
   | `ca-key.pem` | clé de l'autorité locale | **secret**, ne jamais partager ni envoyer |

   Options à connaître :

   - `--nouvelle-autorite` : crée une autorité neuve. Les téléphones qui avaient installé l'ancienne devront
     **réinstaller** le certificat. À n'utiliser que si nécessaire.
   - `--autosigne` : ancien mode (sans autorité). Déconseillé : il oblige à accepter un avertissement sur chaque appareil.
   - Plus tard, renouveler le certificat du serveur (`--force`) ne demande **pas** de réinstaller sur les téléphones, tant
     que l'autorité reste la même. L'autorité est valable 10 ans.

   **Attention :** le certificat du serveur ne couvre que les adresses et noms écrits dans cette commande. Si vous le
   renouvelez plus tard avec `--force`, redonnez **toutes** les adresses (celle du PC et son nom) : celle que vous
   oubliez ne sera plus acceptée.

   Les **postes** (par exemple le PC du poste de garde) qui avaient accepté l'ancien certificat devront eux aussi installer
   le nouveau certificat, ou accepter à nouveau l'avertissement.

3. **Modifier `.env.production`** (avec votre accord ; ne lisez ni ne partagez les mots de passe qu'il contient). Changez
   seulement ces deux lignes :

   ```
   PSIM_HOST=0.0.0.0
   PSIM_PUBLIC_URL=https://<ADRESSE-IP-FIXE-DU-PC>:3033
   ```

4. **Ouvrir le port 3033 dans le pare-feu Windows**, sur le réseau privé seulement. Dans PowerShell lancé **en
   administrateur** :

   ```
   New-NetFirewallRule -DisplayName "PSIM 3033 (réseau privé)" -Direction Inbound -Protocol TCP -LocalPort 3033 -Profile Private -Action Allow
   ```

   Si Windows considère votre réseau comme « public », passez-le en « privé » (Paramètres Windows, Réseau et Internet,
   propriétés du Wi-Fi ou de l'Ethernet).

5. **Redémarrer le PSIM de production** (étape sensible : avec votre accord, hors période critique, équipe prévenue). La
   commande dépend de la façon dont le PSIM est lancé chez vous : **voir `docs/MISE-EN-SERVICE.md`**, section 7
   (« Relance automatique »).

6. **Contrôle préalable.** Dans le dossier du PSIM :

   ```
   npm run check-agents:prod
   ```

   Cet outil dit en clair ce qui manque : HTTPS, certificat à installer, adresse publique, écoute sur le réseau, étage
   avec plan, agent, téléphone, circuit, points placés. Corrigez ce qu'il signale, puis relancez-le. Pour tester aussi le
   PSIM en marche, ajoutez l'option `--live` :

   ```
   npm run check-agents:prod -- --live
   ```

   Certains points (agent, téléphone, circuit, points) ne seront verts qu'après le chapitre 5 : c'est normal, revenez
   alors relancer le contrôle.

7. **Ouvrir le PSIM par son adresse réseau.** Pour la suite de l'essai, ouvrez toujours l'interface du PSIM dans le
   navigateur du PC avec **`https://<ADRESSE-IP-FIXE-DU-PC>:3033`**, **jamais avec `localhost`**. Raison : l'adresse
   affichée à l'écran dans l'éditeur d'un point (« Adresse que contient l'étiquette ») est calculée avec l'adresse tapée
   dans le navigateur. Si vous êtes sur `localhost`, l'adresse copiée pour une étiquette NFC pointerait vers `localhost`
   et ne marcherait sur aucun téléphone. (Les QR imprimés, eux, utilisent `PSIM_PUBLIC_URL`, mais pour écrire les
   étiquettes NFC il faut bien être sur l'adresse réseau.)

---

## 4. Installer le certificat sur le téléphone

À faire **une seule fois par téléphone**. Le certificat est celui de l'autorité locale du PSIM. Il permet à Chrome
d'afficher le cadenas sans avertissement.

### 4.1 Récupérer le fichier

1. Dans le PSIM (ouvert sur `https://<ADRESSE-IP-FIXE-DU-PC>:3033`), allez dans **Rondes**, onglet **Téléphones**. Quand
   vous ajoutez un téléphone, la fenêtre affiche « **Étape 1 : installer le certificat** » avec un QR code et le bouton
   « Télécharger le certificat ».
2. Sur le téléphone, scannez ce QR code avec l'appareil photo (ou ouvrez dans Chrome
   `https://<ADRESSE-IP-FIXE-DU-PC>:3033/api/agent-cert`). Un fichier est téléchargé (nom : `psim.crt`).

> **Normal : un avertissement s'affiche à cette toute première ouverture.** Le téléphone ne connaît pas encore
> l'autorité, donc il prévient que la page n'est pas de confiance. Avancez quand même (« Paramètres avancés », puis
> « Continuer vers le site ») **uniquement pour télécharger ce fichier** : c'est la seule fois. Autre solution :
> transférer le fichier par câble USB, par Bluetooth ou en vous l'envoyant par e-mail.

### 4.2 L'installer

Android exige un verrouillage d'écran (code, schéma ou empreinte) pour installer un certificat. Si le téléphone n'en a
pas, réglez-en un d'abord.

**Android (Pixel et téléphones proches d'Android pur)**

1. Paramètres, puis **Sécurité** (ou **Sécurité et confidentialité**).
2. **Chiffrement et identifiants** (parfois dans « Plus de paramètres de sécurité »).
3. **Installer un certificat**, puis **Certificat CA**.
4. Un avertissement apparaît (voir ci-dessous) : choisissez **Installer quand même**.
5. Choisissez le fichier `psim.crt` téléchargé (dossier Téléchargements). Si on vous demande un nom, tapez « PSIM ».

**Samsung**

1. Paramètres, puis **Biométrie et sécurité**.
2. **Autres paramètres de sécurité**.
3. **Installer depuis la mémoire du téléphone**, puis **Certificat CA**.
4. Acceptez l'avertissement, choisissez le fichier `psim.crt`.

**Xiaomi, Redmi, Poco (HyperOS ou MIUI)**

1. Paramètres, puis **Mots de passe et sécurité**.
2. **Confidentialité du système**.
3. **Chiffrement et identifiants**, puis **Installer un certificat**.
4. Choisissez **Certificat CA**, acceptez l'avertissement, choisissez `psim.crt`.

**Pourquoi l'avertissement « votre réseau peut être surveillé » est normal ici.** Android affiche cette phrase pour tout
certificat d'autorité, sans distinguer le vôtre. Ici, l'autorité a été créée par votre propre PSIM, sur votre propre PC,
pour la seule adresse de votre résidence. Vous installez un certificat que vous avez fabriqué vous-même. Ne faites jamais
cette manipulation avec un fichier reçu d'une source inconnue.

### 4.3 Vérifier

1. **Fermez complètement Chrome** (ouvrez la liste des applications récentes et balayez Chrome). Certains Android ne
   montrent le nouveau certificat qu'après cette fermeture.
2. Rouvrez Chrome et allez sur `https://<ADRESSE-IP-FIXE-DU-PC>:3033/agent/`.
3. Résultat attendu : la page de l'application s'affiche avec un **cadenas, sans aucun avertissement**.

Si un avertissement persiste, voir le chapitre 10, ligne « Avertissement de sécurité dans Chrome malgré l'installation ».

---

## 5. Créer les points, le circuit, les agents et le téléphone

Tout se fait dans le PSIM, menu **Rondes** (ouvert sur l'adresse réseau, voir 3.2 point 7). Il y a cinq onglets :
**Points de contrôle**, **Circuits**, **Agents**, **Téléphones**, **Journal**.

Prérequis : un étage avec son plan existe déjà dans « Équipements et plan ». Sinon, créez-le d'abord.

### 5.1 Les points de contrôle

Un point de contrôle est un endroit que l'agent doit atteindre pendant sa ronde. Proposition pour la résidence (à
adapter à vos lieux) : **Portail, Avant-cour, Escalier, Arrière-cour, Parking, Local technique**.

Pour chaque point, onglet **Points de contrôle** :

1. Dans le panneau « Ajouter un point », saisissez le **Nom du point** (ce que l'agent lit sur son téléphone), la zone et
   l'étage, puis cliquez sur **Ajouter le point**. Le point apparaît au centre du plan.
2. **Glissez le point à sa vraie place sur le plan** (ou utilisez les flèches du clavier).
3. Dans « Point sélectionné », cliquez sur **Enregistrer**.

Choisissez des zones qui existent déjà dans le PSIM : un agent ne reçoit que les alarmes des zones qui lui sont
attribuées (voir 5.3).

### 5.2 Le circuit d'essai

Onglet **Circuits**, bouton **Créer un circuit**. Proposition : une ronde de nuit toutes les 2 heures, de 20 h à 6 h.

| Champ à l'écran | Valeur proposée |
|---|---|
| Nom du circuit | Ronde de nuit |
| Points à contrôler | cochez les six points |
| Ordre de passage | si vous choisissez « Dans l'ordre indiqué », rangez les points avec « Monter » et « Descendre » |
| Ordre | « Dans n'importe quel ordre » (plus simple pour un premier essai : un point scanné trop tôt ne compte pas dans l'autre mode) |
| Durée maximale (en minutes) | 20 (la ronde doit être finie 20 minutes après son début ; la valeur par défaut est 45) |
| Quand | une plage par départ de ronde (voir ci-dessous) |
| Agents concernés | « Tout agent en service », ou « Certains agents seulement » |
| Délai avant alarme critique (en minutes) | 10 (valeur par défaut : après ce délai, une ronde restée incomplète devient critique) |
| Circuit actif | coché |

**Comment écrire « toutes les 2 heures ».** Le PSIM déclenche une ronde à l'**heure de début** (« De ») de chaque plage.
Il n'y a pas de réglage « toutes les 2 heures » : on ajoute une plage par départ, avec le bouton **Ajouter une plage**,
tous les jours cochés. Pour la nuit :

| Plage | De | À |
|---|---|---|
| 1 | 20:00 | 20:20 |
| 2 | 22:00 | 22:20 |
| 3 | 00:00 | 00:20 |
| 4 | 02:00 | 02:20 |
| 5 | 04:00 | 04:20 |

L'heure « À » ne déclenche rien par elle-même : c'est la **Durée maximale** qui fixe la fin de la ronde. Cliquez sur
**Enregistrer le circuit**, puis relisez la phrase « Ce que dira le circuit » : elle doit dire ce que vous voulez.

Pour le premier contrôle, vous pouvez ajouter une plage dans les minutes qui viennent (par exemple dans 15 minutes) afin
de ne pas attendre 20 h.

### 5.3 Les agents (un ou deux volontaires)

Onglet **Agents**, formulaire « Ajouter l'agent » :

| Champ | Règle |
|---|---|
| Nom affiché | Le nom que l'on verra dans la liste et dans le journal |
| Identifiant | 3 à 30 caractères : lettres minuscules sans accent, chiffres, tiret ou soulignement, sans point. Il sert à reconnaître l'agent, pas à se connecter. |
| Code personnel | 4 à 6 chiffres. Le bouton « Choisir un code au hasard » en propose un. **À ne pas partager.** |
| Zones | « Toutes les zones », ou décochez pour limiter aux zones voulues |
| Durée maximale d'un service (heures) | 12 par défaut (de 1 à 24) |

Cliquez sur **Ajouter l'agent**. Le code est affiché **une seule fois**, dans une fenêtre : notez-le et dites-le à l'agent
de vive voix, puis cliquez sur « J'ai noté le code, fermer ». Le PSIM n'en garde qu'une empreinte et ne peut pas le
retrouver. En cas d'oubli, donnez-lui un nouveau code (bouton **Modifier**).

### 5.4 Le téléphone

Onglet **Téléphones** :

1. Tapez un nom (par exemple « Téléphone du portail ») et cliquez sur **Ajouter et afficher le QR code**.
2. Une fenêtre s'ouvre en deux étapes : « Étape 1 : installer le certificat » (chapitre 4) et « Étape 2 : appairer le
   téléphone ».
3. Le QR code d'appairage est **valable peu de temps (15 minutes) et ne sert qu'une fois**. Ne l'affichez qu'au moment où
   le téléphone est prêt. S'il expire, cliquez de nouveau sur **Ajouter** pour en obtenir un autre.

Gardez cette fenêtre ouverte et passez au chapitre 6, puis au 7 : l'appairage se fait à la fin, téléphone en main.

---

## 6. Fabriquer et poser les étiquettes

Une étiquette, qu'elle soit QR ou NFC, contient **la même adresse** :

```
https://<adresse-du-PSIM>/agent/#cp=<code>
```

où `<code>` est un code de 10 caractères (lettres minuscules a à z et chiffres 2 à 7), propre à chaque point.
Exemple (**valeur fictive**, ne l'utilisez pas) :

```
https://192.168.1.50:3033/agent/#cp=k4m7qx2b3d
```

### 6.1 Imprimer la planche de QR codes

1. Onglet **Points de contrôle**. Dans la liste, colonne « Étiquette », cochez **À imprimer** pour les points voulus (ou
   « Tout choisir »).
2. Cliquez sur **Imprimer la planche**. La planche montre, pour chaque point, le QR code, le nom, la zone et le code en
   clair sous la mention « **Saisie de secours** » (utile si le QR est abîmé).
3. Dans la fenêtre d'impression du navigateur :

   | Réglage | Valeur |
   |---|---|
   | Papier | A4 |
   | Échelle | **100 %** (« Taille réelle »). Ne choisissez pas « Ajuster à la page » : un QR réduit se lit mal. |
   | Marges | Par défaut |
   | **En-têtes et pieds de page** | **Désactivés** |
   | Couleur | Noir et blanc, en haute qualité |

   La planche est en trois colonnes. Chaque QR code mesure environ 3,5 cm de côté (35 mm).
4. **Contrôle d'impression avant de plastifier** : avec l'application des agents (chapitre 7) ou avec l'appareil photo,
   scannez une étiquette imprimée. Elle doit s'ouvrir sans hésitation. Sinon, réimprimez (échelle, encre, qualité).

### 6.2 Découper, plastifier, poser

1. **Découpez** chaque étiquette.
2. **Plastifiez** en gardant environ 2 mm de bord blanc autour du QR code. Préférez une pochette **mate** : un plastique
   brillant reflète la lumière et gêne la lecture.
3. **Posez** à hauteur de main, loin du soleil direct et de l'eau, sur une surface propre et sèche, avec du ruban double
   face.
4. **Sur du métal**, une étiquette NFC ordinaire ne fonctionne pas : prenez une étiquette « anti-métal ». Le QR code,
   lui, n'est pas gêné par le métal.

### 6.3 Écrire les étiquettes NFC (facultatif)

Sur un téléphone Android, avec l'application gratuite **NFC Tools** (depuis le Play Store).
**Rappel : ouvrez le PSIM depuis `https://<ADRESSE-IP-FIXE-DU-PC>:3033`, jamais depuis `localhost`** (voir 3.2 point 7).

1. Dans le PSIM, onglet **Points de contrôle**, sélectionnez le point : dans « Point sélectionné », cliquez sur **Copier
   l'adresse** (champ « Adresse que contient l'étiquette »). Vérifiez qu'elle commence par
   `https://<ADRESSE-IP-FIXE-DU-PC>:3033/agent/#cp=`.
2. Faites passer cette adresse au téléphone qui écrit les étiquettes (message à soi-même, par exemple), puis copiez-la.
3. Dans NFC Tools : **Écrire**, puis **Ajouter un enregistrement**, puis **URL/URI**, collez l'adresse, validez.
4. Touchez **Écrire**, puis approchez l'étiquette du dos du téléphone jusqu'à la confirmation.
5. **Vérifiez** : onglet **Lire**, approchez l'étiquette : l'adresse écrite doit s'afficher, avec le bon code.
6. Collez l'étiquette à l'endroit du point. Notez le nom du point au dos si l'étiquette n'a pas de marque.

Une étiquette NFC peut être **verrouillée** (plus jamais modifiable). C'est **irréversible** : ne le faites qu'une fois
l'essai validé. Pendant l'essai, laissez-les modifiables.

---

## 7. Appairer le téléphone et le régler

### 7.1 Appairer

1. Sur le PC, la fenêtre « Étape 2 : appairer le téléphone » doit être ouverte avec son QR code (sinon, onglet
   **Téléphones**, bouton **Afficher le QR** à côté du téléphone en attente).
2. Sur le téléphone, scannez ce QR avec l'appareil photo (ou Chrome). L'application s'ouvre et le téléphone est appairé.
   Le PSIM affiche « <nom du téléphone> est appairé ».
   Si le QR ne s'ouvre pas, ouvrez l'application sur `https://<ADRESSE-IP-FIXE-DU-PC>:3033/agent/` : l'écran **Appairer
   ce téléphone** permet de saisir le code à la main.
3. L'écran « Qui êtes-vous ? » liste les agents. Touchez votre nom, tapez votre code personnel, puis **Valider**.
4. Touchez **Je prends mon service**.

### 7.2 Installer l'application sur l'écran d'accueil

Dans Chrome, menu (les trois points) : **Ajouter à l'écran d'accueil** ou **Installer l'application**. Ouvrez ensuite
l'application par son icône.

### 7.3 Autorisations

| Réglage | Où et quoi |
|---|---|
| Caméra | Autoriser quand Chrome le demande (nécessaire pour scanner les QR codes) |
| NFC | Paramètres Android, Connexions (ou « Appareils connectés »), NFC : activé |
| Notifications | Autoriser |
| Son | Volume **média** et volume de sonnerie levés ; téléphone **pas en mode silencieux** |
| Son, première fois | Si le bandeau « Touchez ici pour activer le son » apparaît, touchez-le une fois : le navigateur exige un geste avant de jouer un son |

### 7.4 Batterie : ne pas endormir l'application

Pour qu'une alarme arrive à temps, l'application ne doit pas être mise en veille par Android.

- **Android général** : Paramètres, Applications, **Chrome**, Batterie, **Sans restriction** (ou « Ne pas optimiser »).
- **Xiaomi** : Paramètres, Batterie (ou Économiseur de batterie), Chrome (et l'application installée), **Aucune
  restriction** ; en plus, **verrouillez l'application dans les applications récentes** (cadenas) et autorisez le
  **démarrage automatique**.

**Ce qu'il faut savoir sur la vitesse d'alerte.** L'application interroge le PSIM **toutes les 4 secondes quand elle est
au premier plan** (écran allumé, application affichée) et **toutes les 30 secondes en arrière-plan**. L'objectif « alarme
reçue en moins de 10 secondes » ne vaut donc que pour l'application ouverte devant l'agent. Garder l'écran allumé n'est
pas obligatoire, mais en arrière-plan le délai peut atteindre 30 secondes. La réception application fermée (notification
système) n'existe pas encore : elle est prévue plus tard.

---

## 8. Check-liste d'essai

Remplissez-la pendant l'essai : cochez `☐` dans « OK » ou « KO » et notez ce que vous voyez dans « Remarque ». Les
actions marquées « poste » se regardent sur le PC du poste de garde (ou le second téléphone).

### 8.1 Avant la nuit : installation

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 1 | Ouvrir `https://<IP>:3033/agent/` dans Chrome | Cadenas, aucun avertissement | ☐ | ☐ | |
| 2 | Scanner le QR d'appairage | Le PSIM affiche « ... est appairé » | ☐ | ☐ | |
| 3 | Installer l'application sur l'écran d'accueil et l'ouvrir par l'icône | L'application s'ouvre en plein écran | ☐ | ☐ | |
| 4 | Contrôle préalable `npm run check-agents:prod -- --live` | Aucun point manquant | ☐ | ☐ | |

### 8.2 P1 : prise de service

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 5 | Toucher votre nom, taper le code, **Valider** | L'écran principal s'affiche (onglets Alarmes, Ronde, SOS) | ☐ | ☐ | |
| 6 | Toucher **Je prends mon service** | Le message « Vous avez pris votre service. » s'affiche ; l'en-tête indique « Service depuis ... » | ☐ | ☐ | |
| 7 | Poste : Rondes, onglet **Agents** | L'agent apparaît « en service » (colonne Service) | ☐ | ☐ | |

### 8.3 P5 : alarme reçue pendant la ronde

Provoquez une vraie alarme dans une zone de l'agent (par exemple en ouvrant une porte surveillée, ou avec le bouton test
d'un détecteur : voir `docs/MISE-EN-SERVICE.md`, chapitre 4.2). Prévenez d'abord les destinataires des alertes.

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 8 | Application affichée, écran allumé : déclencher l'alarme, **chronométrer** jusqu'à l'apparition sur le téléphone | Alarme visible en moins de 10 s. Temps mesuré : ____ s | ☐ | ☐ | |
| 9 | Observer le téléphone | Son et vibration tant que personne n'a acquitté | ☐ | ☐ | |
| 10 | Toucher l'alarme | Le détail s'ouvre ; l'image de la caméra est visible (si une caméra est liée) | ☐ | ☐ | |
| 11 | Toucher **Acquitter** | Message « Alarme acquittée ✓ » ; le son s'arrête | ☐ | ☐ | |
| 12 | Toucher **J'y vais** | Message « C'est noté : vous y allez ✓ » | ☐ | ☐ | |
| 13 | Poste : détail de l'incident | Le bloc « Agents en déplacement » affiche « <nom> — en route (il y a ... ) » | ☐ | ☐ | |
| 14 | Toucher **Sur place** | Message « C'est noté : vous êtes sur place ✓ » ; le poste affiche « sur place » | ☐ | ☐ | |
| 15 | Application en arrière-plan (autre application ouverte), nouvelle alarme, chronométrer | Alarme visible au retour dans l'application. Temps mesuré : ____ s (attendu : jusqu'à 30 s) | ☐ | ☐ | |

### 8.4 Les trois façons de valider un point

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 16 | Onglet **Ronde**, **Scanner une étiquette NFC**, approcher une étiquette | Vibration, écran de confirmation « Point validé » avec coche verte | ☐ | ☐ | |
| 17 | **Scanner un QR code** devant une étiquette imprimée | Même résultat | ☐ | ☐ | |
| 18 | **Saisir le code** (les 10 caractères sous « Saisie de secours »), **Valider le passage** | Même résultat | ☐ | ☐ | |
| 19 | Téléphone déverrouillé, approcher une étiquette NFC **sans** ouvrir l'application | Chrome s'ouvre sur l'application, le passage est enregistré (« lecture téléphone déverrouillé ») | ☐ | ☐ | |
| 20 | Scanner deux fois le même point | Message « Point déjà validé » | ☐ | ☐ | |

### 8.5 Une ronde complète

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 21 | À l'heure d'une ronde (ou 15 min avant), regarder l'onglet **Ronde** | La ronde s'affiche avec ses points « À faire » et « À finir avant ... » | ☐ | ☐ | |
| 22 | Scanner les six points un par un | Chaque point : vibration et coche verte ; compteur « n / 6 points » ; si circuit ordonné, « Prochain point » | ☐ | ☐ | |
| 23 | Après le dernier point | La ronde passe à « Terminée » | ☐ | ☐ | |
| 24 | Poste : Rondes, onglet **Journal** | La ronde est « Faite », avec les six passages et leurs heures | ☐ | ☐ | |

### 8.6 Une ronde laissée incomplète

Les délais sont ceux du circuit configuré : fin de ronde = début + « Durée maximale » ; passage en critique =
fin de ronde + « Délai avant alarme critique » (10 minutes dans notre proposition). Si **aucun** point n'est scanné, il n'y
a pas de pré-alarme : le PSIM ouvre directement l'alarme « Ronde non faite ».

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 25 | Lors d'une ronde, ne scanner que trois points sur six, attendre la fin de la durée maximale | Poste : pré-alarme **« Ronde incomplète »** avec le nom des points manqués. Heure : ____ | ☐ | ☐ | |
| 26 | Ne rien faire pendant le délai avant alarme critique | Poste : l'alerte devient **critique**. Heure : ____ | ☐ | ☐ | |
| 27 | Sur une autre ronde, ne scanner **aucun** point | Poste : alarme **« Ronde non faite »** à la fin de la durée maximale | ☐ | ☐ | |
| 28 | Pendant le délai avant alarme critique, scanner les points manquants | La ronde se termine ; l'alerte retombe | ☐ | ☐ | |

### 8.7 Main courante

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 29 | Onglet **Ronde**, **Main courante** | L'écran « Main courante » s'ouvre | ☐ | ☐ | |
| 30 | Choisir un type (Anomalie, Dégradation, Visiteur, Autre), écrire un texte, **Prendre une photo**, **Envoyer** | Message « Main courante enregistrée ✓ » | ☐ | ☐ | |
| 31 | Poste : Rondes, **Journal**, section « Main courante » | L'entrée est là avec sa photo | ☐ | ☐ | |
| 32 | Poste : cliquer **En faire un incident**, puis **Ouvrir l'incident** | Message « Incident n° ... ouvert » ; l'incident « Signalement d'un agent » apparaît | ☐ | ☐ | |

### 8.8 SOS

Prévenez les destinataires : chaque SOS d'essai est une **vraie alarme critique**. Le bouton SOS se maintient pendant
**2 secondes** (un anneau de progression se remplit).

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 33 | Appui bref sur le bouton SOS | Rien ne part ; message « Pour appeler à l'aide, maintenez le bouton SOS 2 secondes. » | ☐ | ☐ | |
| 34 | Maintenir le bouton SOS 2 secondes | Le message « SOS envoyé ✓ à <heure> » s'affiche ; vibration de confirmation | ☐ | ☐ | |
| 35 | Poste | Alarme critique « Appel de détresse (SOS) » avec le nom de l'agent et son dernier point | ☐ | ☐ | |
| 36 | Onglet **SOS**, activer **Mode SOS discret**, refaire un SOS | Aucun son, aucun message à l'écran, une courte vibration ; le poste reçoit bien l'alarme | ☐ | ☐ | |
| 37 | Couper le Wi-Fi du téléphone, maintenir le SOS 2 s | Message en rouge « SOS non transmis — nouvel essai... » ; essai toutes les 10 s | ☐ | ☐ | |
| 38 | Rallumer le Wi-Fi | Le SOS part tout seul ; message « SOS envoyé ✓ » ; le poste reçoit l'alarme | ☐ | ☐ | |

**Dix essais chronométrés** (réseau Wi-Fi normal). Pour chaque essai : démarrez le chronomètre au moment où le bouton est
**relâché après 2 secondes** (le SOS part à ce moment), arrêtez-le quand l'alarme apparaît au poste.

| Essai | Heure | Temps mesuré (secondes) | Reçu au poste (oui / non) | Moins de 5 s (oui / non) | Remarque |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |
| 8 | | | | | |
| 9 | | | | | |
| 10 | | | | | |
| **Total** | | Moyenne : ____ s | ____ reçus sur 10 | ____ sur 10 en moins de 5 s | |

Objectif : 99 % reçus en moins de 5 secondes et **aucun SOS perdu sans avertissement**. Avec seulement dix essais, le
résultat est une indication, pas une preuve : un seul SOS en retard ou perdu est à noter comme KO et à signaler.

### 8.9 Hors réseau et synchronisation

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 39 | Couper le Wi-Fi, scanner deux points | Message « Enregistré — sera envoyé dès que le réseau revient » ; pastille « Hors ligne » ; badge « 2 envois en attente » | ☐ | ☐ | |
| 40 | Attendre plus de 2 minutes, puis rallumer le Wi-Fi | Le badge disparaît (envoi automatique, ou toucher le badge) | ☐ | ☐ | |
| 41 | Poste : Rondes, **Journal**, détail de la ronde | Les deux passages portent la mention « **reçu en différé** » | ☐ | ☐ | |

### 8.10 Position sur le plan du poste

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 42 | Scanner un point, puis regarder le plan sur le poste | Une pastille de l'agent est posée sur le dernier point scanné | ☐ | ☐ | |
| 43 | Attendre quelques minutes | La pastille indique « il y a N min » qui augmente | ☐ | ☐ | |

La position est **uniquement** le dernier point scanné : il n'y a pas de GPS.

### 8.11 Fin de service et effacement

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 44 | Toucher le nom de l'agent en haut (ou onglet **SOS**, carte « Mon compte »), **Terminer mon service**, **Oui, je termine mon service** | Retour à l'écran « Qui êtes-vous ? » | ☐ | ☐ | |
| 45 | Se reconnecter avec le même agent | Aucune ronde ni aucun envoi de la veille ne reste affiché ; « Hors service » | ☐ | ☐ | |
| 46 | Poste : onglet **Agents** | L'agent n'est plus « en service » ; sa position a disparu du plan | ☐ | ☐ | |

### 8.12 Téléphone révoqué

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 47 | Poste : Rondes, **Téléphones**, **Révoquer** le téléphone d'essai (confirmer) | Message « <nom> est révoqué » | ☐ | ☐ | |
| 48 | Sur le téléphone, attendre ou ouvrir l'application | Elle perd l'accès : message « Ce téléphone n'est plus appairé. Demandez un nouveau QR d'appairage au responsable. » (le serveur répond « Téléphone non appairé ») | ☐ | ☐ | |
| 49 | Ajouter de nouveau le téléphone et l'appairer | Il fonctionne à nouveau | ☐ | ☐ | |

### 8.13 Verrou après codes faux

L'agent est verrouillé après **5 codes faux**.

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 50 | Sur l'écran de code, taper un code faux, 5 fois de suite | Chaque fois « Code incorrect » ; à la 5e : « Compte verrouillé : voyez le chef de poste. » | ☐ | ☐ | |
| 51 | Dans la liste « Qui êtes-vous ? » | Le nom de l'agent est grisé avec la mention « Compte verrouillé : voyez le chef de poste » | ☐ | ☐ | |
| 52 | Poste (chef de poste ou administrateur) : Rondes, **Agents**, **Déverrouiller** | Message « Code de <nom> déverrouillé » | ☐ | ☐ | |
| 53 | Sur le téléphone, **Actualiser la liste**, puis taper le bon code | La connexion réussit | ☐ | ☐ | |

### 8.14 Batterie : une nuit de 12 heures

Notez le niveau au début et à la fin de la nuit, et à chaque heure indiquée. Le téléphone ne doit pas être rechargé.
Écran éteint entre les rondes, application ouverte en service.

| Heure | Niveau (%) | Remarque (rondes faites, écran allumé, Wi-Fi...) |
|---|---|---|
| 20:00 (début) | | |
| 22:00 | | |
| 00:00 | | |
| 02:00 | | |
| 04:00 | | |
| 06:00 (fin) | | |
| 08:00 (après 12 h de service) | | |

Objectif : le téléphone tient les 12 heures sans recharge. Résultat : ☐ OK ☐ KO

### 8.15 Formation d'un agent

| N° | Action à faire | Résultat attendu | OK | KO | Remarque |
|---|---|---|---|---|---|
| 54 | Former un agent qui ne connaît pas l'application : prise de service, une ronde, un SOS, une main courante. **Chronométrer.** | En moins de 15 minutes. Durée mesurée : ____ min | ☐ | ☐ | |
| 55 | Noter ce qu'il n'a pas compris (écrire ses mots exacts) | | ☐ | ☐ | |

---

## 9. Cadre légal et note d'information aux agents

> **Le PSIM ne remplace pas le travail juridique.** La résidence est l'employeur de ses agents : elle doit les **informer
> par écrit avant l'essai** et faire la **déclaration à l'ARTCI** (Autorité de régulation des télécommunications de Côte
> d'Ivoire), au titre de la loi n° 2013-450 sur la protection des données à caractère personnel. **À faire valider par un
> juriste ou par l'ARTCI.** Le modèle ci-dessous est une base, pas un avis juridique.

### Modèle de note d'information (une demi-page)

> **Note d'information aux agents de [NOM DE LA RÉSIDENCE]**
> Date : [JJ/MM/AAAA]
>
> **Pourquoi.** [NOM DE LA RÉSIDENCE] met à l'essai, du [DATE] au [DATE], une application sur téléphone pour la sécurité
> des personnes (bouton SOS, alarmes) et pour garder la preuve des rondes effectuées.
>
> **Quelles données.** Votre identité (nom affiché), vos heures de prise et de fin de service, le dernier point de
> contrôle que vous avez scanné, les photos et textes que vous écrivez dans la main courante, vos SOS. **Il n'y a pas de
> GPS** : l'application ne sait pas où vous êtes, sauf au moment où vous scannez un point de contrôle.
>
> **Pas de suivi hors service.** Votre dernière position est effacée à la fin de votre service. Rien n'est suivi quand
> vous n'êtes pas en service.
>
> **Combien de temps.** Les passages scannés et la main courante sont conservés **400 jours**. La position est effacée à
> la fin du service.
>
> **Qui peut voir.** L'administrateur [NOM] et le chef de poste [NOM]. L'accès à l'historique des passages est enregistré
> dans un journal.
>
> **Vos droits.** Vous pouvez demander à voir vos données, les faire corriger, et vous opposer à leur traitement pour un
> motif légitime. Contact : [NOM, FONCTION, TÉLÉPHONE / E-MAIL].
>
> Déclaration à l'ARTCI : [N° DE DÉCLARATION / « en cours »].
>
> J'ai reçu et lu cette note. Nom : [NOM DE L'AGENT]  Date : [JJ/MM/AAAA]  Signature : [SIGNATURE]

---

## 10. Que faire si...

| Problème | Vérifier, dans l'ordre |
|---|---|
| **Le certificat est refusé, ou il n'y a pas d'option « Certificat CA »** | 1. Un verrouillage d'écran est-il réglé ? Android le réclame. 2. Avez-vous bien cherché le chemin de votre marque (chapitre 4.2) ? Sur certains modèles, le menu s'appelle « Certificat d'autorité » ou se trouve dans « Plus de paramètres de sécurité ». 3. Choisissez « Certificat CA » et non « Certificat VPN et applications ». 4. Re-téléchargez le fichier : il doit s'appeler `psim.crt`. |
| **Avertissement de sécurité dans Chrome malgré l'installation** | 1. **Mauvaise adresse** : le certificat ne couvre que l'adresse donnée à `make-cert` ; tapez exactement `https://<IP>:3033` (pas le nom du PC, pas une autre adresse). 2. **Heure du téléphone fausse** : réglez l'heure et la date en automatique. 3. **Chrome pas redémarré** : fermez-le complètement (applications récentes) et rouvrez. 4. Le certificat du PC a-t-il été refait avec `--nouvelle-autorite` ? Alors réinstallez-le. |
| **Le QR d'appairage ouvre `localhost` ou une adresse inconnue** | `PSIM_PUBLIC_URL` est mal réglé dans `.env.production` : il doit valoir `https://<ADRESSE-IP-FIXE-DU-PC>:3033`. Corrigez, redémarrez le PSIM (avec accord), ajoutez le téléphone de nouveau pour un QR neuf. |
| **La page ne s'ouvre pas du tout** | 1. Le téléphone est-il sur le **même Wi-Fi** que le PC (pas le Wi-Fi invité) ? 2. Le pare-feu autorise-t-il le port 3033 (chapitre 3.2 point 4) ? 3. `PSIM_HOST` vaut-il `0.0.0.0` et le PSIM a-t-il été redémarré ? 4. L'adresse IP du PC a-t-elle changé ? Relancez `npm run check-agents:prod -- --live`. 5. Le PSIM tourne-t-il ? |
| **Le NFC ne lit pas** | 1. NFC activé dans les réglages Android ? 2. Étiquette posée sur du métal (il faut une étiquette « anti-métal») ? 3. Téléphone déverrouillé, écran allumé ? 4. La lecture dans l'application demande Chrome, **page de l'application ouverte** et HTTPS valide. 5. Repli : téléphone déverrouillé, approchez l'étiquette sans ouvrir l'application : l'ouverture de l'adresse enregistre aussi le passage. 6. Relisez l'étiquette avec NFC Tools (chapitre 6.3) : l'adresse est-elle la bonne ? Sinon, réécrivez-la. |
| **Le QR code ne se scanne pas** | 1. Éclairage : ni trop sombre, ni reflet sur le plastique (préférez le mat). 2. Étiquette trop petite ou **réduite à l'impression** (échelle 100 % obligatoire). 3. Caméra autorisée pour Chrome ? 4. Repli : **Saisir le code** (le code est sous « Saisie de secours »). |
| **Pas de son** | 1. Volume média et sonnerie levés, pas de mode silencieux. 2. Le bandeau « Touchez ici pour activer le son » est-il affiché ? Touchez-le une fois. 3. Notifications et son autorisés pour Chrome. |
| **L'application se déconnecte, les alarmes arrivent en retard** | 1. Économiseur de batterie : Chrome en « Sans restriction » (chapitre 7.4). 2. Wi-Fi qui se met en veille quand l'écran s'éteint : dans les réglages Wi-Fi avancés, gardez le Wi-Fi actif en veille. 3. Message « Votre session est terminée. Reconnectez-vous. » : retapez votre code. 4. Application en arrière-plan : l'interrogation passe à 30 s. |
| **Un envoi reste « non transmis » ou « en attente »** | 1. Wi-Fi allumé et PSIM joignable (ouvrez `https://<IP>:3033/agent/`) ? 2. Touchez le badge « N envois en attente », ou « Réessayer maintenant » pour un SOS. 3. Un envoi refusé pour de bon affiche « Envoi refusé : ... » : notez le message et prévenez le chef de projet. 4. Pour un SOS qui ne part pas : **appelez le poste de garde**. |

---

## 11. Retour d'essai

**À noter pendant l'essai**

- La date de l'essai et les noms des participants.
- Le modèle du téléphone, sa version d'Android et sa version de Chrome (Chrome : menu, Paramètres, À propos de Chrome).
- Les temps mesurés : alarme reçue, SOS (tableau des dix essais), délais des alertes de ronde.
- Chaque point « KO » de la check-liste, avec une **capture d'écran** (boutons volume bas et marche en même temps).
- Les phrases exactes dites par les agents (ce qu'ils n'ont pas compris, ce qui les a gênés).
- Le niveau de batterie au début et à la fin de la nuit (tableau 8.14).

**À qui et comment l'envoyer.** Au chef de projet, en joignant :

1. la check-liste remplie (photo ou scan de la feuille imprimée) ;
2. les captures d'écran des KO ;
3. des captures de l'écran **Journal** de Rondes (rondes de la nuit, passages, main courante) : il n'existe pas de
   bouton d'export dans cet écran ;
4. si possible, le rapport de rondes au format CSV : en étant connecté en administrateur, ouvrir dans le navigateur
   `https://<ADRESSE-IP-FIXE-DU-PC>:3033/api/patrols/report.csv` (le navigateur le télécharge) ;
5. un mot sur ce que vous referiez autrement.

Ne joignez **jamais** `.env.production`, `key.pem` ni `ca-key.pem`.
