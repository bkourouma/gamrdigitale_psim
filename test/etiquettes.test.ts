/**
 * Planche d'etiquettes imprimee depuis l'ecran « Rondes » : les etiquettes doivent rester utilisables une fois
 * decoupees et plastifiees (QR assez grand pour un telephone d'entree de gamme, trois colonnes qui tiennent sur A4
 * avec les marges par defaut, encre noire sur fond blanc, code lisible en clair sous le QR).
 *
 * L'impression elle-meme se fait dans le navigateur : on controle donc la feuille de style d'impression, et la taille
 * reelle d'un module du QR code que le serveur produit pour une adresse d'etiquette realiste.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import QRCode from 'qrcode';

const WEB = join(import.meta.dirname, '..', 'web');
const read = (file: string) => readFileSync(join(WEB, file), 'utf8').replace(/\r\n/g, '\n');
const css = read('patrols.css');
const printCss = css.slice(css.indexOf('@media print'));

/** Valeur en millimetres d'une propriete de la regle `selector` dans la feuille d'impression. */
function mm(selector: string, property: string): number {
  const rule = new RegExp(`${selector.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(printCss);
  assert.ok(rule, `regle d'impression ${selector} introuvable`);
  const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([\\d.]+)mm`).exec(rule[1]);
  assert.ok(value, `${selector} : ${property} en mm introuvable`);
  return Number(value[1]);
}

describe('planche d\'etiquettes : impression', () => {
  const qr = mm('body.pt-printing .pt-label-qr', 'width');
  const qrHeight = mm('body.pt-printing .pt-label-qr', 'height');
  const labelWidth = mm('body.pt-printing .pt-label', 'width');
  const labelPadding = mm('body.pt-printing .pt-label', 'padding');

  it('le QR imprime fait au moins 3 cm de symbole, carre, et tient dans l\'etiquette', () => {
    assert.equal(qr, qrHeight, 'QR carre');
    // L'image du serveur a une marge d'un module de chaque cote (margin: 1) : au pire, version 7 (45 modules) -> 47 au total.
    assert.ok((qr * 45) / 47 >= 30, `symbole de ${((qr * 45) / 47).toFixed(1)} mm`);
    assert.ok(qr <= labelWidth - 2 * labelPadding, 'le QR tient dans la largeur utile de l\'etiquette');
  });

  it('trois colonnes de la largeur d\'une etiquette tiennent sur A4 avec la marge de page de 10 mm', () => {
    assert.match(printCss, /grid-template-columns: repeat\(3, 63mm\)/);
    assert.equal(labelWidth, 63);
    const margin = /@page\s*\{\s*margin:\s*(\d+)mm/.exec(css);
    assert.ok(margin, '@page declare sa marge');
    assert.ok(3 * labelWidth <= 210 - 2 * Number(margin[1]), `${3 * labelWidth} mm sur ${210 - 2 * Number(margin[1])} mm utiles`);
  });

  it('une etiquette ne se coupe jamais entre deux pages et au moins trois lignes (neuf etiquettes) tiennent par page A4', () => {
    assert.match(printCss, /break-inside: avoid/);
    assert.match(printCss, /page-break-inside: avoid/);
    // Hauteur d'une etiquette : QR + nom + zone + code + mode d'emploi (2 lignes) + remplissage + ecarts.
    const height = qr + 2 * labelPadding + 5 * 1.5 + (12 + 9 + 8 + 2 * 7) * 0.3528 * 1.4;
    assert.ok(Math.floor((297 - 20) / height) >= 3, `etiquette de ${height.toFixed(0)} mm environ`);
  });

  it('a l\'impression tout est noir sur blanc (QR, nom, zone, code) et le code est ecrit en clair', () => {
    for (const selector of ['.pt-label-name', '.pt-label-zone', '.pt-label-code', '.pt-label-code code', '.pt-label-hint']) {
      const rule = new RegExp(`body\\.pt-printing ${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(printCss);
      assert.ok(rule, selector);
      assert.match(rule[1], /color: #000000/, selector);
    }
    const size = /body\.pt-printing \.pt-label-code code \{[^}]*font-size: (\d+)pt/.exec(printCss);
    assert.ok(size && Number(size[1]) >= 10, 'code de secours en 10 pt ou plus');
    assert.match(read('patrols.js'), /Saisie de secours : ', h\('code', \{ text: cp\.code/);
  });
});

describe('planche d\'etiquettes : QR code', () => {
  it('un module imprime mesure au moins 0,7 mm, meme pour une adresse publique longue', async () => {
    const qr = mm('body.pt-printing .pt-label-qr', 'width');
    for (const origin of ['https://192.168.1.50:3033', 'https://residence-kourouma.exemple.ci:3033', 'https://psim-de-la-residence-kourouma-abidjan.exemple.com:3033']) {
      const url = `${origin}/agent/#cp=k4m7qx2b3d`;
      const code = QRCode.create(url, {});
      const modules = code.modules.size + 2; // + la marge d'un module de chaque cote
      const size = qr / modules;
      assert.ok(size >= 0.7, `${url} : ${modules} modules, ${size.toFixed(2)} mm chacun`);
      // Le serveur produit bien ce meme dessin, avec cette marge.
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 260 });
      assert.match(svg, new RegExp(`viewBox="0 0 ${modules} ${modules}"`));
    }
  });
});
