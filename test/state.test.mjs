import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  parseCodexLifecycle,
  parseSessionTitles,
  readCodexLifecycle,
  readCodexMeta,
  readNotifyState,
  resolveCodexStatus,
} from '../plugin/bin/lib/state.mjs';

function lifecycle(type, timestamp, turnId = 'turn-id') {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type, turn_id: turnId },
  });
}

test('notify reads current session records and the latest fallback only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-notify-'));
  try {
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({ status: 'done', ts: 123 }));
    await writeFile(path.join(dir, 'latest.json'), JSON.stringify({ status: 'needs_input', ts: 456 }));
    await writeFile(path.join(dir, 'historical.json'), JSON.stringify({ status: 'done', ts: 789 }));
    const state = await readNotifyState(['current', 'missing', '../outside'], dir);
    assert.deepEqual([...state], [
      ['current', { status: 'done', ts: 123 }],
      ['latest', { status: 'needs_input', ts: 456 }],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session title index uses the newest valid title for each chat', () => {
  const titles = parseSessionTitles([
    JSON.stringify({ id: 'thread-a', thread_name: 'Old title' }),
    '{"incomplete":',
    JSON.stringify({ id: 'missing-title' }),
    JSON.stringify({ id: 'thread-b', thread_name: 'Another chat' }),
    JSON.stringify({ id: 'thread-a', thread_name: 'Renamed chat' }),
  ].join('\n'));

  assert.deepEqual([...titles], [
    ['thread-a', 'Renamed chat'],
    ['thread-b', 'Another chat'],
  ]);
});

