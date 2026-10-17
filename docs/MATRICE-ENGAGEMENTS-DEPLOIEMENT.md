# Matrice des engagements et des preuves de déploiement

**État vérifié dans le dépôt le 17 octobre 2026.** Cette matrice suit les engagements de la première offre de bâtiment et des pilotes KOUROUMA. « Codé » signifie que le logiciel existe ; « essayé sur matériel » exige une fiche de qualification et une recette du site. Les dates et les responsables de reprise figurent dans [le planning](PLAN-MISE-EN-OEUVRE-DEPLOIEMENT.md).

**Vérification logicielle du jour :** `npm run typecheck` passe sur `main`. La suite complète sur l'arbre de travail final, qui inclut les modifications locales du téléphone, donne **4 720 tests réussis sur 4 720**, sans échec ni test ignoré. `pack check` valide la structure du pack standard et relève 9 équipements à qualifier ; il ne valide pas le matériel.

| Engagement présenté au client | État constaté | Preuve qui manque avant de le promettre sans réserve | Livraison |
|---|---|---|---|
| Alarme sur le plan, caméra liée, image, acquittement, qualification et journal | Codé et essayé avec des équipements simulés ; une voie Dahua précise est qualifiée | Essai complet avec chaque détecteur et caméra du site, fiche signée et mesures de délai | R1 |
| Quatre caméras Dahua HAC-HFW1500TH-I8 sur XVR5104HS-I3 | Pack JSON créé ; références **à qualifier** | Quatre voies en direct et en relecture sur le XVR exact, panne et retour, modèle/firmware/numéros consignés | R1 |
| Deux détecteurs Heiman HS1SA-E, reliés localement sans Internet | Pack JSON créé ; détecteurs et liaison Zigbee **à qualifier** | Deux alarmes réelles, retour au repos, pile faible/silence, coupure Internet, passerelle et supervision | R1 |
| Variante fumée WiFi Tuya | Une référence et la lecture cloud ont été essayées ; dépendance à Internet | Recette de déclenchement et de délai sur le site ; offre indiquant clairement la dépendance au cloud | Variante R1 |
| Notifications, escalade et appel téléphonique | E-mail et Telegram déjà essayés lors d'une ancienne mise en service ; canal Android codé et test local 4/4 hors bac à sable ; WhatsApp dépend de la configuration Meta | Réception par chaque destinataire, escalade, essai d'appel sur le vrai téléphone et comportement en panne ; ne mentionner WhatsApp que s'il est configuré et reçu | R1 selon canaux retenus |
| Portail client multi-sites | Codé ; ancienne installation décrite, service permanent non confirmé | Démarrage automatique, résumé signé reçu, droits par client, alerte de non-remontée et reprise après redémarrage | R1 |
| Sauvegarde, restauration et continuité du poste | Outils et guide disponibles | Restauration sur une autre machine, test de coupure, supervision extérieure, procédures remises | R1 |
| Indice GAMR par zone | Codé ; texte du pack corrigé sur la hausse en cas de panne | Évaluations réelles des zones et explication des calculs revue avec le responsable | R1 |
| Agents : QR/NFC, rondes, SOS, main courante, alarmes application ouverte | Codé ; simulation et intégration logicielle effectuées | Essai sur le téléphone du site et 7 nuits de rondes, mesures de délai, autonomie et trous réseau | R2 |
| Alarmes application fermée, SOS de fond et repli SMS | Lot Android AG6 non commencé | Application Android et essais de fond réels ; ne pas l'inclure dans R2 | R4 |
| Accès Dahua : portes, journal, commandes | Intégré dans `main` ; essais avec faux contrôleurs | Contrôleur réel, mesure des latences, passage récupéré après coupure, retour sûr et issue de secours | R3 |
| Titulaires, badges, synchronisation, règles d'accès et armement des portes | Intégrés dans `main` ; 4 720 tests sur l'arbre final ; essais avec faux contrôleurs | Revue visuelle des écrans, synchronisation et badge perdu sur le contrôleur Dahua réel, droits horaires et préalarme des portes essayés sur site | R3 |

## Règle de publication

Une fiche de vente ou une démonstration peut dire **« disponible sur ce modèle »** seulement si la version logicielle, le modèle exact et son firmware, la configuration du site et la recette signée sont identifiés. Avant cela, employer **« en cours de qualification »**. Une simulation ne qualifie pas un modèle matériel. Les fonctions R4 et les autres familles du catalogue sont présentées comme des développements futurs avec leur propre périmètre.

## Écarts commerciaux déjà corrigés

Dans `docs/Pack-standard-4-cameras-2-detecteurs.docx`, la note GAMR indique désormais qu'elle **augmente** quand un détecteur tombe en panne. La phrase sur la surveillance locale sans Internet indique désormais que la liaison Heiman doit être essayée. Le document reste une **proposition pour décision** ; le pack exact ne doit pas être vendu comme recette achevée.

## Références de contrôle

- `PRODUCT.md` ; `docs/Pack-standard-4-cameras-2-detecteurs.docx` ; `packs/pack-standard-4cam-2fumee/pack.json`.
- `qualification/registry.json` ; `docs/QUALIFICATION.md` ; `docs/MISE-EN-SERVICE.md`.
- `docs/HANDOFF-agents-2026-10-17.md` ; `docs/HANDOFF-controle-acces.md` ; `docs/HANDOFF-prod-2026-10-11.md`.
