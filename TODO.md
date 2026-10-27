# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real FENECON FEMS (Home 10 or 20)
      and, if possible, a plain OpenEMS Edge: log-in with the guest
      password, test button, device creation, the counters over a day.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real system (built without one)

- [ ] The log-in answer of the Edge on port 8085 (OpenEMS `develop`:
      `edges: []`, the role in `user.globalRole`; edge id "0"); the version
      from `_meta/Version`.
- [ ] That `subscribeEdges` is accepted by the Edge (ha_openems sends it in
      direct mode); an error answer, or no answer within 2 s, is ignored.
- [ ] That a guest (password "user" on a FEMS) may subscribe to `_sum/*` and
      `_host/Hostname`, and that a channel missing on an older Edge does not
      refuse the whole subscription (then: "denied" in the status).
- [ ] `_host/Hostname` on every FEMS / OpenEMS version in the field (the
      identity: without it nothing is published).
- [ ] The signs of `_sum/EssActivePower` (OpenEMS: negative = charge) and
      `_sum/GridActivePower` (negative = sell), as documented by OpenEMS.
- [ ] Whether `_sum/*Energy` start at 0 for a few seconds after a restart of
      the Edge (ha_openems has an option for it): the guard holds a drop,
      and the value back to normal ends the hold by itself.
- [ ] Port 80 with path `/websocket` (FEMS web server) as ha_openems "local
      FEMS"; port 8082 (OpenEMS UI backend) is not handled differently.
