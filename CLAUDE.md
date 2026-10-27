# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (Modbus TCP goes through `node:net`). It reads a Dantherm
or Pluggit ventilation unit over Modbus TCP (port 502, no cloud, no
authentication) and shows it as one Gladys device; a stop that depends on no
option; the mode and the filter reset behind off-by-default options. Never
tested with a real device, not affiliated with Dantherm or Pluggit.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi test / gi ci                           # the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap; app.boot() first (a stop kept in /data leaves at once)
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                DanthermApp: the line (one session), polling, backoff,
                          device, states, badge, status, test button, commands, stop guard
src/modbus/client.js      Modbus TCP session: MBAP frames, error kinds, beforeSend/startBy
src/modbus/protocol.js    requests, decoders (32-bit, low word first), writes, pure
src/devices.js            -> the Gladys device and its states (pure)
src/publisher.js          states within 300/min
src/store.js              /data/dantherm-state.json: last read, last unit, identity, stop guard
src/config.js             config_schema normalized
src/constants.js          blocks, registers, modes, feature roles, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeDantherm.js  the fake controller behind the injected connector
test/realclock.test.js    real clock x20 and real sockets (~/code/ref/gladys-testkit)
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `dantherm:unit`, feature roles in
  `FEATURES` of `src/constants.js`. Every role is always built.
- Manifest keys (`host`, `unit_id`, `allow_commands`, `allow_filter_reset`,
  `poll_interval`, `language`, the action `test_connection`) are frozen.
- **Only registers of the manufacturer's table**, whole 32-bit parameters,
  both registers in one write (function 0x10).
- **One Modbus connection at a time, one request at a time**: everything goes
  through `useLine`; a command takes the line from a poll, the stop from
  anything; a new connection only once the old socket is closed.
- **The stop** is never held back (option, command, read, backoff, serial,
  /data, configuration from Gladys); never lifted by the time.
- **Commands**: never a switch, a writable binary or a writable fan; refused
  unless their option (checked on arrival and in `beforeSend` of each write);
  decided on a fresh read in the same session; confirmed only by the read
  back; a written command is never "not sent"; never retried; the ack never
  waits for Gladys.
- Never read sooner than the interval (button, scan, reconnection, restart).
- **Answers are hostile**: MBAP frames bounded and checked; implausible
  values unknown; never log the bytes received; never keep the serial.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
