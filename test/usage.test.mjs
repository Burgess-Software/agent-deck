import test from 'node:test';
import assert from 'node:assert/strict';

import {
  remainingPercent,
  remainingUsageColor,
  remainingUsageSweep,
} from '../plugin/bin/lib/usage.mjs';

test('weekly used percentage is converted to remaining capacity', () => {
  assert.equal(remainingPercent(25), 75);
  assert.equal(remainingPercent(0), 100);
  assert.equal(remainingPercent(100), 0);
});

test('remaining capacity is rounded, clamped, and rejects invalid values', () => {
  assert.equal(remainingPercent(25.4), 75);
  assert.equal(remainingPercent(-10), 100);
  assert.equal(remainingPercent(120), 0);
  assert.equal(remainingPercent(null), null);
  assert.equal(remainingPercent('not-a-number'), null);
  assert.equal(remainingPercent(undefined), null);
  assert.equal(remainingPercent(Number.NaN), null);
});

test('remaining-capacity colors warn as the available amount gets low', () => {
  assert.equal(remainingUsageColor(75), '#27ae60');
  assert.equal(remainingUsageColor(41), '#27ae60');
  assert.equal(remainingUsageColor(40), '#f7c744');
  assert.equal(remainingUsageColor(16), '#f7c744');
  assert.equal(remainingUsageColor(15), '#e74c3c');
  assert.equal(remainingUsageColor(0), '#e74c3c');
  assert.equal(remainingUsageColor(null), '#3a3f4b');
});

test('remaining-capacity ring fills to the available amount', () => {
  assert.equal(remainingUsageSweep(75), 270);
  assert.equal(remainingUsageSweep(100), 360);
  assert.equal(remainingUsageSweep(0), 0);
  assert.equal(remainingUsageSweep(null), 0);
});
