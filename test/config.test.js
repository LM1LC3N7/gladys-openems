import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: host, port 8085 by default, pasted URL, IPv6; never credentials nor broadcast', () => {
  assert.equal(parseAddress('192.168.1.60').address, '192.168.1.60:8085');
  assert.equal(parseAddress('ws://FEMS.local:80/websocket').address, 'fems.local:80');
  assert.equal(parseAddress('[fe80::1]:8085').address, '[fe80::1]:8085');
  assert.equal(parseAddress('fe80::1').address, '[fe80::1]:8085');
  assert.deepEqual(parseAddress(''), { empty: true });
  for (const bad of [
    'u:p@host',
    'a b',
    'host:0',
    'host:70000',
    '0.0.0.0',
    '255.255.255.255',
    '239.1.2.3',
  ]) {
    assert.deepEqual(parseAddress(bad), { error: 'invalid' }, bad);
  }
});

test('the form: user name "x" when empty, password required and never trimmed', () => {
  const c = normalizeConfig({ address: '10.0.0.5', password: ' user ' });
  assert.equal(c.username, 'x');
  assert.equal(c.password, ' user ');
  assert.equal(c.problem, undefined);
  assert.equal(c.pollInterval, 30);
  assert.equal(c.pvIndex, 'energy_monitoring');
  assert.equal(normalizeConfig({ address: '10.0.0.5' }).problem, 'password_missing');
  assert.equal(
    normalizeConfig({ address: '10.0.0.5', password: 'a\rb' }).problem,
    'password_invalid',
  );
  assert.equal(
    normalizeConfig({ address: '10.0.0.5', username: 'a\nb', password: 'p' }).problem,
    'username_invalid',
  );
  assert.equal(normalizeConfig({}).problem, 'address_missing');
  // No secret kept when the form has a problem.
  assert.equal(normalizeConfig({ address: 'u:p@h', password: 'p' }).password, undefined);
});

test('the interval: 30 to 300 s; the production option', () => {
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: '120' }).pollInterval, 120);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 300);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 30);
  assert.equal(normalizeConfig({ production_index: 'sensor_only' }).pvIndex, 'sensor_only');
  assert.equal(normalizeConfig({ production_index: 'x' }).pvIndex, 'energy_monitoring');
});

test('the configuration never reads a key prefixed with gladys_', () => {
  const c = normalizeConfig({ gladys_address: '10.0.0.5', gladys_password: 'p' });
  assert.equal(c.problem, 'address_missing');
});
