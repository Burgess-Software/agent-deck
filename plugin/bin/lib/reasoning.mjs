// Reasoning-effort "dial": reads and cycles model_reasoning_effort in
// ~/.codex/config.toml. New sessions pick the level up.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CODEX_CONFIG = path.join(os.homedir(), '.codex/config.toml');

export const LEVELS = ['minimal', 'low', 'medium', 'high'];

export function getLevel() {
  try {
    const toml = fs.readFileSync(CODEX_CONFIG, 'utf8');
    const m = toml.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
    return m ? m[1] : 'medium';
  } catch {
    return 'medium';
  }
}

export function setLevel(level) {
  if (!LEVELS.includes(level)) throw new Error(`bad level ${level}`);
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

export function cycleLevel(direction = 1) {
  const cur = LEVELS.indexOf(getLevel());
  const next = LEVELS[(cur + direction + LEVELS.length) % LEVELS.length];
  setLevel(next);
  return next;
}
