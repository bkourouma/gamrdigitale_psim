---
name: GAMR-DIGITALE PSIM et portail client
description: Une feuille claire posée dans un cadre bleu marine, et l'indice de sécurité dressé en thermomètre.
colors:
  frame: "#244c87"
  frame-2: "#1c3f73"
  frame-3: "#2f5d9e"
  frame-ink: "#ffffff"
  frame-ink-2: "#bcd3ee"
  frame-warning: "#8a5300"
  frame-alarm: "#b42e1c"
  frame-alarm-hi: "#d13a26"
  focus-on-frame: "#fadf38"
  ground: "#eaf4fb"
  surface: "#ffffff"
  surface-2: "#f4f9fd"
  sky: "#e2f3fd"
  tube: "#99d6f3"
  line: "#d3e2ee"
  line-strong: "#a9c2d8"
  ink: "#10264a"
  ink-2: "#43597b"
  ink-3: "#5b7193"
  brand: "#2b5fae"
  brand-2: "#234f93"
  brand-soft: "#dceafa"
  brand-ink: "#1d4a81"
  wordmark: "#3b6cb7"
  on-brand: "#ffffff"
  link: "#2b5fae"
  link-night: "#9cc1f4"
  ok: "#3a9a4c"
  ok-ink: "#1f7a35"
  ok-soft: "#e3f4e6"
  warning: "#f5b800"
  warning-ink: "#8a5a00"
  warning-soft: "#fff4d1"
  on-warning: "#2a1c00"
  alarm: "#d63a26"
  alarm-ink: "#b42e1c"
  alarm-soft: "#fde6e2"
  fault: "#7a52c7"
  fault-ink: "#6b3fc0"
  fault-soft: "#efe8fb"
  offline: "#7b889c"
  offline-ink: "#586579"
  offline-soft: "#eceff4"
  lvl-faible: "#5da444"
  lvl-modere: "#f7d23a"
  lvl-eleve: "#f08a2c"
  lvl-critique: "#e04a32"
  lvl-none: "#c3d3e3"
  ring-teal: "#2ca792"
  ring-amber: "#fcc006"
  scrim: "rgba(4, 10, 20, 0.88)"
  plate: "#ffffff"
  plate-night: "#dbe5f1"
  night-frame: "#133264"
  night-ground: "#081428"
  night-surface: "#0e1f3a"
  night-ink: "#eaf2fc"
typography:
  display:
    fontFamily: "'Baloo 2', 'Atkinson Hyperlegible Next', 'Segoe UI', sans-serif"
    fontSize: "3.5rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "'Baloo 2', 'Atkinson Hyperlegible Next', 'Segoe UI', sans-serif"
    fontSize: "1.75rem"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'Atkinson Hyperlegible Next', 'Segoe UI', system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "'Atkinson Hyperlegible Next', 'Segoe UI', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Atkinson Hyperlegible Next', 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.2
  code:
    fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace"
    fontSize: "0.92em"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  stage: "12px"
  lg: "16px"
  sheet: "18px"
  xl: "22px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.brand-2}"
    textColor: "{colors.on-brand}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.alarm-ink}"
    rounded: "{rounded.md}"
    height: "44px"
  button-danger-hover:
    backgroundColor: "{colors.frame-alarm}"
    textColor: "#ffffff"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.md}"
  button-sm:
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "16px 24px 24px"
  glass:
    backgroundColor: "{colors.sky}"
    rounded: "{rounded.md}"
  pill-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok-ink}"
    rounded: "{rounded.pill}"
    height: "28px"
  pill-alarm:
    backgroundColor: "{colors.alarm-soft}"
    textColor: "{colors.alarm-ink}"
    rounded: "{rounded.pill}"
    height: "28px"
  pill-solid-alarm:
    backgroundColor: "{colors.frame-alarm}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
  pill-solid-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-warning}"
    rounded: "{rounded.pill}"
  counter:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "36px"
  rail:
    backgroundColor: "{colors.frame}"
    textColor: "{colors.frame-ink}"
    width: "248px"
  tube:
    backgroundColor: "{colors.sky}"
    rounded: "{rounded.pill}"
    height: "14px"
  arm-day-track:
    backgroundColor: "{colors.sky}"
    rounded: "{rounded.pill}"
    height: "16px"
  table-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  lightbox:
    backgroundColor: "{colors.scrim}"
    textColor: "#ffffff"
---

