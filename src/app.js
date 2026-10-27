// -----------------------------------------------------------------------------
// The integration: the unit typed in the configuration (its IP address and
// Modbus unit id), one read of its registers every poll interval over one
// Modbus TCP connection, the Gladys device and its states, the transport
// badge, the "Test the connection" button, and the commands. index.js only
// wires the SDK handlers to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"), one request at a time on it:
// a poll is one session of ten reads, closed after; a command takes the line
// from a poll (the poll is dropped, nothing of it published); the stop takes
// it from anything.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written at most once a minute, BEFORE the read);
//     a reconnection during a read joins it;
//   - an answer that arrives for an old configuration (generation) publishes
//     nothing and sets no status; a read begun before a command left is not
//     applied; a value not read this time is never republished as new;
//   - the serial number is checked at each read: another serial publishes
//     nothing (another device may answer at the address).
//
// Commands (mode, filter reset):
//   - refused unless their option is on, checked on arrival and again right
//     before each write (nothing runs in between);
//   - decided on a fresh read in the same session (serial, current mode, fan
//     level, alarm, or the filter days), never on the state in memory;
//     refused when a value cannot be read, when the serial differs or /data
//     cannot be read; the mode is refused in a mode Gladys does not set
//     (away, summer, fireplace, night, overrides, fail-safe, defrost,
//     installer) and in fire alarm; not written when already so;
//   - first write within 3.5 s of the click or refused unsent; confirmed only
//     by the answer of each write and a read back equal to what was asked
//     (the filter days going up for the reset), by 4.3 s; else "sent, without
//     confirmation" and spaced reads; a Modbus exception 1-3 to the first
//     write is "refused by the unit"; never retried; one at a time;
//   - a mode written lifts the stop guard, right before its first write.
// The stop protects: never held back by an option, another command, a failed
// read, a backoff, the serial, /data or the configuration from Gladys (the
// last unit is kept in /data); takes the line from anything; tried again
// until 3.5 s after the press (idempotent writes); kept in /data with its
// unit; a stop not confirmed is sent again at the container start (before
// anything else) and by the reads that show the unit running (three times at
// most); a stop confirmed is sent again by the reads of the next two minutes
// that show it running (a write of an older command may still land). The
// guard is never lifted by the time: only by a mode written with the option,
// or by two reads in a row showing the unit running when no resend is due
// (restarted outside Gladys).
//
// In-memory times (deadlines, guards, the time of the last read) are on a
// monotonic clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  BLOCKS,
  BLOCK_OF,
  END_SPECIAL,
  FIRE_ALARMS,
  LIMITS,
  MODE_CHANGE_FROM,
  MODE_WRITES,
  NOT_APPLIED_EXCEPTIONS,
  PRESSED,
  REGISTERS,
  SECOND,
  STOP_WRITES,
  TIMINGS,
  VALUE_BLOCK,
} from './constants.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import {
  decodeBlock,
  hasRoomSensor,
  isWriteAnswer,
  parseRead,
  readRequest,
  writeRequest,
} from './modbus/protocol.js';
import { buildDevice, commandOf, deviceStates, parseFeatureId, unitIds } from './devices.js';
import { CURRENT_MODE_NAMES, ERRORS, T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, unitKeyOf } from './store.js';

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time). */
  values: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

/** Stopped: fan level 0 or the current mode stand-by. Running: both known, neither. */
function stopState(values) {
  if (values.fanLevel === 0 || values.currentMode === 'standby') return 'stopped';
  if (values.fanLevel !== undefined && values.currentMode !== undefined) return 'running';
  return 'unknown';
}

/** The stop confirmed by a read back: level 0, in manual or stand-by. */
const stopConfirmed = (values) =>
  values.fanLevel === 0 && ['manual', 'standby'].includes(values.currentMode);

