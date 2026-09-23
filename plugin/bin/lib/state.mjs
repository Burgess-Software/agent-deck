// Codex session/status store.
//
// Sessions are discovered by polling ~/.codex/sessions rollout files. Codex
// writes a NEW rollout file per resume with the SAME session_id, so files are
// deduped by id keeping the newest. Current rollouts contain explicit task
// lifecycle events; those are authoritative so a quiet, long-running task does
// not look complete. File recency remains a fallback for legacy rollouts. The
// notify hook (config.toml) makes "done" immediate and flags approvals as
// "needs_input".
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { StableSessionSlots } from './slots.mjs';

export const STATE_DIR = path.join(os.homedir(), '.local/share/agentdeck');
const CODEX_STATE = path.join(STATE_DIR, 'state/codex');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex/sessions');
const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex/session_index.jsonl');
const SLOT_STATE = path.join(STATE_DIR, 'state/session-slots.json');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // hide sessions idle > 12h
const CODEX_ACTIVE_WINDOW_MS = 15 * 1000;   // legacy rollout fallback only
const CODEX_DONE_WINDOW_MS = 5 * 60 * 1000;
const CODEX_NOTIFY_SLOP_MS = 2 * 1000;
const CODEX_READ_CHUNK_BYTES = 64 * 1024;
const CODEX_MAX_INCREMENTAL_BYTES = 8 * 1024 * 1024;
const POLL_MS = 3000;

