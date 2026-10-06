/**
 * Source d'un détecteur d'intrusion : la détection d'un enregistreur ou d'une caméra Dahua (une voie). Le PSIM lit les
 * événements de l'appareil avec les identifiants déjà enregistrés pour la caméra choisie ; un essai de 20 s montre ce que
 * l'appareil émet vraiment (voie, nom de l'événement), avant d'enregistrer.
 */
import { createDialogs } from './account.js';
import { h, icon, api, toast, time } from './core.js';
import { field, setFieldError, clearFieldErrors, statusLine, setStatus, withBusy, pick } from './sources.js';

/** Types d'événements proposés -> codes Dahua. Les noms du menu de l'enregistreur sont expliqués dans l'aide. */
const KINDS = {
  human: { label: 'Personne détectée', codes: ['SmartMotionHuman'] },
  human_vehicle: { label: 'Personne ou véhicule détecté', codes: ['SmartMotionHuman', 'SmartMotionVehicle'] },
  motion: { label: "Tout mouvement dans l’image", codes: ['VideoMotion'] },
  ivs: { label: 'Franchissement de ligne ou de zone', codes: ['CrossLineDetection', 'CrossRegionDetection'] },
};

/** Type proposé correspondant exactement aux codes enregistrés, ou null (réglage fait autrement : gardé tel quel). */
const kindOf = (codes) => Object.entries(KINDS).find(([, k]) => k.codes.length === codes.length && k.codes.every((c) => codes.includes(c)))?.[0] ?? null;

const TEST_S = 20;

