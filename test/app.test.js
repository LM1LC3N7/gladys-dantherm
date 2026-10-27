// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake controller, with
// the exact wiring of the container (src/handlers.js) and a mocked clock. The
// monotonic clock follows the mocked Date and moves a little at each reading
// (a decision that reads it twice sees it move).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DanthermApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  NOW,
  SERIAL,
  fakeDantherm,
  setSerial,
  setU32,
  settle,
} from './fixtures/fakeDantherm.js';

const CFG = { host: HOST };
const ALLOW = { host: HOST, allow_commands: true };
const DEVICE = 'ext:test-integration:dantherm:unit';
const feature = (role) => `${DEVICE}:${role}`;
const STOP = [
  [168, 4],
  [324, 0],
];
const UNIT = { host: HOST, port: 502, unitId: 1 };

async function setup(
  t,
  { config = CFG, unit = fakeDantherm(), store = memoryStore(), create = true, before } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  let drift = 0;
  const app = new DanthermApp({
    gladys,
    logger,
    connect: unit.connectFn,
    now: () => Date.now(),
    // Moves at each reading: never the same time read twice.
    clock: () => Date.now() + (drift += 1e-4),
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(3);
    }
  };
  t.after(() => app.shutdown());
  await before?.({ app, gladys, unit, advance });
  const connecting = gladys.connect();
  await settle();
  await advance(800);
  await connecting;
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
    await advance(1100);
  }
  const fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE) ?? {
      external_id: DEVICE,
    };
    return gladys.fake.setValue(device, { external_id: feature(role) }, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = fire(role, value);
    await advance(wait, 50);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  const status = () => gladys.fake.connectionStatus;
  return { gladys, app, unit, advance, logs, fire, press, store, state, status };
}

test('discovery: one device, every value read and published, one connection', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      (f.category === 'button' && f.type === 'push') ||
        (f.category === 'text' && f.type === 'select'),
      `${f.external_id} is writable`,
    );
  }
  const mode = device.features.find((f) => f.external_id === feature('mode'));
  for (const option of mode.supported_options) {
    assert.equal(typeof option.label, 'string');
  }
  assert.equal(ctx.state('temperature-outdoor').state, -5.3);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('temperature-extract').state, 21.4);
  assert.equal(ctx.state('temperature-exhaust').state, 3.1);
  assert.equal(ctx.state('temperature-room').state, 20.8);
  assert.equal(ctx.state('humidity').state, 45);
  assert.equal(ctx.state('air-quality').state, 640);
  assert.equal(ctx.state('filter-days-left').state, 87);
  assert.equal(ctx.state('fan-level').state, 2);
  assert.equal(ctx.state('mode').text, 'manual-2');
  assert.equal(ctx.state('current-mode').text, 'manual');
  assert.equal(ctx.state('alarm').text, 'none');
  assert.equal(ctx.state('alarm-active').state, 0);
  assert.equal(ctx.state('bypass').text, 'closed');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.fr, /type 7, firmware 2\.70/);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.device_external_id ?? badge.external_id, DEVICE);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // Only reads of whole parameters of the manufacturer's table, one connection, closed after.
  assert.deepEqual(
    ctx.unit.log.slice(0, 10).map((r) => [r.fc, r.address, r.count]),
    [
      [3, 2, 6],
      [3, 472, 2],
      [3, 168, 2],
      [3, 324, 2],
      [3, 516, 2],
      [3, 24, 2],
      [3, 132, 10],
      [3, 196, 4],
      [3, 430, 2],
      [3, 554, 2],
    ],
  );
  assert.equal(ctx.unit.open.size, 0);
  assert.equal(ctx.unit.maxOpen, 1);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('no sensor: T5 without HRC2, 0 % humidity and VOC 0 are never published', async (t) => {
  const unit = fakeDantherm();
  setU32(unit.regs, 2, 0x07000000);
  setU32(unit.regs, 196, 0);
  setU32(unit.regs, 430, 0);
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('temperature-room'), undefined);
  assert.equal(ctx.state('humidity'), undefined);
  assert.equal(ctx.state('air-quality'), undefined);
  // A text is never a number (no measure 0 for a text).
  for (const s of ctx.gladys.fake.states.filter((s) =>
    /(alarm|bypass|current-mode)$/.test(s.device_feature_external_id),
  )) {
    assert.equal(typeof s.text, 'string');
    assert.equal(s.state, undefined);
  }
});

