// Input injection for KDE Plasma (Wayland): window activation via KWin
// scripting D-Bus API, keystrokes via ydotool (uinput), text via clipboard
// paste so unicode and length are never a problem.
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', err });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// KWin script output is written to the user journal. It is normally visible
// immediately after Script.run returns, so check right away and only wait when
// journald is actually lagging instead of adding a fixed delay to every key.
async function waitForJournalMarker(marker, since, maxWaitMs = 120) {
  const deadline = Date.now() + maxWaitMs;
  do {
    const journal = await run('journalctl', ['--user', '-n', '200', '-o', 'cat', '--since', since]);
    const line = journal.stdout.split('\n').reverse().find((entry) => entry.includes(marker));
    if (line) return line;
    if (Date.now() >= deadline) return null;
    await sleep(10);
  } while (true);
}

export const APP_WINDOW_CLASS = {
  claude: 'claude-desktop',
  codex: 'codex-desktop',
};

export const APP_LAUNCH_CMD = {
  claude: 'claude-desktop',
  codex: 'codex-desktop',
};

let kwinScriptCounter = 0;

/**
 * Activate the first window whose resourceClass contains `cls`; if
 * `captionSubstr` is given, prefer a window whose caption contains it.
 * Returns true if a window was activated.
 */
export async function focusWindow(cls, captionSubstr = '') {
  const name = `agentdeck-focus-${process.pid}-${kwinScriptCounter++}`;
  const marker = `AGENTDECK_${Date.now()}`;
  const script = `
    const wins = (workspace.windowList ? workspace.windowList() : workspace.clientList())
      .filter(w => w.normalWindow && String(w.resourceClass).toLowerCase().includes(${JSON.stringify(cls.toLowerCase())}));
    const cap = ${JSON.stringify(captionSubstr.toLowerCase())};
    let target = cap ? wins.find(w => String(w.caption).toLowerCase().includes(cap)) : null;
    if (!target) target = wins[0];
    if (target) {
      if (target.minimized !== undefined) target.minimized = false;
      if (workspace.activeWindow !== undefined) workspace.activeWindow = target;
      else workspace.activeClient = target;
      print(${JSON.stringify(marker)} + ":FOUND");
    } else {
      print(${JSON.stringify(marker)} + ":MISSING");
    }
  `;
  const file = join(tmpdir(), `${name}.js`);
  await writeFile(file, script);
  try {
    const load = await run('dbus-send', [
      '--session', '--print-reply', '--dest=org.kde.KWin', '/Scripting',
      'org.kde.kwin.Scripting.loadScript', `string:${file}`, `string:${name}`,
    ]);
    const m = load.stdout.match(/int32 (\d+)/);
    if (!m) return false;
    const id = m[1];
    let ran = await run('dbus-send', [
      '--session', '--print-reply', '--dest=org.kde.KWin', `/Scripting/Script${id}`,
      'org.kde.kwin.Script.run',
    ]);
    if (!ran.ok) {
      ran = await run('dbus-send', [
        '--session', '--print-reply', '--dest=org.kde.KWin', `/${id}`,
        'org.kde.kwin.Script.run',
      ]);
    }
    await run('dbus-send', [
      '--session', '--print-reply', '--dest=org.kde.KWin', '/Scripting',
      'org.kde.kwin.Scripting.unloadScript', `string:${name}`,
    ]);
    if (!ran.ok) return false;
    // The script's print() lands in the user journal; read the marker back.
    const markerLine = await waitForJournalMarker(marker, '-15s');
    if (markerLine?.includes(`${marker}:FOUND`)) return true;
    if (markerLine?.includes(`${marker}:MISSING`)) return false;
    return true; // journal unavailable — assume the activation worked
  } finally {
    unlink(file).catch(() => {});
  }
}