export class DanthermApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'dantherm' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data exists but cannot be read: never written over. */
    this.storeUnreadable = false;
    this.booting = undefined;
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    /** The container is stopping: nothing is scheduled any more. */
    this.closed = false;
    /** Configurations applied one at a time, in order (the last one wins). */
    this.configChain = Promise.resolve();
    this.configTimer = undefined;
    this.configTries = 0;
    this.configFailed = undefined;
    this.lastRaw = undefined;
    /** The time of the last read sent to the unit (monotonic; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The session on the line: { kind: 'read' | 'command' | 'protect', abort(), done }. */
    this.active = undefined;
    /** Commands getting ready to take the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The command in flight (one at a time), and the stop in flight. */
    this.inFlight = undefined;
    this.protecting = undefined;
    /** Counts the stops: a command that sees it change before a write gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** When the last stop write left in this run (the window of its resends). */
    this.stopSentAt = -Infinity;
    /** Reads in a row showing the unit running while a stop guard needs no resend. */
    this.runningReads = 0;
    /** The stop guard was lifted by two reads showing the unit running (shown in the status). */
    this.stopLifted = false;
    /** Whether the identity in memory is the one in /data. */
    this.identitySaved = false;
    /** The serial fingerprint read when it differs from the one kept (values and commands held). */
    this.mismatch = undefined;
    /** Role -> { expect, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** Block key -> timeouts in a row while the unit answered the others. */
    this.timeouts = new Map();
    /** Measure block key -> when it is tried again (skipped after repeated timeouts or refusals). */
    this.skipped = new Map();
    /** The pending resend of a stop. */
    this.reassertTimer = undefined;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  // --- Boot: /data, and a stop not confirmed sent again at once --------------------

  /**
   * Loads /data once, before anything else. A stop kept unconfirmed is sent
   * again at once to the unit it was for, without the configuration nor a
   * first read (three resends at most, counted in /data).
   */
  boot() {
    if (!this.booting) {
      this.booting = (async () => {
        const loaded = await this.store.load().catch(() => ({ unreadable: true }));
        this.storeUnreadable = loaded?.unreadable === true;
        if (this.storeUnreadable) {
          this.logger.warn('dantherm: /data cannot be read; it is never written over');
        }
        this.memory = normalizeMemory(this.storeUnreadable ? null : loaded?.data, this.now());
        this.identitySaved = this.memory.identity !== null;
        const guard = this.memory.stopGuard;
        if (guard && !guard.confirmed && guard.reasserts < TIMINGS.stopReasserts) {
          this.logger.warn('dantherm: a stop not confirmed is kept in /data: sent again');
          guard.reasserts += 1;
          this.protect(this.mono(), { target: guard, reassert: true }).catch((err) =>
            this.logger.warn(`dantherm: stop at start: ${err.message}`),
          );
        }
      })();
    }
    return this.booting;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * The 'connected' event: the configuration read from Gladys, again and
   * again while it fails (5 s, doubled up to 5 min), the status saying so.
   * Meanwhile the reads go on with the last configuration received, if any.
   */
  async connectedFrom(readConfig) {
    await this.boot();
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await readConfig();
    } catch (err) {
      const [min, max] = TIMINGS.configRetry;
      const wait = Math.min(max, min * 2 ** this.configTries);
      this.configTries += 1;
      this.configFailed = wait;
      this.logger.warn(
        `dantherm: the configuration could not be read (${err?.name ?? 'Error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      if (this.started) {
        // The reads go on with the configuration in use; the status says it.
        this.lastStatus = undefined;
        await this.updateStatus();
      } else {
        this.lastStatus = undefined;
        await this.setStatus(false, T.configFailed(age(wait)));
      }
      if (this.closed) {
        return;
      }
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedFrom(readConfig).catch((e) =>
          this.logger.error(`dantherm: start failed (${e?.name ?? 'Error'})`),
        );
      }, wait);
      return;
    }
    this.configTries = 0;
    this.configFailed = undefined;
    await this.connected(raw && typeof raw === 'object' ? raw : {});
  }

  /** Runs `fn` after the configurations already queued: one at a time, in order. */
  serialize(fn) {
    const run = this.configChain.then(fn, fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * last states, without reading the unit.
   */
  connected(raw = {}) {
    return this.serialize(async () => {
      await this.boot();
      this.lastRaw = raw;
      if (!this.started) {
        this.started = true;
        await this.start(raw);
        return;
      }
      if (this.needsRestart(raw)) {
        await this.start(raw, { fresh: true });
        return;
      }
      const previous = this.config;
      this.config = normalizeConfig(raw);
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
      this.rescheduleOnNewInterval(previous);
      // Status, Discovery and badge again; the values come with the next read (never resent as new).
      await this.publishAll({ states: false });
    });
  }

  configUpdated(raw = {}) {
    return this.serialize(async () => {
      await this.boot();
      this.lastRaw = raw;
      if (!this.started) {
        this.started = true;
        await this.start(raw);
        return;
      }
      if (this.needsRestart(raw)) {
        await this.start(raw, { fresh: true });
        return;
      }
      const previous = this.config;
      this.config = normalizeConfig(raw);
      this.rememberUnit();
      this.rescheduleOnNewInterval(previous);
      if (this.config.allowCommands !== previous.allowCommands) {
        this.logger.info(
          `dantherm: mode commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
        );
      }
      if (this.config.language !== previous.language) {
        this.published = undefined;
      }
      this.lastStatus = undefined;
      await this.publishAll();
    });
  }

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the
   * interval after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    if (this.closed) {
      return;
    }
    this.stop();
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    if (generation !== this.generation) {
      return;
    }
    this.unit = freshUnit();
    this.mismatch = undefined;
    this.runningReads = 0;
    this.timeouts.clear();
    this.skipped.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    this.rememberUnit();
    if (!this.config.address) {
      // The device already created is shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The unit of the configuration: address and Modbus unit id. */
  configUnit() {
    const a = this.config.address;
    return a ? { host: a.host, port: a.port, unitId: this.config.unitId } : undefined;
  }

  unitKey() {
    return unitKeyOf(this.configUnit());
  }

  /** The last unit configured goes to /data: a stop leaves even without the configuration. */
  rememberUnit() {
    const u = this.configUnit();
    if (u && unitKeyOf(u) !== unitKeyOf(this.memory.unit)) {
      this.memory.unit = u;
      this.saveMemory();
    }
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    // The wall time kept, as a time of the monotonic clock.
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  /** Stops the reads of this configuration. A stop in flight goes on to its end. */
  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    if (this.active && this.active.kind !== 'protect') {
      this.active.abort('stopped');
    }
    this.publisher.stop();
    this.guards.clear();
  }

  /** The container stops: everything, the configuration retries included; nothing starts again. */
  shutdown() {
    this.closed = true;
    this.stop();
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    if (this.reassertTimer) {
      this.timers.clearTimeout(this.reassertTimer);
      this.reassertTimer = undefined;
    }
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /** Only a new address or unit id restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid ||
      next.unitId !== this.config.unitId
    );
  }

  /** A new interval: the next read follows it, counted from the last read. */
  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** Writes /data (never over a file that could not be read). Resolves true when written. */
  async saveMemory() {
    if (this.storeUnreadable) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`dantherm: saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection to `target` (the unit of the
   * configuration by default); the line is held until it ends. `retryUntil`:
   * a refused connection is tried again every 250 ms until then (nothing is
   * sent before the connection, so this never repeats a command).
   */
  async useLine(kind, timeoutMs, fn, { retryUntil, target = this.configUnit() } = {}) {
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      if (!target) {
        throw new ModbusError(ERROR_KINDS.UNREACHABLE, 'no address');
      }
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: target.host,
          port: target.port,
          unitId: target.unitId,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      record.session?.close();
      // The line is free once the socket is closed (bounded: 500 ms at most).
      if (record.session) {
        let timer;
        await Promise.race([
          record.session.closed,
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, 500);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /** One block read in `session`: its values (only those plausible). */
  async readBlock(session, key, options) {
    const block = BLOCK_OF[key];
    const pdu = await session.request(readRequest(block), options);
    const data = parseRead(block, pdu);
    if (data === undefined) {
      // An answer of the wrong size: the session is not trusted any more.
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
    }
    return decodeBlock(block, data);
  }

  /** One 32-bit write and its answer (function, address, quantity). */
  async writeParam(session, address, value, options) {
    const request = writeRequest(address, value);
    const answer = await session.request(request, options);
    if (!isWriteAnswer(request, answer)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the answer of the write'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the answer of the write', { sent: true });
    }
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval; never sooner than the interval after the last read. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    if (this.closed) {
      return;
    }
    let wait = delay ?? (u.online === false ? u.wait : this.interval);
    // Capped at the interval: a clock jump never stops the reads.
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - this.mono()), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('dantherm: refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /**
   * Keeps the time of this read; when the write of the minute is due, in
   * /data BEFORE the read (a container stopped during the read keeps it). At
   * most one write a minute.
   */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.config.address) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command holds the line: the poll waits for the next turn.
      this.schedule();
      return;
    }
    const startedAt = this.mono();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule();
      return;
    }
    let values;
    let failure;
    try {
      values = await this.useLine('read', TIMINGS.connectTimeout, (session) =>
        this.readAll(session),
      );
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      // A command took the line: nothing of this read is applied, not a failure.
      this.logger.debug('dantherm: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('dantherm: read begun before a command, not applied');
    } else {
      this.applyRead(values);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * Every block, one after the other. A block that times out while the unit
   * answered the ones before ends the read (the session is gone): what was
   * read is kept. A block refused by the unit (Modbus exception) leaves its
   * values unknown this time. A state block is never skipped; a measure block
   * that times out three reads in a row, or is refused, is skipped and tried
   * again every hour (one log line when it is skipped).
   */
  async readAll(session) {
    const values = {};
    let answered = 0;
    for (const block of BLOCKS) {
      const skippedUntil = this.skipped.get(block.key);
      if (skippedUntil !== undefined && this.mono() < skippedUntil) {
        continue;
      }
      let read;
      try {
        read = await this.readBlock(session, block.key, { timeoutMs: TIMINGS.requestTimeout });
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          answered += 1;
          if (block.state) {
            this.logger.warn(`dantherm: block ${block.key} refused (${errorReason(err)})`);
          } else {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `dantherm: block ${block.key} refused (${errorReason(err)}), tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          }
          continue;
        }
        if (err.kind === ERROR_KINDS.TIMEOUT && answered > 0) {
          const count = (this.timeouts.get(block.key) ?? 0) + 1;
          this.timeouts.set(block.key, count);
          if (!block.state && count >= LIMITS.blockTimeouts) {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `dantherm: block ${block.key} never answers, tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          } else {
            this.logger.warn(`dantherm: block ${block.key} did not answer`);
          }
          return values;
        }
        throw err;
      }
      answered += 1;
      this.timeouts.delete(block.key);
      this.skipped.delete(block.key);
      Object.assign(values, read);
    }
    return values;
  }

  /** A read: the values of this read only (a value not read is unknown). */
  applyRead(raw) {
    const u = this.unit;
    const values = { ...raw };
    if (!hasRoomSensor(values.components)) {
      // T5 only on a unit that lists the room sensor in this same read.
      delete values.room;
    }
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    this.checkIdentity(values.serial);
    if (this.mismatch !== undefined) {
      // Another device may answer at the address: nothing of it is shown.
      u.values = undefined;
      return;
    }
    u.values = values;
    u.readAt = this.mono();
    this.observe(values);
  }

  /** The salted fingerprint of a serial (the serial itself is never kept). */
  fingerprint(serial, salt) {
    return createHash('sha256').update(`${salt}:${serial}`).digest('hex').slice(0, 16);
  }

  /**
   * The identity of the unit: its serial number, learnt at the first read and
   * kept in /data (salted) for this address and unit id. Another serial read
   * means another device may answer at the address: its values are not shown
   * and the commands (except the stop) are refused until the test button
   * accepts it. An unreadable serial is never "another unit".
   * @returns {boolean} whether the identity is known and matches.
   */
  checkIdentity(serial) {
    if (serial === undefined) {
      return false;
    }
    const kept = this.memory.identity;
    if (!kept || kept.unit !== this.unitKey()) {
      if (this.storeUnreadable) {
        return false;
      }
      const salt = randomBytes(16).toString('hex');
      const identity = { unit: this.unitKey(), salt, fingerprint: this.fingerprint(serial, salt) };
      this.memory.identity = identity;
      this.identitySaved = false;
      this.mismatch = undefined;
      this.saveMemory().then((saved) => {
        if (saved && this.memory.identity === identity) this.identitySaved = true;
      });
      return true;
    }
    const seen = this.fingerprint(serial, kept.salt);
    if (kept.fingerprint === seen) {
      this.mismatch = undefined;
      return true;
    }
    if (this.mismatch !== seen) {
      this.logger.warn(
        'dantherm: the serial number of the unit changed; values and commands held until the test button accepts it',
      );
    }
    this.mismatch = seen;
    return false;
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = reason;
    this.logger.warn(`dantherm: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** The stop guard of the unit configured, if any. */
  stopGuard() {
    const g = this.memory.stopGuard;
    return g && g.unit === this.unitKey() ? g : undefined;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    let message;
    if (!c.address) {
      if (c.invalid) message = T.invalid(c.invalid);
      else message = c.badUnitId ? T.badUnitId : T.noHost;
    } else if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      message = [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
        ? T.unreachable(addressKey(c.address), wait)
        : T.failing(u.error ?? 'error', wait);
    } else if (u.online === true && this.mismatch !== undefined) {
      message = T.otherUnit;
    } else if (u.online === undefined) {
      message =
        u.timer && this.due > this.mono() ? T.waiting(age(this.due - this.mono())) : T.connecting;
    } else {
      message = T.connected(T.summary(u.values ?? {}));
    }
    const guard = this.stopGuard();
    if (guard && !guard.confirmed) {
      message = { en: message.en + T.stopFailing.en, fr: message.fr + T.stopFailing.fr };
    } else if (this.stopLifted) {
      message = { en: message.en + T.stopLifted.en, fr: message.fr + T.stopLifted.fr };
    }
    if (this.storeUnreadable) {
      message = join(message, T.storeUnreadable);
    }
    if (this.configFailed !== undefined) {
      message = join(message, T.configFailed(age(this.configFailed)));
    }
    return message;
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice() {
    const id = unitIds(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  async publishAll({ states = true } = {}) {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    if (states) this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The device, once the unit answered (every feature, always). */
  async publishDevices() {
    if (this.unit.online !== true || this.mismatch !== undefined) {
      return;
    }
    const devices = [buildDevice(this.gladys, { language: this.config.language })];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features. */
  queueValues(values, created = this.createdFeatures()) {
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      unitIds(this.gladys),
      values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  /** The values of the last read, only while they are of this interval (never stale as new). */
  queueStates(created) {
    const u = this.unit;
    const fresh = u.readAt !== undefined && this.mono() - u.readAt <= this.interval;
    if (u.online === true && u.values && this.mismatch === undefined && fresh) {
      this.queueValues(this.unit.values, created);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport: online === true ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    if (this.mismatch !== undefined) {
      // Accepts exactly the serial shown (its fingerprint), without a read.
      const kept = this.memory.identity;
      if (this.storeUnreadable || !kept) {
        return this.status();
      }
      const previous = kept.fingerprint;
      kept.fingerprint = this.mismatch;
      if (!(await this.saveMemory())) {
        kept.fingerprint = previous;
        return ERRORS.saveFailed;
      }
      this.mismatch = undefined;
      this.logger.info('dantherm: unit accepted with its new serial number');
      await this.updateStatus();
      return T.accepted;
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    if (this.mono() < this.due) {
      const waited = T.waiting(age(this.due - this.mono()));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(this.mono() - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    const command = role ? commandOf(role) : undefined;
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    let plan;
    if (command.button) {
      // Strictly 1: null, '', true, 0 or "on" never press a button.
      if (value !== PRESSED && value !== String(PRESSED)) {
        throw this.refusal(ERRORS.badButton);
      }
      plan = { role, command };
    } else {
      // Strictly one of the values of the select: never trimmed, re-cased nor a number.
      if (typeof value !== 'string' || !Object.hasOwn(MODE_WRITES, value)) {
        throw this.refusal(ERRORS.badValue);
      }
      plan = { role, command, choice: value, ...MODE_WRITES[value] };
    }
    if (command.protective) {
      // The stop: never behind an option, the configuration from Gladys, nor another command.
      return this.protect(received);
    }
    if (!this.config[command.option]) {
      throw this.refusal(command.kind === 'mode' ? ERRORS.disabled : ERRORS.filterDisabled);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    if (this.storeUnreadable) {
      throw this.refusal(ERRORS.storeUnreadable);
    }
    if (this.inFlight) {
      throw this.refusal(ERRORS.busy);
    }
    if (this.protecting) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    const promise = this.command(plan, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The values a command read or confirmed: in memory and to Gladys in the background. */
  noteValues(values) {
    if (this.unit.online !== true || !this.unit.values || this.mismatch !== undefined) {
      return;
    }
    Object.assign(this.unit.values, values);
    this.queueValues(values);
    // Shown in the background: the ack never waits for Gladys.
    this.flush().catch(() => {});
  }

  async command(plan, received) {
    const generation = this.generation;
    const seq = this.protectSeq;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The checks before each write, on the latest configuration.
    const check = () => {
      if (!this.config[plan.command.option]) {
        throw this.refusal(plan.command.kind === 'mode' ? ERRORS.disabled : ERRORS.filterDisabled);
      }
      if (generation !== this.generation || !this.config.address) {
        throw this.refusal(ERRORS.configChanged);
      }
      if (seq !== this.protectSeq) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
    };
    const state = { written: false, seq };
    this.reserved += 1;
    try {
      await this.takeLine(['read']);
      if (this.active) {
        throw this.refusal(this.active.kind === 'protect' ? ERRORS.stopMeanwhile : ERRORS.busy);
      }
      check();
      const connectBudget = Math.min(
        TIMINGS.commandConnectMax,
        sendBy - TIMINGS.commandMinSend - TIMINGS.commandMinRead - this.mono(),
      );
      if (connectBudget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      return await this.useLine('command', connectBudget, (session) =>
        this.commandSession(session, plan, { check, sendBy, answerBy, state }),
      );
    } catch (err) {
      throw this.commandError(err, plan, state);
    } finally {
      this.reserved -= 1;
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, plan, state) {
    if (err instanceof Refusal || err?.beforeSend) {
      if (state.written && !(err instanceof Refusal && state.final)) {
        // A later write held back after a first one left: sent, without confirmation.
        return this.unconfirmed(plan, state, err.message);
      }
      return err;
    }
    const reason = errorReason(err);
    // Only a write says whether the command may have left (a read never does).
    if (!state.written) {
      this.logger.warn(`dantherm: command NOT sent (${plan.role}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          state.seq !== this.protectSeq ? ERRORS.stopMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      // A Modbus exception 1-3 to the first write: the unit did not apply it.
      this.logger.warn(`dantherm: command refused by the unit (${plan.role}): ${reason}`);
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the unit: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    this.guards.set(plan.role, { expect: plan.expect, until: this.mono() + TIMINGS.guard });
    this.followUp();
    this.logger.warn(`dantherm: command sent, NOT confirmed (${plan.role}): ${reason}`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  guardActive(role) {
    const guard = this.guards.get(role);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(role);
      return false;
    }
    return Boolean(guard);
  }

  /** Reads `keys` (their blocks) in `session` within the budget of a command. */
  async freshRead(session, keys, sendBy) {
    const blocks = [...new Set(keys.map((key) => VALUE_BLOCK[key]))];
    const fresh = {};
    for (const key of blocks) {
      const budget = Math.min(
        TIMINGS.requestTimeout,
        sendBy - TIMINGS.commandMinSend - this.mono(),
      );
      if (budget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      try {
        Object.assign(fresh, await this.readBlock(session, key, { timeoutMs: budget }));
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED) {
          throw err;
        }
        throw this.refusal(ERRORS.unknownState(errorReason(err)));
      }
    }
    return fresh;
  }

  /** Reads back `keys` after a write, until `answerBy`. */
  async readBack(session, keys, answerBy) {
    const blocks = [...new Set(keys.map((key) => VALUE_BLOCK[key]))];
    const back = {};
    for (const key of blocks) {
      const left = answerBy - this.mono();
      if (left < 50) {
        throw new ModbusError(ERROR_KINDS.TIMEOUT, 'no time left to read back', { sent: true });
      }
      Object.assign(back, await this.readBlock(session, key, { timeoutMs: left }));
    }
    return back;
  }

  async commandSession(session, plan, { check, sendBy, answerBy, state }) {
    const isMode = plan.command.kind === 'mode';
    // The state just before acting, read now in this session, never the one in memory.
    const keys = isMode ? ['serial', 'currentMode', 'fanLevel', 'alarm'] : ['serial', 'filterDays'];
    const fresh = await this.freshRead(session, keys, sendBy);
    check();
    if (fresh.serial === undefined) {
      throw this.refusal(ERRORS.noIdentity);
    }
    if (!this.checkIdentity(fresh.serial)) {
      throw this.refusal(this.mismatch !== undefined ? ERRORS.otherUnit : ERRORS.noIdentity);
    }
    if (!this.identitySaved) {
      // The identity learnt must be in /data before a command goes.
      const identity = this.memory.identity;
      if (!(await this.saveMemory())) {
        throw this.refusal(ERRORS.saveFailed);
      }
      if (this.memory.identity === identity) this.identitySaved = true;
    }
    for (const key of keys) {
      if (fresh[key] === undefined) {
        throw this.refusal(ERRORS.unknownState(word(ERRORS.unreadable, this.config.language)));
      }
    }
    this.noteValues(fresh);
    check();
    let confirm;
    if (isMode) {
      if (!MODE_CHANGE_FROM.has(fresh.currentMode)) {
        throw this.refusal(ERRORS.specialMode(CURRENT_MODE_NAMES[fresh.currentMode]));
      }
      if (FIRE_ALARMS.has(fresh.alarm)) {
        throw this.refusal(ERRORS.fireAlarm);
      }
      const already = Object.entries(plan.expect).every(([k, v]) => fresh[k] === v);
      if (already && !this.guardActive(plan.role) && !this.stopGuard()) {
        this.logger.info(`dantherm: mode ${plan.choice} already so, nothing sent`);
        return;
      }
      confirm = async () => {
        const back = await this.readBack(session, Object.keys(plan.expect), answerBy);
        this.noteValues(back);
        return Object.entries(plan.expect).every(([k, v]) => back[k] === v);
      };
    } else {
      const before = fresh.filterDays;
      plan.writes = [[REGISTERS.FILTER_RESET, 1]];
      confirm = async () => {
        const back = await this.readBack(session, ['filterDays'], answerBy);
        this.noteValues(back);
        // Equal to before: not applied yet (never a confirmation).
        return back.filterDays !== undefined && back.filterDays > before;
      };
    }
    this.logger.info(`dantherm: ${plan.role} ${plan.choice ?? ''}`.trim());
    for (const [index, [address, value]] of plan.writes.entries()) {
      try {
        await this.writeParam(session, address, value, {
          timeoutMs: Math.max(100, Math.min(TIMINGS.requestTimeout, answerBy - this.mono())),
          // The first write leaves by 3.5 s; the next ones while an answer can still come.
          startBy: index === 0 ? sendBy : answerBy - 100,
          beforeSend: () => {
            // The option, the configuration and a stop, checked right before each write.
            check();
            state.written = true;
            this.lastSentAt = this.mono();
            if (isMode && this.memory.stopGuard) {
              // A mode written with the option is the latest wish: the stop guard
              // is lifted right before its synchronous write (never earlier).
              this.liftStopGuard('a mode written from Gladys');
            }
          },
        });
      } catch (err) {
        if (
          index === 0 &&
          err.kind === ERROR_KINDS.REFUSED &&
          NOT_APPLIED_EXCEPTIONS.has(err.code)
        ) {
          // Refused by the unit (illegal function, address or value): not applied.
          state.refused = true;
        }
        throw err;
      }
    }
    if (!(await confirm())) {
      state.final = true;
      throw this.unconfirmed(plan, state, word(ERRORS.notYet, this.config.language));
    }
    this.guards.delete(plan.role);
    this.logger.info(`dantherm: ${plan.role} confirmed by the unit`);
  }

  // --- The stop (protective) -----------------------------------------------------

  /** Lifts the stop guard (and a resend pending), kept in /data. */
  liftStopGuard(why) {
    if (!this.memory.stopGuard) {
      return;
    }
    this.logger.info(`dantherm: stop guard lifted (${why})`);
    this.memory.stopGuard = null;
    this.runningReads = 0;
    if (this.reassertTimer) {
      this.timers.clearTimeout(this.reassertTimer);
      this.reassertTimer = undefined;
    }
    this.saveMemory();
  }

  /** Keeps the stop guard in /data (never awaited by the stop). */
  keepStopGuard(target, { confirmed, reassert }) {
    const previous = this.memory.stopGuard;
    const same = previous && previous.unit === unitKeyOf(target);
    this.memory.stopGuard = {
      host: target.host,
      port: target.port,
      unitId: target.unitId,
      unit: unitKeyOf(target),
      at: this.now(),
      confirmed,
      // A press starts a new count; a resend keeps it.
      reasserts: reassert && same ? previous.reasserts : 0,
    };
    this.saveMemory();
  }

  /** A second press while one runs joins it. */
  async protect(received, options = {}) {
    if (this.protecting) {
      return this.protecting;
    }
    const promise = this.sendStop(received, options);
    this.protecting = promise;
    try {
      return await promise;
    } finally {
      if (this.protecting === promise) {
        this.protecting = undefined;
      }
    }
  }

  /**
   * Never held back: takes the line from anything; reads the current mode
   * first (0.6 s at most, skipped when it fails) to end away, summer or
   * fireplace; writes manual mode then fan level 0; reads them back. A
   * refused or dropped connection, a timeout or a wrong answer is tried
   * again every 250 ms until 3.5 s after the click (the writes are
   * idempotent). Answered by 4.3 s; still running then, it goes on, bounded
   * by its deadline and its requests, and the answer says whether it was
   * written yet.
   */
  async sendStop(
    received,
    { target = this.configUnit() ?? this.memory.unit, reassert = false } = {},
  ) {
    if (!target) {
      throw this.refusal(ERRORS.noHost);
    }
    // A command not written yet gives way (checked right before each of its writes).
    this.protectSeq += 1;
    this.stopLifted = false;
    this.runningReads = 0;
    this.keepStopGuard(target, { confirmed: false, reassert });
    const state = { written: false, skipRead: false };
    const retryUntil = received + TIMINGS.commandSendBy;
    const budget = () => Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono()));
    const writeOptions = () => ({
      timeoutMs: budget(),
      beforeSend: () => {
        state.written = true;
        this.lastSentAt = this.mono();
        this.stopSentAt = this.mono();
      },
    });
    const attempt = async (session) => {
      if (!state.skipRead) {
        // Read once: a failure never holds the stop back (it goes without ending a special mode).
        state.skipRead = true;
        let mode;
        try {
          mode = (
            await this.readBlock(session, 'currentMode', {
              timeoutMs: Math.max(100, Math.min(TIMINGS.stopReadMax, retryUntil - this.mono())),
            })
          ).currentMode;
        } catch (err) {
          if (err.kind !== ERROR_KINDS.REFUSED) throw err;
        }
        if (Object.hasOwn(END_SPECIAL, mode)) {
          await this.writeParam(session, REGISTERS.ACTIVE_MODE, END_SPECIAL[mode], writeOptions());
        }
      }
      for (const [address, value] of STOP_WRITES) {
        await this.writeParam(session, address, value, writeOptions());
      }
      return {
        ...(await this.readBlock(session, 'fanLevel', { timeoutMs: budget() })),
        ...(await this.readBlock(session, 'currentMode', { timeoutMs: budget() })),
      };
    };
    const AGAIN = [ERROR_KINDS.CLOSED, ERROR_KINDS.TIMEOUT, ERROR_KINDS.PROTOCOL];
    this.reserved += 1;
    const sending = (async () => {
      try {
        await this.takeLine(['read', 'command', 'protect']);
        for (;;) {
          try {
            return await this.useLine('protect', TIMINGS.connectTimeout, attempt, {
              retryUntil,
              target,
            });
          } catch (err) {
            const again =
              AGAIN.includes(err?.kind) && this.mono() + TIMINGS.connectRetry < retryUntil;
            if (!again) {
              throw err;
            }
            await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
          }
        }
      } finally {
        this.reserved -= 1;
      }
    })();
    this.logger.info(`dantherm: stop${reassert ? ' (sent again)' : ''}`);
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let late;
    const outcome = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        (back) => resolve({ back }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    const sameUnit = unitKeyOf(target) === this.unitKey();
    if (outcome.back && stopConfirmed(outcome.back)) {
      const guard = this.memory.stopGuard;
      if (guard && guard.unit === unitKeyOf(target)) {
        guard.confirmed = true;
        this.saveMemory();
      }
      if (sameUnit) this.noteValues(outcome.back);
      // Confirmed now, but a write of an older command may still land: checked by the next reads.
      if (sameUnit) this.followUp();
      this.logger.info('dantherm: stop confirmed by the unit');
      this.updateStatus().catch(() => {});
      return;
    }
    // Not confirmed: the next reads send it again.
    if (sameUnit) this.followUp();
    this.updateStatus().catch(() => {});
    if (outcome.late) {
      sending.then(
        (back) => {
          if (back && stopConfirmed(back) && this.memory.stopGuard?.unit === unitKeyOf(target)) {
            this.memory.stopGuard.confirmed = true;
            this.saveMemory();
          }
        },
        (err) => this.logger.warn(`dantherm: stop failed after the ack (${errorReason(err)})`),
      );
      if (!state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.noAnswerYet, this.config.language)));
    }
    if (outcome.err) {
      const reason = errorReason(outcome.err);
      this.logger.warn(`dantherm: stop failed (${reason})`);
      if (!state.written) {
        throw this.refusal(ERRORS.notSent(reason));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (outcome.back && sameUnit) {
      this.noteValues(outcome.back);
    }
    throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.stillRunning, this.config.language)));
  }

  // --- Reads through the guards ----------------------------------------------------

  /**
   * A read (poll or follow-up) through the guards. Command guards lift when
   * the read shows what they asked. The stop guard of this unit:
   *   - a read showing the unit stopped confirms it (never lifts it);
   *   - a read showing it running sends the stop again (three times at most
   *     per stop) when the stop is not confirmed, or within two minutes of
   *     its write in this run (a write of an older command may still land);
   *   - otherwise, two reads in a row showing it running (both known) mean
   *     it was restarted outside Gladys: the guard is lifted, the status
   *     says so. An unknown read breaks the row. The time never lifts it.
   */
  observe(values) {
    for (const [role, guard] of [...this.guards.entries()]) {
      if (!this.guardActive(role) || !guard.expect) continue;
      if (Object.entries(guard.expect).every(([k, v]) => values[k] === v)) {
        this.guards.delete(role);
      }
    }
    const guard = this.stopGuard();
    if (!guard) {
      return;
    }
    const seen = stopState(values);
    if (seen === 'unknown') {
      this.runningReads = 0;
      return;
    }
    if (seen === 'stopped') {
      this.runningReads = 0;
      if (!guard.confirmed) {
        guard.confirmed = true;
        this.saveMemory();
      }
      return;
    }
    const inWindow = this.mono() - this.stopSentAt < TIMINGS.stopReassertWindow;
    if ((!guard.confirmed || inWindow) && guard.reasserts < TIMINGS.stopReasserts) {
      this.runningReads = 0;
      if (this.protecting || this.reassertTimer || this.closed) {
        return;
      }
      guard.reasserts += 1;
      this.saveMemory();
      this.logger.warn('dantherm: the unit runs after a stop: stop sent again');
      // Not awaited, and a second after the read closed the line.
      this.reassertTimer = this.timers.setTimeout(() => {
        this.reassertTimer = undefined;
        // Only for the same guard of the unit configured (a mode written meanwhile lifted it).
        if (this.stopGuard() !== guard) {
          return;
        }
        this.protect(this.mono(), { reassert: true }).catch((err) =>
          this.logger.warn(`dantherm: stop sent again: ${err.message}`),
        );
      }, TIMINGS.reassertDelay);
      return;
    }
    this.runningReads += 1;
    if (this.runningReads >= 2) {
      this.liftStopGuard('read running twice in a row: restarted outside Gladys');
      this.stopLifted = true;
    }
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    if (this.closed) {
      return;
    }
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('dantherm: refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