- [ ] `authenticateWithToken` on a real Edge (review r1: OpenEMS keeps
      every token of `authenticateWithPassword` until a restart; we reuse the
      first one).

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-openems:0.1.0`),
  as for the sibling integrations; the Release workflow owns them from now on.
- **SDK**: `@gladysassistant/integration-sdk` 0.16.0, the latest published
  (registry checked on 2026-10-27). `gladys_version: ">=5.1.0"`, category
  `energy`; no `keywords` nor `countries` in the manifest (home market: DE,
  AT).
- **Reused project**: ha_openems (Lamarqe/ha_openems, Apache-2.0, 1.8.2,
  commit 88224a8 of 2026-10-25, LICENSE checked: Apache-2.0, no copyright
  line, no NOTICE), cloned read-only in `~/code/ref/lot17/ha_openems`: the
  connection types, the JSON-RPC requests, the code 1003 of a wrong
  password, the user "x", the channels. Not ported: the writes
  (`updateComponentConfig`), the FEMS system update, the online portal, the
  REST API, the component scan (`getEdgeConfig`, `getChannelsOfComponent`),
  the templates. OpenEMS itself (AGPL / EPL) is not used nor ported. Structure,
  app, store and guard from gladys-e3dc (the guard is gladys-p1-monitor's, as
  it is); the `connected` retry from gladys-eta; the test clock and the
  WebSocket fake of `~/code/ref/gladys-testkit` copied in `test/kit/`.
- **ws** as a runtime dependency (MIT, already in the tree through the SDK):
  `maxPayload` refuses a long frame from its header, no compression, no
  redirect. Node's built-in WebSocket has no size bound.
- **One session per read**: open, log in, `subscribeEdges`, `subscribeChannels`
  (count 0), the first `currentData` of our Edge holding a number of `_sum`,
  close; the read ends once the socket is closed. One request in flight; only
  the answer with our id; a message arriving before its waiter is kept
  (bounded). Bounds: 256 KiB a message, 40 messages, 500 values; connect 5 s,
  each answer 8 s, the data 8 s, the session 25 s. A stop cuts the session.
- **Refusal**: only the JSON-RPC error 1003 on the log-in (as ha_openems). A
  final stop `{ code, fp }` in `/data` (8-bit salted scrypt of address, user
  name and password), never tried again by itself; the test button tries once
  per click when the interval passed; new fields are tried at once; erased by
  the first success. A closed or silent log-in is no refusal (lot 16, lesson
  7: the Edge answers a wrong password explicitly).
- **Identity**: `edge:<hostname>` (`_host/Hostname`, lower-cased DNS label),
  fixed forever. Asked in every session; no readable host name: nothing
  published (status note); another one: its own device in Discovery.
- **Energy**: the only index is the production (`_sum/ProductionActiveEnergy`,
  `energy-production-sensor` / `index` + its 30-minute feature declared).
  House, grid bought and sold, battery charge and discharge: plain kWh
  sensors (no `energy-sensor`, no `daily-consumption`, never
  `publishEnergyConsumption`): the main meter already counts the house.
  "Sensor only": the same counter as a plain `production_total`; a device
  created with the index keeps it without value; back from "Sensor only",
  the first index value is held as a jump.
- **Lifetime counters**: every one through `IndexGuard` (100 kW, 0.5 kWh):
  never 0 nor a drop published, a drop or a jump held (the last accepted
  value sent again), said in the status and logged once, never confirmed by
  time; "Accept the held counter" in two clicks (3 s to 5 min) accepts both
  directions (a drop is a reset or a new meter: the core counts nothing for
  it). The guard state is in `/data`; a counter is only sent once `/data`
  holds it.
- **/data unreadable ≠ empty**: a file that exists but cannot be read is
  never written over and no counter is sent (status note) until a start reads
  it; a failed write sends the other values only.
- **Pace (lots 11 and 12)**: 30 s by default (30-300 s); the timer looks every
  5 s; nothing reads sooner than the last session + the interval (monotonic):
  not the test button, Discovery, a (re)connection, a save of an unchanged
  form, a restart (the instant written to `/data` before the session, at
  most once a minute; after a restart: that instant + 1 min + the interval).
  Failures: 1 min (or the interval), doubled up to 15 min.
- **`getConfig()` failing in `connected`**: asked again after 5 s, 15 s,
  30 s, then every minute, without end, with a status (lot 17).
- **Strict values**: only finite numbers; a text, null, a boolean or "" is
  unknown, never 0; SoC an integer 0-100, State 0-3, GridMode 1-2 (0 is
  "undefined"); an energy of 0 or below is not available.
- **Signed powers**: battery and grid are one plain signed sensor each, the
  OpenEMS sign in the name; never split nor `grid-sensor`.
- **States per minute**: a sliding budget of 270 states over 60 s.
- **No custom identity**: no User-Agent of an app, the log-in is the one of
  the API. No Bluetooth, no network discovery.

- **Review r1** (2026-10-27): the guards run on the session clock (wall at
  the start + monotonic elapsed), dates loaded from /data or Gladys clamped
  to it; any error ends the session at once; the token of the first log-in
  reused by `authenticateWithToken` (memory only; an unknown token is
  forgotten and the password sent in the same session, only that answer can
  be a refusal); `subscribeEdges` waits 2 s at most; role from
  `user.globalRole`, version from `_meta/Version`; grid mode 3 (off-grid with
  genset); production and house powers down to -100 W shown as 0; the old host
  name never said to answer when none is readable.

- **Review r2** (2026-10-27): /data keeps the dates of the guards on the
  wall clock of the moment they are written (session date + wall - session),
  read back onto the session clock then capped at it; a log-in by token that
  fails in any way (no answer, closed) forgets the token, the next read sends
  the password; the wait after a restart is a monotonic deadline taken at
  load. Left: a life that starts with a wrong wall clock (before NTP) and
  never sees it corrected writes wrong dates; the next life caps a future one
  and only its first read can see a wider margin.

## Ideas

- Keep the session open and take the pushes (as ha_openems) if a real Edge
  dislikes a log-in every 30 s.
- Per-component values (battery modules, PV chargers, meters) read-only.
- Writes (charge limits, wallbox), disabled by default behind an option,
  never a `switch`: out of the first milestone.
