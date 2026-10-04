# Alertes WhatsApp (API officielle de Meta)

Le PSIM envoie ses alertes par **WhatsApp Cloud API**, l'API officielle de Meta : fiable, vers n'importe quel numéro WhatsApp, depuis un numéro d'expéditeur à votre nom. C'est le canal à privilégier là où WhatsApp est la messagerie de tous les jours (Afrique de l'Ouest notamment).

> Pour un essai personnel gratuit, sans compte Meta, le PSIM connaît aussi **CallMeBot** (voir le README) : sans garantie, réservé à un usage personnel, à ne pas utiliser seul pour une alarme.

## Ce qu'il faut savoir avant de commencer

- **Un modèle de message approuvé par Meta est obligatoire.** Une alerte part à l'initiative du PSIM : Meta exige un modèle déclaré à l'avance (catégorie **Utilitaire**). Le PSIM y insère 3 variables : le titre (`ALARME - à confirmer - Fumée séjour`), le lieu (zone et étage) et les détails.
- **Un numéro expéditeur dédié.** Ni votre WhatsApp personnel, ni celui d'un employé : une ligne (une puce locale suffit) qui n'est **pas** déjà enregistrée sur l'application WhatsApp, capable de recevoir un SMS ou un appel de vérification. Pour vos premiers essais, Meta fournit un **numéro de test** gratuit.
- **Coût.** Depuis le 1er juillet 2025, Meta facture **chaque message** selon sa catégorie et le pays du destinataire (grille tarifaire publiée par Meta). Un modèle « Utilitaire » est **gratuit** s'il part dans les 24 h qui suivent un message du destinataire au numéro de l'entreprise ; sinon il est facturé. Il faut un **moyen de paiement** sur le compte WhatsApp Business pour envoyer en dehors du numéro de test.
- **Limites.** Tant que l'entreprise n'est pas **vérifiée** par Meta, le nombre de destinataires différents par 24 h est limité (de l'ordre de quelques centaines) : largement assez pour un site ; la vérification lève cette limite.
- **« Accepté par Meta » n'est pas « lu ».** Le PSIM sait que Meta a accepté le message ; la remise sur le téléphone n'est pas suivie (il faudrait recevoir les accusés de Meta sur une adresse publique). Conséquence : un numéro **sans WhatsApp** ou mal saisi apparaît « envoyé » dans le journal des envois (Meta ne signale l'échec qu'après coup, dans WhatsApp Manager). D'où le **message de test** à chaque nouveau destinataire, et un second canal (e-mail, Telegram) pour les alarmes importantes.
- **Pas d'image** pour l'instant par WhatsApp : les photos des caméras partent par e-mail ou Telegram.

## 1. Créer l'application Meta (une fois)

1. Avec un compte Facebook, ouvrez **business.facebook.com** et créez un **portefeuille d'entreprise** (Business portfolio) au nom de votre société.
2. Ouvrez **developers.facebook.com** → *Mes applications* → **Créer une application** → cas d'usage **« Se connecter avec les clients via WhatsApp »** (ou type *Entreprise*), rattachée à votre portefeuille.
3. Dans l'application : **WhatsApp → Configuration de l'API** (API Setup). Meta crée un compte WhatsApp Business, un **numéro de test** et affiche :
   - l'**identifiant du numéro** (*Phone number ID*, une suite de chiffres : ce n'est pas le numéro lui-même) → `PSIM_WHATSAPP_PHONE_ID` ;
   - un jeton **temporaire** (valable 24 h) : bon pour un premier essai, pas pour la production.
4. Toujours sur cette page, section *To* : ajoutez **votre numéro** comme destinataire autorisé (Meta vous envoie un code). Avec le numéro de test, seuls ces numéros autorisés (5 au plus) reçoivent les messages.

## 2. Créer le modèle de message

Dans **WhatsApp Manager** (business.facebook.com → *WhatsApp Manager* → *Modèles de message*) → **Créer un modèle** :

| Champ | Valeur |
|---|---|
| Catégorie | **Utilitaire** (*Utility*) |
| Nom | `psim_alerte` (minuscules et `_` ; sinon reporter le nom dans `PSIM_WHATSAPP_TEMPLATE`) |
| Langue | **Français** (`fr` ; sinon `PSIM_WHATSAPP_LANG`) |
| Type de variable | Numéro (`{{1}}`, `{{2}}`, `{{3}}`) |

**Corps du message** (à copier tel quel, retours à la ligne compris) :

```
Alerte de sécurité : {{1}}.
Lieu : {{2}}.
Détails : {{3}}
Ouvrez le PSIM pour traiter l'incident.
```

**Exemples demandés par Meta** pour chaque variable :
- `{{1}}` : `ALARME - à confirmer - Fumée séjour`
- `{{2}}` : `RDC - Séjour - Rez-de-chaussée`
- `{{3}}` : `Incident n°12, ouvert à 10:42 | État : NON ACQUITTÉE | Caméras : Voie 1`

Envoyez en validation. L'approbation prend en général de quelques minutes à quelques heures ; le statut doit passer à **Actif / Approuvé**. Le modèle doit garder **exactement 3 variables** : le PSIM en envoie 3.

## 3. Créer un jeton permanent

Le jeton de la page *API Setup* expire en 24 h. Pour le PSIM :

1. **business.facebook.com** → *Paramètres* → **Utilisateurs → Utilisateurs système** → *Ajouter* (rôle **Administrateur**), par exemple « PSIM ».
2. **Attribuer des éléments** à cet utilisateur : l'**application** (contrôle total) et le **compte WhatsApp** (contrôle total).
3. **Générer un jeton** : application = la vôtre, expiration **Jamais**, permissions **`whatsapp_business_messaging`** et **`whatsapp_business_management`**.
4. Copiez le jeton **une seule fois** dans le `.env.production` (étape 5). Ne l'envoyez à personne, ni par message ni par e-mail : il permet d'envoyer des messages au nom de votre entreprise.

## 4. Passer au vrai numéro (production)

1. *WhatsApp Manager* → **Numéros de téléphone** → *Ajouter un numéro* : nom d'affichage (soumis à Meta), vérification par SMS ou appel.
2. **Moyen de paiement** : *WhatsApp Manager* → *Paramètres de paiement*.
3. Remplacez `PSIM_WHATSAPP_PHONE_ID` par l'identifiant de ce nouveau numéro (étape 5 pour le fichier).
4. **Enregistrez le numéro sur la Cloud API** : étape obligatoire, qui ne se fait que par l'API (pas depuis WhatsApp Manager). Sans elle, chaque alerte échoue (« numéro non enregistré », code 133010). Choisissez un **code PIN de 6 chiffres** (il active la vérification en deux étapes du numéro : conservez-le), puis :
   ```bash
   npm run whatsapp-register:prod -- 123456
   ```
   Le PSIM lit le jeton et l'identifiant dans `.env.production` et répond « Numéro enregistré » ou la raison du refus. Le numéro de test de Meta n'en a pas besoin.
5. Facultatif mais conseillé : **vérification de l'entreprise** (*Paramètres → Centre de sécurité*), pour lever la limite de destinataires.

## 5. Régler le PSIM

Dans `.env.production` (Bloc-notes : `notepad .env.production`), ajoutez :

```
PSIM_WHATSAPP_TOKEN=le-jeton-permanent
PSIM_WHATSAPP_PHONE_ID=123456789012345
PSIM_NOTIFY_WHATSAPP_L1=+2250700000000,+2250500000000
PSIM_NOTIFY_WHATSAPP_L2=+2250100000000
```

- `L1` : prévenus à chaque alarme ; `L2` : prévenus si personne n'acquitte (escalade). Numéros au **format international**, sans espace : en Côte d'Ivoire, `+225` suivi des **10 chiffres** du numéro, 0 initial compris (`+2250700000000`).
- Les destinataires peuvent aussi être ajoutés dans l'interface (*Notifications*), une fois le canal configuré.
- Facultatif : `PSIM_WHATSAPP_TEMPLATE` (défaut `psim_alerte`), `PSIM_WHATSAPP_LANG` (défaut `fr`), `PSIM_WHATSAPP_API` (défaut `https://graph.facebook.com/v25.0`, toujours en `https://` : en production, une adresse `http://` est refusée), `PSIM_WHATSAPP_WABA_ID` (identifiant du compte WhatsApp Business, affiché dans *API Setup* : sert seulement à vérifier le modèle à la mise en service si le jeton ne permet pas de le retrouver).
- Des numéros déclarés **sans** jeton ou identifiant de numéro : le PSIM refuse de démarrer en production (ils ne recevraient rien) ; dans l'interface, ils portent la mention « canal non configuré ».

Puis relancez le PSIM (`Stop-ScheduledTask -TaskName PSIM`, puis `Start-ScheduledTask -TaskName PSIM`). Une entrée mal écrite **bloque le démarrage** : le journal `data-prod\logs\psim.log` indique laquelle (sa position, jamais le jeton).

## 6. Vérifier

```bash
npm run commission:prod -- --whatsapp-to +2250700000000
```

- Sans `--whatsapp-to`, le contrôle vérifie auprès de Meta, sans rien envoyer : le jeton, le numéro expéditeur et son **enregistrement** sur la Cloud API, et le **modèle** (approuvé, en `fr`, avec 3 variables). Un modèle en attente, refusé ou mal nommé est signalé comme un **échec** : aucune alerte ne partirait.
- Avec, il envoie en plus un message de test par le modèle. **Vérifiez qu'il arrive sur le téléphone.**
- Dans l'interface : *Notifications* → **Envoyer un message de test** (tous les destinataires, tous canaux).

## En cas d'erreur

| Message du PSIM | Cause probable |
|---|---|
| `jeton refuse ou expire` (code 190) | Jeton temporaire expiré, ou jeton mal copié : refaire l'étape 3 |
| `modele introuvable, pas encore approuve...` (132001) | Modèle pas encore approuvé, autre nom, ou autre langue que `fr` |
| `nombre de variables different...` (132000) | Le modèle n'a pas exactement 3 variables |
| `destinataire non autorise...` (131030) | Numéro de test de Meta : ajouter le destinataire à la liste autorisée (étape 1.4) |
| `numero expediteur non enregistre` (133010) | Étape 4.4 oubliée : `npm run whatsapp-register:prod -- <PIN>` |
| `modele mis en pause par Meta` | Qualité du modèle jugée insuffisante par Meta : voir WhatsApp Manager |
| `probleme de paiement` (131042) | Moyen de paiement absent ou refusé |
| `trop de messages` (130429, 131056) | Limite de débit de Meta : les alertes suivantes repartiront |
| `WhatsApp (Meta) injoignable` | Le serveur du PSIM n'accède pas à `graph.facebook.com` (réseau, pare-feu, proxy) |
