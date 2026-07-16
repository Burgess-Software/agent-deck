import test from 'node:test';
import assert from 'node:assert/strict';

import { releaseManagedHold, startManagedHold } from '../plugin/bin/lib/ptt.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a managed hold acquires and releases exactly once', async () => {
  const holder = {};
  const releases = [];

  assert.equal(await startManagedHold(holder, 'ctrl+shift+d', async () => {}, async (keys) => releases.push(keys)), true);
  assert.equal(holder.holding, 'ctrl+shift+d');
  assert.equal(holder.holdPending, false);

  assert.equal(await releaseManagedHold(holder, async (keys) => releases.push(keys)), true);
  assert.deepEqual(releases, ['ctrl+shift+d']);
  assert.equal(holder.holding, null);
  assert.equal(await releaseManagedHold(holder, async (keys) => releases.push(keys)), false);
});

test('keyUp during async acquisition releases immediately after keyDown finishes', async () => {
  const holder = {};
  const acquisition = deferred();
  const releases = [];
  const started = startManagedHold(
    holder,
    'ctrl+shift+d',
    () => acquisition.promise,
    async (keys) => releases.push(keys),
  );

  assert.equal(holder.holdPending, true);
  assert.equal(await releaseManagedHold(holder, async (keys) => releases.push(keys)), true);
  assert.equal(holder.holdReleased, true);

  acquisition.resolve();
  assert.equal(await started, false);
  assert.deepEqual(releases, ['ctrl+shift+d']);
  assert.equal(holder.holdPending, false);
  assert.equal(holder.holding, null);
});
