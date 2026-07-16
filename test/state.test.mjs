import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { parseSessionTitles, readCodexMeta } from '../plugin/bin/lib/state.mjs';

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
