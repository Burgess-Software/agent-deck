import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldShowUsageWhenEmpty,
  usesUsageWhenEmpty,
} from '../plugin/bin/lib/agent-display.mjs';

test('an opted-in empty agent slot shows usage', () => {
  assert.equal(usesUsageWhenEmpty({ usageWhenEmpty: true }), true);
  assert.equal(shouldShowUsageWhenEmpty(null, { usageWhenEmpty: true }), true);
  assert.equal(shouldShowUsageWhenEmpty(undefined, { usageWhenEmpty: 'true' }), true);
});

test('a session always replaces the usage fallback', () => {
  const session = { id: 'thread-id', status: 'working' };
  assert.equal(shouldShowUsageWhenEmpty(session, { usageWhenEmpty: true }), false);
});

test('ordinary empty agent slots retain the empty-session display', () => {
  assert.equal(shouldShowUsageWhenEmpty(null, {}), false);
  assert.equal(shouldShowUsageWhenEmpty(null, { usageWhenEmpty: false }), false);
});
