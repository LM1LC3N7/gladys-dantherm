// -----------------------------------------------------------------------------
// A fake Dantherm / Pluggit controller behind the injected `connect` (no
// network): Modbus TCP framing (MBAP), the holding registers of the
// manufacturer's table (32-bit parameters, low word first), write multiple
// registers applied, answers after a delay (mocked timers). It counts the
// connections open at once (the integration must never open a second one).
// Values made up, never from a real unit.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.80';
export const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
export const SERIAL = 123_456_789_012n;

/** Sets a 32-bit unsigned parameter (low word first). */
export function setU32(regs, address, value) {
  regs.set(address, value & 0xffff);
  regs.set(address + 1, Math.floor(value / 0x10000) & 0xffff);
}

export function getU32(regs, address) {
  return (regs.get(address) ?? 0) + (regs.get(address + 1) ?? 0) * 0x10000;
}

/** Sets a 32-bit float parameter (low word first). */
export function setFloat(regs, address, value) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(value, 0);
  regs.set(address + 1, b.readUInt16BE(0));
  regs.set(address, b.readUInt16BE(2));
}

export function setSerial(regs, serial) {
  for (let i = 0; i < 4; i += 1) {
    regs.set(4 + i, Number((serial >> BigInt(16 * i)) & 0xffffn));
  }
}

/** A unit in manual mode, level 2, no alarm. */
export function defaultMap() {
  const regs = new Map();
  setU32(regs, 2, 0x07000000 | 0x0400 | 0x0040 | 0x0080 | 0x0004); // type 7, HRC2, RH, VOC, bypass
  setSerial(regs, SERIAL);
  setU32(regs, 24, 0x0246); // firmware 2.70
  setFloat(regs, 132, -5.3); // T1 outdoor
  setFloat(regs, 134, 18.5); // T2 supply
  setFloat(regs, 136, 21.4); // T3 extract
  setFloat(regs, 138, 3.1); // T4 exhaust
  setFloat(regs, 140, 20.8); // T5 room
  setU32(regs, 168, 0x0004); // active mode: manual
  setU32(regs, 196, 45); // RH %
  setU32(regs, 198, 0); // bypass closed
  setU32(regs, 324, 2); // fan level 2
  setU32(regs, 430, 640); // VOC ppm
  setU32(regs, 472, 1); // current mode: manual
  setU32(regs, 516, 0); // no alarm
  setU32(regs, 554, 87); // filter days left
  setU32(regs, 558, 0);
  return regs;
}

class FakeSocket extends EventEmitter {
  constructor(unit) {
    super();
    this.unit = unit;
    this.destroyed = false;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.unit.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unit.open.delete(this);
    setImmediate(() => this.emit('close'));
  }

  setNoDelay() {}
}

export function fakeDantherm({ regs = defaultMap(), unitId = 1 } = {}) {
  const unit = {
    regs,
    unitId,
    open: new Set(),
    /** The most connections open at once (must stay 1). */
    maxOpen: 0,
    /** Every request received: { fc, address, count } or { fc, address, value }. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    /** "fc:address" keys or function codes that never answer, or answer an exception. */
    silent: new Set(),
    exceptions: new Set(),
    exceptionCode: 2,
    delays: {},
    /** Writes acknowledged but not applied (an unconfirmed command). */
    ignoreWrites: false,
    /** Delays of the next writes (one each), and writes applied even after their connection closed. */
    writeDelays: [],
    applyClosedWrites: false,
    /** The next connections accepted then closed at once. */
    dropConnections: 0,
    badEcho: false,
    /** Applies a write as the controller would (the current mode follows). */
    apply(address, value) {
      const r = unit.regs;
      if (address === 168) {
        setU32(r, 168, value);
        if (value === 0x0002) setU32(r, 472, 2);
        else if (value === 0x0008) setU32(r, 472, 3);
        else if (value === 0x0004) setU32(r, 472, getU32(r, 324) === 0 ? 0 : 1);
        else if (value === 0x8010 || value === 0x8800 || value === 0x8040) setU32(r, 472, 1);
      } else if (address === 324) {
        setU32(r, 324, value);
        if ([0, 1].includes(getU32(r, 472))) setU32(r, 472, value === 0 ? 0 : 1);
      } else if (address === 558) {
        if (value === 1) setU32(r, 554, 180);
        setU32(r, 558, 0);
      } else {
        setU32(r, address, value);
      }
    },
    handle(socket, frame) {
      const tid = frame.readUInt16BE(0);
      const uid = frame[6];
      const pdu = frame.subarray(7);
      const fc = pdu[0];
      const address = pdu.readUInt16BE(1);
      const count = pdu.readUInt16BE(3);
      const write = fc === 0x10;
      const value = write ? pdu.readUInt16BE(6) + pdu.readUInt16BE(8) * 0x10000 : undefined;
      unit.log.push(write ? { fc, address, value } : { fc, address, count, uid });
      const key = `${fc}:${address}`;
      if (unit.silent.has(key) || unit.silent.has(fc)) return;
      const writeDelay =
        write && unit.writeDelays.length > 0 ? unit.writeDelays.shift() : undefined;
      setTimeout(
        () => {
          if (socket.destroyed) {
            // A write already in the unit is applied even when its connection is gone.
            if (write && unit.applyClosedWrites && !unit.ignoreWrites) unit.apply(address, value);
            return;
          }
          let answer;
          if (unit.exceptions.has(key) || unit.exceptions.has(fc)) {
            answer = Buffer.from([fc | 0x80, unit.exceptionCode]);
          } else if (fc === 3) {
            answer = Buffer.alloc(2 + count * 2);
            answer[0] = fc;
            answer[1] = count * 2;
            for (let i = 0; i < count; i += 1) {
              answer.writeUInt16BE(unit.regs.get(address + i) ?? 0, 2 + i * 2);
            }
          } else if (write) {
            if (!unit.ignoreWrites) unit.apply(address, value);
            answer = Buffer.from(pdu.subarray(0, 5));
            if (unit.badEcho) answer[4] ^= 1;
          } else {
            answer = Buffer.from([fc | 0x80, 1]);
          }
          const out = Buffer.alloc(7 + answer.length);
          out.writeUInt16BE(tid, 0);
          out.writeUInt16BE(0, 2);
          out.writeUInt16BE(answer.length + 1, 4);
          out[6] = uid;
          answer.copy(out, 7);
          socket.emit('data', out);
        },
        writeDelay ?? unit.delays[key] ?? unit.delay,
      );
    },
    connect() {
      const socket = new FakeSocket(unit);
      unit.connections += 1;
      setTimeout(() => {
        if (socket.destroyed) return;
        if (unit.down) {
          unit.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        if (unit.dropConnections > 0) {
          unit.dropConnections -= 1;
          socket.emit('connect');
          setImmediate(() => !socket.destroyed && socket.emit('close'));
          return;
        }
        unit.open.add(socket);
        unit.maxOpen = Math.max(unit.maxOpen, unit.open.size);
        socket.emit('connect');
      }, unit.connectDelay);
      return socket;
    },
    writes: () =>
      unit.log.filter((r) => r.fc === 0x10).map(({ address, value }) => [address, value]),
    reads: () => unit.log.filter((r) => r.fc !== 0x10).length,
    u32: (address) => getU32(unit.regs, address),
  };
  unit.connectFn = () => unit.connect();
  return unit;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