// Linux input event codes (uinput), enough for the shortcuts we send.
const KEYCODES = {
  esc: 1, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  minus: 12, equal: 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  enter: 28, ctrl: 29, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  shift: 42, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  alt: 56, space: 57, meta: 125, super: 125,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  up: 103, down: 108, left: 105, right: 106, pageup: 104, pagedown: 109, home: 102, end: 107,
  delete: 111, insert: 110,
};

function comboCodes(combo) {
  const codes = combo.toLowerCase().split('+').map((p) => KEYCODES[p]);
  if (codes.some((c) => c === undefined)) throw new Error(`unknown key in combo "${combo}"`);
  return codes;
}

/**
 * Send a key combo like "ctrl+n", "enter", "ctrl+shift+p", or a sequence
 * of combos separated by spaces: "esc esc".
 *
 * Uses ydotool (kernel uinput), NOT xdotool/XTEST. On this KDE Wayland
 * session Xwayland runs with -enable-ei-portal, so XTEST synthetic input is
 * routed through the RemoteDesktop portal and pops a "control input devices"
 * authorization dialog. uinput injects below the display server and never
 * triggers the portal. Delivers fine to XWayland windows (Codex) too.
 */
export async function sendKeys(combos) {
  for (const combo of combos.trim().split(/\s+/)) {
    const codes = comboCodes(combo);
    const seq = [
      ...codes.map((c) => `${c}:1`),
      ...codes.slice().reverse().map((c) => `${c}:0`),
    ];
    const res = await run('ydotool', ['key', '--key-delay', '12', ...seq]);
    if (!res.ok) throw new Error(`ydotool failed: ${res.stderr || res.err}`);
    await sleep(60);
  }
}

/** Hold a combo down (for push-to-talk). Pair with releaseKeys. */
export async function holdKeys(combo) {
  const codes = comboCodes(combo);
  const res = await run('ydotool', ['key', '--key-delay', '8', ...codes.map((c) => `${c}:1`)]);
  if (!res.ok) throw new Error(`ydotool keydown failed: ${res.stderr || res.err}`);
}

/** Release a held combo (reverse order). */
export async function releaseKeys(combo) {
  const codes = comboCodes(combo);
  await run('ydotool', ['key', '--key-delay', '8', ...codes.slice().reverse().map((c) => `${c}:0`)]);
}

/** Put text in the focused input via clipboard paste; restores clipboard. */
export async function pasteText(text, { submit = false } = {}) {
  const prev = await run('wl-paste', ['-n']);
  const copy = await new Promise((resolve) => {
    const p = execFile('wl-copy', [], (err) => resolve({ ok: !err, err }));
    p.stdin.end(text);
  });
  if (!copy.ok) throw new Error(`wl-copy failed: ${copy.err}`);
  await sleep(180);
  await sendKeys('ctrl+v');
  await sleep(250);
  if (submit) await sendKeys('enter');
  // Restore previous clipboard contents (best effort, only if it was text).
  if (prev.ok && prev.stdout.length > 0 && prev.stdout.length < 1024 * 1024) {
    setTimeout(() => {
      const p = execFile('wl-copy', [], () => {});
      p.stdin.end(prev.stdout);
    }, 800);
  }
}

/** Run an arbitrary user-configured shell command (push-to-talk etc). */
export function runShell(command) {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', command], { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr });
    });
  });
}

/** resourceClass of the currently focused window (KWin), or null. */
export async function activeWindowClass() {
  const name = `agentdeck-active-${process.pid}-${kwinScriptCounter++}`;
  const marker = `AGENTDECK_ACTIVE_${Date.now()}`;
  const script = `
    const w = workspace.activeWindow !== undefined ? workspace.activeWindow : workspace.activeClient;
    print(${JSON.stringify(marker)} + ":" + (w ? String(w.resourceClass) : "none"));
  `;
  const file = join(tmpdir(), `${name}.js`);
  await writeFile(file, script);
  try {
    const load = await run('dbus-send', [
      '--session', '--print-reply', '--dest=org.kde.KWin', '/Scripting',
      'org.kde.kwin.Scripting.loadScript', `string:${file}`, `string:${name}`,
    ]);
    const m = load.stdout.match(/int32 (\d+)/);
    if (!m) return null;
    await run('dbus-send', [
      '--session', '--print-reply', '--dest=org.kde.KWin', `/Scripting/Script${m[1]}`,
      'org.kde.kwin.Script.run',
    ]);
    await run('dbus-send', [
      '--session', '--print-reply', '--dest=org.kde.KWin', '/Scripting',
      'org.kde.kwin.Scripting.unloadScript', `string:${name}`,
    ]);
    const hit = await waitForJournalMarker(marker, '-10s', 100);
    return hit ? hit.split(`${marker}:`)[1]?.trim() ?? null : null;
  } finally {
    unlink(file).catch(() => {});
  }
}

