#!/usr/bin/env node
// Agent Deck installer:
//  1. generates the manifest PNG icons
//  2. symlinks the plugin into OpenDeck's plugin directory
//  3. merges the status hooks into ~/.claude/settings.json (backup kept)
//  4. wires notify into ~/.codex/config.toml (backup kept)
// Idempotent: safe to re-run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_SRC = path.join(ROOT, 'plugin');
const PLUGIN_UUID = 'com.thomasburgess.agentdeck';
const OPENDECK_PLUGINS = path.join(os.homedir(), '.config/opendeck/plugins');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude/settings.json');
const CODEX_CONFIG = path.join(os.homedir(), '.codex/config.toml');
// Absolute node path: hooks run from the desktop app, whose PATH lacks nvm.
const HOOK_CMD = `${process.execPath} ${path.join(PLUGIN_SRC, 'hooks/claude-hook.mjs')}`;
const NOTIFY_PATH = path.join(PLUGIN_SRC, 'hooks/codex-notify.mjs');
const STAMP = new Date().toISOString().slice(0, 10);

const log = (m) => console.log(`[agent-deck] ${m}`);

// 1. icons
const { manifestIcon } = await import(path.join(PLUGIN_SRC, 'bin/lib/icons.mjs'));
const iconDir = path.join(PLUGIN_SRC, 'icons');
fs.mkdirSync(iconDir, { recursive: true });
for (const kind of ['plugin', 'agent', 'command', 'skill', 'reasoning', 'target']) {
  fs.writeFileSync(path.join(iconDir, `${kind}.png`), manifestIcon(kind, 144));
  fs.writeFileSync(path.join(iconDir, `${kind}@2x.png`), manifestIcon(kind, 288));
}
log('icons generated');

// 2. copy into OpenDeck (a symlink won't do: OpenDeck canonicalizes the path
// and derives the plugin UUID from the real directory's basename)
fs.mkdirSync(OPENDECK_PLUGINS, { recursive: true });
const dest = path.join(OPENDECK_PLUGINS, `${PLUGIN_UUID}.sdPlugin`);
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(PLUGIN_SRC, dest, { recursive: true });
fs.chmodSync(path.join(dest, 'agentdeck.sh'), 0o755);
fs.chmodSync(path.join(PLUGIN_SRC, 'agentdeck.sh'), 0o755);
log(`installed ${dest}`);

// 3. Claude hooks
const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
settings.hooks ??= {};
let claudeChanged = false;
for (const event of ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd']) {
  settings.hooks[event] ??= [];
  const present = settings.hooks[event].some((entry) =>
    (entry.hooks ?? []).some((h) => (h.command ?? '').includes('agent-deck')));
  if (!present) {
    settings.hooks[event].push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 10 }] });
    claudeChanged = true;
  }
}
if (claudeChanged) {
  fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.bak-agentdeck-${STAMP}`);
  fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  log(`claude hooks installed (backup: settings.json.bak-agentdeck-${STAMP})`);
} else {
  log('claude hooks already installed');
}

// 4. Codex notify (top-level key: must precede the first [table] header)
let toml = fs.readFileSync(CODEX_CONFIG, 'utf8');
if (toml.includes('agent-deck')) {
  log('codex notify already installed');
} else if (/^\s*notify\s*=/m.test(toml)) {
  log('WARNING: config.toml already has a notify setting — skipped; chain it manually to ' + NOTIFY_PATH);
} else {
  fs.copyFileSync(CODEX_CONFIG, `${CODEX_CONFIG}.bak-agentdeck-${STAMP}`);
  const nodeBin = process.execPath;
  const notifyLine = `notify = ["${nodeBin}", "${NOTIFY_PATH}"]\n`;
  const firstTable = toml.search(/^\s*\[/m);
  toml = firstTable === -1
    ? toml + notifyLine
    : toml.slice(0, firstTable) + notifyLine + toml.slice(firstTable);
  fs.writeFileSync(CODEX_CONFIG, toml);
  log(`codex notify installed (backup: config.toml.bak-agentdeck-${STAMP})`);
}

// 5. state dir
const stateDir = path.join(os.homedir(), '.local/share/agentdeck');
fs.mkdirSync(path.join(stateDir, 'state/claude'), { recursive: true });
fs.mkdirSync(path.join(stateDir, 'state/codex'), { recursive: true });
if (!fs.existsSync(path.join(stateDir, 'target'))) {
  fs.writeFileSync(path.join(stateDir, 'target'), 'claude');
}
log('done — restart OpenDeck to load the plugin');
