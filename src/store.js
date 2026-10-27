// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
// - the time of the last read of the unit (written at most once a minute,
//   BEFORE the read), so a restart never reads the unit sooner than the
//   interval;
// - the last unit configured (address, port, Modbus unit id), so a stop can
//   leave even when Gladys does not give the configuration;
// - the identity of the unit: a salted fingerprint of its serial number
//   (never the serial itself), learnt at the first read;
// - the stop guard: the last stop, its unit, whether it was confirmed and how
//   many times the reads sent it again.
// No secret (the Modbus interface has none). The file is readable by the
// container user only (0600), bounded and repaired when read back. A file
// that exists but cannot be read is never taken for an empty one: it is never
// written over (`unreadable`).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { DEFAULT_PORT, TIMINGS, UNIT_ID } from './constants.js';

export const STATE_FILE = '/data/dantherm-state.json';
const MAX_SIZE = 8 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }` (null when there is no file yet) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      try {
        if (text.length > MAX_SIZE) return { unreadable: true };
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failSaves` makes the saves fail. */
export function memoryStore(initial = null, { unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failSaves: false,
    unreadable,
    async load() {
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.failSaves) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : undefined;

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** A unit kept: host (no control character), port and Modbus unit id, else null. */
function keptUnit(raw) {
  const u = object(raw);
  const host = shortText(u.host, 253);
  const port = Number.isInteger(u.port) && u.port >= 1 && u.port <= 65535 ? u.port : DEFAULT_PORT;
  const unitId =
    Number.isInteger(u.unitId) && u.unitId >= UNIT_ID.min && u.unitId <= UNIT_ID.max
      ? u.unitId
      : undefined;
  return host && /^[a-z0-9.-]+$/.test(host) && unitId !== undefined ? { host, port, unitId } : null;
}

/** The key of a unit: its address and Modbus unit id. */
export const unitKeyOf = (u) => (u ? `${u.host}:${u.port}#${u.unitId}` : '');

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null (a time in the
 *   future is not valid: null);
 * - `unit`: the last unit configured, or null;
 * - `identity`: `{ unit, salt, fingerprint }`, the salted fingerprint of the
 *   serial learnt for the unit `unit`, or null;
 * - `stopGuard`: `{ unit, host, port, unitId, at, confirmed, reasserts }`,
 *   the last stop (wall time `at`, never in the future), or null.
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const identity = object(data.identity);
  const guard = object(data.stopGuard);
  const idUnit = shortText(identity.unit, 280);
  const salt = /^[0-9a-f]{32}$/.test(identity.salt ?? '') ? identity.salt : undefined;
  const fingerprint = /^[0-9a-f]{16}$/.test(identity.fingerprint ?? '')
    ? identity.fingerprint
    : undefined;
  const guardUnit = keptUnit(guard);
  return {
    lastAttemptAt:
      Number.isFinite(data.lastAttemptAt) && data.lastAttemptAt <= now ? data.lastAttemptAt : null,
    unit: keptUnit(data.unit),
    identity: idUnit && salt && fingerprint ? { unit: idUnit, salt, fingerprint } : null,
    stopGuard:
      guardUnit && Number.isFinite(guard.at) && guard.at <= now
        ? {
            ...guardUnit,
            unit: unitKeyOf(guardUnit),
            at: guard.at,
            confirmed: guard.confirmed === true,
            reasserts: Number.isInteger(guard.reasserts)
              ? Math.min(TIMINGS.stopReasserts, Math.max(0, guard.reasserts))
              : 0,
          }
        : null,
  };
}
