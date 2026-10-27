// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and mode names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Dantherm / Pluggit ventilation', 'Ventilation Dantherm / Pluggit');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Ventilation mode', 'Mode de ventilation'),
  [FEATURES.CURRENT_MODE]: both('Current mode', 'Mode en cours'),
  [FEATURES.FAN_LEVEL]: both('Fan level (0-4)', 'Niveau de ventilation (0-4)'),
  [FEATURES.ALARM]: both('Alarm', 'Alarme'),
  [FEATURES.ALARM_ACTIVE]: both('Alarm active', 'Alarme active'),
  [FEATURES.BYPASS]: both('Bypass damper', 'Volet de bypass'),
  [FEATURES.TEMP_OUTDOOR]: both(
    'Outdoor air temperature (T1)',
    'Température de l’air extérieur (T1)',
  ),
  [FEATURES.TEMP_SUPPLY]: both('Supply air temperature (T2)', 'Température de l’air soufflé (T2)'),
  [FEATURES.TEMP_EXTRACT]: both(
    'Extract air temperature (T3)',
    'Température de l’air extrait (T3)',
  ),
  [FEATURES.TEMP_EXHAUST]: both('Exhaust air temperature (T4)', 'Température de l’air rejeté (T4)'),
  [FEATURES.TEMP_ROOM]: both('Room temperature (T5)', 'Température ambiante (T5)'),
  [FEATURES.HUMIDITY]: both('Humidity', 'Humidité'),
  [FEATURES.AIR_QUALITY]: both(
    'Air quality (VOC, CO2 equivalent)',
    'Qualité de l’air (COV, équivalent CO2)',
  ),
  [FEATURES.FILTER_DAYS]: both('Filter: days left', 'Filtres : jours restants'),
  [FEATURES.STOP]: both('Stop the ventilation', 'Arrêter la ventilation'),
  [FEATURES.FILTER_RESET]: both(
    'Reset the filter timer',
    'Remettre à zéro le compteur des filtres',
  ),
};

/** The choices of the mode select. */
export const MODE_NAMES = {
  automatic: both('Automatic (demand)', 'Automatique (à la demande)'),
  'week-program': both('Week program', 'Programme hebdomadaire'),
  'manual-1': both('Manual, level 1', 'Manuel, niveau 1'),
  'manual-2': both('Manual, level 2', 'Manuel, niveau 2'),
  'manual-3': both('Manual, level 3', 'Manuel, niveau 3'),
  'manual-4': both('Manual, level 4', 'Manuel, niveau 4'),
};

