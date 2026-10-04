/**
 * Source d'un detecteur d'intrusion : la detection d'un enregistreur ou d'une camera Dahua (une voie). Le PSIM lit les
 * evenements de l'appareil avec les identifiants deja enregistres pour la camera choisie ; un essai de 20 s montre ce que
 * l'appareil emet vraiment (voie, nom de l'evenement), avant d'enregistrer.
 */

/** Types d'evenements proposes -> codes Dahua. */
const KINDS = {
  human: { label: 'Humain (SMD)', codes: ['SmartMotionHuman'] },
  human_vehicle: { label: 'Humain ou véhicule (SMD)', codes: ['SmartMotionHuman', 'SmartMotionVehicle'] },
  motion: { label: 'Tout mouvement (détection de mouvement)', codes: ['VideoMotion'] },
  ivs: { label: 'Franchissement de ligne ou de zone (IVS)', codes: ['CrossLineDetection', 'CrossRegionDetection'] },
};

/** Type propose correspondant exactement aux codes enregistres, ou null (reglage fait autrement : garde tel quel). */
const kindOf = (codes) => Object.entries(KINDS).find(([, k]) => k.codes.length === codes.length && k.codes.every((c) => codes.includes(c)))?.[0] ?? null;
const time = (ts) => new Date(ts).toLocaleTimeString('fr-FR');

