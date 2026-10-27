// -----------------------------------------------------------------------------
// The pure parts: Modbus PDUs and decoders, the MBAP session against hostile
// answers, the configuration, the device and its states, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_OF, MAX_FRAME, MODES } from '../src/constants.js';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { buildDevice, deviceStates, modeOf, parseFeatureId } from '../src/devices.js';
import { ERROR_KINDS, ModbusSession } from '../src/modbus/client.js';
import {
  decodeBlock,
  float32,
  isWriteAnswer,
  parseRead,
  readRequest,
  uint32,
  writeRequest,
} from '../src/modbus/protocol.js';
import { fileStore, normalizeMemory } from '../src/store.js';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';

test('read requests: function 3, address, count', () => {
  assert.deepEqual([...readRequest(BLOCK_OF.temperatures)], [3, 0, 132, 0, 10]);
  assert.deepEqual([...readRequest(BLOCK_OF.identity)], [3, 0, 2, 0, 6]);
});

test('read answers of the wrong size or function are refused', () => {
  const block = BLOCK_OF.fanLevel;
  assert.deepEqual(parseRead(block, Buffer.from([3, 4, 0, 2, 0, 0])), [2, 0]);
  assert.equal(parseRead(block, Buffer.from([3, 2, 0, 2])), undefined);
  assert.equal(parseRead(block, Buffer.from([3, 4, 0, 2, 0, 0, 0])), undefined);
  assert.equal(parseRead(block, Buffer.from([4, 4, 0, 2, 0, 0])), undefined);
});

test('32-bit parameters: low word first; floats in the same order', () => {
  assert.equal(uint32(0x0246, 0), 0x0246);
  assert.equal(uint32(0x0000, 0x0700), 0x07000000);
  const b = Buffer.alloc(4);
  b.writeFloatBE(18.5, 0);
  assert.equal(float32(b.readUInt16BE(2), b.readUInt16BE(0)), 18.5);
  assert.equal(float32(0xffff, 0x7fff), undefined, 'NaN is unknown');
});

test('decoders: plausible values only', () => {
  const words = (pairs) => pairs.flatMap((v) => [v & 0xffff, Math.floor(v / 0x10000)]);
  assert.deepEqual(decodeBlock(BLOCK_OF.currentMode, words([16])), { currentMode: 'night' });
  assert.deepEqual(decodeBlock(BLOCK_OF.currentMode, words([17])), {});
  assert.deepEqual(decodeBlock(BLOCK_OF.fanLevel, words([5])), {});
  assert.deepEqual(decodeBlock(BLOCK_OF.fanLevel, words([0])), { fanLevel: 0 });
  assert.deepEqual(decodeBlock(BLOCK_OF.alarm, words([14])), { alarm: 'fire', alarmCode: 14 });
  assert.deepEqual(decodeBlock(BLOCK_OF.alarm, words([16])), {
    alarm: 'fire-protection',
    alarmCode: 16,
  });
  assert.deepEqual(
    decodeBlock(BLOCK_OF.alarm, words([0x10000])),
    { alarm: 'unknown-65536', alarmCode: 0x10000 },
    'a code not in the list is shown, never silence',
  );
  assert.deepEqual(decodeBlock(BLOCK_OF.firmware, words([0x0246])), { firmware: '2.70' });
  assert.deepEqual(decodeBlock(BLOCK_OF.climate, words([0, 0x40])), { bypass: 'opening' });
  assert.deepEqual(decodeBlock(BLOCK_OF.climate, words([101, 7])), {}, 'out of range');
  assert.deepEqual(decodeBlock(BLOCK_OF.voc, words([0])), {}, 'no VOC sensor');
  assert.deepEqual(decodeBlock(BLOCK_OF.filter, words([4000])), {});
  const identity = decodeBlock(BLOCK_OF.identity, [0x0440, 0x0700, 0x5678, 0x1234, 0x0001, 0]);
  assert.equal(identity.components, 0x0440);
  assert.equal(identity.unitType, 7);
  assert.equal(identity.serial, String(0x0001_1234_5678n));
  assert.equal(
    decodeBlock(BLOCK_OF.identity, [0, 0, 0, 0, 0, 0]).serial,
    undefined,
    '0 is no serial',
  );
  assert.deepEqual(decodeBlock(BLOCK_OF.fanLevel, [1]), {}, 'wrong length');
});

