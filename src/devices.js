// -----------------------------------------------------------------------------
// The unit -> one Gladys device and its states (pure).
//
// `ext:<selector>:dantherm:unit`: one device per integration. FROZEN RULE: the
// device is keyed by the unit of the configuration, never by its IP address
// nor its serial (a new address keeps the device and its history; the serial
// is only a check, kept salted in /data). The feature roles (the last part of
// their external ids) are published forever: never rename them. Every role
// is always built, so a republished device never loses a feature.
//
// No switch, no writable binary, no writable fan: a "turn everything off"
// (Google Home, Alexa, HomeKit, MCP, `switch.*` scenes) never reaches the
// ventilation. The commands are one `text/select` (the mode) and
// `button/push` features (stop, filter reset): the mode and the filter reset
// are refused unless their option allows them; the stop never depends on an
// option (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor, % on
// humidity-sensor, ppm on co2-sensor (the VOC sensor gives a CO2 equivalent
// in ppm, as the Home Assistant integration shows it), days on duration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { ALARMS, BYPASS_STATES, COMMANDS, CURRENT_MODES, FEATURES, MODES } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

export const SERVICE = 'dantherm';
export const PLATFORM_ID = 'unit';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -60,
  max: 90,
});
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.MODE]: select,
  [FEATURES.CURRENT_MODE]: text,
  [FEATURES.FAN_LEVEL]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 4 }),
  [FEATURES.ALARM]: text,
  [FEATURES.ALARM_ACTIVE]: binary,
  [FEATURES.BYPASS]: text,
  [FEATURES.TEMP_OUTDOOR]: temperature,
  [FEATURES.TEMP_SUPPLY]: temperature,
  [FEATURES.TEMP_EXTRACT]: temperature,
  [FEATURES.TEMP_EXHAUST]: temperature,
  [FEATURES.TEMP_ROOM]: temperature,
  [FEATURES.HUMIDITY]: sensor({
    category: C.HUMIDITY_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  }),
  [FEATURES.AIR_QUALITY]: sensor({
    category: C.CO2_SENSOR,
    type: T.SENSOR.INTEGER,
    unit: U.PPM,
    min: 0,
    max: 10_000,
  }),
  [FEATURES.FILTER_DAYS]: sensor({
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.DAYS,
    min: 0,
    max: 3650,
  }),
  [FEATURES.STOP]: button,
  [FEATURES.FILTER_RESET]: button,
};

export const ROLES = Object.keys(DEFINITIONS);

/** The value read for each numeric or binary sensor role. */
const VALUE_OF = {
  [FEATURES.FAN_LEVEL]: 'fanLevel',
  [FEATURES.TEMP_OUTDOOR]: 'outdoor',
  [FEATURES.TEMP_SUPPLY]: 'supply',
  [FEATURES.TEMP_EXTRACT]: 'extract',
  [FEATURES.TEMP_EXHAUST]: 'exhaust',
  [FEATURES.TEMP_ROOM]: 'room',
  [FEATURES.HUMIDITY]: 'humidity',
  [FEATURES.AIR_QUALITY]: 'airQuality',
  [FEATURES.FILTER_DAYS]: 'filterDays',
};

/** 0 is "no sensor" for these (the manufacturer's table, the Home Assistant integration). */
const NOT_ZERO = new Set([FEATURES.HUMIDITY, FEATURES.AIR_QUALITY]);

/** The texts read, with the keys each may take. */
const TEXT_OF = {
  [FEATURES.CURRENT_MODE]: ['currentMode', CURRENT_MODES],
  [FEATURES.ALARM]: ['alarm', ALARMS],
  [FEATURES.BYPASS]: ['bypass', [...BYPASS_STATES.values()]],
};

export const unitIds = (gladys) => gladys.externalIds(SERVICE, PLATFORM_ID);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:${SERVICE}:${PLATFORM_ID}:([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[1]) ? match[1] : undefined;
}

/** The choice of the select a read shows, or undefined (stopped, a special mode, unknown). */
export function modeOf(values) {
  switch (values.currentMode) {
    case 'demand':
      return 'automatic';
    case 'week-program':
      return 'week-program';
    case 'manual':
      return values.fanLevel >= 1 && values.fanLevel <= 4 ? `manual-${values.fanLevel}` : undefined;
    default:
      return undefined;
  }
}

/** The Gladys device of the unit. */
export function buildDevice(gladys, { language }) {
  const ids = unitIds(gladys);
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: 'Dantherm / Pluggit',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.MODE
        ? {
            supported_options: MODES.map((value, index) => ({
              value,
              label: word(MODE_NAMES[value], language),
              sort_order: index,
            })),
          }
        : {}),
    })),
    params: [{ name: 'protocol', value: 'Modbus TCP' }],
  };
}

/** Whether a role is a command, and which. */
export const commandOf = (role) => (Object.hasOwn(COMMANDS, role) ? COMMANDS[role] : undefined);

/**
 * The states of the values read this time (a value not read is left out:
 * Gladys keeps its last one, never republished as new). A value outside the
 * bounds of its feature is dropped. Texts are stable English keys, whatever
 * the language (scenes keep working), and never sent as a number.
 */
export function deviceStates(ids, values) {
  const states = [];
  // The list only shows its options: a stopped unit or a special mode does not change it.
  const mode = modeOf(values);
  if (mode !== undefined) {
    states.push({ device_feature_external_id: ids.feature(FEATURES.MODE), text: mode });
  }
  for (const [role, [key, allowed]] of Object.entries(TEXT_OF)) {
    if (typeof values[key] === 'string' && allowed.includes(values[key])) {
      states.push({ device_feature_external_id: ids.feature(role), text: values[key] });
    }
  }
  if (ALARMS.includes(values.alarm)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.ALARM_ACTIVE),
      state: values.alarm === 'none' ? 0 : 1,
    });
  }
  for (const [role, key] of Object.entries(VALUE_OF)) {
    const value = values[key];
    const { min, max } = DEFINITIONS[role];
    if (NOT_ZERO.has(role) && value === 0) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ device_feature_external_id: ids.feature(role), state: value });
    }
  }
  return states;
}
