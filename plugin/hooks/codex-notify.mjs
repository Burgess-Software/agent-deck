#!/usr/bin/env node
// Codex notify target (config.toml: notify = ["node", ".../codex-notify.mjs"]).
// Codex invokes it with one JSON argument describing the event. Known event:
// agent-turn-complete. We store it keyed by thread/session id when present,
// else under "latest"; the plugin's Codex poller merges it in.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE = path.join(os.homedir(), '.local/share/agentdeck/state/codex');

try {
  const arg = process.argv[process.argv.length - 1];
  const event = JSON.parse(arg);
  const type = String(event.type || '');
  let status = null;
  if (type.includes('turn-complete')) status = 'done';
  else if (type.includes('approval')) status = 'needs_input';
  if (!status) process.exit(0);

  const id = event['thread-id'] || event.thread_id || event['session-id'] || event.session_id || 'latest';
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, `${id}.json`), JSON.stringify({ status, ts: Date.now(), type }));
} catch {
  // never break codex
}
process.exit(0);