test('writes: one 32-bit parameter in one request, low word first; the answer checked', () => {
  const request = writeRequest(324, 3);
  assert.deepEqual([...request], [0x10, 0x01, 0x44, 0, 2, 4, 0, 3, 0, 0]);
  assert.ok(isWriteAnswer(request, Buffer.from([0x10, 0x01, 0x44, 0, 2])));
  assert.ok(!isWriteAnswer(request, Buffer.from([0x10, 0x01, 0x44, 0, 1])));
  assert.ok(!isWriteAnswer(request, Buffer.from([0x10, 0x01, 0x45, 0, 2])));
  assert.throws(() => writeRequest(324, -1));
  assert.throws(() => writeRequest(324, 1.5));
  assert.throws(() => writeRequest(324, 0x10000));
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
  }
  write(b) {
    this.written.push(Buffer.from(b));
  }
  destroy() {
    this.destroyed = true;
  }
}

const frame = (tid, unit, pdu) => {
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out[6] = unit;
  Buffer.from(pdu).copy(out, 7);
  return out;
};

test('the session: hostile answers end it, never taken for the answer', async () => {
  // Another transaction id.
  let socket = new FakeSocket();
  let session = new ModbusSession(socket, { unitId: 1 });
  let p = session.request(readRequest(BLOCK_OF.fanLevel));
  let tid = socket.written[0].readUInt16BE(0);
  socket.emit('data', frame((tid + 1) & 0xffff, 1, [3, 4, 0, 2, 0, 0]));
  await assert.rejects(p, (e) => e.kind === ERROR_KINDS.PROTOCOL);
  assert.ok(socket.destroyed);
  // Another unit id.
  socket = new FakeSocket();
  session = new ModbusSession(socket, { unitId: 1 });
  p = session.request(readRequest(BLOCK_OF.fanLevel));
  tid = socket.written[0].readUInt16BE(0);
  socket.emit('data', frame(tid, 2, [3, 4, 0, 2, 0, 0]));
  await assert.rejects(p, (e) => e.kind === ERROR_KINDS.PROTOCOL);
  // A header announcing more than a frame: cut before reading the rest.
  socket = new FakeSocket();
  session = new ModbusSession(socket, { unitId: 1 });
  p = session.request(readRequest(BLOCK_OF.fanLevel));
  const big = Buffer.alloc(8);
  big.writeUInt16BE(socket.written[0].readUInt16BE(0), 0);
  big.writeUInt16BE(0xfff0, 4);
  socket.emit('data', big);
  await assert.rejects(p, (e) => e.kind === ERROR_KINDS.PROTOCOL);
  // More bytes than a Modbus TCP frame in one chunk.
  socket = new FakeSocket();
  session = new ModbusSession(socket, { unitId: 1 });
  p = session.request(readRequest(BLOCK_OF.fanLevel));
  socket.emit('data', Buffer.alloc(MAX_FRAME + 1));
  await assert.rejects(p, (e) => e.kind === ERROR_KINDS.PROTOCOL);
  // An exception: refused, with its code.
  socket = new FakeSocket();
  session = new ModbusSession(socket, { unitId: 1 });
  p = session.request(writeRequest(324, 1));
  tid = socket.written[0].readUInt16BE(0);
  socket.emit('data', frame(tid, 1, [0x90, 2]));
  await assert.rejects(p, (e) => e.kind === ERROR_KINDS.REFUSED && e.code === 2 && e.sent);
  // Bytes with no request waiting.
  socket = new FakeSocket();
  new ModbusSession(socket, { unitId: 1 });
  socket.emit('data', Buffer.from([1, 2, 3]));
  assert.ok(socket.destroyed);
});