# Système de design : GAMR-DIGITALE PSIM et portail client

Sources (build livré) : `web/base.css` (jetons, thèmes, composants partagés, copié dans `portal/web/base.css`), `web/shell.css` (cadre, rail, feuille, connexion), `web/surveillance.css` (plan, légende, vue éclatée, mur vidéo), `web/alarms.css` (fiche d'alarme, alarmes, journal), `web/risk.css` (Risques), `web/prevention.css` (Armement, Rapports), `web/admin.css` (Administration), `web/equipment.css` (Équipements, Simulateur), `web/gauge.js`, `web/icons.svg`, `web/logo.svg`, `portal/web/portal.css`. Les règles ci-dessous décrivent ce que ces fichiers font aujourd'hui.

## Overview

**Creative North Star : « La jauge GAMR »**

L'interface parle la langue de l'affiche de la marque : une feuille claire posée dans un cadre bleu marine, et l'indice de sécurité dressé en thermomètre. Le cadre n'est pas un décor : c'est l'état du site. Il est marine au calme, ambre-brun en préalarme, rouge tant qu'une alarme est ouverte, et il pulse lentement tant qu'une alarme attend d'être acquittée. La feuille, elle, reste calme et lisible pour des agents qui ne sont pas informaticiens, de jour comme de nuit.

La densité est celle d'un outil de travail : panneaux blancs à bord fin, verre bleu ciel pour le plan et les jauges, commandes de 44 px qu'on touche au doigt. La même échelle de 0 à 60 (seuils 8, 20, 36, 60) se lit partout : thermomètre dans le rail, tubes par zone dans Risques, anneau de l'indice du site et par site dans le portail. Le verre à graduations revient ailleurs sous la même forme : la frise d'armement (un tube par jour) et la barre d'attente d'une alarme (un tube de 8 px).

Refus confirmés : l'écran de salle de contrôle sombre à panneaux (l'ancien écran) et le tableau de bord à tuiles de gros chiffres.

**Key Characteristics :**
- Cadre marine qui porte l'état du site ; feuille claire qui porte le travail.
- Thermomètre GAMR toujours au même endroit, une seule échelle 0 à 60.
- Chaque état dit par une forme, une icône et un mot, jamais par la couleur seule ; la forme dit le type, la couleur dit l'état.
- Baloo 2 très grasse pour la marque, les titres et les chiffres de l'indice ; Atkinson Hyperlegible Next pour tout le reste.
- Deux thèmes, Jour et Nuit, par jetons seulement.
- Un tableau n'est jamais un défilement de côté sur téléphone : chaque ligne devient une carte.

## Colors

Un bleu marine d'affiche, une feuille bleu ciel très claire, et une palette d'états où chaque couleur a sa version texte à 4,5:1 au moins.

