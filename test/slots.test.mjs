import test from 'node:test';
import assert from 'node:assert/strict';

import { StableSessionSlots } from '../plugin/bin/lib/slots.mjs';

const session = (id, ts, rolloutPath = `/rollouts/${id}.jsonl`, extra = {}) => ({
  id,
  ts,
  rolloutPath,
  title: id.toUpperCase(),
  status: 'idle',
  ...extra,
});

const ids = (result) => result.sessions.map((value) => value?.id ?? null);

test('bootstrap fills visible slots by recency', () => {
  const slots = new StableSessionSlots();
  const result = slots.reconcile([
    session('old', 100),
    session('new', 300),
    session('middle', 200),
  ], [0, 1, 2]);

  assert.deepEqual(ids(result), ['new', 'middle', 'old']);
  assert.equal(result.stateChanged, true);
});

test('rollout activity and metadata updates refresh in place without reordering', () => {
  const slots = new StableSessionSlots();
  slots.reconcile([session('a', 300), session('b', 200), session('c', 100)], [0, 1, 2]);

  const result = slots.reconcile([
    session('c', 500, undefined, { status: 'working', title: 'Changed' }),
    session('a', 150),
    session('b', 50),
  ], [0, 1, 2]);

  assert.deepEqual(ids(result), ['a', 'b', 'c']);
  assert.equal(result.sessions[2].status, 'working');
  assert.equal(result.sessions[2].title, 'Changed');
  assert.equal(result.stateChanged, false);
});

test('known overflow activity cannot bounce back onto a full deck', () => {
  const slots = new StableSessionSlots();
  slots.reconcile([
    session('a', 400), session('b', 300), session('c', 200), session('overflow', 100),
  ], [0, 1, 2]);

  const result = slots.reconcile([
    session('overflow', 1000), session('a', 400), session('b', 300), session('c', 200),
  ], [0, 1, 2]);

  assert.deepEqual(ids(result), ['a', 'b', 'c']);
  assert.equal(result.stateChanged, false);
});

test('a new chat replaces only the least-recent incumbent', () => {
  const slots = new StableSessionSlots();
  slots.reconcile([session('a', 400), session('b', 300), session('c', 200)], [0, 1, 2]);

  const result = slots.reconcile([
    session('new', 1000), session('a', 400), session('b', 300), session('c', 200),
  ], [0, 1, 2]);

  assert.deepEqual(ids(result), ['a', 'b', 'new']);
});

test('a new rollout for an overflowed session is admitted once as a resume', () => {
  const slots = new StableSessionSlots();
  slots.reconcile([
    session('a', 400), session('b', 300), session('c', 200), session('resumed', 100),
  ], [0, 1, 2]);

  const resumedPath = '/rollouts/resumed-second-run.jsonl';
  const admitted = slots.reconcile([
    session('resumed', 1000, resumedPath),
    session('a', 400), session('b', 300), session('c', 200),
  ], [0, 1, 2]);
  assert.deepEqual(ids(admitted), ['a', 'b', 'resumed']);

  const updated = slots.reconcile([
    session('c', 1200),
    session('resumed', 1001, resumedPath),
    session('a', 400), session('b', 300),
  ], [0, 1, 2]);
  assert.deepEqual(ids(updated), ['a', 'b', 'resumed']);
});

test('expiry changes only its slot and fills that vacancy after the grace scan', () => {
  const slots = new StableSessionSlots({ missingGraceScans: 2 });
  slots.reconcile([
    session('a', 400), session('b', 300), session('c', 200), session('waiting', 100),
  ], [0, 1, 2]);

  const firstMiss = slots.reconcile([
    session('a', 401), session('c', 201), session('waiting', 101),
  ], [0, 1, 2]);
  assert.deepEqual(ids(firstMiss), ['a', null, 'c']);

  const expired = slots.reconcile([
    session('a', 402), session('c', 202), session('waiting', 102),
  ], [0, 1, 2]);
  assert.deepEqual(ids(expired), ['a', 'waiting', 'c']);
});

