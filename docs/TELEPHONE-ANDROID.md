# Appels par un téléphone Android du site

Au lieu d'un service payé (Vonage demande un crédit initial élevé), le PSIM peut faire sonner un téléphone **par l'intermédiaire d'un téléphone Android posé sur le site**, avec une carte SIM : le PSIM lui envoie une requête sur le réseau local, et le téléphone compose le numéro par le réseau mobile.

C'est le **même canal « Appel téléphonique »** que Vonage (mêmes numéros, niveaux, zones, mêmes alarmes), sans fournisseur, et il marche **même si la connexion Internet du site est coupée**.

## Ce qu'il faut savoir

- **Aucune voix de synthèse** : le téléphone appelé sonne, la personne décroche et entend… rien, ou la voix de la personne qui est à l'autre bout (le téléphone-passerelle). Le titre et le lieu partent par les canaux écrits ; l'appel sert à réveiller. Pour une voix lisant l'alarme, il faut un service comme Vonage ou Twilio.
- **L'appel complète les messages, il ne les remplace pas** : « accepté par le téléphone » ne veut pas dire « décroché ». Gardez toujours un canal écrit pour les mêmes personnes.
- Seulement pour les alarmes (ouverture, aggravation, escalade, rappels) et le message de test. Jamais pour un redémarrage, un détecteur muet ou une alerte de compte.
- **Le PC du PSIM et le téléphone doivent être sur le même réseau** (Wi-Fi). Donnez au téléphone une **adresse fixe** (réservation DHCP dans le routeur), sinon l'adresse change et les appels cessent.
- **Ce montage n'a pas encore été validé avec un vrai téléphone** : seul le côté PSIM est testé (faux téléphone local). Faites l'essai ci-dessous avant de compter dessus. Pour une installation, utilisez un téléphone **dédié**, branché en permanence.
- Fonctionne sous Android. Sur iPhone, ce n'est pas possible (iOS interdit de lancer un appel automatiquement).

## 1. Côté téléphone (Redmi Note 14 Pro, HyperOS)

1. Installez **MacroDroid** (Play Store). Accordez-lui les autorisations qu'il demande (Téléphone/appels, notifications, affichage par-dessus les autres applications).
2. Créez une macro :
   - **Déclencheur** : *Serveur HTTP* (Web Hooks) : port `8080`, identifiant `psim-appel`.
   - **Action** : *Appeler un numéro*, avec le numéro pris dans la requête (paramètre `number`).
   - Conseillé : une **contrainte** qui vérifie que le paramètre `token` est égal au secret que vous mettrez dans le `.env`, pour que personne d'autre sur le réseau ne puisse faire sonner le téléphone.
   - Les noms exacts des champs changent selon la version de MacroDroid : si le numéro de la requête n'est pas utilisable, essayez d'abord avec **un numéro fixe** dans l'action pour valider la chaîne, puis revenez au numéro variable.
3. **Réglages Xiaomi indispensables** (sinon HyperOS endort MacroDroid et l'appel ne part jamais) :
   - Paramètres → Applications → MacroDroid → **Démarrage automatique : activé**.
   - Paramètres → Batterie → MacroDroid → **Économiseur de batterie : Aucune restriction**.
   - Paramètres → Applications → Autorisations → **Afficher les fenêtres pop-up lors de l'exécution en arrière-plan : autorisé** (nécessaire pour lancer un appel depuis l'arrière-plan).
   - Vue des applications récentes : **verrouillez** MacroDroid (appui long sur la carte → cadenas).
   - Notez l'adresse IP du téléphone (Wi-Fi → détails du réseau).
4. Vérifiez depuis un autre appareil du réseau, navigateur ouvert sur `http://ADRESSE-DU-TELEPHONE:8080/psim-appel?number=%2B225XXXXXXXXXX&token=VOTRE-SECRET` : le téléphone doit appeler ce numéro.

## 2. Côté PSIM

Dans le `.env` (ou `.env.production`), **sans** réglage `PSIM_VONAGE_*` (les deux ensemble bloquent le démarrage) :

```
PSIM_PHONE_GATEWAY_URL=http://192.168.1.50:8080/psim-appel
PSIM_PHONE_GATEWAY_TOKEN=un-secret-partage-long
PSIM_NOTIFY_VONAGE_L1=+2250700000000
```

Les numéros à appeler s'ajoutent aussi dans l'interface (Administration → Personnes prévenues → canal *Appel téléphonique*), au format international sans espace. Redémarrez le PSIM, puis **Personnes prévenues → Envoyer un message de test** : chaque numéro est appelé une fois.

La requête envoyée par le PSIM est un GET : `…/psim-appel?number=%2B225…&kind=opened&text=…&token=…`.

## Si ça ne marche pas

| Message dans « Derniers envois » | Cause probable |
|---|---|
| `Téléphone-passerelle injoignable` | Téléphone éteint ou hors Wi-Fi, mauvaise adresse, MacroDroid fermé par HyperOS (voir les réglages Xiaomi), ou le PC et le téléphone ne sont pas sur le même réseau. |
| `HTTP 401` / `403` | Le secret du `.env` n'est pas celui de la règle MacroDroid. |
| Le PSIM dit « envoyé » mais rien ne sonne | La macro reçoit la requête mais l'appel est bloqué : autorisation Téléphone, ou pop-up en arrière-plan non autorisé. |
| Le téléphone appelle mais pas le bon numéro | Le paramètre `number` n'est pas relié à l'action d'appel. |

## Sécurité

- Le secret circule en clair sur le réseau local : utilisez un réseau de confiance (pas un Wi-Fi invité) et un secret propre à ce montage.
- N'exposez jamais le port du téléphone à Internet.