test('the commands are off by default: refused, nothing written', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('mode', 'manual-3');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Autoriser les commandes de mode/);
  const reset = await ctx.press('filter-reset');
  assert.equal(reset.success, false);
  assert.match(String(reset.error), /remise à zéro des filtres/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a mode: decided on a fresh read, both parameters written, confirmed by the read back', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const ack = await ctx.press('mode', 'manual-3');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [
    [168, 4],
    [324, 3],
  ]);
  assert.equal(ctx.state('fan-level').state, 3);
  assert.equal(ctx.unit.maxOpen, 1);
  // Already so: nothing sent.
  assert.equal((await ctx.press('mode', 'manual-3')).success, true);
  assert.equal(ctx.unit.writes().length, 2);
  // Automatic: one write.
  assert.equal((await ctx.press('mode', 'automatic')).success, true);
  assert.deepEqual(ctx.unit.writes().at(-1), [168, 2]);
});

test('the select takes only its values (never a number, never trimmed)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const value of ['standby', ' manual-1', 'MANUAL-1', 2, '', null]) {
    assert.equal((await ctx.press('mode', value, 100)).success, false, String(value));
  }
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a special mode (away) or a fire alarm: the mode is refused, the stop is not', async (t) => {
  const unit = fakeDantherm();
  setU32(unit.regs, 472, 5);
  const ctx = await setup(t, { config: ALLOW, unit });
  const ack = await ctx.press('mode', 'manual-1');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /absence/);
  assert.deepEqual(ctx.unit.writes(), []);
  // The stop ends the away mode first, then manual, level 0.
  const stop = await ctx.press('stop');
  assert.equal(stop.success, true, String(stop.error));
  assert.deepEqual(ctx.unit.writes(), [[168, 0x8010], ...STOP]);
  // Fire alarm.
  setU32(unit.regs, 516, 12);
  const fire = await ctx.press('mode', 'manual-1');
  assert.equal(fire.success, false);
  assert.match(String(fire.error), /incendie/);
});

test('an unreadable state refuses the command (never decided on memory)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('3:324');
  const ack = await ctx.press('mode', 'manual-3');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /n’a pas pu être relu/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a write the unit refuses (exception 2): refused, not applied; exception 6: sent, unconfirmed', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('16:168');
  let ack = await ctx.press('mode', 'manual-3');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /a refusé la commande/);
  ctx.unit.exceptionCode = 6;
  ack = await ctx.press('mode', 'manual-3');
  assert.match(String(ack.error), /envoyée, sans confirmation/);
});

test('a write not applied, or a wrong answer: "sent, without confirmation", never a success', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.ignoreWrites = true;
  let ack = await ctx.press('mode', 'manual-4');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /envoyée, sans confirmation \(pas encore appliquée\)/);
  ctx.unit.ignoreWrites = false;
  ctx.unit.badEcho = true;
  ack = await ctx.press('mode', 'manual-1');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /envoyée, sans confirmation/);
});

test('the option turned off during the fresh read: refused, nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 300;
  const ack = ctx.fire('mode', 'manual-3');
  await ctx.advance(200);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(4 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a slow unit: refused unsent within the deadline', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 1_300;
  const ack = await ctx.press('mode', 'manual-3', 5 * SECOND);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /trop lentement|non envoyée/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the stop: never behind an option, confirmed by the read back, kept in /data', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(ctx.state('fan-level').state, 0);
  const guard = ctx.store.data.stopGuard;
  assert.equal(guard.confirmed, true);
  assert.equal(guard.host, HOST);
  assert.ok(guard.at <= Date.now());
  assert.equal(ctx.unit.maxOpen, 1);
});

test('the stop goes with another serial, /data unreadable or a fire alarm', async (t) => {
  const store = memoryStore(null, { unreadable: true });
  const unit = fakeDantherm();
  setU32(unit.regs, 516, 12);
  const ctx = await setup(t, { config: ALLOW, store, unit });
  assert.match(ctx.status().message.fr, /illisible/);
  const refused = await ctx.press('mode', 'manual-1');
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /\/data est illisible/);
  assert.equal((await ctx.press('stop')).success, true);
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(store.saves, 0, '/data never written over');
});

test('the stop takes the line from a frozen read (not a failure)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.silent.add('3:132');
  await ctx.advance(60 * SECOND, 100);
  // The read hangs on the temperatures: the stop takes the line.
  const ack = ctx.fire('stop');
  ctx.unit.silent.clear();
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, true);
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(ctx.unit.maxOpen, 1);
  assert.equal(ctx.app.unit.online, true, 'an aborted read is not a failure');
});

