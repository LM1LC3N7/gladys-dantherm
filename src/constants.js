// -----------------------------------------------------------------------------
// Dantherm / Pluggit constants: the Modbus TCP map of the controller, manifest
// keys, feature roles, limits and timings.
//
// Dantherm HCV/RCV/HCH and Pluggit AP/iFlow units share one controller (the
// Pluggit "MPCB"), which answers Modbus TCP on port 502 without
// authentication, three sockets at most, closing a socket idle for a minute.
// The register map is the manufacturer's ("Pluggit Controller, Modbus
// Registers Table", document version 6b, 2013-10-21: 4xxxx addresses), as the
// Dantherm and Pluggit Home Assistant integrations (Tvalley71, Apache-2.0,
// 1.4.0) read and write it on current firmwares (2.70 and 3.08 or later):
// protocol address = document address - 40001.
//
// Every parameter is 32 bits in two consecutive registers, the LOW word first
// (lower address); a parameter is always written whole, both registers in one
// request (the document: two separate requests are not applied). Only these
// requests are ever sent:
//   - read holding registers (0x03) of the blocks below;
//   - write multiple registers (0x10), two registers, to:
//       168 (prmRamIdxUnitMode: 0x0002 automatic, 0x0004 manual, 0x0008 week
//           program, 0x8010 / 0x8800 / 0x8040 end of away / summer /
//           fireplace),
//       324 (prmRomIdxSpeedLevel: the manual fan level, 0-4; 0 is the stop),
//       558 (prmFilterReset: 1).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_HOLDING: 0x03,
  WRITE_MULTIPLE: 0x10,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/** Registers written (protocol addresses). */
export const REGISTERS = {
  ACTIVE_MODE: 168,
  FAN_LEVEL: 324,
  FILTER_RESET: 558,
};

/**
 * The blocks read at each poll, in this order (the state of the unit first).
 * Each block covers whole parameters of the manufacturer's table, never an
 * address the table does not list. `state`: the unit's state (mode, level,
 * identity), never skipped.
 */
export const BLOCKS = [
  { key: 'identity', address: 2, count: 6, state: true }, // prmSystemID, prmSystemSerialNum (64 bits)
  { key: 'currentMode', address: 472, count: 2, state: true }, // prmCurrentBLState
  { key: 'activeMode', address: 168, count: 2, state: true }, // prmRamIdxUnitMode
  { key: 'fanLevel', address: 324, count: 2, state: true }, // prmRomIdxSpeedLevel
  { key: 'alarm', address: 516, count: 2, state: true }, // prmLastActiveAlarm
  { key: 'firmware', address: 24, count: 2 }, // prmFWVersion
  { key: 'temperatures', address: 132, count: 10 }, // prmRamIdxT1..T5 (float)
  { key: 'climate', address: 196, count: 4 }, // prmRamIdxRh3Corrected, prmRamIdxBypassActualState
  { key: 'voc', address: 430, count: 2 }, // prmVOC
  { key: 'filter', address: 554, count: 2 }, // prmFilterRemainingTime (days)
];

export const BLOCK_OF = Object.fromEntries(BLOCKS.map((b) => [b.key, b]));

/** The block that holds each value a command reads. */
export const VALUE_BLOCK = {
  serial: 'identity',
  currentMode: 'currentMode',
  activeMode: 'activeMode',
  fanLevel: 'fanLevel',
  alarm: 'alarm',
  filterDays: 'filter',
};

/** prmCurrentBLState (register 472), stable keys whatever the language. */
export const CURRENT_MODES = [
  'standby',
  'manual',
  'demand',
  'week-program',
  'servo-flow',
  'away',
  'summer',
  'di-override',
  'hygrostat-override',
  'fireplace',
  'installer',
  'fail-safe-1',
  'fail-safe-2',
  'fail-off',
  'defrost-off',
  'defrost',
  'night',
];

/**
 * The current modes in which Gladys may change the mode: the unit stopped or
 * in one of the modes the select sets. Any other (away, summer, fireplace,
 * night, an override, a fail-safe, defrost, installer) belongs to the unit or
 * its own app: the mode command is refused there.
 */
export const MODE_CHANGE_FROM = new Set([
  'standby',
  'manual',
  'demand',
  'week-program',
  'servo-flow',
]);

/** prmLastActiveAlarm (register 516): 0 none, then the highest active alarm. */
export const ALARMS = [
  'none',
  'exhaust-fan',
  'supply-fan',
  'bypass',
  't1-sensor',
  't2-sensor',
  't3-sensor',
  't4-sensor',
  't5-sensor',
  'humidity-sensor',
  'outdoor-below-13',
  'supply-below-5',
  'fire',
  'communication',
  'fire-thermostat',
  'voc-sensor',
];

/** Alarms in which no command that moves air is sent (the unit handles them). */
export const FIRE_ALARMS = new Set(['fire', 'fire-thermostat']);

