/**
 * Fiche de recette imprimable : une ligne par equipement de l'inventaire, a cocher et signer pendant la mise en
 * service, puis les essais de bout en bout. Page autonome (styles integres), a imprimer ou enregistrer en PDF.
 */
import { CATEGORY_LABEL } from '../../server/sources.ts';
import type { DeviceCategory } from '../../server/types.ts';

export interface SheetDevice {
  id: string;
  kind: 'detector' | 'camera';
  name: string;
  zone: string;
  category: DeviceCategory;
  /** Camera : « ONVIF 192.168.1.20 », « RTSP ... » ou « simulee ». */
  source?: string;
  links?: string[];
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ESSAIS: { titre: string; etapes: string[] }[] = [
  {
    titre: 'Alarme de bout en bout',
    etapes: [
      "Declencher un detecteur reel (bouton test) : l'incident s'ouvre en moins de 5 s, avec le bon nom et la bonne zone",
      "L'alerte sonore retentit ; les cameras liees s'affichent ; l'image est jointe a l'incident",
      "La notification arrive sur chaque canal (e-mail, Telegram, webhook) chez chaque destinataire de niveau 1",
      "Ne pas acquitter : apres le delai, le niveau 2 est prevenu (escalade) ; puis acquitter, remettre a la normale, cloturer (« fausse alarme : recette »)",
    ],
  },
  {
    titre: 'Pannes et reprise',
    etapes: [
      "Debrancher un detecteur supervise : il passe « hors ligne » apres le delai prevu, et une notification part",
      "Arreter brutalement le PSIM (tuer le processus), le relancer : periode sans surveillance journalisee et notifiee",
      "Couper l'acces reseau du PSIM quelques minutes : la supervision externe alerte la personne prevue",
      "Verifier la restauration d'une sauvegarde sur une autre machine (`npm run restore`)",
    ],
  },
  {
    titre: 'Securite et exploitation',
    etapes: [
      "Chaque administrateur a active la double authentification ; chaque operateur a son propre compte",
      "L'acces se fait en HTTPS ; le certificat est valide ou installe sur les postes",
      "`npm run verify-journal` rend « INTEGRE » ; l'ancre est conservee hors de la machine",
      "Le rapport automatique par e-mail est regle ; un envoi de test a ete recu",
      "Les destinataires ont ete informes et savent quoi faire a la reception d'une alerte",
    ],
  },
];

export function buildSheet(opts: { site: string; generatedAt: number; devices: SheetDevice[] }): string {
  const row = (d: SheetDevice) => {
    const cat = d.kind === 'camera' ? 'Camera' : CATEGORY_LABEL[d.category];
    const extra = d.kind === 'camera' ? esc(d.source ?? '') : d.links?.length ? `cameras : ${esc(d.links.join(', '))}` : 'aucune camera liee';
    return `<tr><td><b>${esc(d.id)}</b></td><td>${esc(d.name)}<br><small>${esc(d.zone || 'sans zone')}</small></td><td>${esc(cat)}<br><small>${extra}</small></td>${
      d.kind === 'detector'
        ? '<td class="c">&#9744;</td><td class="c">&#9744;</td><td class="c">&#9744;</td><td class="c">&#9744;</td>'
        : '<td class="c">&mdash;</td><td class="c">&mdash;</td><td class="c">&#9744;</td><td class="c">&mdash;</td>'
    }<td class="w"></td></tr>`;
  };
  const when = new Date(opts.generatedAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiche de recette - ${esc(opts.site)}</title>
<style>
body{font:12px/1.4 Segoe UI,Arial,sans-serif;color:#111;margin:18px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #999}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #777;padding:4px 6px;vertical-align:top}th{background:#eee;text-align:left}
td.c{text-align:center;font-size:18px;width:62px}td.w{width:190px}small{color:#555}
ul{margin:4px 0;padding-left:0;list-style:none}li{margin:5px 0}li:before{content:"\\2610  "}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:26px}.sign div{border-top:1px solid #111;padding-top:4px}
@media print{body{margin:8mm}tr{break-inside:avoid}h2{break-after:avoid}}
</style></head><body>
<h1>Fiche de recette - ${esc(opts.site)}</h1>
<p>Etablie le ${esc(when)} a partir de l'inventaire du PSIM. Une ligne par equipement ; cocher au fur et a mesure. Detecteurs : <code>npm run commission -- watch</code> montre ce que le PSIM comprend de chaque message.</p>
<h2>1. Equipements</h2>
<table><thead><tr><th>Id</th><th>Nom / zone</th><th>Type</th><th>Message recu</th><th>Alarme testee</th><th>Image visible</th><th>Retour normal</th><th>Date, technicien, remarque</th></tr></thead><tbody>
${opts.devices.map(row).join('\n')}
</tbody></table>
${ESSAIS.map((e, i) => `<h2>${i + 2}. ${esc(e.titre)}</h2><ul>${e.etapes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`).join('\n')}
<h2>${ESSAIS.length + 2}. Reserves</h2><div style="height:70px;border:1px solid #777"></div>
<div class="sign"><div>Installateur : nom, date, signature</div><div>Responsable du site : nom, date, signature</div></div>
</body></html>`;
}