test('the stop cancels a mode not written yet: nothing emitted before it leaves after it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 200;
  const mode = ctx.fire('mode', 'manual-4');
  await ctx.advance(300);
  const stop = ctx.fire('stop');
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await mode).success, false);
  assert.match(String((await mode).error), /arrêtée entre-temps|configuration/);
  assert.equal((await stop).success, true);
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('the stop tries again a refused or dropped connection until 3.5 s', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  ctx.unit.dropConnections = 1;
  const ack = ctx.fire('stop');
  await ctx.advance(1_000, 20);
  ctx.unit.down = false;
  await ctx.advance(4 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('the stop with Gladys unable to give the configuration: the last unit kept in /data', async (t) => {
  const store = memoryStore({ unit: UNIT });
  const ctx = await setup(t, {
    store,
    before: ({ gladys }) => {
      // The fake reads it once in connect(): the handler's reads fail.
      const real = gladys.getConfig.bind(gladys);
      let calls = 0;
      gladys.getConfig = async () => {
        calls += 1;
        if (calls === 1) return real();
        throw new Error('timeout');
      };
    },
  });
  assert.match(ctx.status().message.fr, /configuration n’a pas pu être lue/);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('getConfig() failing in connected is tried again without end, then the reads start', async (t) => {
  let fails = 2;
  const ctx = await setup(t, {
    create: false,
    before: ({ gladys }) => {
      const real = gladys.getConfig.bind(gladys);
      let calls = 0;
      gladys.getConfig = async () => {
        calls += 1;
        if (calls > 1 && fails > 0) {
          fails -= 1;
          throw new Error('timeout');
        }
        return real();
      };
    },
  });
  assert.equal(ctx.unit.reads(), 0);
  assert.match(ctx.status().message.en, /next try in 5 s/);
  await ctx.advance(5 * SECOND, 100);
  assert.match(ctx.status().message.en, /next try in 10 s/);
  await ctx.advance(11 * SECOND, 100);
  assert.equal(ctx.status().connected, true);
  assert.ok(ctx.unit.reads() >= 10);
  // A reconnection whose read fails keeps reading with the configuration in use.
  fails = 1;
  await ctx.app.connectedFrom(() => ctx.gladys.getConfig());
  assert.match(ctx.status().message.en, /could not be read from Gladys/);
  const reads = ctx.unit.reads();
  await ctx.advance(61 * SECOND, 200);
  assert.ok(ctx.unit.reads() > reads, 'the reads go on');
  assert.doesNotMatch(ctx.status().message.en, /could not be read/);
});

test('a stop not confirmed in /data leaves at the container start, before Gladys and any read', async (t) => {
  const store = memoryStore({
    unit: UNIT,
    stopGuard: { ...UNIT, at: NOW - 30 * SECOND, confirmed: false, reasserts: 0 },
  });
  const unit = fakeDantherm();
  let writesBeforeConnect;
  await setup(t, {
    store,
    unit,
    before: async ({ app, advance }) => {
      await app.boot();
      await advance(1_000, 20);
      writesBeforeConnect = unit.writes();
    },
  });
  assert.deepEqual(writesBeforeConnect, STOP);
  assert.equal(store.data.stopGuard.confirmed, true);
  assert.equal(store.data.stopGuard.reasserts, 1);
});

test('a stop kept with a date in the future, or resent three times, is not sent at start', async (t) => {
  const store = memoryStore({
    unit: UNIT,
    stopGuard: { ...UNIT, at: NOW + 60 * MINUTE, confirmed: false, reasserts: 0 },
  });
  const ctx = await setup(t, { store });
  assert.deepEqual(ctx.unit.writes(), []);
  assert.equal(store.data.stopGuard, null);
});

test('a stop not applied: "sent, without confirmation", resent by the reads three times, then lifted by two running reads', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('stop', 1, 5 * SECOND);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /envoyée, sans confirmation/);
  assert.match(ctx.status().message.fr, /pas confirmé/);
  // Follow-ups and polls send it again, three times at most.
  await ctx.advance(4 * MINUTE, 200);
  const stops = ctx.unit.writes().filter(([a, v]) => a === 324 && v === 0).length;
  assert.equal(stops, 4, 'the stop and three resends');
  assert.equal(ctx.store.data.stopGuard, null, 'lifted by two reads running in a row');
  assert.match(ctx.status().message.fr, /relancée hors de Gladys/);
});

test('a write of an older command landing after a stop: the next read sends the stop again', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.applyClosedWrites = true;
  // The level write of the mode is slow: it lands after the stop closed its connection.
  ctx.unit.writeDelays = [10, 1_500];
  const mode = ctx.fire('mode', 'manual-4');
  await ctx.advance(200, 10);
  const stop = ctx.fire('stop');
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await stop).success, true);
  assert.match(String((await mode).error), /sans confirmation/);
  assert.equal(ctx.unit.u32(324), 4, 'the older write landed after the stop');
  await ctx.advance(30 * SECOND, 100);
  const writes = ctx.unit.writes();
  assert.ok(
    writes.filter(([a, v]) => a === 324 && v === 0).length >= 2,
    `the stop sent again: ${JSON.stringify(writes)}`,
  );
  assert.equal(ctx.unit.u32(324), 0, 'stopped in the end');
  assert.ok(ctx.store.data.stopGuard, 'the guard stays');
});

