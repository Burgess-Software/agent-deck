import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  codexLaunchActionSocketPath,
  sendCodexLaunchAction,
} from '../plugin/bin/lib/inject.mjs';

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('Codex launch-action socket path follows the desktop environment contract', () => {
  assert.equal(
    codexLaunchActionSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }),
    '/run/user/1000/codex-desktop/launch-action.sock',
  );
  assert.equal(
    codexLaunchActionSocketPath({
      XDG_RUNTIME_DIR: '/run/user/1000',
      CODEX_LINUX_APP_ID: 'work-codex',
      CODEX_LINUX_INSTANCE_ID: 'secondary',
    }),
    '/run/user/1000/work-codex/instances/secondary/launch-action.sock',
  );
  assert.equal(
    codexLaunchActionSocketPath({ HOME: '/home/thomas' }),
    '/home/thomas/.local/state/codex-desktop/launch-action.sock',
  );
});

test('Codex launch action sends a URI to the running desktop socket', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-launch-action-'));
  const socketPath = path.join(directory, 'launch-action.sock');
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const server = createServer((client) => {
    let payload = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => { payload += chunk; });
    client.on('end', () => {
      resolveRequest(JSON.parse(payload));
      client.end('ok\n');
    });
  });

  await listen(server, socketPath);
  try {
    assert.equal(
      await sendCodexLaunchAction('codex://threads/thread-123', { socketPath }),
      true,
    );
    assert.deepEqual(await request, { argv: ['codex://threads/thread-123'] });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
