import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_SCRIPT = path.join(ROOT, 'scripts/gen-profile.mjs');
const AGENT_PI = path.join(ROOT, 'plugin/pi/agent.html');
const ACTION_PREFIX = 'com.thomasburgess.agentdeck.';

test('default 15-key profile uses two session rows and a bottom command row', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-profile-'));
  const device = 'test-device';

  try {
    const result = spawnSync(process.execPath, [PROFILE_SCRIPT, device], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const profilePath = path.join(home, '.config/opendeck/profiles', device, 'Agent Deck.json');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.equal(profile.keys.length, 15);

    for (let slot = 0; slot < 10; slot++) {
      assert.equal(profile.keys[slot].action.uuid, `${ACTION_PREFIX}agent`);
      assert.deepEqual(profile.keys[slot].settings, {
        slot: String(slot),
        ...(slot === 9 ? { usageWhenEmpty: true } : {}),
      });
      assert.match(profile.keys[slot].context, new RegExp(`\\.Keypad\\.${slot}\\.0$`));
    }

    const commands = ['accept', 'reject', 'newchat', 'ptt', 'interrupt'];
    for (let offset = 0; offset < commands.length; offset++) {
      const key = profile.keys[10 + offset];
      assert.equal(key.action.uuid, `${ACTION_PREFIX}command`);
      assert.deepEqual(key.settings, { command: commands[offset] });
      assert.match(key.context, new RegExp(`\\.Keypad\\.${10 + offset}\\.0$`));
    }

    const defaultActions = profile.keys.map((key) => key.action.uuid);
    assert.equal(defaultActions.includes(`${ACTION_PREFIX}model`), false);
    assert.equal(defaultActions.includes(`${ACTION_PREFIX}usage`), false);
    assert.equal(defaultActions.includes(`${ACTION_PREFIX}reasoning`), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('agent property inspector offers all ten stable slots', () => {
  const html = fs.readFileSync(AGENT_PI, 'utf8');
  const options = [...html.matchAll(/<option>(\d+)<\/option>/g)].map((match) => Number(match[1]));
  assert.deepEqual(options, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.match(html, /type="checkbox" data-setting="usageWhenEmpty"/);
});
