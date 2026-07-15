#!/usr/bin/env node
// Claude Code hook target. Registered for UserPromptSubmit, Notification,
// Stop, SessionStart, SessionEnd in ~/.claude/settings.json. Reads the hook
// payload on stdin and writes per-session status files that the Agent Deck
// plugin watches. Must be fast and never block Claude: fail silently.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE = path.join(os.homedir(), '.local/share/agentdeck/state/claude');

const STATUS_BY_EVENT = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Notification: 'needs_input',
  Stop: 'done',
};

try {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  const id = payload.session_id;
  if (!id) process.exit(0);
  fs.mkdirSync(STATE, { recursive: true });
  const file = path.join(STATE, `${id}.json`);

  if (payload.hook_event_name === 'SessionEnd') {
    fs.rmSync(file, { force: true });
    process.exit(0);
  }

  const status = STATUS_BY_EVENT[payload.hook_event_name];
  if (!status) process.exit(0);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    status,
    cwd: payload.cwd || '',
    ts: Date.now(),
    event: payload.hook_event_name,
  }));
  fs.renameSync(tmp, file);
} catch {
  // never surface errors into the Claude session
}
process.exit(0);
