// -----------------------------------------------------------------------------
// The channels read from the OpenEMS Edge and their values. Pure.
//
// Every value comes from the `_sum` component (the totals of the Edge, always
// present) and `_host/Hostname` (the identity). Units and signs as OpenEMS
// documents them (io.openems.edge.common.sum.Sum):
// - powers in W; `EssActivePower` is negative while charging, positive while
//   discharging; `GridActivePower` is positive when buying from the grid,
//   negative when selling to it;
// - energies in Wh, lifetime counters (CUMULATED_WATT_HOURS), shown in kWh;
// - `EssSoc` in %; `State` 0 Ok, 1 Info, 2 Warning, 3 Fault (the worst state
//   of all the components); `GridMode` 0 undefined, 1 on-grid, 2 off-grid.
// A value that is not a finite number (null, a text, a boolean) is unknown,
// never 0: `Number('')` would be 0, so no conversion is ever made.
// -----------------------------------------------------------------------------

/** The channel addresses subscribed to, and the name of their value. */
export const CHANNELS = {
  hostname: '_host/Hostname',
  soc: '_sum/EssSoc',
  essPower: '_sum/EssActivePower',
  gridPower: '_sum/GridActivePower',
  productionPower: '_sum/ProductionActivePower',
  consumptionPower: '_sum/ConsumptionActivePower',
  productionEnergy: '_sum/ProductionActiveEnergy',
  consumptionEnergy: '_sum/ConsumptionActiveEnergy',
  gridBuyEnergy: '_sum/GridBuyActiveEnergy',
  gridSellEnergy: '_sum/GridSellActiveEnergy',
  essChargeEnergy: '_sum/EssDcChargeEnergy',
  essDischargeEnergy: '_sum/EssDcDischargeEnergy',
  state: '_sum/State',
  gridMode: '_sum/GridMode',
};

/** The energies (Wh lifetime counters), given in kWh by parseValues. */
export const ENERGIES = [
  'productionEnergy',
  'consumptionEnergy',
  'gridBuyEnergy',
  'gridSellEnergy',
  'essChargeEnergy',
  'essDischargeEnergy',
];

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** A host name of the Edge: trimmed, lower-cased, a DNS label of 1 to 63 characters; else undefined. */
export function hostnameOf(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) ? value : undefined;
}

/** A version text of OpenEMS (e.g. "2026.7.2"): digits, letters, dots and dashes, 32 characters at most. */
export function versionOf(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(value) ? value : undefined;
}

/** An integer of a closed range, else undefined. */
const intIn = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/**
 * The values of one `currentData` (its `params`, a plain object). Unknown or
 * odd values are left out (undefined).
 */
export function parseValues(params) {
  const get = (name) => {
    const address = CHANNELS[name];
    return Object.hasOwn(params ?? {}, address) ? params[address] : undefined;
  };
  const number = (name) => (isNumber(get(name)) ? get(name) : undefined);
  const values = {
    hostname: hostnameOf(get('hostname')),
    soc: intIn(get('soc'), 0, 100),
    essPower: number('essPower'),
    gridPower: number('gridPower'),
    productionPower: number('productionPower'),
    consumptionPower: number('consumptionPower'),
    state: intIn(get('state'), 0, 3),
    // 0 is "undefined": not a mode.
    gridMode: intIn(get('gridMode'), 1, 2),
  };
  for (const name of ENERGIES) {
    const wh = number(name);
    // A lifetime counter: 0 or below is "not available", never a value.
    values[name] = wh !== undefined && wh > 0 ? wh / 1000 : undefined;
  }
  return values;
}

/** Whether a `currentData` holds a useful value (a number of `_sum`): the Edge is alive. */
export function hasUsefulValue(params) {
  return Object.keys(CHANNELS).some(
    (name) => name !== 'hostname' && isNumber(params?.[CHANNELS[name]]),
  );
}
