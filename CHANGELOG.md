# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- Dantherm (HCV, RCV, HCH) and Pluggit (AP, iFlow) heat recovery ventilation
  over local Modbus TCP: temperatures T1 to T5, current mode, fan level,
  alarm, bypass damper, humidity, air quality and filter days left.
- "Stop the ventilation" (level 0 then manual mode; away, summer, fireplace
  or night ended first), which depends on no option, is confirmed only by
  stand-by or manual level 0, kept in /data and sent again when not
  confirmed (the guide lists when it can fail).
- The mode (automatic, week program, manual level 1 to 4) behind "Allow the
  mode commands" and the filter reset behind "Allow the filter reset", both
  off by default.
- "Test the connection" button, docs in English and French, cover image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-dantherm/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-dantherm/releases/tag/v0.1.1
