# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- FENECON FEMS / OpenEMS Edge read locally through its JSON-RPC WebSocket API
  (port 8085), read-only: state of charge, battery, grid, production and house
  powers, the lifetime energy counters, the system state and the grid mode.
- A production index for the Gladys energy monitoring (option "Sensor only"
  when another integration already counts the production).
- A guard on every lifetime counter: never 0, a drop or a jump held back and
  said in the status, taken only by "Accept the held counter" clicked twice.
- A refused password stops the reads until new fields or a test click.
- The password is sent once: the next reads log in with the token of the Edge
  (memory only), so the Edge does not keep one token per read; a log-in by
  token the Edge leaves unanswered makes the next reads send the password for
  5 min (doubled while it goes on, up to 6 h) before the token is tried again.
- After a restart of the container, the first read waits the interval and one
  minute after the last session, also in a new process.
- Grid mode 3 (off-grid with a genset).
