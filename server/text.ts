/**
 * Noms saisis (equipement, zone, etage). Ils finissent dans des e-mails, des messages Telegram, des journaux, des
 * terminaux et des rapports : forme Unicode unique (NFC), et jamais de caractere de controle (C0, C1), de separateur de
 * ligne ni de caractere de format invisible (bidi U+202E, largeur nulle U+200B...) qui ferait lire un nom pour un autre.
 */
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;

export const normalizeName = (value: string): string => value.normalize('NFC').trim();

export const hasForbiddenChar = (value: string): boolean => FORBIDDEN.test(value);
