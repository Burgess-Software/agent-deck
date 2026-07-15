#!/usr/bin/env node
// Agent Deck installer:
//  1. generates the manifest PNG icons
//  2. copies the plugin into OpenDeck's plugin directory
//  3. wires notify into ~/.codex/config.toml (backup kept)
//  4. removes any agent-deck hooks a previous (Claude-supporting) version
//     added to ~/.claude/settings.json
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
const NOTIFY_PATH = path.join(PLUGIN_SRC, 'hooks/codex-notify.mjs');
const STAMP = new Date().toISOString().slice(0, 10);

const log = (m) => console.log(`[agent-deck] ${m}`);

// 1. icons
const { manifestIcon } = await import(path.join(PLUGIN_SRC, 'bin/lib/icons.mjs'));
const iconDir = path.join(PLUGIN_SRC, 'icons');
fs.mkdirSync(iconDir, { recursive: true });
for (const kind of ['plugin', 'agent', 'command', 'skill', 'reasoning', 'model', 'usage']) {
  fs.writeFileSync(path.join(iconDir, `${kind}.png`), manifestIcon(kind, 144));
  fs.writeFileSync(path.join(iconDir, `${kind}@2x.png`), manifestIcon(kind, 288));
}
fs.rmSync(path.join(iconDir, 'target.png'), { force: true });
fs.rmSync(path.join(iconDir, 'target@2x.png'), { force: true });
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

// 3. Codex notify (top-level key: must precede the first [table] header)
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

// 4. remove agent-deck hooks from ~/.claude/settings.json (older versions)
try {
  const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  let removed = false;
  for (const [event, arr] of Object.entries(settings.hooks ?? {})) {
    const kept = arr.filter((entry) =>
      !(entry.hooks ?? []).some((h) => (h.command ?? '').includes('agent-deck')));
    if (kept.length !== arr.length) removed = true;
    if (kept.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = kept;
  }
  if (removed) {
    fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.bak-agentdeck-${STAMP}`);
    fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
    log('removed old agent-deck hooks from ~/.claude/settings.json');
  }
} catch { /* no claude settings — nothing to clean */ }

// 5. state dir
fs.mkdirSync(path.join(os.homedir(), '.local/share/agentdeck/state/codex'), { recursive: true });
fs.rmSync(path.join(os.homedir(), '.local/share/agentdeck/state/claude'), { recursive: true, force: true });
fs.rmSync(path.join(os.homedir(), '.local/share/agentdeck/target'), { force: true });
log('done — restart OpenDeck to load the plugin');
