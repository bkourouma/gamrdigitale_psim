# Appels téléphoniques (Vonage)

Le PSIM peut **faire sonner un téléphone** quand une alarme s'ouvre : une voix de synthèse lit l'alarme (titre, lieu), **deux fois de suite**, puis raccroche. C'est le moyen de réveiller une personne d'astreinte qui ne regarde pas ses messages. Le service utilisé est l'**API Voice de Vonage**.

## Ce qu'il faut savoir avant de commencer

- **L'appel complète les messages, il ne les remplace pas.** « Accepté par Vonage » veut dire que l'appel est **lancé** ; si la personne ne décroche pas (téléphone éteint, hors réseau, messagerie vocale), le PSIM ne le sait pas. Gardez toujours au moins un canal écrit (WhatsApp, e-mail, Telegram) pour les mêmes personnes.
- **Pas d'acquittement par touche.** La voix dit quoi faire : ouvrir le PSIM. L'acquittement se fait dans le PSIM, comme pour les autres canaux.
- **Seulement pour les alarmes.** L'appel part à l'ouverture et à l'aggravation d'un incident, à l'escalade (non acquitté) et aux rappels, et pour le **message de test**. Jamais pour une confirmation, un redémarrage, un détecteur muet, une alerte de sécurité de compte ou un journal altéré : ces messages passent par les autres canaux. (La liste est `VONAGE_KINDS` dans `server/notifications.ts`.)
- **Coût.** Vonage facture chaque appel à la minute selon le pays appelé, plus la location d'un numéro. Un appel dure une dizaine de secondes. Les rappels (jusqu'à `PSIM_MAX_REMINDERS`) rappellent : prévoyez du crédit.
- **Compte d'essai.** Tant que le compte Vonage n'est pas crédité, seuls les numéros **ajoutés et vérifiés** dans le tableau de bord peuvent être appelés.
- **Le numéro qui appelle** (`PSIM_VONAGE_FROM`) doit être un numéro Vonage lié à l'application. La disponibilité des numéros, et la façon dont le numéro appelant s'affiche chez le destinataire, dépendent du pays : vérifiez la liste des pays et les règles de Vonage avant de vous engager.

## 1. Créer l'application Vonage (une fois)

1. Créez un compte sur **dashboard.nexmo.com** (Vonage API Dashboard) et créditez-le.
2. **Applications → Create a new application**. Donnez-lui un nom (« PSIM »).
3. Cliquez **Generate public and private key** : un fichier de clé privée (`private.key`) est téléchargé. **Il ne se télécharge qu'une fois** : conservez-le.
4. **Capabilities** : activez **Voice**. Le formulaire demande une *Answer URL* et une *Event URL* : le PSIM n'en utilise pas (il envoie le message avec l'appel), mais ces champs sont obligatoires ; mettez par exemple `https://example.com/answer` et `https://example.com/event`.
5. Enregistrez. Notez l'**Application ID** → `PSIM_VONAGE_APPLICATION_ID`.
6. **Numbers → Buy numbers** : prenez un numéro avec la capacité **Voice**, puis **liez-le à l'application** (Manage numbers → *Link* à « PSIM »). Ce numéro (chiffres seulement, avec l'indicatif, sans `+`) → `PSIM_VONAGE_FROM`.

## 2. Configurer le PSIM

Placez le fichier de clé hors de git (le dossier `secrets/` et les fichiers `*.key` sont ignorés), par exemple `secrets/vonage.key`, puis dans le `.env` (ou `.env.production`) :

```
PSIM_VONAGE_APPLICATION_ID=l-identifiant-de-l-application
PSIM_VONAGE_PRIVATE_KEY_FILE=secrets/vonage.key
PSIM_VONAGE_FROM=14155550100
PSIM_NOTIFY_VONAGE_L1=+2250700000000
```

- Les trois premiers réglages **vont ensemble** : il en manque un, ou la clé est illisible ? Le PSIM refuse de démarrer et le dit (sans jamais afficher la clé).
- Le chemin de la clé est relatif au dossier du PSIM, ou absolu.
- Voix : `PSIM_VONAGE_LANG` (défaut `fr-FR`).
- Les destinataires s'écrivent au format international, sans espace. Ils peuvent aussi être ajoutés **dans l'interface** (Administration → Personnes prévenues → canal *Appel téléphonique*), avec un niveau et des zones comme les autres canaux.
- Redémarrez le PSIM.

## 3. Vérifier

```
npm run commission -- --vonage-to +2250700000000
```

(`commission:prod` pour la production.)

- **Sans `--vonage-to`**, le contrôle vérifie auprès de Vonage que l'identifiant et la clé sont acceptés (lecture de la liste des appels : gratuite), et ne passe **aucun appel**.
- **Avec `--vonage-to`**, il passe **un seul appel de test** à ce numéro : le téléphone doit sonner, et une voix dire « Ceci est un appel de test du PSIM ». Un numéro non vérifié sur un compte d'essai est refusé : ce n'est pas un défaut du PSIM.
- L'écran **Personnes prévenues → Envoyer un message de test** appelle aussi chaque destinataire d'appel (un appel par numéro).

## Si ça ne marche pas

| Message dans « Derniers envois » | Cause probable |
|---|---|
| `identifiants refusés` (401) | Mauvais `PSIM_VONAGE_APPLICATION_ID`, ou fichier de clé qui n'est pas celui de **cette** application (régénérer une clé la remplace). |
| `crédit Vonage insuffisant` (402) | Compte à créditer. |
| `appel interdit` (403) | Capacité Voice non activée sur l'application, ou compte d'essai : numéro appelé non vérifié. |
| `appel refusé` (422) | Numéro appelé invalide, ou `PSIM_VONAGE_FROM` qui n'est pas un numéro Vonage de ce compte lié à l'application. |
| `trop d'appels` (429) | Limite de débit de Vonage atteinte. |
| `Vonage injoignable` | Le PC du PSIM doit joindre `api.nexmo.com` en HTTPS (pare-feu, proxy). |

## Sécurité

- La clé privée ne quitte jamais le PC du PSIM : elle sert à signer un jeton valable 5 minutes, créé à chaque appel. Elle n'est ni en base, ni dans l'interface, ni dans les journaux.
- Quiconque a ce fichier peut passer des appels facturés à votre compte : limitez son accès au compte qui exécute le PSIM, et révoquez l'application (ou régénérez la clé) dans le tableau de bord s'il fuit.
- `PSIM_VONAGE_API` doit rester en `https://` en production (le démarrage le vérifie).
