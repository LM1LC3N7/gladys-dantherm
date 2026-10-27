// -----------------------------------------------------------------------------
// The app on a REAL moving clock, sped up 20 times (30 s of the interval are
// 1.5 s), against a real local Modbus TCP server (the shared test kit): the
// reads really start at the interval, never sooner; the stop goes through a
// frozen read on a real socket, one connection at a time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, realClock, spyOn, tcpServer } from './kit/index.mjs';
import { DanthermApp } from '../src/app.js';
import { tcpConnect } from '../src/modbus/client.js';
import { POLL_INTERVAL, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { defaultMap, fakeDantherm } from './fixtures/fakeDantherm.js';

const SPEED = 20;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** The real connector, counting the client sockets open at once (until their 'close'). */
function countingConnect() {
  const counter = { open: 0, peak: 0 };
  counter.connect = (host, port) => {
    const socket = tcpConnect(host, port);
    counter.open += 1;
    counter.peak = Math.max(counter.peak, counter.open);
    socket.once('close', () => {
      counter.open -= 1;
    });
    return socket;
  };
  return counter;
}

/** A Modbus TCP server answering from the fake's registers (frames may arrive glued). */
async function modbusServer() {
  const unit = fakeDantherm({ regs: defaultMap() });
  const state = { frozen: new Set(), writes: [] };
  const server = await tcpServer({
    onData(chunk) {
      const out = [];
      for (let at = 0; at + 7 <= chunk.length;) {
        const length = chunk.readUInt16BE(at + 4);
        const frame = chunk.subarray(at, at + 6 + length);
        at += 6 + length;
        const pdu = frame.subarray(7);
        const address = pdu.readUInt16BE(1);
        if (state.frozen.has(address)) continue;
        let answer;
        if (pdu[0] === 3) {
          const count = pdu.readUInt16BE(3);
          answer = Buffer.alloc(2 + count * 2);
          answer[0] = 3;
          answer[1] = count * 2;
          for (let i = 0; i < count; i += 1)
            answer.writeUInt16BE(unit.regs.get(address + i) ?? 0, 2 + i * 2);
        } else {
          const value = pdu.readUInt16BE(6) + pdu.readUInt16BE(8) * 0x10000;
          state.writes.push([address, value]);
          unit.apply(address, value);
          answer = Buffer.from(pdu.subarray(0, 5));
        }
        const head = Buffer.alloc(7);
        frame.copy(head, 0, 0, 7);
        head.writeUInt16BE(answer.length + 1, 4);
        out.push(head, answer);
      }
      return out.length ? Buffer.concat(out) : undefined;
    },
  });
  return { server, unit, state };
}

test('real clock: the reads come at the interval, never sooner', async (t) => {
  const { server } = await modbusServer();
  const clock = realClock({ speed: SPEED });
  t.after(async () => {
    clock.close();
    await server.close();
  });
  const gladys = createFakeGladys({ config: { host: `127.0.0.1:${server.port}` } });
  await gladys.connect();
  const app = new DanthermApp({
    gladys,
    logger: quiet,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  await app.connected({ host: `127.0.0.1:${server.port}` });
  await measurePeriod(spy, { count: 3, period: POLL_INTERVAL.default * SECOND });
  app.shutdown();
  assert.equal(server.peak, 1, 'one connection at a time');
});

test('real sockets: the stop goes through a frozen read, one connection at a time', async (t) => {
  const { server, state } = await modbusServer();
  const clock = realClock({ speed: SPEED });
  t.after(async () => {
    clock.close();
    await server.close();
  });
  const config = { host: `127.0.0.1:${server.port}` };
  const gladys = createFakeGladys({ config });
  await gladys.connect();
  const store = memoryStore();
  const sockets = countingConnect();
  const app = new DanthermApp({
    gladys,
    logger: quiet,
    connect: sockets.connect,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store,
  });
  await app.connected(config);
  // The next read hangs on the temperatures (no byte comes back).
  state.frozen.add(132);
  app.clearTimer();
  const reading = app.tick();
  await clock.sleep(500);
  const started = clock.monotonic();
  await app.protect(clock.monotonic());
  const took = clock.monotonic() - started;
  assert.ok(took < 4_300, `answered in ${Math.round(took)} ms (simulated)`);
  assert.deepEqual(state.writes, [
    [324, 0],
    [168, 4],
    [324, 0],
  ]);
  assert.equal(store.data.stopGuard.confirmed, true);
  await reading;
  app.shutdown();
  assert.equal(sockets.peak, 1, 'a new connection only once the old one is closed');
});