test('the address: IPv4 unicast or a host name; never broadcast, multicast, 0.x, nor control characters', () => {
  assert.deepEqual(parseAddress('192.168.1.80'), { host: '192.168.1.80', port: 502 });
  assert.deepEqual(parseAddress('unit.local:1502'), { host: 'unit.local', port: 1502 });
  for (const bad of [
    '255.255.255.255',
    '224.0.0.1',
    '0.0.0.0',
    '192.168.1.80\r\n',
    'a b',
    'unit:0',
    'unit:70000',
    '1.2.3',
    '..',
    'http://x',
  ]) {
    assert.equal(parseAddress(bad), undefined, JSON.stringify(bad));
  }
  const c = normalizeConfig({ host: 'not an address, a pasted key', unit_id: '1' });
  assert.equal(c.address, undefined);
  assert.equal(c.invalid, 28, 'only its length is kept');
  assert.equal(normalizeConfig({ host: '192.168.1.80', unit_id: '' }).address, undefined);
  assert.equal(normalizeConfig({ host: '192.168.1.80', unit_id: 1.5 }).address, undefined);
  assert.equal(
    normalizeConfig({ host: '192.168.1.80', allow_commands: 'yes' }).allowCommands,
    false,
  );
  assert.equal(normalizeConfig({ host: '192.168.1.80' }).allowFilterReset, false);
});

test('the device: every role, labels are strings; states never a text as a number', () => {
  const gladys = createFakeGladys({});
  const device = buildDevice(gladys, { language: 'fr' });
  const mode = device.features.find((f) => f.external_id.endsWith(':mode'));
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    MODES,
  );
  assert.ok(mode.supported_options.every((o) => typeof o.label === 'string' && o.label));
  assert.equal(parseFeatureId(`${device.external_id}:stop`), 'stop');
  assert.equal(parseFeatureId(`${device.external_id}:nope`), undefined);
  const ids = gladys.externalIds('dantherm', 'unit');
  const states = deviceStates(ids, {
    currentMode: 'away',
    fanLevel: 9,
    alarm: 'nope',
    humidity: 0,
  });
  assert.deepEqual(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.text ?? s.state]),
    [['current-mode', 'away']],
  );
  assert.equal(
    modeOf({ currentMode: 'manual', fanLevel: 0 }),
    undefined,
    'level 0 is not a choice',
  );
  assert.equal(modeOf({ currentMode: 'demand' }), 'automatic');
});

test('/data: a date in the future is not valid; bounds; never the serial', () => {
  const now = Date.UTC(2026, 9, 27);
  const m = normalizeMemory(
    {
      lastAttemptAt: now + 1,
      unit: { host: '192.168.1.80', port: 502, unitId: 1 },
      stopGuard: { host: '192.168.1.80', port: 502, unitId: 1, at: now + 1, confirmed: false },
      identity: { unit: 'x', salt: 'nothex', fingerprint: '0123456789abcdef' },
    },
    now,
  );
  assert.equal(m.lastAttemptAt, null);
  assert.equal(m.stopGuard, null);
  assert.equal(m.identity, null);
  assert.deepEqual(m.unit, { host: '192.168.1.80', port: 502, unitId: 1 });
  const g = normalizeMemory(
    { stopGuard: { host: '192.168.1.80', port: 502, unitId: 1, at: now, reasserts: 99 } },
    now,
  ).stopGuard;
  assert.equal(g.reasserts, 3);
  assert.equal(g.confirmed, false);
  assert.equal(normalizeMemory({ unit: { host: 'a\r\nb', unitId: 1 } }, now).unit, null);
});

test('/data on disk: missing is empty, unreadable is never empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dantherm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ lastAttemptAt: 1 });
  assert.deepEqual(await store.load(), { data: { lastAttemptAt: 1 } });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).lastAttemptAt, 1);
  await writeFile(path, '{broken');
  assert.deepEqual(await store.load(), { unreadable: true });
  await writeFile(path, `"${'x'.repeat(9000)}"`);
  assert.deepEqual(await store.load(), { unreadable: true });
});
