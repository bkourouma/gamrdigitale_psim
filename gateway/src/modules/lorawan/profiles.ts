/**
 * Profils predefinis de capteurs LoRaWAN : DONNEES uniquement (aucun code dynamique).
 * Chaque profil est une liste de regles de traduction, au meme format que `mapping` dans la configuration.
 *
 * ATTENTION : les noms de champs viennent des codecs publies par les fabricants, relus de memoire ; aucun n'a
 * ete verifie avec un capteur reel. `fiabilite: 'probable'` = nom de champ vraisemblable, a controler ;
 * `fiabilite: 'a_qualifier'` = incertain, a qualifier avec le capteur reel avant mise en service.
 * Dans les deux cas, un installateur corrige un nom de champ SANS code via `overrides` (voir la documentation).
 */

export type Fiabilite = 'probable' | 'a_qualifier';

export interface ProfileDef {
  label: string;
  fiabilite: Fiabilite;
  /** Champs du codec ChirpStack attendus (pour la documentation et les messages d'erreur). */
  champs: string;
  mapping: Record<string, unknown>[];
}

export const PROFILES: Readonly<Record<string, ProfileDef>> = {
  // Temperature / humidite
  'dragino-lht65': {
    label: 'Dragino LHT65 (temperature)',
    fiabilite: 'probable',
    champs: 'object.TempC_SHT (degres C), object.BatV (volts)',
    mapping: [
      { key: 'temperature', from: 'object.TempC_SHT', type: 'number', emit: { value: true }, deadband: 0.5, minIntervalS: 60 },
      { key: 'batterie', from: 'object.BatV', type: 'battery', unit: 'volt', threshold: 2.6 },
    ],
  },
  'milesight-th': {
    label: 'Milesight temperature/humidite (famille EM300-TH, AM103...)',
    fiabilite: 'probable',
    champs: 'object.temperature (degres C), object.battery (pourcent)',
    mapping: [
      { key: 'temperature', from: 'object.temperature', type: 'number', emit: { value: true }, deadband: 0.5, minIntervalS: 60 },
      { key: 'batterie', from: 'object.battery', type: 'battery', unit: 'percent' },
    ],
  },

  // Contacts de porte : ouverture = intrusion (masquee par le PSIM si la zone est desarmee), fermeture = retour normal
  'milesight-ws301': {
    label: 'Milesight WS301 (contact de porte)',
    fiabilite: 'a_qualifier',
    champs: 'object.door ("open" / "close"), object.battery (pourcent)',
    mapping: [
      { key: 'porte', from: 'object.door', type: 'enum', map: { open: { event: 'intrusion' }, close: { event: 'door_closed' } } },
      { key: 'batterie', from: 'object.battery', type: 'battery', unit: 'percent' },
    ],
  },
  'dragino-lds03a': {
    label: 'Dragino LDS03A (contact de porte)',
    fiabilite: 'probable',
    champs: 'object.DOOR_OPEN_STATUS (1 = ouvert, 0 = ferme), object.BAT_V (volts)',
    mapping: [
      { key: 'porte', from: 'object.DOOR_OPEN_STATUS', type: 'bool', equals: true, emit: { event: 'intrusion' }, emitElse: { event: 'door_closed' } },
      { key: 'batterie', from: 'object.BAT_V', type: 'battery', unit: 'volt', threshold: 2.4 },
    ],
  },

  // Fuite d'eau
  'dragino-lwl03a': {
    label: "Dragino LWL03A (fuite d'eau)",
    fiabilite: 'probable',
    champs: 'object.WATER_LEAK_STATUS (1 = fuite, 0 = sec), object.BAT_V (volts)',
    mapping: [
      { key: 'fuite', from: 'object.WATER_LEAK_STATUS', type: 'bool', equals: true, emit: { event: 'leak' }, emitElse: { event: 'dry' } },
      { key: 'batterie', from: 'object.BAT_V', type: 'battery', unit: 'volt', threshold: 2.4 },
    ],
  },

  // Niveau de cuve par ultrasons : la hauteur de cuve (emptyAt) DOIT etre fournie dans `overrides.niveau.emptyAt`
  'dragino-ldds75': {
    label: 'Dragino LDDS75 / LDDS45 (niveau de cuve ultrason)',
    fiabilite: 'a_qualifier',
    champs: 'object.Distance (distance capteur-liquide, souvent texte « 430 mm »), object.Bat (volts)',
    mapping: [
      { key: 'niveau', from: 'object.Distance', type: 'level', fullAt: 0, deadband: 2, minIntervalS: 300 },
      { key: 'batterie', from: 'object.Bat', type: 'battery', unit: 'volt', threshold: 3.0 },
    ],
  },

  // Detecteur de mouvement PIR
  'milesight-ws202': {
    label: 'Milesight WS202 (detecteur de mouvement PIR)',
    fiabilite: 'probable',
    champs: 'object.pir ("trigger" / "normal"), object.battery (pourcent)',
    mapping: [
      { key: 'mouvement', from: 'object.pir', type: 'enum', map: { trigger: { event: 'motion' }, normal: { event: 'clear' } } },
      { key: 'batterie', from: 'object.battery', type: 'battery', unit: 'percent' },
    ],
  },

  // Boutons panique / SOS : chaque appui est un evenement (repeat)
  'milesight-ws101': {
    label: 'Milesight WS101 (bouton, appui long = panique)',
    fiabilite: 'a_qualifier',
    champs: 'object.press ("short" / "long" / "double"), object.battery (pourcent)',
    mapping: [
      { key: 'bouton', from: 'object.press', type: 'enum', map: { long: { event: 'panic' } }, repeat: true },
      { key: 'batterie', from: 'object.battery', type: 'battery', unit: 'percent' },
    ],
  },
  'bouton-sos': {
    label: 'Bouton panique / SOS generique',
    fiabilite: 'a_qualifier',
    champs: 'object.alarm (booleen ou 0/1) ; a adapter au codec du bouton reel via overrides',
    mapping: [
      { key: 'bouton', from: 'object.alarm', type: 'bool', equals: true, emit: { event: 'panic' }, repeat: true },
      { key: 'batterie', from: 'object.battery', type: 'battery', unit: 'percent' },
    ],
  },
};
