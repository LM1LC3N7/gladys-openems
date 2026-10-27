// -----------------------------------------------------------------------------
// The Gladys device of the OpenEMS Edge and its states. Pure.
//
// External id (forever): edge:<hostname> (src/constants.js,
// src/openems/model.js hostnameOf). Feature keys (forever): see FEATURE below.
//
// Energy rules of the Gladys core (server/utils/constants.js) and of this
// project:
// - the ONLY index is the production (`energy-production-sensor` / `index`,
//   from `_sum/ProductionActiveEnergy`, with its `thirty-minutes-production`
//   declared here, ids computed (UUID v5) so that an "Update" in Discovery
//   keeps the same rows; the integration never publishes that one). With the
//   option "Sensor only" (an inverter already sends its production to
//   Gladys), chosen before the device is created, the index is not declared
//   and the same counter is a plain sensor; a device created with the index
//   keeps it, which then gets no value;
// - NO `energy-sensor` / `index`, no `daily-consumption`, never
//   publishEnergyConsumption: the house consumption and what is bought from
//   the grid are already counted by the main meter of the home; counted
//   twice, they would be billed twice. They are plain sensors, kWh in the
//   name. What is sold to the grid is never in `energy-sensor` either;
// - every lifetime counter (the index and the plain ones) goes through the
//   guard (src/guard.js): never 0, never a drop nor a jump published without
//   the user (src/app.js);
// - the battery and grid powers are ONE signed plain sensor each, the sign of
//   OpenEMS in the name: never `grid-sensor`, never split;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): % for battery-storage, W and kWh for
//   energy-production-sensor, none for unknown (the unit is in the name).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { ENERGY_MAX, EXTERNAL_ID_TYPE, POWER_MAX, PV_ENERGY_MONITORING } from './constants.js';

/** Feature keys (forever). */
export const FEATURE = {
  SOC: 'soc',
  BATTERY_POWER: 'battery_power',
  GRID_POWER: 'grid_power',
  PRODUCTION_POWER: 'production_power',
  CONSUMPTION_POWER: 'consumption_power',
  PRODUCTION_INDEX: 'production_index',
  /** 30-minute production: fed by the Gladys core from the index, never by the integration. */
  PRODUCTION_30MIN: 'production_index_30min',
  PRODUCTION_TOTAL: 'production_total',
  CONSUMPTION_TOTAL: 'consumption_total',
  GRID_BUY_TOTAL: 'grid_buy_total',
  GRID_SELL_TOTAL: 'grid_sell_total',
  BATTERY_CHARGE_TOTAL: 'battery_charge_total',
  BATTERY_DISCHARGE_TOTAL: 'battery_discharge_total',
  SYSTEM_STATE: 'system_state',
  GRID_MODE: 'grid_mode',
};

/**
 * The guarded lifetime counters: their feature, the value of
 * src/openems/model.js they show (kWh) and their name in the texts
 * (src/i18n.js). `production_index` and `production_total` are the same
 * counter (the option decides which one the device has).
 */
export const COUNTERS = [
  { name: 'production', key: FEATURE.PRODUCTION_INDEX, value: 'productionEnergy' },
  { name: 'production', key: FEATURE.PRODUCTION_TOTAL, value: 'productionEnergy' },
  { name: 'consumption', key: FEATURE.CONSUMPTION_TOTAL, value: 'consumptionEnergy' },
  { name: 'gridBuy', key: FEATURE.GRID_BUY_TOTAL, value: 'gridBuyEnergy' },
  { name: 'gridSell', key: FEATURE.GRID_SELL_TOTAL, value: 'gridSellEnergy' },
  { name: 'batteryCharge', key: FEATURE.BATTERY_CHARGE_TOTAL, value: 'essChargeEnergy' },
  { name: 'batteryDischarge', key: FEATURE.BATTERY_DISCHARGE_TOTAL, value: 'essDischargeEnergy' },
];