/** The current modes (register 472), for the status. */
export const CURRENT_MODE_NAMES = {
  standby: both('stopped (stand-by)', 'arrêtée (veille)'),
  manual: both('manual', 'manuel'),
  demand: both('automatic (demand)', 'automatique (à la demande)'),
  'week-program': both('week program', 'programme hebdomadaire'),
  'servo-flow': both('servo-flow', 'servo-flow'),
  away: both('away', 'absence'),
  summer: both('summer', 'été'),
  'di-override': both('external input override', 'forçage par entrée externe'),
  'hygrostat-override': both('hygrostat override', 'forçage par l’hygrostat'),
  fireplace: both('fireplace', 'cheminée'),
  installer: both('installer', 'installateur'),
  'fail-safe-1': both('fail-safe 1', 'sécurité 1'),
  'fail-safe-2': both('fail-safe 2', 'sécurité 2'),
  'fail-off': both('fail off', 'arrêt sur défaut'),
  'defrost-off': both('defrost off', 'arrêt pour dégivrage'),
  defrost: both('defrost', 'dégivrage'),
  night: both('night', 'nuit'),
};

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Dantherm or Pluggit unit (Modbus TCP), then save.',
    'Saisissez l’adresse IP de votre centrale Dantherm ou Pluggit (Modbus TCP), puis enregistrez.',
  ),
  invalid: (length) =>
    both(
      `Invalid address (${length} characters): an IPv4 address or a host name, optionally with a port.`,
      `Adresse invalide (${length} caractères) : une adresse IPv4 ou un nom d’hôte, avec un port si besoin.`,
    ),
  badUnitId: both(
    'Invalid Modbus unit id: a whole number from 1 to 247 (1 unless changed). Nothing is read.',
    'Identifiant d’unité Modbus invalide : un nombre entier de 1 à 247 (1 sauf changement). Rien n’est lu.',
  ),
  configFailed: (wait) =>
    both(
      `The configuration could not be read from Gladys; next try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  storeUnreadable: both(
    'The state file in /data cannot be read: it is never written over; the mode and the filter reset are refused until it is fixed (the stop is not).',
    'Le fichier d’état dans /data est illisible : il n’est jamais écrasé ; le mode et la remise à zéro des filtres sont refusés tant qu’il n’est pas réparé (pas l’arrêt).',
  ),
  otherUnit: both(
    'Connected, but the serial number of the unit changed: another device may answer at this address. Its values are not shown and the mode and filter reset are refused (not the stop). If it is your unit (after a replacement), press "Test the connection" to accept it.',
    'Connecté, mais le numéro de série de la centrale a changé : un autre appareil répond peut-être à cette adresse. Ses valeurs ne sont pas affichées et le mode et la remise à zéro des filtres sont refusés (pas l’arrêt). Si c’est bien votre centrale (après un remplacement), appuyez sur « Tester la connexion » pour l’accepter.',
  ),
  accepted: both(
    'Unit accepted with its new serial number: its values are shown again.',
    'Centrale acceptée avec son nouveau numéro de série : ses valeurs sont de nouveau affichées.',
  ),
  connecting: both('Reading the unit…', 'Lecture de la centrale…'),
  waiting: (wait) =>
    both(
      `Next read of the unit in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la centrale dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address, that Modbus TCP is enabled on the unit, and the Modbus unit id.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse, que le Modbus TCP est activé sur la centrale, et l’identifiant d’unité Modbus.`,
    ),
  failing: (reason, wait) =>
    both(
      `The unit answered badly (${reason}); next try in ${wait.en}.`,
      `La centrale a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  stopFailing: both(
    ' The last stop is not confirmed: the next reads send it again.',
    ' Le dernier arrêt n’est pas confirmé : les prochaines lectures le renvoient.',
  ),
  stopLifted: both(
    ' The unit was restarted outside Gladys after a stop (read twice running).',
    ' La centrale a été relancée hors de Gladys après un arrêt (lue deux fois en marche).',
  ),
  summary: (values) => {
    const mode = CURRENT_MODE_NAMES[values.currentMode] ?? both('unknown mode', 'mode inconnu');
    const level = Number.isInteger(values.fanLevel)
      ? both(`, level ${values.fanLevel}`, `, niveau ${values.fanLevel}`)
      : both('', '');
    const alarm =
      values.alarm && values.alarm !== 'none'
        ? both(`, ALARM ${values.alarm}`, `, ALARME ${values.alarm}`)
        : both('', '');
    const fw = values.firmware
      ? both(`, firmware ${values.firmware}`, `, firmware ${values.firmware}`)
      : both('', '');
    const type = Number.isInteger(values.unitType)
      ? both(` (unit type ${values.unitType}${fw.en})`, ` (type ${values.unitType}${fw.fr})`)
      : both('', '');
    return both(
      `Unit${type.en}: ${mode.en}${level.en}${alarm.en}.`,
      `Centrale${type.fr} : ${mode.fr}${level.fr}${alarm.fr}.`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  badButton: both('A button only takes 1: not sent.', 'Un bouton ne prend que 1 : non envoyé.'),
  disabled: both(
    'The mode commands are disabled: turn on "Allow the mode commands" in the configuration of the integration.',
    'Les commandes de mode sont désactivées : activez « Autoriser les commandes de mode » dans la configuration de l’intégration.',
  ),
  filterDisabled: both(
    'The filter reset is disabled: turn on "Allow the filter reset" in the configuration of the integration.',
    'La remise à zéro des filtres est désactivée : activez « Autoriser la remise à zéro des filtres » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address or Modbus unit id in the configuration: not sent.',
    'Aucune adresse ou identifiant d’unité Modbus valide dans la configuration : non envoyée.',
  ),
  specialMode: (mode) =>
    both(
      `The unit is in a mode Gladys does not change (${mode.en}): change it on the unit or in its app. Not sent.`,
      `La centrale est dans un mode que Gladys ne change pas (${mode.fr}) : changez-le sur la centrale ou dans son application. Non envoyée.`,
    ),
  fireAlarm: both(
    'The unit is in fire alarm: no command that moves air is sent. Not sent.',
    'La centrale est en alarme incendie : aucune commande qui fait circuler l’air n’est envoyée. Non envoyée.',
  ),
  otherUnit: both(
    'The serial number of the unit changed: another device may answer at this address. Press "Test the connection" to accept it. Not sent.',
    'Le numéro de série de la centrale a changé : un autre appareil répond peut-être à cette adresse. Appuyez sur « Tester la connexion » pour l’accepter. Non envoyée.',
  ),
  noIdentity: both(
    'The serial number of the unit could not be read just before: not sent.',
    'Le numéro de série de la centrale n’a pas pu être relu juste avant : non envoyée.',
  ),
  storeUnreadable: both(
    'The state file in /data cannot be read: not sent (the stop still works).',
    'Le fichier d’état dans /data est illisible : non envoyée (l’arrêt fonctionne toujours).',
  ),
  saveFailed: both(
    'The state could not be written to /data: not sent.',
    'L’état n’a pas pu être écrit dans /data : non envoyée.',
  ),
  unreadable: both('unreadable', 'illisible'),
  stopPending: both(
    'Stop not sent yet, still trying to reach the unit: check the ventilation in a few seconds.',
    'Arrêt pas encore envoyé, la centrale est encore en cours de connexion : vérifiez la ventilation dans quelques secondes.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    'Another command to the unit is still running: not sent.',
    'Une autre commande vers la centrale est encore en cours : non envoyée.',
  ),
  stopMeanwhile: both(
    'The ventilation was stopped meanwhile: not sent.',
    'La ventilation a été arrêtée entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The unit answered too slowly to send the command in time: not sent.',
    'La centrale a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the unit could not be read just before (${reason}): command not sent.`,
      `L’état de la centrale n’a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The unit refused the command (${reason}): not applied.`,
      `La centrale a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The unit could not be reached (${reason}): command not sent.`,
      `La centrale n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the unit in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état de la centrale dans quelques secondes.`,
    ),
  notYet: both('not applied yet', 'pas encore appliquée'),
  stillRunning: both('still running', 'toujours en marche'),
  noAnswerYet: both('no answer yet', 'pas encore de réponse'),
};