function sameNumberSet(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function loadSlotState() {
  try {
    const value = JSON.parse(fs.readFileSync(SLOT_STATE, 'utf8'));
    if (value?.version !== 1 || !Array.isArray(value.bindings)) return {};
    return { bindings: value.bindings, knownRollouts: value.knownRollouts };
  } catch {
    return {};
  }
}

async function persistSlotState(value) {
  const tmp = `${SLOT_STATE}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(SLOT_STATE), { recursive: true });
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await fsp.rename(tmp, SLOT_STATE);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export class AgentState extends EventEmitter {
  constructor() {
    super();
    fs.mkdirSync(CODEX_STATE, { recursive: true });
    this.codexMeta = new Map();     // file -> {id, cwd}
    this.codexStatus = new Map();   // id -> {status, ts}
    this.codexLifecycle = new Map(); // file -> incremental task lifecycle state
    this.threadTitles = new Map();  // id -> Codex-generated chat title
    this.sessionIndexStamp = '';
    this.discoveredSessions = [];
    this.activeSlots = new Set();
    this.fallbackSlots = new Set();
    this.slotAllocator = new StableSessionSlots(loadSlotState());
    this.sessions = this.slotAllocator.bindings.map(() => null);
    this.slotStateDirty = false;
    this.stateQueue = Promise.resolve();
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

  /** sessions indexed by their stable Stream Deck slot (holes are null) */
  get() { return this.sessions; }

  /** Update the logical slot numbers currently represented by visible keys. */
  setActiveSlots(slots, fallbackSlots = []) {
    const next = new Set([...slots]
      .map((slot) => Number(slot))
      .filter((slot) => Number.isInteger(slot) && slot >= 0));
    const nextFallbacks = new Set([...fallbackSlots]
      .map((slot) => Number(slot))
      .filter((slot) => Number.isInteger(slot) && next.has(slot)));
    return this.enqueue(async () => {
      if (sameNumberSet(next, this.activeSlots)
          && sameNumberSet(nextFallbacks, this.fallbackSlots)) return;
      this.activeSlots = next;
      this.fallbackSlots = nextFallbacks;
      await this.applySlots();
    });
  }

  /**
   * Latest rate-limit usage, read from the tail of the most recently written
   * rollout file (Codex embeds a rate_limits object each turn). Returns the
   * weekly window's used percentage. Cached ~30s. null if unknown.
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

  refresh() {
    return this.enqueue(async () => {
      this.discoveredSessions = await this.scan();
      await this.applySlots();
    });
  }

  enqueue(work) {
    const next = this.stateQueue.then(work, work);
    this.stateQueue = next.catch(() => {});
    return next;
  }

  async applySlots() {
    const result = this.slotAllocator.reconcile(
      this.discoveredSessions,
      this.activeSlots,
      this.fallbackSlots,
    );
    const sessions = result.sessions;
    const changed = JSON.stringify(sessions) !== JSON.stringify(this.sessions);
    this.sessions = sessions;
    if (result.stateChanged) this.slotStateDirty = true;
    if (changed) this.emit('change');
    // Rendering must not depend on a successful state-file write. Keep a dirty
    // flag so a transient failure is retried by the next watcher/poll refresh.
    if (this.slotStateDirty) {
      try {
        await persistSlotState(this.slotAllocator.snapshot());
        this.slotStateDirty = false;
      } catch (error) {
        console.error('could not persist stable slots; will retry', error);
      }
    }
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

    // Codex appends generated/renamed chat titles here. Check it on every poll
    // so a title that arrives just after thread creation appears immediately;
    // the reader only reparses when its mtime or size changes.
    const threadTitles = await this.readSessionTitles();

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
        // Spawned agents replay parent history in their own rollout. They are
        // implementation details of a top-level chat, not independent deck
        // sessions, and must not replace the parent's status source.
        if (meta?.isSubagent) this.codexMeta.set(file, meta);
        // A just-created rollout may not contain its first user_message yet.
        // Retry those files until either the fallback snippet or the generated
        // index title exists instead of permanently caching the project name.
        else if (meta?.hasSnippet || threadTitles.has(meta?.id)) this.codexMeta.set(file, meta);
      }
      if (!meta || meta.isSubagent) continue;
      const prev = newestById.get(meta.id);
      if (!prev || stat.mtimeMs > prev.stat.mtimeMs) newestById.set(meta.id, { meta, stat, file });
    }
    const notifyState = await readNotifyState(newestById.keys());

    const out = [];
    for (const { meta, stat, file } of newestById.values()) {
      const prev = this.codexStatus.get(meta.id);
      const notified = notifyState.get(meta.id) || notifyState.get('latest');
      const lifecycle = await this.readCodexLifecycle(file, stat);
      const status = resolveCodexStatus({
        lifecycle,
        fileMtimeMs: stat.mtimeMs,
        notified,
        previous: prev,
      });
      if (status !== prev?.status) this.codexStatus.set(meta.id, { status, ts: Date.now() });
      out.push({
        id: meta.id,
        status,
        cwd: meta.cwd,
        project: meta.project || (meta.cwd ? path.basename(meta.cwd) : '?'),
        title: threadTitles.get(meta.id) || meta.title,
        ts: stat.mtimeMs,
        rolloutPath: file,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  async readCodexLifecycle(file, stat) {
    const cached = this.codexLifecycle.get(file);
    if (cached && stat.size >= cached.observedSize) {
      if (stat.size === cached.observedSize) return cached.lifecycle;

      // Normally only a few new JSONL rows need parsing. If the plugin was
      // asleep through a very large append, finding the newest lifecycle event
      // backwards is both cheaper and sufficient.
      if (stat.size - cached.offset <= CODEX_MAX_INCREMENTAL_BYTES) {
        try {
          const appended = await readCompleteAppend(file, cached.offset, stat.size);
          const next = {
            lifecycle: parseCodexLifecycle(appended.text, cached.lifecycle),
            offset: appended.offset,
            observedSize: stat.size,
          };
          this.codexLifecycle.set(file, next);
          return next.lifecycle;
        } catch { /* fall through to a fresh backwards read */ }
      }
    }

    try {
      const snapshot = await readCodexLifecycleSnapshot(file, stat.size);
      const next = { ...snapshot, observedSize: stat.size };
      this.codexLifecycle.set(file, next);
      return next.lifecycle;
    } catch {
      return null;
    }
  }

  async readSessionTitles() {
    try {
      const stat = await fsp.stat(CODEX_SESSION_INDEX);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === this.sessionIndexStamp) return this.threadTitles;

      const titles = parseSessionTitles(await fsp.readFile(CODEX_SESSION_INDEX, 'utf8'));
      this.threadTitles = titles;
      this.sessionIndexStamp = stamp;
    } catch { /* keep the last good snapshot; rollout snippets remain a fallback */ }
    return this.threadTitles;
  }
}

/** Only current sessions can use a notify record; old records may number in the thousands. */
export async function readNotifyState(ids, dir = CODEX_STATE) {
  const state = new Map();
  for (const id of new Set([...ids, 'latest'])) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
    try {
      state.set(id, JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8')));
    } catch { /* missing or partially written record */ }
  }
  return state;
}

// session_index.jsonl is append-only. Later entries win so manual renames and
// regenerated titles are reflected without restarting the plugin.
export function parseSessionTitles(text) {
  const titles = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const title = typeof entry.thread_name === 'string' ? cleanSnippet(entry.thread_name) : '';
      if (entry.id && title) titles.set(entry.id, title);
    } catch { /* ignore a partial final line while Codex is writing */ }
  }
  return titles;
}

function lifecycleFromEntry(entry) {
  if (entry?.type !== 'event_msg') return null;
  const event = entry.payload?.type;
  if (event !== 'task_started' && event !== 'task_complete' && event !== 'turn_aborted') return null;
  const parsedTs = Date.parse(entry.timestamp);
  return {
    status: event === 'task_started' ? 'working' : 'done',
    event,
    turnId: entry.payload?.turn_id || null,
    ts: Number.isFinite(parsedTs) ? parsedTs : null,
  };
}

/** Parse lifecycle rows in chronological order, optionally continuing a cache. */
export function parseCodexLifecycle(text, initial = null) {
  let lifecycle = initial;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      lifecycle = lifecycleFromEntry(JSON.parse(line)) || lifecycle;
    } catch { /* ignore a partial row while Codex is writing */ }
  }
  return lifecycle;
}

function latestLifecycleInText(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const lifecycle = lifecycleFromEntry(JSON.parse(lines[i]));
      if (lifecycle) return lifecycle;
    } catch { /* keep looking before a malformed/partial row */ }
  }
  return null;
}

async function readInto(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

async function lastCompleteLineOffset(handle, size) {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - CODEX_READ_CHUNK_BYTES);
    const chunk = await readInto(handle, Buffer.allocUnsafe(end - start), start);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

// On first sight of a rollout, search backwards until the newest lifecycle row
// is found. Completed sessions usually take one chunk; long active turns may
// put task_started megabytes behind EOF, so a fixed-size tail is insufficient.
async function readCodexLifecycleSnapshot(file, size) {
  const handle = await fsp.open(file, 'r');
  try {
    const offset = await lastCompleteLineOffset(handle, size);
    let end = offset;
    let leading = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CODEX_READ_CHUNK_BYTES);
      const chunk = await readInto(handle, Buffer.allocUnsafe(end - start), start);
      const combined = leading.length ? Buffer.concat([chunk, leading]) : chunk;
      const firstNewline = combined.indexOf(0x0a);
      if (start === 0 || firstNewline >= 0) {
        const complete = start === 0 ? combined : combined.subarray(firstNewline + 1);
        const lifecycle = latestLifecycleInText(complete.toString('utf8'));
        if (lifecycle) return { lifecycle, offset };
        leading = start === 0 ? Buffer.alloc(0) : combined.subarray(0, firstNewline);
      } else {
        leading = combined;
      }
      end = start;
    }
    return { lifecycle: null, offset };
  } finally {
    await handle.close();
  }
}

/** Read the newest complete lifecycle row from a rollout file. */
export async function readCodexLifecycle(file) {
  const stat = await fsp.stat(file);
  return (await readCodexLifecycleSnapshot(file, stat.size)).lifecycle;
}

async function readCompleteAppend(file, start, end) {
  if (end <= start) return { text: '', offset: start };
  const handle = await fsp.open(file, 'r');
  try {
    const data = await readInto(handle, Buffer.allocUnsafe(end - start), start);
    const newline = data.lastIndexOf(0x0a);
    if (newline < 0) return { text: '', offset: start };
    return {
      text: data.subarray(0, newline + 1).toString('utf8'),
      offset: start + newline + 1,
    };
  } finally {
    await handle.close();
  }
}

/** Resolve a deck color from authoritative lifecycle data, then legacy hints. */
export function resolveCodexStatus({
  lifecycle = null,
  fileMtimeMs,
  notified = null,
  previous = null,
  now = Date.now(),
}) {
  const mtime = Number(fileMtimeMs) || 0;
  const notifyTs = notified?.ts == null ? Number.NaN : Number(notified.ts);
  const lifecycleTs = lifecycle?.ts == null ? Number.NaN : Number(lifecycle.ts);
  const notificationIsCurrent = Number.isFinite(notifyTs)
    && notifyTs >= mtime - CODEX_NOTIFY_SLOP_MS
    && (!Number.isFinite(lifecycleTs) || notifyTs >= lifecycleTs);

  // Approval notifications have no equivalent lifecycle terminal row.
  if (notificationIsCurrent && notified.status === 'needs_input') return 'needs_input';
  // Preserve immediate completion if the hook wins a race with the final row.
  if (notificationIsCurrent && notified.status === 'done') {
    return now - notifyTs < CODEX_DONE_WINDOW_MS ? 'done' : 'idle';
  }

  if (lifecycle?.status === 'working') return 'working';
  if (lifecycle?.status === 'done') {
    const completedAt = Number.isFinite(lifecycleTs) ? lifecycleTs : mtime;
    return now - completedAt < CODEX_DONE_WINDOW_MS ? 'done' : 'idle';
  }

  // Older rollouts lack task_started/task_complete. Keep their original
  // activity heuristic, without allowing it to override modern lifecycle.
  const age = now - mtime;
  if (age < CODEX_ACTIVE_WINDOW_MS) return 'working';
  if (previous?.status === 'working') return 'done';
  if (previous?.status === 'done' && now - previous.ts < CODEX_DONE_WINDOW_MS) return 'done';
  return 'idle';
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
        return {
          usedPercent: Math.round(weekly.used_percent),
          resetsAt: weekly.resets_at,
          windowMinutes: weekly.window_minutes,
        };
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
  return String(msg ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/https?:\/\/\S+/g, '')          // bare urls
    .replace(/[`*_#>]/g, '')                 // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

// Read the rollout for id, cwd, project, and a first-message fallback title.
// The generated Codex title from session_index.jsonl takes precedence during
// scan, but the fallback keeps new threads distinct before that title arrives.
export function readCodexMeta(file) {
  return new Promise((resolve) => {
    const fallbackId = path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-(?=[0-9a-f])/, '');
    let id = '', cwd = '', gitProject = null, snippet = '', lines = 0, settled = false;
    let sawSessionMeta = false, isSubagent = false;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      const project = gitProject || (cwd ? path.basename(cwd) : 'thread');
      const title = snippet || project;
      resolve({ id: id || fallbackId, cwd, project, title, hasSnippet: !!snippet, isSubagent });
    };
    rl.on('line', (line) => {
      if (settled) return;
      if (++lines > 600) return finish(); // bound work on huge transcripts
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const p = o.payload ?? o;
      // A subagent rollout embeds copied parent history, including another
      // session_meta row. Only the first row describes this rollout itself.
      if (o.type === 'session_meta' && !sawSessionMeta) {
        sawSessionMeta = true;
        id = p.id || p.session_id || id;
        cwd = p.cwd || cwd;
        gitProject = projectFromGit(p.git);
        isSubagent = p.source === 'subagent'
          || !!p.source?.subagent
          || p.thread_source === 'subagent'
          || !!p.thread_source?.subagent;
        if (isSubagent) return finish();
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