test('a mode written with the option lifts the stop guard (the latest wish)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  assert.ok(ctx.store.data.stopGuard);
  assert.equal((await ctx.press('mode', 'manual-2')).success, true);
  assert.equal(ctx.store.data.stopGuard, null);
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(ctx.unit.u32(324), 2, 'never stopped again');
});

test('a restart outside Gladys long after a stop: never fought, lifted after two reads', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('stop')).success, true);
  await ctx.advance(3 * MINUTE, 200);
  ctx.unit.apply(168, 4);
  ctx.unit.apply(324, 3);
  await ctx.advance(61 * SECOND, 200);
  assert.ok(ctx.store.data.stopGuard, 'one read running is not enough');
  await ctx.advance(2 * MINUTE, 200);
  assert.equal(ctx.unit.u32(324), 3, 'not stopped again');
  assert.equal(ctx.store.data.stopGuard, null);
});

test('the filter reset: behind its option, confirmed only when the days go up', async (t) => {
  const ctx = await setup(t, { config: { host: HOST, allow_filter_reset: true } });
  const ack = await ctx.press('filter-reset');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [[558, 1]]);
  assert.equal(ctx.state('filter-days-left').state, 180);
  ctx.unit.ignoreWrites = true;
  const again = await ctx.press('filter-reset');
  assert.equal(again.success, false);
  assert.match(String(again.error), /pas encore appliquée/);
});

test('another serial: nothing published, commands refused, stop goes, the button accepts it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const states = ctx.gladys.fake.states.length;
  setSerial(ctx.unit.regs, SERIAL + 1n);
  setU32(ctx.unit.regs, 554, 12);
  await ctx.advance(61 * SECOND, 200);
  assert.match(ctx.status().message.fr, /numéro de série de la centrale a changé/);
  assert.equal(
    ctx.gladys.fake.states
      .slice(states)
      .filter((s) => s.device_feature_external_id === feature('filter-days-left')).length,
    0,
  );
  const ack = await ctx.press('mode', 'manual-3');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /numéro de série/);
  assert.equal((await ctx.press('stop')).success, true);
  const answer = await ctx.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /acceptée/);
  assert.doesNotMatch(ctx.status().message.fr, /a changé/);
  await ctx.advance(61 * SECOND, 200);
  assert.equal(ctx.state('filter-days-left').state, 12);
  assert.doesNotMatch(
    JSON.stringify(ctx.store.data),
    new RegExp(String(SERIAL + 1n)),
    'never the serial',
  );
});

test('the identity is in /data before a command: a failed save refuses it', async (t) => {
  const store = memoryStore();
  store.failSaves = true;
  const ctx = await setup(t, { config: ALLOW, store });
  const ack = await ctx.press('mode', 'manual-3');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /\/data/);
  assert.deepEqual(ctx.unit.writes(), []);
  assert.equal((await ctx.press('stop')).success, true, 'the stop is never held by /data');
});

test('never read sooner than the interval: button, scan, reconnection, same config', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.unit.reads();
  await ctx.gladys.fake.action('test_connection');
  await ctx.gladys.fake.scanRequest();
  await ctx.app.connected(CFG);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(2 * SECOND);
  assert.equal(ctx.unit.reads(), reads);
  await ctx.advance(60 * SECOND, 200);
  assert.equal(ctx.unit.reads(), reads + 10);
});