test('repo rollout retains a first-message title until the generated title exists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-state-'));
  const file = path.join(dir, 'rollout-2026-07-16T00-00-00-thread-id.jsonl');
  await writeFile(file, [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'thread-id',
        cwd: '/tmp/worktrees/agent-deck-feature',
        git: { repository_url: 'git@github.com:Burgess-Software/agent-deck.git' },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: '**Speed up** the voice button' },
    }),
  ].join('\n'));

  try {
    assert.deepEqual(await readCodexMeta(file), {
      id: 'thread-id',
      cwd: '/tmp/worktrees/agent-deck-feature',
      project: 'agent-deck',
      title: 'Speed up the voice button',
      hasSnippet: true,
      isSubagent: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unfinished rollout can be retried after its first message arrives', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-state-'));
  const file = path.join(dir, 'rollout-2026-07-16T00-00-00-late-message.jsonl');
  await writeFile(file, `${JSON.stringify({
    type: 'session_meta',
    payload: { id: 'late-message', cwd: '/tmp/agent-deck' },
  })}\n`);

  try {
    const before = await readCodexMeta(file);
    assert.equal(before.hasSnippet, false);
    assert.equal(before.title, 'agent-deck');

    await appendFile(file, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Differentiate my chats' },
    })}\n`);

    const after = await readCodexMeta(file);
    assert.equal(after.hasSnippet, true);
    assert.equal(after.title, 'Differentiate my chats');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subagent metadata cannot impersonate its parent chat', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-state-'));
  const file = path.join(dir, 'rollout-2026-08-17T00-00-00-child-id.jsonl');
  await writeFile(file, [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child-id',
        session_id: 'parent-id',
        cwd: '/tmp/child-worktree',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent-id' } } },
      },
    }),
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'parent-id', session_id: 'parent-id', cwd: '/tmp/parent' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Copied parent prompt' },
    }),
  ].join('\n'));

  try {
    assert.deepEqual(await readCodexMeta(file), {
      id: 'child-id',
      cwd: '/tmp/child-worktree',
      project: 'child-worktree',
      title: 'child-worktree',
      hasSnippet: false,
      isSubagent: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('string thread_source also identifies a subagent rollout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-state-'));
  const file = path.join(dir, 'rollout-2026-08-17T00-00-00-child-id.jsonl');
  await writeFile(file, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'child-id',
      session_id: 'parent-id',
      cwd: '/tmp/child-worktree',
      thread_source: 'subagent',
    },
  })}\n`);

  try {
    const meta = await readCodexMeta(file);
    assert.equal(meta.id, 'child-id');
    assert.equal(meta.isSubagent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('latest explicit lifecycle survives quiet periods and malformed trailing rows', () => {
  const startedAt = '2026-08-17T19:36:18.000Z';
  const started = parseCodexLifecycle([
    lifecycle('task_complete', '2026-08-17T19:31:48.000Z', 'old-turn'),
    lifecycle('task_started', startedAt, 'current-turn'),
    '{"timestamp":"partial"',
  ].join('\n'));

  assert.deepEqual(started, {
    status: 'working',
    event: 'task_started',
    turnId: 'current-turn',
    ts: Date.parse(startedAt),
  });

  const completed = parseCodexLifecycle(
    `${lifecycle('task_complete', '2026-08-17T19:38:00.000Z', 'current-turn')}\n`,
    started,
  );
  assert.equal(completed.status, 'done');
  assert.equal(completed.event, 'task_complete');

  const aborted = parseCodexLifecycle(
    lifecycle('turn_aborted', '2026-08-17T19:39:00.000Z', 'next-turn'),
    { ...started, turnId: 'next-turn' },
  );
  assert.equal(aborted.status, 'done');
  assert.equal(aborted.event, 'turn_aborted');
});

test('an unmatched task_started remains working after the rollout goes quiet', () => {
  const startedAt = Date.parse('2026-08-17T19:36:18.000Z');
  const active = { status: 'working', event: 'task_started', turnId: 'current-turn', ts: startedAt };
  const now = startedAt + 60_000;

  assert.equal(resolveCodexStatus({
    lifecycle: active,
    fileMtimeMs: startedAt + 5_000,
    notified: { status: 'done', ts: startedAt - 270_000 },
    previous: { status: 'working', ts: startedAt },
    now,
  }), 'working');
});

test('notification precedence distinguishes a stale completion from the current hook', () => {
  const startedAt = Date.parse('2026-08-17T19:36:18.000Z');
  const active = { status: 'working', event: 'task_started', turnId: 'current-turn', ts: startedAt };

  // The old hook is close enough to pass the filesystem-mtime slop, but it
  // still predates this task_started and must not end the new turn.
  assert.equal(resolveCodexStatus({
    lifecycle: active,
    fileMtimeMs: startedAt + 500,
    notified: { status: 'done', ts: startedAt - 100 },
    now: startedAt + 10_000,
  }), 'working');

  // When the completion hook is newer than the start and final rollout write,
  // it may mark done before the incremental reader sees task_complete.
  assert.equal(resolveCodexStatus({
    lifecycle: active,
    fileMtimeMs: startedAt + 60_000,
    notified: { status: 'done', ts: startedAt + 60_100 },
    now: startedAt + 60_200,
  }), 'done');
});

test('terminal lifecycle is immediate, then ages from done to idle', () => {
  const completedAt = Date.parse('2026-08-17T19:38:00.000Z');
  const complete = { status: 'done', event: 'task_complete', turnId: 'turn-id', ts: completedAt };

  assert.equal(resolveCodexStatus({
    lifecycle: complete,
    fileMtimeMs: completedAt,
    now: completedAt + 100,
  }), 'done');
  assert.equal(resolveCodexStatus({
    lifecycle: complete,
    fileMtimeMs: completedAt,
    previous: { status: 'done', ts: completedAt + 10 * 60_000 },
    now: completedAt + 5 * 60_000,
  }), 'idle');
});

test('terminal lifecycle without a valid event timestamp falls back to file mtime', () => {
  const now = Date.parse('2026-08-17T19:38:00.000Z');
  assert.equal(resolveCodexStatus({
    lifecycle: { status: 'done', event: 'task_complete', turnId: 'turn-id', ts: null },
    fileMtimeMs: now - 100,
    now,
  }), 'done');
});

test('legacy rollouts retain file-recency status fallback', () => {
  const now = Date.parse('2026-08-17T19:38:00.000Z');
  assert.equal(resolveCodexStatus({ fileMtimeMs: now - 5_000, now }), 'working');
  assert.equal(resolveCodexStatus({
    fileMtimeMs: now - 20_000,
    previous: { status: 'working', ts: now - 20_000 },
    now,
  }), 'done');
});

test('backwards lifecycle read finds a task start beyond the fixed tail', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-state-'));
  const file = path.join(dir, 'rollout-2026-08-17T00-00-00-thread-id.jsonl');
  const startedAt = '2026-08-17T19:36:18.000Z';
  await writeFile(file, [
    lifecycle('task_started', startedAt, 'long-turn'),
    JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(160 * 1024) } }),
    '{"incomplete":',
  ].join('\n'));

  try {
    assert.deepEqual(await readCodexLifecycle(file), {
      status: 'working',
      event: 'task_started',
      turnId: 'long-turn',
      ts: Date.parse(startedAt),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
