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

  /**
   * Latest rate-limit usage, read from the tail of the most recently written
   * rollout file (Codex embeds a rate_limits object each turn). Returns the
   * weekly window's used_percent. Cached ~30s. null if unknown.
   */
  async getUsage() {
    if (this._usage && Date.now() - this._usage.ts < 30000) return this._usage.value;
    const value = await readUsage();
    // keep last known value if this read found nothing (between turns)
    this._usage = { value: value ?? this._usage?.value ?? null, ts: Date.now() };
    return this._usage.value;
  }

  /** Last-read usage without triggering I/O (for synchronous rendering). */
  getUsageCached() { return this._usage?.value ?? null; }

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

// Parse the JSON object that starts at the first "{" at/after `from`.
function parseObjectAt(text, from) {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

async function readUsage() {
  // newest rollout file across today + yesterday
  const days = [new Date(), new Date(Date.now() - 86400000)].map((d) =>
    path.join(CODEX_SESSIONS, String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  let newest = null;
  for (const dir of days) {
    let entries;
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.startsWith('rollout-') || !e.endsWith('.jsonl')) continue;
      const p = path.join(dir, e);
      try {
        const st = await fsp.stat(p);
        if (!newest || st.mtimeMs > newest.mtime) newest = { file: p, mtime: st.mtimeMs, size: st.size };
      } catch { /* skip */ }
    }
  }
  if (!newest) return null;
  try {
    const len = Math.min(newest.size, 256 * 1024);
    const fh = await fsp.open(newest.file, 'r');
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, newest.size - len);
    await fh.close();
    const text = buf.toString('utf8');
    // walk backwards through rate_limits occurrences until one parses
    let idx = text.lastIndexOf('"rate_limits"');
    while (idx >= 0) {
      const obj = parseObjectAt(text, idx + '"rate_limits"'.length);
      const cands = [obj?.primary, obj?.secondary].filter((w) => w && typeof w.used_percent === 'number');
      if (cands.length) {
        // weekly = the widest window (a weekly limit is larger than any 5h one)
        const weekly = cands.reduce((a, b) => (b.window_minutes > (a?.window_minutes ?? -1) ? b : a), null);
        return { percent: Math.round(weekly.used_percent), resetsAt: weekly.resets_at, windowMinutes: weekly.window_minutes };
      }
      idx = text.lastIndexOf('"rate_limits"', idx - 1);
    }
  } catch { /* fall through */ }
  return null;
}

// Project name from a git remote URL: git@github.com:Org/repo.git -> "repo".
function projectFromGit(git) {
  const url = git?.repository_url;
  if (!url) return null;
  const m = url.replace(/\.git$/, '').match(/[/:]([^/]+?)\/?$/);
  return m ? m[1] : null;
}

// Compact a first-user-message into a label: strip markdown links/urls/
// punctuation, collapse whitespace, cap length.
function cleanSnippet(msg) {
  return String(msg)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/https?:\/\/\S+/g, '')          // bare urls
    .replace(/[`*_#>]/g, '')                 // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

// Read the rollout for id, cwd, and label. Label = git repo name when the
// thread is in a repo (available on the first session_meta line, so we can
// stop immediately); otherwise, for scratch-dir threads, keep reading to the
// first real user message and use that snippet. Cached per file.
function readCodexMeta(file) {
  return new Promise((resolve) => {
    const fallbackId = path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-(?=[0-9a-f])/, '');
    let id = '', cwd = '', gitProject = null, snippet = '', lines = 0, settled = false;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      const project = gitProject || (cwd ? path.basename(cwd) : 'thread');
      // repo threads: repo name; scratch dirs: first-message snippet, else dir
      const title = gitProject ? project : (snippet || project);
      resolve({ id: id || fallbackId, cwd, project, title });
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
        gitProject = projectFromGit(p.git);
        if (gitProject) return finish(); // in a repo — no need to read further
      }
      if (!snippet && o.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
        snippet = cleanSnippet(p.message);
        if (snippet) return finish();
      }
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}