export function buildDetectorSource(d, { cameras }) {
  const box = h('div', { class: 'source-box' }, h('p', { class: 'hint', text: 'Chargement de la source…' }));
  if (d.category !== 'intrusion') {
    box.replaceChildren(h('p', { class: 'hint', text: "Réservé aux détecteurs d’intrusion : changez d’abord la catégorie dans les réglages ci-dessus." }));
    return box;
  }
  const url = `/api/detectors/${encodeURIComponent(d.id)}/source`;
  // Résultat d'un essai affiché : le rafraîchissement de l'état ne l'efface pas (surtout un échec, ou « aucun événement »).
  let pinned = false;
  let zone = d.zone;
  let loaded = false;
  let lastSrc = null;
  const load = () =>
    api(url)
      .then(render)
      .catch((err) => {
        const status = statusLine();
        setStatus(status, 'error', `Source illisible : ${err.message}`);
        box.replaceChildren(status);
      });

  /** État de la connexion à l'appareil, en mots : ce que cela veut dire pour la surveillance de la zone. */
  function connectionText(src) {
    if (!src) return { kind: 'info', text: "Pas de source : ce détecteur attend ses messages d’une autre façon (voir « Pour l’installateur » ci-dessus)." };
    const c = src.connection;
    const last = c.lastEvent ? ` Dernier événement : ${c.lastEvent.code} ${c.lastEvent.action} à ${time(c.lastEvent.at)}.` : '';
    if (c.state === 'connected') return { kind: 'ok', text: `Le PSIM écoute l’appareil depuis ${time(c.since)}.${last}` };
    if (c.state === 'connecting') return { kind: 'busy', text: 'Connexion à l’appareil en cours…' };
    return { kind: 'error', text: `Pas de connexion à l’appareil : ${c.error ?? 'raison inconnue'}. Si cela dure, le détecteur passe « hors ligne ».${last}` };
  }

  function render(src) {
    pinned = false;
    loaded = true;
    lastSrc = src;
    const real = cameras().filter((c) => c.streamKind === 'rtsp' || c.streamKind === 'onvif');
    if (!real.length && !src) {
      box.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          icon('camera'),
          h('strong', { text: 'Aucune caméra branchée pour l’instant' }),
          h('span', { text: 'Choisissez d’abord une caméra sur le plan, réglez sa source vidéo (caméra réseau ou flux direct) avec son utilisateur et son mot de passe, puis revenez ici.' }),
        ),
      );
      return;
    }
    const camera = h('select', {}, ...real.map((c) => h('option', { value: c.id, text: `${c.id} · ${c.name}` })));
    // Caméra enregistrée mais dont la source n'est plus réelle : montrée telle quelle, jamais remplacée sans le voir.
    if (src && !real.some((c) => c.id === src.cameraId)) camera.append(h('option', { value: src.cameraId, text: `${src.cameraId} (sans source vidéo réelle)` }));
    pick(camera, src ? src.cameraId : (real[0]?.id ?? ''));
    const channel = h('input', { type: 'number', min: '1', max: '128', inputmode: 'numeric', class: 'input-narrow', value: src ? String(src.channel) : '' });
    // Un réglage enregistré hors des types proposés est montré et gardé tel quel (jamais remplacé sans le voir).
    const current = src && !kindOf(src.events) ? h('option', { value: 'current', text: `Réglage actuel : ${src.events.join(' + ')}` }) : null;
    const kind = h('select', {}, ...Object.entries(KINDS).map(([id, k]) => h('option', { value: id, text: k.label })), ...(current ? [current] : []));
    pick(kind, src ? (kindOf(src.events) ?? 'current') : 'human');
    const codesOf = () => (kind.value === 'current' ? src.events : KINDS[kind.value].codes);
    const port = h('input', { type: 'number', min: '1', max: '65535', inputmode: 'numeric', class: 'input-narrow', value: String(src?.httpPort ?? 80) });
    const connection = connectionText(src);
    const line = statusLine({ dataset: { role: 'connection' } });
    setStatus(line, connection.kind, connection.text);
    const results = h('ul', { class: 'source-events', 'aria-label': "Événements reçus pendant l’essai" });
    results.hidden = true;
    const advice = h('p', { class: 'notice is-warning' });
    advice.hidden = true;

    const channelOk = () => /^\d+$/.test(channel.value) && Number(channel.value) >= 1 && Number(channel.value) <= 128;
    // La voie se déduit du chemin RTSP de la caméra (« channel=3 ») : proposée, modifiable. Sinon, on dit comment la trouver.
    const guessChannel = () =>
      api(`/api/cameras/${encodeURIComponent(camera.value)}/source`)
        .then((s) => {
          const m = /channel=(\d+)/.exec(s.rtspPath ?? '');
          if (m && !channel.value) {
            channel.value = m[1];
            channel.defaultValue = m[1]; // une proposition, pas une saisie : elle ne retient pas l'éditeur
          }
        })
        .catch(() => {});
    camera.addEventListener('change', () => {
      channel.value = '';
      setFieldError(channel);
      guessChannel();
    });
    channel.addEventListener('input', () => channelOk() && setFieldError(channel));
    port.addEventListener('input', () => /^\d+$/.test(port.value) && Number(port.value) >= 1 && Number(port.value) <= 65535 && setFieldError(port));

    const noZone = !zone;
    const save = h('button', { class: 'btn btn-primary', type: 'button', text: 'Enregistrer la source', disabled: noZone });
    save.addEventListener('click', async () => {
      clearFieldErrors(box);
      const portOk = /^\d+$/.test(port.value) && Number(port.value) >= 1 && Number(port.value) <= 65535;
      if (!channelOk()) setFieldError(channel, 'Voie de 1 à 128 : le numéro de la caméra sur l’enregistreur (1 pour une caméra seule).');
      if (!portOk) setFieldError(port, 'Port de 1 à 65535 (80 en général).');
      if (!channelOk() || !portOk) return (channelOk() ? port : channel).focus();
      setStatus(line, 'busy', 'Enregistrement…');
      try {
        const saved = await withBusy(save, () => api(url, { method: 'PUT', body: { cameraId: camera.value, channel: Number(channel.value), events: codesOf(), httpPort: Number(port.value) } }));
        toast(`${d.id} : source enregistrée, le PSIM écoute l’appareil`, 'ok');
        render(saved);
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    const test = h('button', { class: 'btn', type: 'button' }, icon('play'), `Écouter ${TEST_S} secondes`);
    test.addEventListener('click', async () => {
      pinned = true;
      advice.hidden = true;
      results.hidden = true;
      let left = TEST_S;
      // Annoncé une fois aux lecteurs d'écran ; le décompte, lui, est muet (aria-hidden).
      const counter = h('span', { 'aria-hidden': 'true' });
      const say = () => (counter.textContent = ` (encore ${left} s)`);
      setStatus(line, 'busy', `Écoute de l’appareil pendant ${TEST_S} secondes : passez devant la caméra.`);
      line.append(counter);
      say();
      const tick = setInterval(() => {
        left = Math.max(0, left - 1);
        say();
      }, 1000);
      try {
        const r = await withBusy(test, () => api(`/api/cameras/${encodeURIComponent(camera.value)}/events-test`, { method: 'POST', body: { httpPort: Number(port.value) } }));
        clearInterval(tick);
        setStatus(line, r.ok ? 'ok' : 'error', r.message);
        // Marqué : seulement ce qui déclenchera CE détecteur (bonne voie ET type d'événement suivi).
        const wanted = channelOk() ? Number(channel.value) : null;
        const codes = codesOf();
        const fires = (e) => e.channel === wanted && codes.includes(e.code);
        results.hidden = r.events.length === 0;
        results.replaceChildren(
          ...r.events.map((e) =>
            h(
              'li',
              { class: fires(e) ? 'is-match' : '' },
              h('time', { text: time(e.at) }),
              h('span', { class: 'mono', text: `voie ${e.channel}  ${e.code}  ${e.action}` }),
              fires(e)
                ? h('span', { class: 'tag is-ok' }, icon('check', 'icon-sm'), 'Déclenchera ce détecteur')
                : e.channel === wanted
                  ? h('span', { class: 'tag', text: "Bonne voie, autre type d’événement" })
                  : null,
            ),
          ),
        );
        if (r.ok && !r.events.some(fires)) {
          advice.hidden = false;
          advice.replaceChildren(
            icon('state-warning'),
            h('span', {
              text:
                wanted === null
                  ? 'Voie à choisir : reprenez la voie d’un événement ci-dessus, puis enregistrez.'
                  : `Aucun événement « ${kind.selectedOptions[0]?.text ?? ''} » sur la voie ${wanted} pendant l’écoute : vérifiez la voie et le type, passez devant la caméra, puis recommencez.`,
            }),
          );
        }
      } catch (e) {
        clearInterval(tick);
        setStatus(line, 'error', e.message);
      }
    });

    const remove = src ? h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Retirer la source') : null;
    remove?.addEventListener('click', async () => {
      const ok = await createDialogs({ h }).confirm({
        heading: `Retirer la source de ${d.id}`,
        message: `Le détecteur ${d.id} ne recevra plus la détection de cet appareil.`,
        confirmLabel: 'Ne plus écouter l’enregistreur',
        danger: true,
      });
      if (!ok) return;
      try {
        await withBusy(remove, () => api(url, { method: 'DELETE' }));
        toast(`${d.id} : source retirée`, 'ok');
        load();
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    if (!src && camera.value) guessChannel();

    box.replaceChildren(
      ...[
      h('p', { class: 'hint', text: "Le PSIM écoute la détection d’une caméra ou d’un enregistreur Dahua, avec l’utilisateur et le mot de passe de sa source vidéo. L’armement de la zone (planning de nuit) s’applique." }),
      noZone
        ? h('p', { class: 'notice is-warning' }, icon('state-warning'), h('span', { text: 'Donnez d’abord une zone à ce détecteur (champ « Zone » en haut, puis Enregistrer) : l’armement et les personnes prévenues s’appliquent par zone.' }))
        : null,
      h(
        'div',
        { class: 'eq-grid' },
        field('Caméra ou enregistreur', camera),
        field('Numéro de la caméra', channel, 'Voie de l’enregistreur : le numéro de la caméra sur l’enregistreur (1 pour une caméra seule). Si elle n’est pas proposée, lancez l’écoute : la voie de chaque événement s’affiche.'),
        field(
          'Événement suivi',
          kind,
          'Dans le menu Dahua : « SMD » détecte personnes et véhicules, « IVS » les lignes et zones virtuelles. La fonction doit y être activée.',
        ),
        field('Port de l’appareil', port, 'Port HTTP, 80 en général.'),
      ),
      h('div', { class: 'actions' }, save, test, remove),
      line,
      results,
      advice,
      ].filter(Boolean),
    );
  }

  // Zone enregistrée dans l'identité : la section suit sans attendre que le focus quitte l'éditeur.
  const onZone = (e) => {
    if (!box.isConnected) return document.removeEventListener('psim:zone-saved', onZone);
    if (e.detail?.id !== d.id) return;
    zone = e.detail.zone;
    if (loaded && !pinned && !box.contains(document.activeElement)) render(lastSrc);
  };
  document.addEventListener('psim:zone-saved', onZone);

  load();
  // État de la connexion rafraîchi tant que l'éditeur est affiché : rien n'est demandé quand l'écran est masqué.
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    if (pinned || box.closest('[hidden]')) return; // essai en cours ou résultat affiché ; ou écran quitté
    api(url)
      .then((src) => {
        const line = box.querySelector('[data-role="connection"]');
        if (!line || pinned) return;
        const c = connectionText(src);
        setStatus(line, c.kind, c.text);
      })
      .catch(() => {});
  }, 10_000);
  return box;
}
