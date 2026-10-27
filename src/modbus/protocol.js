// -----------------------------------------------------------------------------
// The Modbus PDUs of the Dantherm / Pluggit controller (pure): the read
// requests of the blocks, what their answers mean, and the write requests.
// Addresses and meanings from the manufacturer's table (see constants.js), as
// the Dantherm Home Assistant integration reads them: 32-bit parameters, low
// word first; floats IEEE 754 in the same word order. Every decoder returns
// undefined when the answer has not the exact size asked or the value is not
// plausible: an unknown value is never a value.
// -----------------------------------------------------------------------------

import { ALARMS, BYPASS_STATES, COMPONENT_HRC2, CURRENT_MODES, FC } from '../constants.js';

const round1 = (value) => Math.round(value * 10) / 10;

/** Temperatures out of these ranges are read errors (no sensor, a register not filled). */
const TEMPERATURE_RANGE = [-60, 90];
/** The room sensor (T5), as the Home Assistant integration bounds it. */
const ROOM_RANGE = [-40, 70];

/** The read request of a block (read holding registers). */
export function readRequest({ address, count }) {
  const pdu = Buffer.alloc(5);
  pdu[0] = FC.READ_HOLDING;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** The words (16-bit registers) of a read answer, or undefined when it is not exactly what was asked. */
export function parseRead({ count }, pdu) {
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== FC.READ_HOLDING) return undefined;
  const bytes = pdu[1];
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(pdu.readUInt16BE(2 + i * 2));
  }
  return words;
}

/** A 32-bit unsigned parameter from its two registers (low word first). */
export const uint32 = (low, high) =>
  Number.isInteger(low) && Number.isInteger(high) ? high * 0x10000 + low : undefined;

/** A 32-bit float parameter from its two registers (low word first); undefined if not finite. */
export function float32(low, high) {
  if (!Number.isInteger(low) || !Number.isInteger(high)) return undefined;
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(high, 0);
  buffer.writeUInt16BE(low, 2);
  const value = buffer.readFloatBE(0);
  return Number.isFinite(value) ? value : undefined;
}

const within = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

function temperature(low, high, [min, max] = TEMPERATURE_RANGE) {
  const value = float32(low, high);
  return value !== undefined && value >= min && value <= max ? round1(value) : undefined;
}

/**
 * The values a block gives (only those plausible). `words` are those of
 * `parseRead`.
 */
export function decodeBlock(block, words) {
  if (!Array.isArray(words) || words.length !== block.count) return {};
  const values = {};
  const put = (key, value) => {
    if (value !== undefined) values[key] = value;
  };
  const u32 = (i) => uint32(words[i], words[i + 1]);
  switch (block.key) {
    case 'identity': {
      // prmSystemID: installed components in the low 16 bits, the unit type
      // in the top byte (as the Home Assistant integration reads it).
      const system = u32(0);
      if (system !== undefined) {
        put('components', system & 0xffff);
        put('unitType', Math.floor(system / 0x1000000));
      }
      // prmSystemSerialNum, 64 bits, low word first. 0 (the default) is no serial.
      const serial =
        (BigInt(words[5]) << 48n) |
        (BigInt(words[4]) << 32n) |
        (BigInt(words[3]) << 16n) |
        BigInt(words[2]);
      if (serial !== 0n) put('serial', serial.toString());
      break;
    }
    case 'currentMode':
      put('currentMode', CURRENT_MODES[within(u32(0), 0, CURRENT_MODES.length - 1)]);
      break;
    case 'activeMode':
      put('activeMode', within(u32(0), 0, 0xffff));
      break;
    case 'fanLevel':
      put('fanLevel', within(u32(0), 0, 4));
      break;
    case 'alarm': {
      // Every code is shown: a code not in the list is an active alarm, never silence.
      const code = u32(0);
      if (code !== undefined) {
        put('alarmCode', code);
        put('alarm', ALARMS[code] ?? `unknown-${code}`);
      }
      break;
    }
    case 'firmware': {
      // Major in byte 1, minor in byte 0 (2.70 is 0x0246).
      const fw = within(u32(0), 1, 0xffff);
      if (fw !== undefined) put('firmware', `${fw >> 8}.${String(fw & 0xff).padStart(2, '0')}`);
      break;
    }
    case 'temperatures':
      put('outdoor', temperature(words[0], words[1]));
      put('supply', temperature(words[2], words[3]));
      put('extract', temperature(words[4], words[5]));
      put('exhaust', temperature(words[6], words[7]));
      // T5 only on a unit that has it (checked by the app with the components).
      put('room', temperature(words[8], words[9], ROOM_RANGE));
      break;
    case 'climate': {
      // 0 % is no sensor (as the Home Assistant integration reads it).
      put('humidity', within(u32(0), 1, 100));
      const bypass = u32(2);
      put('bypass', bypass === undefined ? undefined : BYPASS_STATES.get(bypass));
      break;
    }
    case 'voc':
      // 0 is "no VOC sensor installed" (the manufacturer's table).
      put('airQuality', within(u32(0), 1, 10_000));
      break;
    case 'filter':
      put('filterDays', within(u32(0), 0, 3650));
      break;
    default:
      break;
  }
  return values;
}

/** Whether the installed components list the room sensor T5. */
export const hasRoomSensor = (components) =>
  Number.isInteger(components) && (components & COMPONENT_HRC2) === COMPONENT_HRC2;

/**
 * The write request of one 32-bit parameter: write multiple registers
 * (0x10), two registers, low word first, in one request.
 */
export function writeRequest(address, value) {
  if (!Number.isInteger(address) || address < 0 || address > 0xfffe) {
    throw new RangeError('A register address is 0-65534');
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    // Every value written by this integration fits in the low word.
    throw new RangeError('A value written is 0-65535');
  }
  const pdu = Buffer.alloc(10);
  pdu[0] = FC.WRITE_MULTIPLE;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(2, 3);
  pdu[5] = 4;
  pdu.writeUInt16BE(value, 6);
  pdu.writeUInt16BE(0, 8);
  return pdu;
}

/** A write multiple is answered by the function, address and quantity of its request. */
export const isWriteAnswer = (request, answer) =>
  Buffer.isBuffer(answer) && answer.length === 5 && request.subarray(0, 5).equals(answer);
