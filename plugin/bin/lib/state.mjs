// Central session/status store.
//
// Claude Code: hook scripts (installed into ~/.claude/settings.json) write
// one JSON file per session to <stateDir>/state/claude/<session_id>.json.
//
// Codex: sessions are discovered by polling ~/.codex/sessions rollout files.
// A session whose file grew recently is "working"; a working session that
// goes quiet transitions to "done". The optional notify hook makes "done"
// immediate and flags approval requests as "needs_input".
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const STATE_DIR = path.join(os.homedir(), '.local/share/agentdeck');
const CLAUDE_STATE = path.join(STATE_DIR, 'state/claude');
const CODEX_STATE = path.join(STATE_DIR, 'state/codex');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex/sessions');
const CLAUDE_DESKTOP_SESSIONS = path.join(os.homedir(), '.config/Claude/claude-code-sessions');
const TARGET_FILE = path.join(STATE_DIR, 'target');

let sessionDirsCache = null;
async function globSessionDirs() {
  if (sessionDirsCache) return sessionDirsCache;
  const dirs = [];
  try {
    for (const org of await fsp.readdir(CLAUDE_DESKTOP_SESSIONS)) {
      const orgDir = path.join(CLAUDE_DESKTOP_SESSIONS, org);
      try {
        for (const user of await fsp.readdir(orgDir)) dirs.push(path.join(orgDir, user));
      } catch { /* not a dir */ }
    }
  } catch { /* store absent (desktop app not installed) */ }
  sessionDirsCache = dirs;
  return dirs;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // hide sessions idle > 12h
const CODEX_ACTIVE_WINDOW_MS = 15 * 1000;   // file touched this recently = working
const POLL_MS = 3000;

export class AgentState extends EventEmitter {
  constructor() {
    super();
    fs.mkdirSync(CLAUDE_STATE, { recursive: true });
    fs.mkdirSync(CODEX_STATE, { recursive: true });
    this.codexMeta = new Map();     // file -> {id, cwd}
    this.codexStatus = new Map();   // id -> {status, ts}
    this.sessions = { claude: [], codex: [] };
  }

  start() {
    const notify = () => this.refresh().catch((e) => console.error('refresh failed', e));
    try {
      this.claudeWatcher = fs.watch(CLAUDE_STATE, notify);
      this.codexNotifyWatcher = fs.watch(CODEX_STATE, notify);
      this.targetWatcher = fs.watch(STATE_DIR, (ev, f) => { if (f === 'target') this.emit('target'); });
    } catch (e) {
      console.error('fs.watch failed, relying on polling only', e);
    }
    this.desktopWatchers = [];
    globSessionDirs().then((dirs) => {
      for (const d of dirs) {
        try { this.desktopWatchers.push(fs.watch(d, notify)); } catch { /* polling covers it */ }
      }
    });
    this.timer = setInterval(notify, POLL_MS);
    return this.refresh();
  }

  stop() {
    clearInterval(this.timer);
    this.claudeWatcher?.close();
    this.codexNotifyWatcher?.close();
    this.targetWatcher?.close();
    for (const w of this.desktopWatchers ?? []) w.close();
  }

  getTarget() {
    try { return fs.readFileSync(TARGET_FILE, 'utf8').trim() === 'codex' ? 'codex' : 'claude'; }
    catch { return 'claude'; }
  }

  setTarget(app) {
    fs.writeFileSync(TARGET_FILE, app);
    this.emit('target');
  }

  toggleTarget() {
    const next = this.getTarget() === 'claude' ? 'codex' : 'claude';
    this.setTarget(next);
    return next;
  }

  /** sessions sorted most-recently-active first */
  get(app) { return this.sessions[app] ?? []; }

  async refresh() {
    const [claude, codex] = await Promise.all([this.scanClaude(), this.scanCodex()]);
    const changed = JSON.stringify([claude, codex]) !== JSON.stringify([this.sessions.claude, this.sessions.codex]);
    this.sessions = { claude, codex };
    if (changed) this.emit('change');
  }

  async scanClaude() {
    // Source of truth: the desktop app's own session store
    // (~/.config/Claude/claude-code-sessions/<org>/<user>/local_*.json).
    // Hook state files (keyed by CLI session id) contribute live status.
    const hookStatus = new Map();
    try {
      for (const f of await fsp.readdir(CLAUDE_STATE)) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(await fsp.readFile(path.join(CLAUDE_STATE, f), 'utf8'));
          if (Date.now() - data.ts > SESSION_TTL_MS) {
            await fsp.unlink(path.join(CLAUDE_STATE, f)).catch(() => {});
            continue;
          }
          hookStatus.set(f.replace(/\.json$/, ''), data);
        } catch { /* partial write */ }
      }
    } catch { /* no state dir yet */ }

    const out = [];
    for (const dir of await globSessionDirs()) {
      let files;
      try { files = await fsp.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        try {
          const s = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          if (s.isArchived) continue;
          const ts = s.lastActivityAt ?? s.lastFocusedAt ?? s.createdAt ?? 0;
          if (Date.now() - ts > SESSION_TTL_MS) continue;
          const hook = s.cliSessionId ? hookStatus.get(s.cliSessionId) : null;
          out.push({
            app: 'claude',
            id: s.sessionId,           // local_… id, used by the claude://code deep link
            cliId: s.cliSessionId,
            status: hook?.status ?? 'idle',
            cwd: s.cwd || '',
            project: s.cwd ? path.basename(s.cwd) : '?',
            title: s.title || (s.cwd ? path.basename(s.cwd) : 'chat'),
            ts,
          });
        } catch { /* partial write */ }
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  async scanCodex() {
    // Look at today's and yesterday's session directories.
    const days = [new Date(), new Date(Date.now() - 86400000)].map((d) =>
      path.join(CODEX_SESSIONS, String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
    const files = [];
    for (const dir of days) {
      let entries;
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const e of entries) {
        if (e.startsWith('rollout-') && e.endsWith('.jsonl')) files.push(path.join(dir, e));
      }
    }

    // Notify-hook state (id -> done/needs_input timestamps).
    const notifyState = new Map();
    try {
      for (const f of await fsp.readdir(CODEX_STATE)) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(await fsp.readFile(path.join(CODEX_STATE, f), 'utf8'));
          notifyState.set(f.replace(/\.json$/, ''), data);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    const out = [];
    for (const file of files) {
      let stat;
      try { stat = await fsp.stat(file); } catch { continue; }
      const age = Date.now() - stat.mtimeMs;
      if (age > SESSION_TTL_MS) continue;

      let meta = this.codexMeta.get(file);
      if (!meta) {
        meta = await readCodexMeta(file);
        if (meta) this.codexMeta.set(file, meta);
      }
      if (!meta) continue;

      const prev = this.codexStatus.get(meta.id);
      const notified = notifyState.get(meta.id) || notifyState.get('latest');
      let status;
      if (age < CODEX_ACTIVE_WINDOW_MS) {
        status = 'working';
      } else if (notified?.status === 'needs_input' && notified.ts > stat.mtimeMs - 2000) {
        status = 'needs_input';
      } else if (prev?.status === 'working' || (notified?.status === 'done' && Date.now() - notified.ts < 5 * 60 * 1000)) {
        // just went quiet, or notify said the turn completed recently
        status = prev?.status === 'working' ? 'done' : notified.status;
      } else if (prev?.status === 'done' && Date.now() - prev.ts < 5 * 60 * 1000) {
        status = 'done';
      } else {
        status = 'idle';
      }
      if (status !== prev?.status) this.codexStatus.set(meta.id, { status, ts: Date.now() });
      out.push({
        app: 'codex',
        id: meta.id,
        status,
        cwd: meta.cwd,
        project: meta.cwd ? path.basename(meta.cwd) : '?',
        title: meta.cwd ? path.basename(meta.cwd) : 'thread',
        ts: stat.mtimeMs,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }
}

async function readCodexMeta(file) {
  try {
    // The session_meta line embeds the full base instructions, so it can be
    // tens of KB. Read a generous chunk and try full parse, then fall back
    // to plucking the two fields we need out of the raw text.
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    const head = buf.subarray(0, bytesRead).toString('utf8');
    const fallbackId = path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-(?=[0-9a-f])/, '');
    try {
      const parsed = JSON.parse(head.split('\n')[0]);
      const payload = parsed.payload ?? parsed;
      return { id: payload.session_id || payload.id || fallbackId, cwd: payload.cwd || '' };
    } catch {
      const id = head.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1] || fallbackId;
      const cwd = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] || '';
      return { id, cwd: cwd.replace(/\\(.)/g, '$1') };
    }
  } catch {
    return null;
  }
}
