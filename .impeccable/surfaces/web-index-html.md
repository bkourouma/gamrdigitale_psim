---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["portal/web/index.html"]
---

# Surface : interfaces du PSIM (`web/`) et du portail client (`portal/web/`)

Mode : **Operate** (le visiteur accomplit une tâche). Refonte complète du monde visuel, décidée le 5 octobre 2026.

- Public : agents au poste de garde (jour et nuit), responsable sécurité, technicien installateur, consultation sur téléphone ; pour le portail, la direction du client et le responsable de site. Aucun n'est informaticien.
- Tâches : voir et traiter une alarme ; trouver chaque activité dans un menu par activité ; lire l'indice de sécurité GAMR ; pour le portail, suivre plusieurs sites et leur indice.
- Contraintes : aucun framework, CSP stricte (polices et icônes locales, pas d'attribut `style` dans le HTML), comportements de sécurité inchangés (une alarme ramène sur Surveillance et sur l'étage concerné).
- Moment mémorable : le cadre marine qui passe au rouge et la fiche d'alarme en trois étapes ; le thermomètre GAMR toujours au même endroit.
- À décider plus tard : export du logo pour l'impression (couleurs CMJN), photo ou illustration de marque (aucune fournie).

## Direction contract

THESIS: Le PSIM et le portail parlent la langue de l'affiche GAMR-DIGITALE : une feuille claire posée dans un cadre bleu marine, et l'indice de sécurité dressé en thermomètre. Refuse l'écran de salle de contrôle sombre à panneaux (l'écran actuel) et le tableau de bord à tuiles de chiffres.

OWN-WORLD: Cadre marine #244C87 (rail du menu) qui passe au rouge d'alarme tant qu'une alarme attend d'être acquittée ; feuille #F1FBFF, panneaux bleu ciel #E2F3FD, tube #99D6F3 ; bandes de niveau vert #5DA444, jaune #FADF38, orange, rouge #E35235 ; sarcelle #2CA792 et ambre #FCC006 de la jauge. Baloo 2 très grasse (mot GAMR-DIGITALE, titres d'écran, chiffres de l'indice), Atkinson Hyperlegible Next pour tout le reste. Icônes au trait 1,8. Chaque état : forme, icône et mot (plein en service, pointillé désarmé, barré hors service, double anneau à acquitter). Mode Nuit : même cadre, feuille marine profonde.

STORY: L'agent voit d'un coup d'œil « Tout est calme » ou l'alarme : où, depuis quand, et quoi faire (1 regarder les caméras, 2 acquitter, 3 clôturer en qualifiant). Le responsable lit l'indice sur le thermomètre et trouve chaque activité dans le menu. Le client retrouve la même jauge, site par site, dans le portail.

FIRST VIEWPORT: Rail marine de 248 px à gauche : logo GAMR-DIGITALE PSIM, nom du site, menu par activité (Surveillance, Alarmes, Caméras, Armement, Risques, Rapports, Journal, puis Administration), thermomètre de l'indice en bas du rail. Barre du haut : titre de l'écran, connexion temps réel, compteurs. Écran Surveillance : plan de l'étage à gauche (environ 60 %), à droite la fiche d'alarme en étapes numérotées ou le bloc « Tout est calme », puis le mur de caméras 2 × 2. Action primaire : « Acquitter », dans la fiche. Signature en mouvement : à l'ouverture d'une alarme, le cadre passe au rouge (pulsation lente jusqu'à l'acquittement, fixe ensuite), la fiche prend la scène et sa barre d'attente s'allonge ; le mercure du thermomètre glisse vers sa valeur quand l'indice change. États en 150 à 250 ms, aucune animation d'entrée de page ; mouvement réduit : cadre rouge fixe.

FORM: Direction 7 de ma liste ordonnée (l'affiche GAMR, son thermomètre et sa jauge : lecture littérale de la marque), désignée par le tirage, clé a79b9276. Rehaussée par les cinq candidats écartés : l'état par la forme, les gestes graves isolés, l'alarme qui prend la scène, la durée qui se voit, la même échelle de 0 à 60 partout. Signature : le thermomètre GAMR dans le rail (indice du site, quatre bandes aux seuils 8, 20, 36, 60), repris en tubes par zone et en jauge par site dans le portail.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
