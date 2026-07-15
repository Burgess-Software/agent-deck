// Codex session/status store.
//
// Sessions are discovered by polling ~/.codex/sessions rollout files. Codex
// writes a NEW rollout file per resume with the SAME session_id, so files are
// deduped by id keeping the newest. A session whose file grew recently is
// "working"; a working session that goes quiet transitions to "done". The
// notify hook (config.toml) makes "done" immediate and flags approvals as
// "needs_input".
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';

export const STATE_DIR = path.join(os.homedir(), '.local/share/agentdeck');
const CODEX_STATE = path.join(STATE_DIR, 'state/codex');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex/sessions');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // hide sessions idle > 12h
const CODEX_ACTIVE_WINDOW_MS = 15 * 1000;   // file touched this recently = working
const POLL_MS = 3000;

export class AgentState extends EventEmitter {
  constructor() {
    super();
    fs.mkdirSync(CODEX_STATE, { recursive: true });
    this.codexMeta = new Map();     // file -> {id, cwd}
    this.codexStatus = new Map();   // id -> {status, ts}
    this.sessions = [];
  }

  start() {
    const notify = () => this.refresh().catch((e) => console.error('refresh failed', e));
    try {
      this.notifyWatcher = fs.watch(CODEX_STATE, notify);
    } catch (e) {
      console.error('fs.watch failed, relying on polling only', e);
    }
    this.timer = setInterval(notify, POLL_MS);
    return this.refresh();
  }

  stop() {
    clearInterval(this.timer);
    this.notifyWatcher?.close();
  }

  /** sessions sorted most-recently-active first */
  get() { return this.sessions; }

  async refresh() {
    const sessions = await this.scan();
    const changed = JSON.stringify(sessions) !== JSON.stringify(this.sessions);
    this.sessions = sessions;
    if (changed) this.emit('change');
  }

  async scan() {
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

    // Dedupe by session id: resumes create new rollout files with the same
    // id — keep only the newest file per id.
    const newestById = new Map();
    for (const file of files) {
      let stat;
      try { stat = await fsp.stat(file); } catch { continue; }
      if (Date.now() - stat.mtimeMs > SESSION_TTL_MS) continue;
      let meta = this.codexMeta.get(file);
      if (!meta) {
        meta = await readCodexMeta(file);
        if (meta) this.codexMeta.set(file, meta);
      }
      if (!meta) continue;
      const prev = newestById.get(meta.id);
      if (!prev || stat.mtimeMs > prev.stat.mtimeMs) newestById.set(meta.id, { meta, stat });
    }

    const out = [];
    for (const { meta, stat } of newestById.values()) {
      const age = Date.now() - stat.mtimeMs;
      const prev = this.codexStatus.get(meta.id);
      const notified = notifyState.get(meta.id) || notifyState.get('latest');
      let status;
      if (age < CODEX_ACTIVE_WINDOW_MS) {
        status = 'working';
      } else if (notified?.status === 'needs_input' && notified.ts > stat.mtimeMs - 2000) {
        status = 'needs_input';
      } else if (prev?.status === 'working' || (notified?.status === 'done' && Date.now() - notified.ts < 5 * 60 * 1000)) {
        status = prev?.status === 'working' ? 'done' : notified.status;
      } else if (prev?.status === 'done' && Date.now() - prev.ts < 5 * 60 * 1000) {
        status = 'done';
      } else {
        status = 'idle';
      }
      if (status !== prev?.status) this.codexStatus.set(meta.id, { status, ts: Date.now() });
      out.push({
        id: meta.id,
        status,
        cwd: meta.cwd,
        project: meta.cwd ? path.basename(meta.cwd) : '?',
        title: meta.title,
        ts: stat.mtimeMs,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }
}

// Turn a raw first-user-message into a compact thread title, mirroring what
// the Codex app shows. Strips markdown links/urls/punctuation and collapses
// whitespace. Result is cached per file (first message never changes).
function cleanTitle(msg) {
  return String(msg)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/https?:\/\/\S+/g, '')          // bare urls
    .replace(/[`*_#>]/g, '')                 // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

// Stream the rollout to pull the session id + cwd (from the session_meta line)
// and the first real user message (an event_msg of type "user_message" — the
// clean message, not the system-injected context items). Stops as soon as it
// has the title, or after a bounded number of lines.
function readCodexMeta(file) {
  return new Promise((resolve) => {
    const fallbackId = path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-(?=[0-9a-f])/, '');
    let id = '', cwd = '', title = '', lines = 0, settled = false;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      resolve({
        id: id || fallbackId,
        cwd,
        title: title || (cwd ? path.basename(cwd) : 'thread'),
      });
    };
    rl.on('line', (line) => {
      if (settled) return;
      if (++lines > 600) return finish(); // bound work on huge transcripts
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const p = o.payload ?? o;
      if (o.type === 'session_meta' || p.session_id) {
        id = p.session_id || p.id || id;
        cwd = p.cwd || cwd;
      }
      if (!title && o.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
        title = cleanTitle(p.message);
        if (title) return finish();
      }
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}
