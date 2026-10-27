# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Its runtime dependencies are the SDK and `ws`. It started from the official
JavaScript template.

It reads a **FENECON FEMS / OpenEMS Edge** through the JSON-RPC WebSocket API
of the Edge (port 8085): log-in, subscription to the `_sum` channels and
`_host/Hostname`, first values, close. Requests ported from
[ha_openems](https://github.com/Lamarqe/ha_openems) (Apache-2.0, see
`THIRD_PARTY_NOTICES.md`); OpenEMS itself (AGPL / EPL) is never copied nor
ported. Unofficial. **Read-only**: never `onSetValue`, never a request that
sets anything. Siblings: `gladys-e3dc` (structure, app, store),
`gladys-p1-monitor` (`src/guard.js`), `gladys-eta` (`connected` retry).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/client.test.js           # one file (a fake Edge on 127.0.0.1)
node --test --test-name-pattern "counter" # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/cover.mjs cover.png          # the store cover (800×534)
```

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every handler, registered before connect()
src/app.js                        OpenemsApp: pace, reads, identity, counters, refusal, buttons
src/openems/client.js             the only network access: one WebSocket session at a time
src/openems/model.js              the channels and their values (pure, strict)
src/guard.js                      plausibility of a lifetime counter (gladys-p1-monitor, as it is)
src/store.js                      what /data keeps across restarts (unreadable ≠ empty)
src/devices.js                    the device, feature keys, catalog, states (pure)
src/config.js                     the form, normalized
src/constants.js                  timings, bounds, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
test/kit/                         copied from ~/code/ref/gladys-testkit (clock, WebSocket fake)
test/helpers/fakeEdge.js          a fake Edge on a real WebSocket server
```

## Rules

- **Read-only.** No `onSetValue`; the client sends only
  `authenticateWithPassword`, `subscribeEdges` and `subscribeChannels`. A
  command, if one is ever added, is a `button` disabled by default behind an
  option, never a `switch`.
- **Secrets**: the password only goes into the log-in request to the
  configured address; never logged, shown, written to `/data` nor put in an
  error. `/data` keeps only an 8-bit fingerprint of a REFUSED log-in, erased
  by the first success. Never the forbidden word for secrets
  (`test/encoding.test.js`).
- **Refusal**: only the error 1003 on the log-in; a final stop in `/data`,
  only new fields or the test button (one try per click) try again.
- **Pace**: never a read faster than the interval, whatever asks. One session
  at a time; a stop cuts it. A read of an old generation publishes nothing
  and sets no status. Each decision reads each clock once.
- **Lifetime counters** (`COUNTERS` in `src/devices.js`): through
  `IndexGuard`, never 0, never a drop nor a jump without the two-click action.
  The production index is the only index; everything else is a plain sensor.
- **External ids are forever**: `edge:<hostname>`, the `FEATURE` keys, the
  manifest keys. The device published again never loses a feature.
- **Units**: only those of `DEVICE_FEATURE_UNITS_BY_CATEGORY` in the core.
- **The container rootfs is read-only.** Write only `/data/openems-state.json`.
- **Versions belong to the Release workflow.** Never edit `version` by hand.
- **Changelog** under `## [Unreleased]`; **manifest** texts `{ en, fr }`; no
  `default` on a secret; UTF-8 without BOM nor control byte.
- **Tests never leave the machine** (127.0.0.1 only); `mkdtemp` folders are
  removed in `t.after`.
