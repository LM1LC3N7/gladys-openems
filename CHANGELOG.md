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
