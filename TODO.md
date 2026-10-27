# TODO — Dantherm / Pluggit v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post from a module session: the batch reserved in /t/10385 gets
  one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-27, lot 17): the unit by IP address and
      Modbus unit id, ten reads every interval over one connection (never
      sooner, even after a restart), one device, the stop (never behind an
      option, kept in /data, resent), the mode select and the filter reset
      behind their options (off), serial check, test button, docs en/fr,
      cover. Tested against a fake controller and a real local TCP server
      only.
- [ ] **Milestone 2 — real unit**: run against a real Dantherm or Pluggit
      unit (see "To check").
- [ ] **Milestone 3 — more**: alarm reset (register 514, the alarm number,
      behind an option: it clears a fire alarm), operating hours (register
      624, a lifetime counter: never 0 nor a drop published, an exit and a
      signal in the status), fan speeds (100, 102: not in the 2013 table),
      bypass and humidity settings, week program number.

## To check on a real unit

- That the unit type is the top byte of `prmSystemID` (Home Assistant) and
  not the low byte (the 2013 table); only shown, never used to decide.
- That writing manual mode then level 0 stops the fans and that
  `prmCurrentBLState` then reads 0 (stand-by) or 1 (manual).
- What the stop does in night mode (16), an override or a fail-safe (no end
  code is written there: the stop may answer "sent, without confirmation").
- How fast `prmCurrentBLState` follows a write of the active mode (the read
  back must see it within 4.3 s of the click, else "sent, without
  confirmation" and the follow-up reads).
- That the filter reset raises the days left at once (the confirmation).
- Whether the controller answers with Home Assistant connected at the same
  time (three sockets at most).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-dantherm:0.1.0`); the
  first patch release gives 0.1.1. The manifest test checks the semver shape
  and that the four agree, never a pinned value.
- **SDK** `^0.16.0` (latest published on 2026-10-27, template's).
- **Manifest**: `gladys_version >=5.1.0`, categories `climate` and
  `environment`; no `keywords`, no `countries` (not yet supported by the
  store validator; to add later: DK, DE).
- **Reference**: Tvalley71/dantherm 1.4.0 (commit 0299247) and
  Tvalley71/pluggit (commit c6894e2), Apache-2.0 (LICENSE files read:
  standard text, no copyright line, no NOTICE), cloned read-only in
  `~/code/ref/lot17/{dantherm,pluggit}`. Register meanings checked against
  the manufacturer's "Pluggit Controller, Modbus Registers Table" (v6b,
  2013-10-21, Web Archive copy of pluggit.com's file). Credited in
  `THIRD_PARTY_NOTICES.md`, copied in the image.
- **Sibling modules**: gladys-salda-smarty (structure, line, polling,
  guards, Modbus client), gladys-sinapsi-alfa (`getConfig()` retried in
  `connected`).
- **Reads**: ten requests covering whole parameters only (identity 2-7,
  current mode, active mode, fan level, alarm, firmware, T1-T5 132-141, RH and
  bypass 196-199, VOC, filter days), never an address the table does not
  list. State blocks are never skipped; a measure block refused or silent
  three times is read again once an hour.
- **Values**: 0 % humidity and VOC 0 are "no sensor" (the table, Home
  Assistant); T5 only with the HRC2 component in the same read; texts as
  stable English keys, never a number.
- **Stop = manual mode (0x0004) then level 0**, as Home Assistant's stand-by.
  Away, summer, fireplace are ended first (0x8010, 0x8800, 0x8040) when the
  stop's own read (0.6 s at most, skipped on failure) shows them; nothing is
  written for night mode.
- **Stop guard** (lot 17 rules): kept in /data with its unit (address, port,
  unit id), its date (a date in the future is invalid), confirmed or not and
  its resends. Never lifted by the time; lifted by a mode written with the
  option (in `beforeSend` of its first write), or by two reads in a row
  showing the unit running when no resend is due (an unknown read resets the
  count). Resends: three at most per stop, at the container start (not
  confirmed), on reads showing the unit running (not confirmed, or within
  two minutes of the stop write in this run).
- **The stop's target**: the configuration's unit, else the last unit kept
  in /data (so it leaves when Gladys does not give the configuration). A
  configuration saved during a stop never interrupts it.
- **Identity**: salted SHA-256 fingerprint of the serial (16 hex), in /data
  with a random salt; another serial: values not published, optional
  commands refused, the test button accepts it; an unreadable serial is never
  "another unit". The identity must be written to /data before a command.
- **/data unreadable**: never written over, optional commands refused, the
  stop still goes.
- **Filter reset** behind its own option (off): it resets the countdown the
  unit uses to ask for a filter change; confirmed only when the days left go
  up.
- **Mode starts a stopped unit** only with the option on, never during a
  stop in flight.