export function buildDetectorSource(d, { api, h, toast, cameras }) {
  const box = h('div', { class: 'source-box' }, h('p', { class: 'small muted', text: 'Chargement de la source…' }));
  if (d.category !== 'intrusion') {
    box.replaceChildren(h('p', { class: 'small muted', text: "Source « détection d'un enregistreur Dahua » : réservée aux détecteurs d'intrusion (catégorie Intrusion), pour profiter de l'armement et du planning de nuit." }));
    return box;
  }
  const url = `/api/detectors/${encodeURIComponent(d.id)}/source`;
  // Resultat d'un essai affiche : le rafraichissement de l'etat ne l'efface pas (surtout un echec, ou « aucun evenement »).
  let pinned = false;
  const load = () =>
    api(url)
      .then(render)
      .catch((err) => box.replaceChildren(h('p', { class: 'error', text: err.message })));

  function statusText(src) {
    if (!src) return { text: 'Aucune source : ce détecteur attend ses messages par MQTT ou HTTP.', kind: 'muted' };
    const c = src.connection;
    const last = c.lastEvent ? ` Dernier événement : ${c.lastEvent.code} ${c.lastEvent.action} à ${time(c.lastEvent.at)}.` : '';
    if (c.state === 'connected') return { text: `Connecté à l'appareil depuis ${time(c.since)}.${last}`, kind: 'ok' };
    if (c.state === 'connecting') return { text: 'Connexion à l’appareil en cours…', kind: 'muted' };
    return { text: `Pas de connexion : ${c.error ?? 'raison inconnue'}. Le détecteur passera « hors ligne » si cela dure.${last}`, kind: 'error' };
  }

  function render(src) {
    pinned = false;
    const real = cameras().filter((c) => c.streamKind === 'rtsp' || c.streamKind === 'onvif');
    if (!real.length && !src) {
      box.replaceChildren(h('p', { class: 'small muted', text: "Source Dahua : il faut d'abord une caméra avec une source vidéo réelle (RTSP ou ONVIF) et ses identifiants." }));
      return;
    }
    const camera = h('select', {}, ...real.map((c) => h('option', { value: c.id, text: `${c.id} ${c.name}` })));
    if (src) camera.value = src.cameraId;
    const channel = h('input', { type: 'number', min: '1', max: '128', required: '', class: 'narrow', value: src ? String(src.channel) : '' });
    // Un reglage enregistre hors des types proposes est montre et garde tel quel (jamais remplace sans le voir).
    const current = src && !kindOf(src.events) ? h('option', { value: 'current', text: `Réglage actuel : ${src.events.join(' + ')}` }) : null;
    const kind = h('select', {}, ...Object.entries(KINDS).map(([id, k]) => h('option', { value: id, text: k.label })), ...(current ? [current] : []));
    kind.value = src ? (kindOf(src.events) ?? 'current') : 'human';
    const codesOf = () => (kind.value === 'current' ? src.events : KINDS[kind.value].codes);
    const port = h('input', { type: 'number', min: '1', max: '65535', class: 'narrow', value: String(src?.httpPort ?? 80) });
    const hint = h('p', { class: 'small warn', text: "Voie introuvable dans l'adresse de la caméra : lancez l'essai, la voie de chaque événement s'affiche." });
    hint.hidden = true;
    const warning = h('p', { class: 'small warn' });
    warning.hidden = true;
    const status = statusText(src);
    const line = h('p', { class: `small ${status.kind}`, role: 'status', text: status.text });
    const results = h('ul', { class: 'source-events' });
    results.hidden = true;

    const channelOk = () => /^\d+$/.test(channel.value) && Number(channel.value) >= 1 && Number(channel.value) <= 128;
    const syncChannel = () => {
      save.disabled = !channelOk();
      if (channelOk()) hint.hidden = true;
    };
    // La voie se deduit du chemin RTSP de la camera (« channel=3 ») : proposee, modifiable. Sinon, on dit comment la trouver.
    const guessChannel = () =>
      api(`/api/cameras/${encodeURIComponent(camera.value)}/source`)
        .then((s) => {
          const m = /channel=(\d+)/.exec(s.rtspPath ?? '');
          if (m && !channel.value) channel.value = m[1];
        })
        .catch(() => {})
        .finally(() => {
          hint.hidden = channelOk();
          syncChannel();
        });
    camera.addEventListener('change', () => {
      channel.value = '';
      guessChannel();
    });
    channel.addEventListener('input', syncChannel);

    const save = h('button', {
      class: 'btn small primary',
      type: 'button',
      text: 'Enregistrer la source',
      onclick: () =>
        api(url, { method: 'PUT', body: { cameraId: camera.value, channel: Number(channel.value), events: codesOf(), httpPort: Number(port.value) } })
          .then((s) => {
            toast('Source enregistrée : le PSIM écoute l’appareil', 'ok');
            render(s);
          })
          .catch((e) => toast(e.message)),
    });
    const test = h('button', {
      class: 'btn small',
      type: 'button',
      text: 'Tester (20 s)',
      onclick: async () => {
        pinned = true;
        test.disabled = true;
        warning.hidden = true;
        line.className = 'small muted';
        line.textContent = 'Écoute de l’appareil pendant 20 s : passez devant la caméra…';
        try {
          const r = await api(`/api/cameras/${encodeURIComponent(camera.value)}/events-test`, { method: 'POST', body: { httpPort: Number(port.value) } });
          line.className = `small ${r.ok ? 'ok' : 'error'}`;
          line.textContent = r.message;
          // En vert : seulement ce qui declenchera CE detecteur (bonne voie ET type d'evenement suivi).
          const wanted = channelOk() ? Number(channel.value) : null;
          const codes = codesOf();
          const fires = (e) => e.channel === wanted && codes.includes(e.code);
          results.hidden = r.events.length === 0;
          results.replaceChildren(
            ...r.events.map((e) =>
              h('li', {
                class: fires(e) ? 'ok' : 'muted',
                text: `${time(e.at)}  voie ${e.channel}  ${e.code}  ${e.action}${fires(e) ? '  <- déclenchera ce détecteur' : e.channel === wanted ? "  (bonne voie, autre type d'événement)" : ''}`,
              }),
            ),
          );
          if (r.ok && !r.events.some(fires)) {
            warning.hidden = false;
            warning.textContent =
              wanted === null
                ? "Voie à choisir : reprenez la voie d'un événement ci-dessus, puis enregistrez."
                : `Aucun événement « ${kind.selectedOptions[0]?.text ?? ''} » sur la voie ${wanted} pendant l'essai : vérifiez la voie et le type, passez devant la caméra, puis relancez.`;
          }
        } catch (e) {
          line.className = 'small error';
          line.textContent = e.message;
        } finally {
          test.disabled = false;
        }
      },
    });
    const remove = src
      ? h('button', {
          class: 'btn small danger',
          type: 'button',
          text: 'Retirer la source',
          onclick: () =>
            confirm(`Ne plus écouter l'appareil pour ${d.id} ?`) &&
            api(url, { method: 'DELETE' })
              .then(() => load())
              .catch((e) => toast(e.message)),
        })
      : null;

    syncChannel();
    if (!src && camera.value) guessChannel();

    box.replaceChildren(
      h('p', { class: 'small muted', text: "Source : détection d'un enregistreur ou d'une caméra Dahua (mêmes identifiants que la caméra). L'armement de la zone (planning de nuit) s'applique." }),
      h(
        'div',
        { class: 'row wrap' },
        h('label', { class: 'row small' }, 'caméra', camera),
        h('label', { class: 'row small' }, 'voie', channel),
        h('label', { class: 'row small' }, 'événement', kind),
        h('label', { class: 'row small' }, 'port HTTP', port),
      ),
      hint,
      h('div', { class: 'row wrap' }, save, test, remove),
      line,
      results,
      warning,
    );
  }

  load();
  // Etat de la connexion rafraichi tant que l'editeur est affiche.
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    if (pinned) return; // un essai est en cours ou son resultat est affiche : on le laisse lire
    api(url)
      .then((src) => {
        const line = box.querySelector('[role="status"]');
        if (!line) return;
        const status = statusText(src);
        line.className = `small ${status.kind}`;
        line.textContent = status.text;
      })
      .catch(() => {});
  }, 10_000);
  return box;
}