/**
 * Guarded injection: runs `fn` only if the focused window's class contains
 * `cls`. Prevents keystrokes from landing in whatever the user switched to.
 */
export async function whileFocused(cls, fn) {
  const active = await activeWindowClass();
  if (!active || !active.toLowerCase().includes(cls.toLowerCase())) {
    throw new Error(`focus moved to "${active}" — aborting injection meant for ${cls}`);
  }
  return fn();
}

const SAFE_SOCKET_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Match Codex Desktop's Linux launch-action socket lookup.  Sending a URI to
 * this socket reaches the running Electron instance directly; spawning a new
 * desktop process through xdg-open can leave a headless orphan behind.
 */
export function codexLaunchActionSocketPath(env = process.env) {
  const configuredAppId = env.CODEX_LINUX_APP_ID || env.CODEX_APP_ID || 'codex-desktop';
  const appId = SAFE_SOCKET_SEGMENT.test(configuredAppId) ? configuredAppId : 'codex-desktop';
  const candidateInstanceId = env.CODEX_LINUX_INSTANCE_ID?.trim();
  const instanceId = candidateInstanceId && SAFE_SOCKET_SEGMENT.test(candidateInstanceId)
    ? candidateInstanceId
    : null;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();

  if (runtimeDir) {
    return instanceId
      ? join(runtimeDir, appId, 'instances', instanceId, 'launch-action.sock')
      : join(runtimeDir, appId, 'launch-action.sock');
  }

  const stateHome = env.XDG_STATE_HOME?.trim()
    || (env.HOME?.trim() ? join(env.HOME, '.local', 'state') : null);
  if (!stateHome) return null;
  return instanceId
    ? join(stateHome, appId, 'instances', instanceId, 'launch-action.sock')
    : join(stateHome, appId, 'launch-action.sock');
}

/** Send a Codex deep link to the already-running Linux desktop app. */
export function sendCodexLaunchAction(uri, {
  socketPath = codexLaunchActionSocketPath(),
  timeoutMs = 1000,
} = {}) {
  if (!socketPath || !uri.startsWith('codex://')) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let response = '';
    const socket = createConnection(socketPath);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(ok);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.end(`${JSON.stringify({ argv: [uri] })}\n`);
    });
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\n')) finish(response.trim() === 'ok');
    });
    socket.once('end', () => finish(response.trim() === 'ok'));
    socket.once('error', () => finish(false));
  });
}

/** Open a deep link, preferring Codex Desktop's running-instance socket. */
export async function openUri(uri, { allowFallback = true } = {}) {
  if (uri.startsWith('codex://') && await sendCodexLaunchAction(uri)) return true;
  if (uri.startsWith('codex://') && !allowFallback) return false;
  return new Promise((resolve) => {
    execFile('xdg-open', [uri], { timeout: 10000 }, (err) => resolve(!err));
  });
}

/** Launch the app if it has no window; returns after focusing either way. */
export async function focusOrLaunch(app, captionSubstr = '') {
  const ok = await focusWindow(APP_WINDOW_CLASS[app], captionSubstr);
  if (!ok) {
    execFile('setsid', ['-f', APP_LAUNCH_CMD[app]], () => {});
  }
  return ok;
}
