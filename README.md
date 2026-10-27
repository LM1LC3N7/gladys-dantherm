# gladys-dantherm

[Gladys Assistant](https://gladysassistant.com) external integration for
**Dantherm** (HCV, RCV, HCH) and **Pluggit** (AP, iFlow) heat recovery
ventilation, through the **Modbus TCP** interface of their shared controller
on the local network (port 502, no cloud, no password): temperatures T1 to
T5, current mode, fan level, alarm, bypass damper, humidity, air quality and
filter days left; a "Stop the ventilation" button that depends on no option;
the mode and the filter reset behind off-by-default options. **Never tested
with a real device. Not affiliated with Dantherm or Pluggit.** Modbus TCP has
no authentication: keep the unit on a trusted network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (DanthermApp)
                                  ├─ src/modbus/client.js    one Modbus TCP session at a time, bounded MBAP frames
                                  ├─ src/modbus/protocol.js  requests and decoders (pure)
                                  ├─ src/devices.js          the device and its states (pure)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/dantherm-state.json
```

- **Reads**: one Modbus TCP connection per poll (every 60 s, 30 s – 1 h), ten
  read requests of whole 32-bit parameters of the manufacturer's table, then
  closed (the next connection once the socket is closed, 500 ms at most). Never sooner
  than the interval (test button, Discovery, reconnection, unchanged
  configuration, container restart: the time of the last read is kept in
  `/data`, written at most once a minute, before the read). Failures retried
  after 30 s to 5 min, never under the interval.
- **Device**: `ext:<selector>:dantherm:unit` (never the address nor the
  serial). Every feature is always published; no switch, no writable binary
  or fan. The serial number is checked at each read and before each command
  (a salted fingerprint in `/data`).
- **Stop the ventilation** (protective): level 0, manual mode, level 0 again
  (away, summer, fireplace or night ended first, after a read of the mode
  that a failure never skips). Confirmed only by stand-by or manual level 0.
  Never behind an option, another command, a read (it takes the line), a
  backoff, the serial, `/data` or the configuration from Gladys (the last
  unit is kept in `/data`); retried every 250 ms until 3.5 s (exceptions
  4-6 included); kept in `/data`; a stop not confirmed is sent again at the
  container start and by the reads showing the unit running (three times at
  most, then the status says it did not take); a confirmed one by the first
  read begun after its write only. Never lifted by the time: only by a mode
  written with the option, or, after a confirmed stop, two reads in a row
  showing the unit running.
- **Mode** (`allow_commands`, off) and **filter reset**
  (`allow_filter_reset`, off): decided on a fresh read in their own session,
  refused in a mode Gladys does not set and in fire alarm, first write
  within 3.5 s, confirmed only by the read back by 4.3 s; otherwise "sent,
  without confirmation", a guard and reads 5 s and 20 s later.

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
gi ci            # the whole CI locally (VM tooling)
```

See [CLAUDE.md](CLAUDE.md) for the rules and [TODO.md](TODO.md) for the
status and decisions. Licensed under the Apache License 2.0; ported logic is
credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