### Primary
- **Marine du cadre** (`--frame` #244c87) : rail du menu et pourtour de la feuille. Nuances `--frame-2` (survol, actif) et `--frame-3` (filets). Texte `--frame-ink` blanc, secondaire `--frame-ink-2`.
- **Bleu d'action** (`--brand` #2b5fae, survol `--brand-2`) : action principale, sélection. `--brand-soft` en fond sélectionné, `--brand-ink` pour les titres, chiffres de marque et boutons discrets, `--wordmark` pour le mot GAMR-DIGITALE.
- **Bleu de lien** (`--link`, #2b5fae de jour comme `--brand`, `--info-ink` #9cc1f4 de nuit) : liens, résumés dépliables au survol, intitulés cliquables (aide repliée, identifiant d'inventaire). De nuit, `--brand` ne ferait que 3,7:1 sur la feuille : le lien prend l'encre bleue claire (4,5:1 au moins). Le portail le redéclare à l'identique.

### Secondary
- **Rouge du cadre** (`--frame-alarm` #b42e1c, pulsation `--frame-alarm-hi`) et **ambre-brun** (`--frame-warning` #8a5300, pulsation `--frame-warning-hi` dans shell.css) : le cadre en alarme et en préalarme. Les nuances dérivées passent par `color-mix()` dans shell.css. Le rouge du cadre est aussi le plein des pastilles solides, du bouton de confirmation grave et des puces d'alarme (blanc à 6:1 dans les deux thèmes).
- **Jaune de l'affiche** (`--focus-on-frame` #fadf38) : anneau de focus sur le cadre et sur tout voile sombre (rail, mur vidéo, loupe d'image), sélection de texte, fond de l'étiquette PSIM, trait « maintenant » de la frise d'armement.
- **Encre d'avertissement** (`--on-warning` #2a1c00, 11:1) : texte et icône posés sur un fond ambre plein (`--warning`) : pastille solide de préalarme, pastille du plan, compteur ambre, étiquette d'étage.

### Tertiary : états et niveaux
- États (remplissage / texte / fond doux) : `--ok`, `--warning`, `--alarm`, `--fault`, `--offline`, `--camera`, `--info`, chacun en trois jetons `X`, `X-ink`, `X-soft`. Le violet plein sous texte blanc (`--fault-solid`, #6b3fc0) est déclaré dans surveillance.css pour l'étiquette d'étage « hors service », gardé identique la nuit.
- Niveaux de l'indice : `--lvl-faible` #5da444, `--lvl-modere` #f7d23a, `--lvl-eleve` #f08a2c, `--lvl-critique` #e04a32, `--lvl-none` (sans indice), chacun avec son `-ink`. Accents de la jauge : `--ring-teal` #2ca792, `--ring-amber` #fcc006.

### Neutral
- Feuille `--ground` #eaf4fb, panneaux `--surface` blanc, `--surface-2` pour les en-têtes de tableau et les fonds de carte interne, verre `--sky` et `--tube`, filets `--line` / `--line-strong`.
- Texte `--ink` bleu nuit #10264a, `--ink-2` (7:1), `--ink-3` (4,9:1, discret ; aussi le trait des champs, 3:1 exigé).
- Voile `--scrim` (rgba(4, 10, 20, 0.88)) : derrière la loupe d'image seulement.
- Papier du plan `--plate` (blanc de jour, #dbe5f1 de nuit, avec le filtre `--plan-filter` : luminosité 0,84) : le plan reste une feuille claire en Nuit, atténuée pour ne pas éblouir.

### Thème Nuit
`<html data-theme="night">`, ou le système en sombre sans attribut `data-theme="day"`. Le cadre reste marine (#133264) ; la feuille devient bleu nuit profond (`--ground` #081428, `--surface` #0e1f3a) ; textes, états et niveaux basculent sur des `-ink` clairs. Les couleurs de remplissage des niveaux ne changent pas. Le survol du bouton principal fonce le bleu (`color-mix` avec du noir) au lieu de l'éclaircir, pour garder le blanc à 4,5:1. Dans l'icône d'équipement, le glyphe devient foncé (`--ground`) sur les aplats d'état éclaircis.

### Named Rules
**La règle du cadre.** Seul le cadre change de couleur avec l'état du site : marine au calme, `--frame-warning` en préalarme, `--frame-alarm` en alarme ; pulsation lente (2,4 s) tant qu'une alarme n'est pas acquittée, rouge fixe ensuite et en mouvement réduit.

**La règle du texte d'état.** Tout texte coloré utilise le jeton `-ink` ; la couleur de remplissage est réservée au graphique. Jamais de texte gris clair sur un fond coloré. Sur un plein d'état, le texte est blanc (rouge, violet, bleu) ou `--on-warning` (ambre).

**La règle des jetons.** Aucun écran n'invente de couleur, de rayon ni d'ombre. Un jeton vraiment manquant se déclare dans le fichier de l'écran, commenté, dérivé des jetons existants (`--arm-glass`, `--arm-on`, `--pin-neutral`, `--plate`).

## Typography

**Marque :** Baloo 2, 800 (`--font-brand`), polices locales WOFF2 variables.
**Interface :** Atkinson Hyperlegible Next (`--font-ui`), repli Segoe UI, system-ui.
**Codes :** police à chasse fixe du système (`code`, `kbd`, `.mono` : ui-monospace, Cascadia Mono, Consolas), seulement pour ce qui se recopie ou se saisit caractère par caractère (codes de secours, clé de double authentification, code à six chiffres, adresses techniques).

Échelle : 13 / 14 / 16 / 18 / 22 / 28 / 36 / 56 px (`--fs-xs` à `--fs-num`).

### Hierarchy
- **Display** (Baloo 800, 56 px, `--fs-num`) : le chiffre de l'indice. Dans le rail, 34 px blanc ; indices secondaires et niveau du site (Risques) en `--fs-3xl` (36 px) ; chiffre d'une zone en `--fs-xl` (22 px).
- **Headline** (Baloo 800, 28 px, interligne 1,1, `--brand-ink`) : titre d'écran `h1` ; titres de fenêtre en 22 px.
- **Title** (Atkinson 700, 18 px) : `h2`, titres de panneau ; `h3` à 16 px.
- **Body** (Atkinson 400, 16 px, interligne 1,5) : texte courant.
- **Label** (Atkinson 700, 14 px) : libellés de champ, pastilles d'état ; 13 px réservé aux métadonnées et en-têtes de tableau.

### Named Rules
**La règle Baloo.** Baloo 2 seulement pour le mot GAMR-DIGITALE, l'étiquette PSIM, les titres d'écran et de fenêtre, les chiffres et le niveau de l'indice, et les numéros d'étape (fiche d'alarme, Mon compte). Jamais sur un bouton, une étiquette ou une donnée de tableau (dans un tableau, le chiffre de l'indice passe en Atkinson).

**La règle des chiffres.** Chiffres en `tabular-nums` (`.num`, `<time>`).

**La règle de la langue.** Français courant : boutons au verbe d'action (« Acquitter »), pas de jargon dans les libellés principaux, erreurs qui disent le problème et quoi faire, guillemets « » et espace insécable avant « : ; ! ? ».

## Layout

- **Coquille PSIM :** grille à deux colonnes, rail de 248 px (`--rail-w`) puis la feuille, sur toute la hauteur (`100dvh`). La feuille est posée dans le cadre avec un écart visible de 8 px (`--frame-gap`) et un coin de 18 px (`--sheet-r`). Barre du haut de 68 px, collante : titre d'écran, connexion temps réel, compteurs. Le `body` est lui-même couleur cadre, pour qu'aucun clair ne clignote.
- **Rail :** logo et étiquette PSIM, nom du site, menu par activité (Surveillance, Alarmes, Caméras, Armement, Risques, Rapports, Journal, puis le groupe Administration : équipements et plan, personnes prévenues, utilisateurs, système, simulateur), thermomètre de l'indice (112 px ; 60 px sous 940 px de haut ; 64 px dans le tiroir), puis un pied collé en bas (Son, Thème, Compte, Déconnexion) qui reste à portée quand le menu défile. Pastille de compte sur un élément du menu : rouge plein (alarmes à acquitter), ambre (système), liseré clair pour se détacher du cadre.
- **Portail :** même rail de 248 px, même feuille (écart 8 px, coin 18 px), barre du haut de 60 px.
- **Points de rupture :** 1400 px (tableaux d'administration en cartes), 1280 px (colonne latérale de Surveillance et d'Équipements), 1024 px (le rail devient un tiroir de 300 px au plus, ouvert par un bouton de menu), 760 px (barre d'onglets de 64 px à cinq entrées, compteurs en texte court, tableaux d'équipement en cartes), 640 px (tableaux d'alarmes et de journal en cartes), 480 px (téléphone). Les panneaux de Risques, du plan, d'Armement, de Rapports et du portail se règlent sur leur propre largeur (requêtes de conteneur), pas sur celle de la fenêtre.
- **Rythme :** base 4 (`--s1` à `--s7`). Panneaux : 16 px en haut, 24 px sur les côtés (12 et 16 px sur téléphone). Grilles de formulaire en `auto-fit, minmax(200px, 1fr)`.
- **Écran Surveillance :** plan de l'étage à gauche, colonne de droite de 400 px (360 px sous 1280 px) : fiche d'alarme ou bloc « Tout est calme » en haut, mur de caméras 2 × 2 dessous. Entre 1024 et 1279 px, les alarmes passent en tête sur toute la largeur, puis plan et caméras côte à côte ; sous 1024 px, une colonne (alarmes, plan, caméras). Sur l'écran Caméras en téléphone, le mur passe avant le sélecteur.
- **Écran Équipements et plan :** plan collant à gauche, panneaux (éditeur, ajout, étages) dans une colonne de 440 px ; sous 1280 px le plan occupe toute la largeur et les panneaux se rangent dessous, une colonne sur téléphone. L'inventaire occupe toute la largeur.
- **Écran Risques :** indice du site (anneau, niveau, tendance, échelle), une ligne par zone avec son tube, puis trois horizons d'action côte à côte au-delà de 1000 px.

## Elevation & Depth

Profondeur par couches de teinte, ombres ambiantes discrètes. Le cadre est le plan le plus bas, la feuille est posée dessus, les panneaux blancs reposent sur la feuille avec `--shadow-1`. `--shadow-2` est réservé aux éléments qui flottent (fenêtres, menus, tiroir, fiche d'alarme suivie, éditeur de risque ouvert, pastille qu'on déplace). En Nuit, les ombres passent au noir plus dense. Les anneaux d'état des pastilles de plan sont des `box-shadow` sans flou ni décalage : ils ne comptent pas comme des ombres.

### Named Rules
**La règle des deux ombres.** Uniquement `--shadow-1` et `--shadow-2`. Pas de verre flou décoratif, pas d'ombre décalée dure.

## Shapes

Coins doux et réguliers : 6 px (étiquettes), 8 px (petits boutons, vignettes d'images), 10 px (boutons, champs, verre, cartes de ligne), 12 px (scène du plan), 16 px (panneaux), 18 px (feuille), 22 px (fenêtres, feuille de connexion), et 999 px pour les pastilles et les tubes. Bordures d'un pixel (`--line`), jamais d'accent coloré sur un seul côté.

La forme porte l'état : plein (en service), **pointillé** (désarmé, non mesuré, à évaluer, planning non enregistré), **barré** d'un trait diagonal (défaut, hors ligne), **double anneau pulsant** (alarme à acquitter).

La forme porte aussi le type, sur le plan, dans la légende, dans l'inventaire et dans l'éditeur : incendie en rond, intrusion en losange arrondi, accès en écusson (carré à bas arrondi), environnement en goutte, caméra en carré arrondi bleu. Les pastilles du plan et celles de la légende partagent les mêmes règles : la légende ne peut pas mentir. Anneaux : bleu de marque (sélection), bleu pâle bordé de bleu caméra (caméra au mur), double anneau rouge (alarme non acquittée).

## Components

### Buttons
- **Forme :** 44 px de haut (`--control-h`), coin 10 px, Atkinson 600 16 px, icône de 20 px.
- **Défaut :** fond `--surface`, bord `--line-strong` ; survol, bord `--brand`.
- **Principal** (`.btn-primary`) : fond `--brand`, texte blanc ; survol `--brand-2` (de nuit, bleu foncé). Un seul par zone.
- **Geste grave** (`.btn-danger`) : contour `--alarm-ink` sur fond transparent ; plein `--frame-alarm` au survol et au focus. Isolé à droite dans `.actions`, confirmé en mots simples ; le bouton de confirmation est plein (`.is-solid`).
- **Discret** (`.btn-ghost`, texte `--brand-ink`), **petit** (`.btn-sm`, 36 px, minimum en liste dense ; 44 px sur écran tactile et sous 1024 px dans les fiches), **grand** (`.btn-lg`, 52 px), **icône** (carré de 44 px), **enfoncé** (`aria-pressed`, fond `--brand-soft` ; les jours de l'éditeur de planning, plein marine), **occupé** (`.is-busy`, anneau tournant).
- Transitions de 150 ms ; appui : décalage de 1 px vers le bas.

### Pastilles d'état (`.pill`) et compteurs
Hauteur 28 px, pilule, Atkinson 700 14 px, icône de 16 px. Variantes `is-ok`, `is-warning`, `is-alarm`, `is-fault`, `is-offline`, `is-info` (fond `-soft`, texte `-ink`), `is-solid-alarm` (rouge plein, blanc à 6:1), `is-solid-warning` (ambre plein, `--on-warning`), `is-dashed` (pointillé). Toujours icône + mot. `.tag` : étiquette de 24 px, coin 6 px, contour.

Les compteurs de la barre du haut (`.counter`, 36 px) sont des commandes : « alarmes à acquitter » et « hors service » sont des boutons-pastilles. Le compteur « hors service » s'ouvre sur une fenêtre qui liste les détecteurs concernés (`.down-list`). Sur téléphone, le texte court remplace le texte long, et le compteur d'alarmes garde 44 px.

### Panneaux et verre
`.panel` : fond `--surface`, bord `--line`, coin 16 px, `--shadow-1`, en-tête `.panel-head` et corps `.panel-body`. `.glass` : fond `--sky`, bord teinté `--tube`, coin 10 px, pour le plan et les jauges. Bloc d'état `.state-block` (grande icône, titre, détail), vide `.empty` en pointillé qui dit quoi faire, message en ligne `.notice` teinté avec icône.

### Champs
`.field` : libellé visible au-dessus (14 px, 700), aide `.hint` en `--ink-2`, erreur `.error` en `--alarm-ink`. Commandes de 44 px, trait `--ink-3`, focus par bord `--brand` et halo. Cases et listes de cases en cibles de 36 px (44 px en carte). Message d'action `.form-status` (en cours, réussi, échec, info) dans la rangée d'actions.

### Tableaux et cartes
`table.data` : en-têtes en 13 px 700 `--ink-2` sur `--surface-2`, sans majuscules.

Sous un seuil de largeur (voir Layout), chaque ligne devient une carte (`--surface`, bord `--line`, coin 10 px, 12 à 16 px de marge) et chaque cellule porte son libellé (`data-label`, 13 px 700). L'en-tête est masqué (à l'œil seulement, lu par les lecteurs d'écran, sauf alarmes et journal où il est retiré). L'identifiant ou l'état passe en tête, l'action en bas ; le geste grave reste à l'écart. Administration : sous 1400 px ; équipements et simulateur : sous 760 px ; alarmes, alarmes closes et journal : sous 640 px ; portail : sous 600 px de panneau, avec une fiche à faits côte à côte pour les sites entre 601 et 900 px.

### Icônes
Sprite local `icons.svg`, trait 1,8, `<svg class="icon"><use href="icons.svg#nom"/></svg>` ; tailles 16, 20, 28, 40 px. États : `state-ok`, `state-warning`, `state-alarm` (octogone), `state-unknown`, `state-offline`, `wrench`. Catégories : `fire`, `intrusion`, `door`, `drop`, `camera`. Canaux d'envoi : `mail` (e-mail), `chat` (messagerie), `send`, `megaphone`. Gestes : `plus`, `pencil`, `trash`, `refresh`, `search`, `upload`, `download`, `printer`, `play`, `lock`, `unlock`, `key`. Navigation et lieux : `eye`, `bell`, `shield`, `gauge`, `doc`, `list`, `plan`, `layers`, `users`, `server`, `sliders`, `history`, `chart`, `building`, `home`, `grid`, `pin`, `move`, `image`, `signal`, `clock`, `info`, `external`.

### Logo
Sprite `logo.svg` : `#mark-on-light`, `#mark-on-dark` (viewBox 0 0 64 64), `#wordmark` (`currentColor`, 15 px de haut dans le rail, 22 px à la connexion), `#psim-word`. Étiquette `.psim-tag` : Baloo 800 14 px, casse normale, fond jaune de l'affiche (marine sur la feuille de connexion).

### Jauge GAMR (signature)
`web/gauge.js` : `createThermometer()` (rail et indice du site), `createTube()` (une zone, un site), `createRing()` (indice du site dans Risques, un site dans le portail), `levelOf()`, `BANDS`. Quatre bandes aux seuils 8 (Faible), 20 (Modéré), 36 (Élevé), 60 (Critique) ; repères gravés dans le verre ; le mercure glisse vers sa valeur (`--t-slow`, 600 ms) quand l'indice change. Sans indice : jauge vide en pointillé et « À évaluer » / « non transmis ».

**Tubes par zone (Risques).** Une ligne par zone : nom, tube de 14 px, chiffre (Baloo) et niveau en mot, puces de facteurs (P V R), actions dont le détail du calcul. Les colonnes s'alignent d'une ligne à l'autre au-delà de 940 px de panneau ; plus étroit, la ligne se plie (nom et chiffre, tube, puces et actions). Un détecteur hors service dans la zone s'écrit par une étiquette violette (clé et mot).

### Cadre d'alarme et fiche d'alarme
`.app[data-frame='calm'|'warning'|'alarm']` et `[data-pending]` : la couleur et la pulsation du cadre (et de la barre d'onglets). La fiche suivie est dépliée en tête du panneau « Alarmes en cours », bord de marque et `--shadow-2` ; les autres sont des lignes compactes de 56 px. Bandeau teinté de la couleur de l'état tant que personne n'a acquitté, attente qui se voit (tube de 8 px qui se remplit en cinq minutes, un repère par minute). Trois étapes numérotées reliées par un fil : 1 regarder les caméras, 2 acquitter (action principale), 3 clôturer en qualifiant, avec la raison qui bloque ou autorise la clôture. L'onglet d'un étage en alarme clignote tant qu'on n'y est pas (cadre rouge fixe en mouvement réduit).

### Plan et légende
Le plan est posé sur du verre bleu ciel (`.plan-stage`, coin 12 px, marge de 18 px) ; pointillé de marque en édition. Liens détecteur-caméras en pointillés bleus (rouges pour un détecteur qui sonne). La **légende** (`.plan-legend`, résumé dépliable sous le plan) tient en deux lignes qui apprennent la grammaire : la couleur dit l'état, la forme dit le type ; elle se replie par défaut sur téléphone, son titre reste un bouton de 44 px. La vue éclatée empile les étages en perspective, l'étage en alarme est cerné d'un double anneau et les plateaux au-dessus restent transparents.

### Frise d'armement
Écran Armement : une carte par zone d'intrusion (état, échéance, commandes) ; zone désarmée en pointillé `--warning-ink` sur fond ambre doux. La frise de la semaine donne un jour par tube de verre (16 px, `--arm-glass`), gradué 0 h, 6 h, 12 h, 18 h, 24 h ; les plages armées le remplissent en marine (`--arm-on`, soit `--brand-2`). Réglage manuel en cours : hachures, par-dessus le planning (ambre si désarmé, marine si armé). « Maintenant » : un trait jaune de l'affiche cerné d'encre ; le jour courant a son tube bordé de bleu de marque. Planning non enregistré : cadre en pointillé ambre. L'éditeur des plages (jours en boutons bascule, une ligne de 7 même au téléphone) s'ouvre sous la carte ; pendant la saisie, « Enregistrer le planning » devient la seule action principale.

### Administration
Quatre écrans sur les mêmes composants, sans couleur ni police neuves : **Personnes prévenues** (destinataires par zone et par niveau, canaux `mail` et `chat`, état des envois en liste de canaux, message de test, derniers envois dépliables), **Utilisateurs** (qui, rôle, double authentification, actions ; geste grave à l'écart), **Système** (groupes de faits `dt`/`dd` avec icône et mot d'état, tâches avec leur résultat) et la fenêtre **Mon compte** (identité, formulaires de compte, double authentification en étapes numérotées avec numéro Baloo dans un rond, clé et code en chasse fixe, codes de secours en deux colonnes dans un bloc pointillé). Les listes sont des tableaux qui passent en cartes sous 1400 px.

### Loupe d'image
Les images prises par une alarme sont des vignettes de 112 × 63 px (coin 8 px, curseur de loupe) ; au clic, la loupe prend tout l'écran sous un voile `--scrim`, image au plus 94 vw × 82 vh, légende blanche, clic pour fermer. Sur ce voile sombre, le contour de focus passe au jaune de l'affiche.

## Do's and Don'ts

### Do:
- **Do** utiliser uniquement des `var(--…)` de base.css ; tout doit être lisible en Jour et en Nuit.
- **Do** dire chaque état par une forme, une icône du sprite et un mot.
- **Do** garder une seule action principale par zone et isoler à droite le geste grave.
- **Do** viser 44 px pour toute cible tactile, 36 px au minimum en liste dense.
- **Do** donner un libellé visible à chaque champ et écrire des vides qui disent ce qui manque et comment l'obtenir.
- **Do** transformer un tableau en cartes sous son seuil, avec un `data-label` par cellule, plutôt que d'imposer un défilement de côté.
- **Do** employer `--link` pour tout lien ou intitulé cliquable sur la feuille, et `--on-warning` sur tout fond ambre plein.
- **Do** limiter les mouvements d'état à 150–250 ms avec `--ease-out`, et respecter `prefers-reduced-motion` (cadre rouge fixe).
- **Do** respecter la CSP : ni attribut `style`, ni script ou style en ligne, ressources locales seulement, données injectées par `textContent`.

### Don't:
- **Don't** refaire l'écran de salle de contrôle sombre à panneaux ni le tableau de bord à tuiles de gros chiffres.
- **Don't** inventer un chiffre d'indice : sans indice, jauge en pointillé et « À évaluer ».
- **Don't** utiliser de caractères Unicode ou d'émojis comme icônes (◀ ▶ ▲ ▼ ✔ ✖ ⚠).
- **Don't** poser de bordure colorée de plus de 1 px sur un seul côté d'une carte, d'une ligne ou d'une alerte.
- **Don't** mettre de sur-titre au-dessus d'un titre, de numéros de section décoratifs, de texte en dégradé ni de verre flou décoratif.
- **Don't** utiliser Baloo 2 sur un bouton, une étiquette ou une donnée de tableau.
- **Don't** ajouter d'animation d'entrée de page.