test('a restart waits for the interval after the last read kept in /data', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 10 * SECOND });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.unit.reads(), 0);
  assert.match(ctx.status().message.en, /Next read/);
  await ctx.advance(2 * MINUTE, 500);
  assert.equal(ctx.unit.reads(), 10);
});

test('configurations saved back to back apply one at a time, the last one wins', async (t) => {
  const ctx = await setup(t);
  const a = ctx.gladys.fake.configUpdated({ host: '192.168.1.81' });
  const b = ctx.gladys.fake.configUpdated({ host: '192.168.1.82' });
  const c = ctx.gladys.fake.configUpdated({ host: HOST, poll_interval: 120 });
  await ctx.advance(2 * SECOND);
  await Promise.all([a, b, c]);
  assert.equal(ctx.app.config.address.host, HOST);
  assert.equal(ctx.app.config.pollInterval, 120);
});

test('an unreachable unit: status says so, retried with a backoff, device unreachable', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  await ctx.advance(61 * SECOND, 200);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.en, /No answer from 192\.168\.1\.80/);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('a measure block refused is skipped for an hour, the others still read', async (t) => {
  const unit = fakeDantherm();
  unit.exceptions.add('3:430');
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('air-quality'), undefined);
  assert.equal(ctx.state('filter-days-left').state, 87);
  const count = () => ctx.unit.log.filter((r) => r.address === 430).length;
  const before = count();
  await ctx.advance(5 * MINUTE, 500);
  assert.equal(count(), before, 'skipped');
});

test('the status and Discovery are sent again at each reconnection, without a read', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.unit.reads();
  const discovered = ctx.gladys.fake.discoveredDevices.length;
  const states = ctx.gladys.fake.states.length;
  await ctx.app.connectedFrom(() => ctx.gladys.getConfig());
  await ctx.advance(2 * SECOND, 100);
  assert.equal(ctx.unit.reads(), reads);
  assert.equal(ctx.gladys.fake.states.length, states, 'nothing old sent again as new');
  assert.ok(ctx.gladys.fake.discoveredDevices.length >= discovered);
  assert.equal(ctx.status().connected, true);
});

test('a configuration saved during a stop never interrupts it', async (t) => {
  const ctx = await setup(t);
  ctx.unit.delay = 200;
  const ack = ctx.fire('stop');
  await ctx.advance(300, 10);
  await ctx.gladys.fake.configUpdated({ host: '192.168.1.81' });
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('a stop that took effect meanwhile: the mode gives way before its write', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 300;
  const ack = ctx.fire('mode', 'manual-3');
  await ctx.advance(400, 10);
  // A stop counted (as if it ran between two awaits of the command).
  ctx.app.protectSeq += 1;
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.match(String((await ack).error), /arrêtée entre-temps/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the option turned off between the two writes: the second never leaves', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.writeDelays = [600];
  const ack = ctx.fire('mode', 'manual-3');
  await ctx.advance(300, 10);
  assert.deepEqual(ctx.unit.writes(), [[168, 4]]);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.match(String((await ack).error), /envoyée, sans confirmation/);
  assert.deepEqual(ctx.unit.writes(), [[168, 4]]);
});

test('a mode refused by its option never takes the line from a read', async (t) => {
  const ctx = await setup(t);
  ctx.unit.delay = 100;
  await ctx.advance(55 * SECOND, 500);
  for (let i = 0; i < 200 && !ctx.app.active; i += 1) await ctx.advance(50, 10);
  assert.equal(ctx.app.active?.kind, 'read', 'a read in progress');
  assert.equal((await ctx.press('mode', 'manual-3', 100)).success, false);
  await ctx.advance(3 * SECOND, 50);
  assert.ok(!ctx.logs.some((l) => l.includes('read dropped')), ctx.logs.join('\n'));
});

test('another serial at the address: a stop guard never sends to it', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  const ack = ctx.fire('stop');
  await ctx.advance(4_500, 50);
  assert.equal((await ack).success, false);
  setSerial(ctx.unit.regs, SERIAL + 7n);
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(ctx.unit.writes().filter(([a, v]) => a === 324 && v === 0).length, 1);
});

test('a device created long after the last read gets no old value', async (t) => {
  const ctx = await setup(t, { create: false });
  ctx.unit.down = true;
  await ctx.advance(3 * MINUTE, 500);
  const states = ctx.gladys.fake.states.length;
  await ctx.gladys.fake.deviceCreated(ctx.gladys.fake.discoveredDevices[0]);
  await ctx.advance(2 * SECOND, 100);
  assert.equal(ctx.gladys.fake.states.length, states);
});
