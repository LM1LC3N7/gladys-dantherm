# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the projects below. The ported parts
were rewritten, not copied; the changes are described below.

## Tvalley71/dantherm and Tvalley71/pluggit

<https://github.com/Tvalley71/dantherm> (Home Assistant integration for
Dantherm ventilation units, version 1.4.0, commit 0299247 of 2026-10-26) and
<https://github.com/Tvalley71/pluggit> (the same integration for Pluggit
units, commit c6894e2 of 2026-10-01), by Tvalley71. Both are licensed under
the Apache License, Version 2.0, January 2004; their `LICENSE` files hold the
standard text with no copyright line filled in and no `NOTICE` file. The full
text of the license is the `LICENSE` file of this repository (identical
terms), shipped in the Docker image next to this file.

Ported in `src/constants.js`, `src/modbus/protocol.js` and `src/app.js`:

- the protocol addresses of the registers read and written (`modbus.py`):
  system id 2, serial number 4, firmware 24, temperatures 132 to 140, active
  mode 168, humidity 196, bypass damper 198, fan level 324, VOC 430, current
  mode 472, alarm 516, filter days left 554, filter reset 558;
- the 32-bit parameters in two registers, low word first, for unsigned
  integers and floats (`modbus.py`, `convert_from_registers(..., "little")`);
- the unit type in the top byte of the system id and the installed
  components in its low 16 bits (`device.py`);
- the values of the active mode (`ActiveUnitMode`: automatic 0x0002, manual
  0x0004, week program 0x0008, end of away 0x8010, end of summer 0x8800, end
  of fireplace 0x8040), of the current mode (`CurrentUnitMode`) and of the
  bypass damper (`BypassDamperState`) (`device_map.py`);
- stand-by as manual mode with fan level 0, written in that order
  (`set_operation_selection`), and the filter reset as a write of 1
  (`set_filter_reset`);
- 0 read as "no sensor" for humidity and air quality, the room temperature
  bounds (-40 to 70 °C) and the room sensor tied to the HRC2 component
  (`device_map.py`).

The register meanings and the alarm list were checked against the
manufacturer's document "Pluggit Controller, Modbus Registers Table"
(version 6b, 2013-10-21).

Changed: one Modbus TCP connection at a time, closed after each read; every
answer bounded and checked (transaction, unit id, function, size); values
out of range or not finite are unknown, never published; the stop never
depends on an option, is retried, kept in /data and confirmed by a read
back; the mode and the filter reset are off by default and confirmed only
by a read back; no calendar, adaptive trigger, notification or time
synchronization.
