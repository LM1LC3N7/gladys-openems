# FENECON FEMS / OpenEMS

Unofficial integration, not affiliated with FENECON nor the OpenEMS
Association. It reads a **FENECON FEMS** storage system (Home, Commercial) or
any **OpenEMS Edge** on your network, through the local JSON-RPC WebSocket API
of the Edge. **Read-only**: it never changes a setting of the system. No
cloud: the FENECON portal is never contacted.

**Never tested with a real device**: built from the API as the Home Assistant
integration ha_openems uses it. Your feedback is welcome.

## What you get

One device per Edge, named after its host name (e.g. `OpenEMS fems12345`):

- state of charge (%);
- battery power (W, signed: + discharging, - charging);
- grid power (W, signed: + bought from the grid, - sold to it);
- production power (W) and house consumption (W);
- the lifetime energy counters (kWh): production, house consumption, bought
  from the grid, sold to the grid, battery charge and discharge;
- the system state (0 OK, 1 info, 2 warning, 3 fault) and the grid mode
  (1 on-grid, 2 off-grid);
- a **production index** for the Gladys energy monitoring (option
  "Production").

The house consumption and what is bought from the grid are plain sensors,
not counted by the energy monitoring: your main meter already counts them
(they would be billed twice).

## Setup

1. Give the Edge a fixed address in your router.
2. In Gladys, install the integration and fill in:
   - **Edge address**: its IP address; add a port only if it is not 8085
     (`:80` uses the WebSocket of the FEMS web page);
   - **User name**: leave `x` (the Edge recognizes the user by the password);
   - **Password**: the read-only guest is enough; on a FEMS its password is
     usually `user`. The status says so when the password logs in with more
     rights;
   - **Production**: "Energy monitoring" (the production goes to the energy
     monitoring as an index) or "Sensor only" (another integration already
     sends this production to Gladys). Choose before creating the device;
   - **Reading interval**: 30 s by default (30 to 300).
3. Click **Test the connection**, then create the device from the
   **Discover** tab.

## How it reads

Each read opens one connection to the Edge, logs in, subscribes to the values,
takes the first values the Edge sends, and closes. One connection at a time,
never faster than the interval: not on the test button, not on Discovery, not
on a reconnection, not after a restart of the container (it waits the interval
plus one minute after the last session). A new address or a new password is
read at once.

- **Password refused** (the Edge answers "authentication failed"): the reads
  stop until you save a new password or click **Test the connection** (one
  try per click). A closed connection, no answer or another error is not a
  refusal: tried again after 1 min, then up to every 15 min.
- **Identity**: the values only go to the device of the host name read in
  the same session. Without a readable host name, nothing is published; another
  host name at the same address gets its own device.

## Lifetime counters

A lifetime counter only rises. Every counter goes through a guard:

- 0, a missing value or a text is never published;
- a **drop** (a reset, a replaced meter) or a **jump** of more than 100 kW on
  average (plus 0.5 kWh) since the last value is **held back**: the last accepted value is
  sent again, the status shows it, and time never confirms it;
- if it is right, click **Accept the held counter** twice (the first click
  lists, the second, from 3 s to 5 min later, accepts exactly what was
  listed). After a drop is accepted, counting goes on from the new value; the
  energy monitoring counts nothing for the drop. Saving the configuration
  accepts nothing.

## Privacy and security

The password is kept by Gladys in its database, never shown again, sent only
to the Edge on your network, inside the log-in request. It is never written to
the logs, to `/data` nor to a status. After a refused password, `/data` keeps
an 8-bit salted fingerprint of it (to see after a restart whether the form
changed), erased by the next successful log-in. The connection is a plain
WebSocket on your network, as the FEMS web page uses.

## Limits

- One Edge per integration.
- No command: charge limits, the wallbox and the settings of the Edge are not
  available (maybe later, behind an option).
- The signs of the battery and grid powers are the ones OpenEMS documents;
  not checked on a real system yet.
