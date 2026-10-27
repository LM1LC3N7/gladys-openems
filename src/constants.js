// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js, the external id rule) is
// forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held_counter' };

/**
 * The external id of the system: `edge:<hostname>`, the host name the Edge
 * gives in its channel `_host/Hostname` (src/openems/model.js hostnameOf),
 * lower-cased. A read whose host name is missing or unreadable publishes
 * nothing.
 */
export const EXTERNAL_ID_TYPE = 'edge';

// --- The JSON-RPC WebSocket of the OpenEMS Edge -----------------------------------------
/** The WebSocket of the Edge (Controller.Api.Websocket, the "direct edge" of ha_openems). */
export const DEFAULT_PORT = 8085;
/** On port 80, the FEMS web server passes the WebSocket on at this path (ha_openems "local_fems"). */
export const FEMS_WEB_PORT = 80;
export const FEMS_WEB_PATH = '/websocket';
/** Opening the connection, the WebSocket handshake included. */
export const CONNECT_TIMEOUT = 5_000;
/** Each answer (the Edge answers within a second on the home network). */
export const ANSWER_TIMEOUT = 8_000;
/** The first `currentData` after the subscription (the Edge sends one each cycle, 1 s). */
export const DATA_TIMEOUT = 8_000;
/** A whole session (connect, log in, subscribe, first data), whatever happens. */
export const SESSION_TIMEOUT = 25_000;
/** One WebSocket message, at most: `ws` refuses a longer frame from its header (before reading it). */
export const MAX_MESSAGE_BYTES = 256 * 1024;
/** The messages one session takes, at most (a flood ends it). */
export const MAX_MESSAGES = 40;
/** The channel values one `currentData` may hold, at most. */
export const MAX_CHANNELS = 500;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The reading interval of the form (s): 30 s by default, 30 to 300. */
export const POLL_DEFAULT = 30;
export const POLL_MIN = 30;
export const POLL_MAX = 300;
/** How often the integration looks whether a read is due (never a read by itself). */
export const TICK = 5 * SECOND;
/**
 * The instant of the last session is written to /data at most once a minute:
 * after a restart, the first read waits this long on top of the interval, so
 * that a container restarting in a loop never reads faster than the interval.
 */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** The states sent in any 60 s, at most (the core refuses a whole batch beyond 300). */
export const STATES_PER_MINUTE = 270;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** Unreachable: tried again after 1 min (never faster than a read), doubled up to 15 min. */
export const RETRY_MIN = MINUTE;
export const RETRY_MAX = 15 * MINUTE;
/** getConfig() failed: asked again after 5 s, 15 s, 30 s, then every minute, without end. */
export const CONFIG_RETRY = [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE];
/** The test button answers within this delay. */
export const TEST_ANSWER_WITHIN = 25 * SECOND;
/** The second click of "Accept the held counter" counts from 3 s to 5 min after the first. */
export const ACCEPT_CONFIRM_AFTER = 3 * SECOND;
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/** Values older than this many intervals are no longer published as current. */
export const FRESH_INTERVALS = 2;

// --- Energy ---------------------------------------------------------------------------
/** The `production_index` option: the production index in the energy monitoring, or a plain sensor only. */
export const PV_ENERGY_MONITORING = 'energy_monitoring';
export const PV_SENSOR_ONLY = 'sensor_only';

/**
 * The margin of the guard of every lifetime counter (src/guard.js): 100 kW
 * covers a home system and the small commercial ones (FENECON Home 6 to 30,
 * Commercial 30 and 92), 0.5 kWh is always accepted on top.
 */
export const COUNTER_LIMITS = { maxKw: 100, slackKwh: 0.5 };

/** A power above this (W, either sign) is a glitch. */
export const POWER_MAX = 1_000_000;
/** A lifetime counter above this (kWh) is a glitch. */
export const ENERGY_MAX = 100_000_000;
