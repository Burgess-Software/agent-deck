// Reasoning-effort "dial": reads and cycles the real config values —
// effortLevel in ~/.claude/settings.json and model_reasoning_effort in
// ~/.codex/config.toml. New sessions pick the level up.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude/settings.json');
const CODEX_CONFIG = path.join(os.homedir(), '.codex/config.toml');

export const LEVELS = {
  claude: ['low', 'medium', 'high'],
  codex: ['minimal', 'low', 'medium', 'high'],
};

export function getLevel(app) {
  try {
    if (app === 'claude') {
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
      return settings.effortLevel || 'high';
    }
    const toml = fs.readFileSync(CODEX_CONFIG, 'utf8');
    const m = toml.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
    return m ? m[1] : 'medium';
  } catch {
    return app === 'claude' ? 'high' : 'medium';
  }
}

export function setLevel(app, level) {
  if (!LEVELS[app].includes(level)) throw new Error(`bad level ${level} for ${app}`);
  if (app === 'claude') {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    settings.effortLevel = level;
    fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
    return;
  }
  const toml = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const line = `model_reasoning_effort = "${level}"`;
  let next;
  if (/^\s*model_reasoning_effort\s*=.*$/m.test(toml)) {
    next = toml.replace(/^\s*model_reasoning_effort\s*=.*$/m, line);
  } else {
    next = `${line}\n${toml}`; // top-level key must precede any [table]
  }
  fs.writeFileSync(CODEX_CONFIG, next);
}

export function cycleLevel(app, direction = 1) {
  const levels = LEVELS[app];
  const cur = levels.indexOf(getLevel(app));
  const next = levels[(cur + direction + levels.length) % levels.length];
  setLevel(app, next);
  return next;
}
