# Logo GAMR-DIGITALE PSIM

Le logo reprend l'affiche de la marque (`affiche-gamr-digitale.jpg`) : le mot **GAMR-DIGITALE** en lettres rondes
et grasses, et un symbole tiré de sa jauge. Ce symbole, la « jauge-œil », est un cadran en trois bandes (vert, jaune,
rouge, comme le thermomètre de l'affiche) avec au centre une lentille de surveillance et son aiguille.
L'étiquette **PSIM** désigne le logiciel de supervision. L'ASP-CI n'apparaît pas dans ce logo.

## Les fichiers

| Fichier | Usage |
|---|---|
| `gamr-digitale-psim-logo.svg` / `.png` | Logo complet sur fond clair (blanc, bleu ciel). PNG de 1200 px, fond transparent. |
| `gamr-digitale-psim-logo-negatif.svg` / `.png` | Le même logo sur fond marine : en-têtes sombres, diapositives, signalétique. |
| `gamr-digitale-psim-symbole.svg` / `.png` | Le symbole seul (avatar, tampon, petit espace). PNG de 512 px, fond transparent. |
| `favicon-32.png` | Icône d'onglet du navigateur (tuile marine arrondie). |
| `favicon-180.png` | Icône d'écran d'accueil (iPhone, iPad). Carré plein, sans coins arrondis : le téléphone les arrondit lui-même. |
| `web/logo.svg`, `portal/web/logo.svg` | Planche de symboles pour l'interface (voir plus bas). Les deux fichiers sont identiques. |
| `web/favicon.svg`, `portal/web/favicon.svg` | Icône d'onglet vectorielle des deux applications. |

Utilisez toujours ces fichiers : ne recomposez pas le logo à la main. Tout le texte est déjà dessiné en contours, donc
le logo s'affiche pareil partout, même sans la police installée.

## Couleurs

| Rôle | Couleur |
|---|---|
| Mot GAMR-DIGITALE | `#3B6CB7` |
| Marine (cadre, lentille, aiguille, étiquette PSIM, fond du négatif) | `#244C87` |
| Bande verte | `#5DA444` |
| Bande jaune sur fond clair | `#F5C400` (un ton plus dense que celui de l'affiche, pour rester visible sur le blanc) |
| Bande jaune sur fond marine, étiquette PSIM du négatif | `#FADF38` (celui de l'affiche) |
| Bande rouge | `#E35235` |
| « Supervision de sécurité » sur fond marine | `#BCD3EE` |
| Blanc | `#FFFFFF` |

## Polices

- **Baloo 2, graisse 800** (ExtraBold) pour GAMR-DIGITALE et PSIM. L'espacement entre les lettres est celui de la police
  (crénage d'origine), avec +12 % pour PSIM.
- **Atkinson Hyperlegible Next, graisse 600** pour « Supervision de sécurité ».
- Les deux polices sont sous licence libre SIL Open Font License (`web/fonts/OFL-*.txt`). Le logo les utilise
  sous forme de dessins vectoriels, ce que la licence autorise.

## Zone de protection

Notez **x** la hauteur d'une capitale du mot GAMR-DIGITALE. Laissez au moins **x** d'espace vide tout autour du logo :
pas de texte, pas de bord de page, pas d'autre logo dans cette marge. Les fichiers SVG et PNG du logo complet incluent
déjà cette marge. Autour du symbole seul, gardez au moins un quart de sa largeur.

## Tailles minimales

- Logo complet : 260 px de large à l'écran, 50 mm à l'impression (sinon « Supervision de sécurité » devient illisible).
  En dessous, utilisez le symbole avec le mot seul, ou le symbole seul.
- Mot GAMR-DIGITALE seul : 12 px de haut.
- Symbole : 24 px à l'écran. À 16 px, utilisez uniquement `favicon.svg`, dessiné plus gras pour cette taille.

## À ne pas faire

- Déformer le logo (l'étirer, l'écraser, le pencher) ou le faire tourner.
- Changer les couleurs des bandes, leur ordre (vert, jaune, rouge dans le sens des aiguilles d'une montre) ou leur nombre.
- Déplacer l'aiguille, changer la police du mot, ou réécrire GAMR-DIGITALE dans une autre police.
- Poser le logo sur une photo chargée ou un fond bariolé : utilisez un fond uni, clair (logo normal) ou marine (négatif).
- Ajouter une ombre, un contour, un dégradé ou un effet de relief.
- Mettre le logo normal sur un fond foncé, ou le négatif sur un fond clair.

## Pour l'interface (planche `logo.svg`)

Chaque symbole s'utilise par son identifiant. Ces noms sont un contrat avec le code : ne les changez pas.

| Identifiant | viewBox | Contenu |
|---|---|---|
| `mark-on-light` | `0 0 64 64` | Symbole pour fond clair : lentille et aiguille marine, reflet blanc. Couleurs fixes. |
| `mark-on-dark` | `0 0 64 64` | Symbole pour fond marine : lentille et aiguille blanches, reflet marine. Couleurs fixes. |
| `wordmark` | `0 0 712.8 64.3` | GAMR-DIGITALE. Couleur donnée par la propriété CSS `color`. |
| `psim-word` | `0 0 247.8 64.3` | PSIM. Couleur donnée par la propriété CSS `color`. |

```html
<svg class="brand-mark" aria-hidden="true"><use href="logo.svg#mark-on-dark"/></svg>
<svg class="brand-word" role="img" aria-label="GAMR-DIGITALE"><use href="logo.svg#wordmark"/></svg>
```

Repères pour régler les tailles (h = hauteur de la boîte du mot `wordmark`) :

- Le mot fait 11,09 h de large ; ses capitales mesurent 0,96 h.
- Dans la boîte de 64 du symbole, le dessin occupe x 4,5 à 59,5 et y 10,5 à 51,75 : il est centré, avec une petite
  marge sur les côtés.
- Logo complet (mot, puis ligne PSIM) : boîte du symbole = 3,2 h, centrée en hauteur sur les deux lignes de texte ;
  espace entre la boîte et le mot = 0,25 h. Étiquette PSIM : 0,71 h de haut, à 0,36 h sous la boîte du mot.
- Symbole et mot sur une seule ligne : boîte du symbole = 2,4 h, espace = 0,3 h.

## Construction du symbole (carré 64 × 64)

Centre (32, 38). Arc de 240°, ouvert en bas, de 150° à 390° dans le sens des aiguilles d'une montre (0° = à droite),
comme l'anneau de l'interface (`web/gauge.js`). Rayon moyen 23,25, épaisseur 8,5. Trois bandes égales de 80°, séparées
par un interstice de largeur constante 2. Lentille : disque de rayon 9,5. Reflet : rayon 2,7, décalé de (−4 ; −2,5).
Aiguille : trait de 3,8, bout arrondi, longueur 16,5, orientée à 255°, dans la bande jaune.
L'icône d'onglet reprend ce dessin sur une tuile marine (rayon des coins 14) : rayon 19,3, épaisseur 9,5, lentille 8,6,
aiguille 13,2 × 4.