/** The external ids of the Edge of `hostname`. */
export const ids = (gladys, hostname) => gladys.externalIds(EXTERNAL_ID_TYPE, hostname);

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('8d41b6e09f2c4a7d93e5016c7ab4f2d8', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name (as gladys-e3dc). */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- The catalog ------------------------------------------------------------------
//
// Each entry: the feature key, the value of src/openems/model.js it shows
// (undefined for a counter: the guard gives it), its rounding, how it is
// declared, and `mode`: 'index' for the entries of the energy monitoring
// only, 'sensor' for the one of "Sensor only" (option `production_index`).

const def = (key, value, digits, spec, mode) => ({ key, value, digits, spec, mode });

const measure = (name, category, type, extra = {}) => ({ name, category, type, ...extra });
/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (name, extra = {}) => measure(name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);
const watts = (name) => plain(`${name} (W)`, { max: POWER_MAX });
const signedWatts = (name) => plain(name, { min: -POWER_MAX, max: POWER_MAX });
const total = (name) => plain(`${name} (kWh, lifetime, not counted)`, { max: ENERGY_MAX });
const index = (name, type) =>
  measure(name, C.ENERGY_PRODUCTION_SENSOR, type, { unit: U.KILOWATT_HOUR, max: ENERGY_MAX });

export const CATALOG = [
  def(FEATURE.SOC, 'soc', 0, {
    ...measure('State of charge', C.BATTERY_STORAGE, T.BATTERY_STORAGE.BATTERY_LEVEL),
    unit: U.PERCENT,
    max: 100,
  }),
  def(
    FEATURE.BATTERY_POWER,
    'essPower',
    0,
    signedWatts('Battery power (W, + discharging, - charging)'),
  ),
  def(
    FEATURE.GRID_POWER,
    'gridPower',
    0,
    signedWatts('Grid power (W, + bought from the grid, - sold to it)'),
  ),
  def(FEATURE.PRODUCTION_POWER, 'productionPower', 0, {
    ...measure('Production power', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER),
    unit: U.WATT,
    max: POWER_MAX,
  }),
  def(FEATURE.CONSUMPTION_POWER, 'consumptionPower', 0, watts('House consumption')),
  def(
    FEATURE.PRODUCTION_INDEX,
    undefined,
    3,
    index('Production index', T.ENERGY_PRODUCTION_SENSOR.INDEX),
    'index',
  ),
  // Declared only: the core computes it from the index.
  def(
    FEATURE.PRODUCTION_30MIN,
    undefined,
    3,
    index(
      'Production index (30-minute production)',
      T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
    ),
    'index',
  ),
  def(FEATURE.PRODUCTION_TOTAL, undefined, 3, total('Production'), 'sensor'),
  def(FEATURE.CONSUMPTION_TOTAL, undefined, 3, total('House consumption')),
  def(FEATURE.GRID_BUY_TOTAL, undefined, 3, total('Bought from the grid')),
  def(FEATURE.GRID_SELL_TOTAL, undefined, 3, total('Sold to the grid')),
  def(FEATURE.BATTERY_CHARGE_TOTAL, undefined, 3, total('Battery charge')),
  def(FEATURE.BATTERY_DISCHARGE_TOTAL, undefined, 3, total('Battery discharge')),
  def(FEATURE.SYSTEM_STATE, 'state', 0, {
    ...measure('System state (0 OK, 1 info, 2 warning, 3 fault)', C.UNKNOWN, T.SENSOR.INTEGER),
    max: 3,
  }),
  def(FEATURE.GRID_MODE, 'gridMode', 0, {
    ...measure(
      'Grid mode (1 on-grid, 2 off-grid, 3 off-grid with genset)',
      C.UNKNOWN,
      T.SENSOR.INTEGER,
    ),
    min: 1,
    max: 3,
  }),
];

/** The feature keys of a created device (its features are fixed at its creation). */
export function keysOfDevice(device) {
  return new Set(
    (device?.features ?? []).map((f) =>
      String(f.external_id ?? '')
        .split(':')
        .at(-1),
    ),
  );
}

/**
 * The catalog entries of the device: the index with the option of the energy
 * monitoring, the plain production counter with "Sensor only", plus every one
 * the created device already has (published again, a device never loses a
 * feature: "Update" in Discovery would drop its history).
 */
export function entriesFor(pvIndex = PV_ENERGY_MONITORING, createdKeys = new Set()) {
  const wanted = pvIndex === PV_ENERGY_MONITORING ? 'index' : 'sensor';
  return CATALOG.filter((e) => !e.mode || e.mode === wanted || createdKeys.has(e.key));
}

/**
 * The device of the Edge. `info`: `{ hostname, address, version }`;
 * `pvIndex`: the option; `created`: the device the user created, if any.
 */
export function buildDevice(gladys, info, { pvIndex, created } = {}) {
  const external = ids(gladys, info.hostname);
  const indexId = external.feature(FEATURE.PRODUCTION_INDEX);
  const features = entriesFor(pvIndex, keysOfDevice(created)).map(({ key, spec }) => {
    const feature = {
      min: 0,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...spec,
      external_id: external.feature(key),
    };
    if (key === FEATURE.PRODUCTION_INDEX) {
      feature.id = uuidOf(indexId);
    } else if (key === FEATURE.PRODUCTION_30MIN) {
      feature.id = uuidOf(external.feature(FEATURE.PRODUCTION_30MIN));
      feature.energy_parent_id = uuidOf(indexId);
    }
    return feature;
  });
  return {
    name: `OpenEMS ${info.hostname}`,
    external_id: external.device,
    features,
    params: [
      { name: 'OPENEMS_ADDRESS', value: info.address ?? '' },
      { name: 'OPENEMS_HOSTNAME', value: info.hostname },
      { name: 'OPENEMS_VERSION', value: info.version ?? '' },
    ],
  };
}

export const round = (value, digits) => {
  const r = Math.round(value * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? 0 : r;
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const COUNTER_KEYS = new Set(COUNTERS.map((c) => c.key));

/**
 * The states of a read. `values`: src/openems/model.js parseValues;
 * `counters`: by feature key, the values the guards let through (undefined:
 * not published this time). A counter is never taken from `values` directly.
 */
export function readStates(external, values, counters = {}) {
  const states = [];
  for (const { key, value, digits, spec } of CATALOG) {
    let v;
    if (COUNTER_KEYS.has(key)) {
      // Never 0 (the guard never lets 0 through, checked again here).
      v = isNumber(counters[key]) && counters[key] > 0 ? counters[key] : undefined;
    } else if (value !== undefined) {
      v = values[value];
    }
    if (!isNumber(v)) {
      continue;
    }
    const r = round(v, digits);
    const min = spec.min ?? 0;
    if (r < min || (spec.max !== undefined && r > spec.max)) {
      continue;
    }
    states.push({ device_feature_external_id: external.feature(key), state: r });
  }
  return states;
}