/** prmRamIdxBypassActualState (register 198). */
export const BYPASS_STATES = new Map([
  [0x00, 'closed'],
  [0x01, 'in-progress'],
  [0x20, 'closing'],
  [0x40, 'opening'],
  [0xff, 'opened'],
]);

/** The special modes the stop ends first (current mode -> value written to register 168). */
export const END_SPECIAL = {
  away: 0x8010,
  summer: 0x8800,
  fireplace: 0x8040,
};

/** Installed components (prmSystemID, low 16 bits): the room sensor T5 comes with HRC2. */
export const COMPONENT_HRC2 = 0x0400;

/**
 * Modbus exception codes that mean the request was not applied (illegal
 * function, address, value). Any other code (4 device failure, 5 acknowledge,
 * 6 busy…) may come from a write the unit applies anyway: "sent, without
 * confirmation".
 */
export const NOT_APPLIED_EXCEPTIONS = new Set([1, 2, 3]);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'mode',
  CURRENT_MODE: 'current-mode',
  FAN_LEVEL: 'fan-level',
  ALARM: 'alarm',
  ALARM_ACTIVE: 'alarm-active',
  BYPASS: 'bypass',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_SUPPLY: 'temperature-supply',
  TEMP_EXTRACT: 'temperature-extract',
  TEMP_EXHAUST: 'temperature-exhaust',
  TEMP_ROOM: 'temperature-room',
  HUMIDITY: 'humidity',
  AIR_QUALITY: 'air-quality',
  FILTER_DAYS: 'filter-days-left',
  STOP: 'stop',
  FILTER_RESET: 'filter-reset',
};

/** The choices of the mode select, in display order. */
export const MODES = ['automatic', 'week-program', 'manual-1', 'manual-2', 'manual-3', 'manual-4'];

/**
 * What each choice writes (register, value), in this order, and the values
 * read back that confirm it.
 */
export const MODE_WRITES = {
  automatic: { writes: [[REGISTERS.ACTIVE_MODE, 0x0002]], expect: { currentMode: 'demand' } },
  'week-program': {
    writes: [[REGISTERS.ACTIVE_MODE, 0x0008]],
    expect: { currentMode: 'week-program' },
  },
  ...Object.fromEntries(
    [1, 2, 3, 4].map((level) => [
      `manual-${level}`,
      {
        writes: [
          [REGISTERS.ACTIVE_MODE, 0x0004],
          [REGISTERS.FAN_LEVEL, level],
        ],
        expect: { currentMode: 'manual', fanLevel: level },
      },
    ]),
  ),
};

/** The stop: manual mode, fan level 0 (the Home Assistant integration's stand-by). */
export const STOP_WRITES = [
  [REGISTERS.ACTIVE_MODE, 0x0004],
  [REGISTERS.FAN_LEVEL, 0],
];

/**
 * The commands, by feature role. `option`: the configuration key that allows
 * it (off by default). `protective`: never held back (the stop).
 */
export const COMMANDS = {
  [FEATURES.MODE]: { kind: 'mode', option: 'allowCommands' },
  [FEATURES.FILTER_RESET]: { kind: 'filter-reset', option: 'allowFilterReset', button: true },
  [FEATURES.STOP]: { kind: 'stop', protective: true, button: true },
};

/** The value of a button press (Gladys sends 1). */
export const PRESSED = 1;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 30,
  max: 3600,
  default: 60,
};

/** The Modbus unit id (slave id) of the configuration. */
export const UNIT_ID = {
  min: 1,
  max: 247,
  default: 1,
};

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** A measure block that times out this many reads in a row (the unit answering others) is skipped. */
  blockTimeouts: 3,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused or dropped connection of a stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** A measure block skipped after repeated timeouts or refusals is tried again this often. */
  blockRetry: HOUR,
  /** A stop reaffirmed by a read leaves at least this long after the read closed the line. */
  reassertDelay: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The configuration read from Gladys at `connected`: 5 s, doubled, up to 5 min, forever. */
  configRetry: [5 * SECOND, 5 * MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the connection, the fresh read
   * and the first write must be done by 3.5 s after the click, or the command
   * is refused unsent; the read back that confirms it is awaited until 4.3 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Connecting for a command: 2 s at most. */
  commandConnectMax: 2_000,
  /** The fresh reads of a command: 0.3 s at least left to send after them. */
  commandMinRead: 300,
  commandMinSend: 300,
  /** The stop reads the current mode first (to end away, summer, fireplace): 0.6 s at most. */
  stopReadMax: 600,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /**
   * A stop: the reads of the next 2 minutes send it again when the unit reads
   * running (a write of an older command may still land); three times at
   * most per stop.
   */
  stopReassertWindow: 2 * MINUTE,
  stopReasserts: 3,
};