test('persisted bindings survive restart despite changed activity order', () => {
  const before = new StableSessionSlots();
  before.reconcile([session('a', 300), session('b', 200), session('c', 100)], [0, 1, 2]);

  const after = new StableSessionSlots(before.snapshot());
  const result = after.reconcile([
    session('c', 900), session('b', 800), session('a', 700),
  ], [0, 1, 2]);

  assert.deepEqual(ids(result), ['a', 'b', 'c']);
});

test('inactive slot five does not hide a session from the bundled five-key layout', () => {
  const slots = new StableSessionSlots();
  const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => session(id, 600 - index));

  const five = slots.reconcile(candidates, [0, 1, 2, 3, 4]);
  assert.deepEqual(ids(five), ['a', 'b', 'c', 'd', 'e']);

  const six = slots.reconcile(candidates, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(ids(six), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('expanding the bundled profile to ten keys preserves the first row and fills the second', () => {
  const slots = new StableSessionSlots();
  const candidates = 'abcdefghijkl'.split('').map((id, index) => session(id, 1200 - index));

  const firstRow = slots.reconcile(candidates, [0, 1, 2, 3, 4]);
  assert.deepEqual(ids(firstRow), ['a', 'b', 'c', 'd', 'e']);

  const twoRows = slots.reconcile(candidates, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ids(twoRows), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);

  const activeOverflow = candidates.map((candidate, index) => ({
    ...candidate,
    ts: candidate.id === 'l' ? 5000 : index,
  }));
  const afterActivity = slots.reconcile(activeOverflow, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ids(afterActivity), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);

  const restarted = new StableSessionSlots(slots.snapshot());
  const afterRestart = restarted.reconcile(activeOverflow, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ids(afterRestart), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
});

test('the elastic final slot yields to usage below ten sessions and fills when needed', () => {
  const slots = new StableSessionSlots({ missingGraceScans: 2 });
  const activeSlots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const fallbackSlots = [9];
  const firstNine = 'abcdefghi'.split('').map((id, index) => session(id, 1000 - index));

  const usageVisible = slots.reconcile(firstNine, activeSlots, fallbackSlots);
  assert.deepEqual(ids(usageVisible), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', null]);

  const tenth = session('j', 2000);
  const full = slots.reconcile([tenth, ...firstNine], activeSlots, fallbackSlots);
  assert.deepEqual(ids(full), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);

  const afterExpiry = [tenth, ...firstNine].filter((candidate) => candidate.id !== 'c');
  slots.reconcile(afterExpiry, activeSlots, fallbackSlots);
  const usageReturns = slots.reconcile(afterExpiry, activeSlots, fallbackSlots);
  assert.deepEqual(ids(usageReturns), ['a', 'b', 'j', 'd', 'e', 'f', 'g', 'h', 'i', null]);

  const restarted = new StableSessionSlots(slots.snapshot());
  const stable = restarted.reconcile(afterExpiry, activeSlots, fallbackSlots);
  assert.deepEqual(ids(stable), ['a', 'b', 'j', 'd', 'e', 'f', 'g', 'h', 'i', null]);
});

test('a dormant sixth-slot binding can move into a visible vacancy', () => {
  const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => session(id, 600 - index));
  const seeded = new StableSessionSlots();
  seeded.reconcile(candidates, [0, 1, 2, 3, 4, 5]);

  const persisted = seeded.snapshot();
  persisted.bindings[4] = null;
  const fiveKeyLayout = new StableSessionSlots(persisted);
  const result = fiveKeyLayout.reconcile(
    candidates.filter((candidate) => candidate.id !== 'e'),
    [0, 1, 2, 3, 4],
  );

  assert.deepEqual(ids(result).slice(0, 5), ['a', 'b', 'c', 'd', 'f']);
  assert.equal(result.sessions[5], null);
});

test('a scan with no visible keys does not consume a later admission', () => {
  const slots = new StableSessionSlots();
  slots.reconcile([session('a', 100)], [0]);

  const hidden = slots.reconcile([session('new', 200), session('a', 100)], []);
  assert.deepEqual(ids(hidden), ['a']);

  const visible = slots.reconcile([session('new', 200), session('a', 100)], [0]);
  assert.deepEqual(ids(visible), ['new']);
});
