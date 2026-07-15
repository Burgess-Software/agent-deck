#!/usr/bin/env node
// Agent Deck — Codex Micro feature set as a Stream Deck (OpenDeck) plugin,
// controlling the Codex desktop app.
import { StreamDeck, parseArgs } from './lib/protocol.mjs';
import { AgentState } from './lib/state.mjs';
import * as icons from './lib/icons.mjs';
import { focusOrLaunch, sendKeys, pasteText, runShell, openUri, whileFocused, holdKeys, releaseKeys, APP_WINDOW_CLASS } from './lib/inject.mjs';

// Default shortcut the reasoning key sends. Bind this to "Cycle reasoning
// effort" in Codex → Settings → Keyboard Shortcuts (it has no default). NOT
// ctrl+alt+r — that's Codex's built-in "Rename task". The increase/decrease
// variants are used by an encoder's rotation if bound.
const DEFAULT_REASONING_CYCLE = 'ctrl+alt+e';
// Codex's built-in "open model picker" shortcut (no setup needed).
const MODEL_PICKER_KEYS = 'ctrl+shift+m';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PREFIX = 'com.thomasburgess.agentdeck';
const CODEX_CLS = APP_WINDOW_CLASS.codex;

const COMMAND_PRESETS = {
  accept:    { title: 'Accept',   keys: 'enter',        accent: '#27ae60' },
  reject:    { title: 'Reject',   keys: 'esc',          accent: '#e74c3c' },
  interrupt: { title: 'Stop',     keys: 'esc',          accent: '#e74c3c' },
  newchat:   { title: 'New chat', keys: 'ctrl+n',       accent: '#3d8bfd' },
  ptt:       { title: 'Voice',    keys: 'ctrl+shift+d', accent: '#b48cf2', hold: true },
  custom:    { title: 'Custom',   keys: '',             accent: '#f7821b' },
};

export const SKILL_PRESETS = {
  review:   { title: 'Review PR', prompt: 'Review the current branch against the main branch like a thorough PR reviewer: correctness bugs first, then design concerns. Be specific with file and line references.' },
  debug:    { title: 'Debug',     prompt: 'Something is failing. Look at the most recent error (check terminal output, logs, or failing tests), find the root cause, and fix it.' },
  refactor: { title: 'Refactor',  prompt: 'Refactor the code we have been discussing (or the most recently changed files) for clarity and simplicity without changing behavior. Keep the diff focused.' },
  tests:    { title: 'Tests',     prompt: 'Write or extend tests for the most recently changed code. Cover the main path and the edge cases that could realistically break.' },
  explain:  { title: 'Explain',   prompt: 'Explain what the current code/change does and why, at a level a teammate unfamiliar with it would understand.' },
  ship:     { title: 'Commit',    prompt: 'Run the relevant checks, then commit the current work with a good message and push the branch.' },
};

const args = parseArgs(process.argv.slice(2));
const sd = new StreamDeck({
  port: args.port,
  pluginUUID: args.pluginUUID,
  registerEvent: args.registerEvent,
  info: args.info,
});

const state = new AgentState();
// context -> {action, settings}
const instances = new Map();
let pulse = false; // blink phase for "working"

// ---------- rendering ----------

// Fit a label into two short lines (<= ~8 chars each) so OpenDeck's centered
// title never overflows and clips. Breaks on a word boundary when possible.
function wrapLabel(text, width = 8, maxLines = 2) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
    if (lines.length >= maxLines) break;
    // a single word longer than width: hard-split it
    while (cur.length > width && lines.length < maxLines) {
      lines.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const out = lines.slice(0, maxLines);
  // mark truncation if we ran out of room
  if (out.length === maxLines) {
    const used = out.join(' ').length;
    if (used < String(text).trim().length) out[maxLines - 1] = `${out[maxLines - 1].slice(0, width - 1)}…`;
  }
  return out.join('\n');
}

function renderAgent(context, settings) {
  const slot = Number(settings?.slot ?? 0);
  const s = state.get()[slot] ?? null;
  if (!s) {
    sd.setImage(context, icons.agentKey({ status: 'empty' }));
    sd.setTitle(context, `\n\n\n—`);
    return;
  }
  const dim = s.status === 'working' && pulse;
  sd.setImage(context, icons.agentKey({ status: s.status, dim }));
  // OpenDeck center-clips titles past ~8 chars at the default font size, so
  // wrap onto two short lines instead of one overflowing line.
  sd.setTitle(context, `\n\n${wrapLabel(s.title || s.project)}`);
}

function renderCommand(context, settings) {
  const preset = COMMAND_PRESETS[settings?.command ?? 'accept'] ?? COMMAND_PRESETS.accept;
  sd.setImage(context, icons.commandKey({ accent: preset.accent }));
  sd.setTitle(context, `\n\n${wrapLabel(settings?.label || preset.title)}`);
}

function renderSkill(context, settings) {
  const preset = SKILL_PRESETS[settings?.skill ?? 'review'] ?? SKILL_PRESETS.review;
  sd.setImage(context, icons.commandKey({ accent: '#f7c744' }));
  sd.setTitle(context, `\n\n${wrapLabel(settings?.label || preset.title)}`);
}

function renderReasoning(context, settings) {
  // The current level lives in Codex's UI state, not a file we can read, so
  // the key is a stateless "nudge" (like the hardware dial) rather than a
  // gauge. Show a neutral dial glyph + label.
  sd.setImage(context, icons.reasoningKey({ frac: 0.6 }));
  sd.setTitle(context, `\n\n${wrapLabel(settings?.label || 'Reason')}`);
}

function renderModel(context, settings) {
  sd.setImage(context, icons.modelKey());
  sd.setTitle(context, `\n\n${wrapLabel(settings?.label || 'Model')}`);
}

function renderUsage(context, settings) {
  const u = state.getUsageCached();
  const pct = u ? u.percent : null;
  sd.setImage(context, icons.usageKey({ percent: pct ?? 0 }));
  sd.setTitle(context, `\n\n\n${pct == null ? '—' : `${pct}%`}`);
}

function render(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const kind = inst.action.slice(PREFIX.length + 1);
  try {
    if (kind === 'agent') renderAgent(context, inst.settings);
    else if (kind === 'command') renderCommand(context, inst.settings);
    else if (kind === 'skill') renderSkill(context, inst.settings);
    else if (kind === 'reasoning') renderReasoning(context, inst.settings);
    else if (kind === 'model') renderModel(context, inst.settings);
    else if (kind === 'usage') renderUsage(context, inst.settings);
  } catch (e) {
    console.error(`render ${kind} failed`, e);
  }
}

function renderAll(kinds = null) {
  for (const [context, inst] of instances) {
    if (!kinds || kinds.includes(inst.action.slice(PREFIX.length + 1))) render(context);
  }
}

// ---------- key behavior ----------

async function pressAgent(context, settings) {
  const s = state.get()[Number(settings?.slot ?? 0)] ?? null;
  if (s) {
    console.log(`agent key: opening codex://threads/${s.id}`);
    await openUri(`codex://threads/${s.id}`);
    await sleep(400);
  }
  await focusOrLaunch('codex');
}

async function pressCommand(context, settings) {
  const name = settings?.command ?? 'accept';
  const preset = COMMAND_PRESETS[name] ?? COMMAND_PRESETS.accept;
  if (settings?.shell) {
    const res = await runShell(settings.shell);
    res.ok ? sd.showOk(context) : sd.showAlert(context);
    return;
  }
  if (settings?.text) {
    await focusOrLaunch('codex');
    await sleep(300);
    await whileFocused(CODEX_CLS, () => pasteText(settings.text, { submit: !!settings.submit }));
    sd.showOk(context);
    return;
  }
  const keys = settings?.keys || preset.keys;
  if (!keys) { sd.showAlert(context); return; }
  await focusOrLaunch('codex');
  await sleep(300);
  await whileFocused(CODEX_CLS, () => sendKeys(keys));
  sd.showOk(context);
}

async function pressSkill(context, settings) {
  const preset = SKILL_PRESETS[settings?.skill ?? 'review'] ?? SKILL_PRESETS.review;
  const prompt = settings?.prompt || preset.prompt;
  await focusOrLaunch('codex');
  await sleep(350);
  await whileFocused(CODEX_CLS, () => pasteText(prompt, { submit: settings?.autosend !== false }));
  sd.showOk(context);
}

async function pressModel(context, settings) {
  const keys = settings?.keys || MODEL_PICKER_KEYS;
  await focusOrLaunch('codex');
  await sleep(250);
  await whileFocused(CODEX_CLS, () => sendKeys(keys));
  sd.showOk(context);
}

async function pressUsage(context) {
  // refresh from disk and redraw
  await state.getUsage().catch(() => {});
  renderAll(['usage']);
  sd.showOk(context);
}

async function pressReasoning(context, settings, direction = 0) {
  // direction 0 = cycle (key press), +1 = increase, -1 = decrease (encoder).
  const cycle = settings?.cycleKeys || DEFAULT_REASONING_CYCLE;
  const keys = direction > 0 ? (settings?.upKeys || cycle)
    : direction < 0 ? (settings?.downKeys || cycle)
    : cycle;
  await focusOrLaunch('codex');
  await sleep(250);
  await whileFocused(CODEX_CLS, () => sendKeys(keys));
  sd.showOk(context);
}

// ---------- event wiring ----------

sd.on('willAppear', (e) => {
  instances.set(e.context, { action: e.action, settings: e.payload?.settings ?? {} });
  console.log(`willAppear ${e.action} @ ${e.context} (${instances.size} instances)`);
  render(e.context);
});

sd.on('willDisappear', (e) => {
  const inst = instances.get(e.context);
  if (inst?.holding) releaseKeys(inst.holding).catch(() => {});
  instances.delete(e.context);
});

// Push-to-talk: Codex dictation records only while Ctrl+Shift+D is held, so
// the deck key mirrors that — shortcut goes down on keyDown, up on keyUp.
sd.on('keyDown', async (e) => {
  const inst = instances.get(e.context);
  if (!inst || inst.action !== `${PREFIX}.command`) return;
  const preset = COMMAND_PRESETS[inst.settings?.command ?? 'accept'];
  if (!preset?.hold || inst.settings?.shell || inst.settings?.text) return;
  const keys = inst.settings?.keys || preset.keys;
  try {
    await focusOrLaunch('codex');
    await sleep(250);
    await whileFocused(CODEX_CLS, () => holdKeys(keys));
    inst.holding = keys;
    sd.setImage(e.context, icons.commandKey({ accent: '#e74c3c' })); // recording
    // Safety net: never leave the combo stuck if keyUp gets lost.
    inst.holdTimeout = setTimeout(() => {
      if (inst.holding) { releaseKeys(inst.holding).catch(() => {}); inst.holding = null; render(e.context); }
    }, 120000);
  } catch (err) {
    console.error('ptt keyDown failed', err);
    sd.showAlert(e.context);
  }
});

sd.on('didReceiveSettings', (e) => {
  const inst = instances.get(e.context);
  if (inst) inst.settings = e.payload?.settings ?? {};
  render(e.context);
});

sd.on('keyUp', async (e) => {
  const inst = instances.get(e.context);
  if (!inst) return;
  if (inst.holding) {
    // end of a push-to-talk hold: release the shortcut, don't run a command
    clearTimeout(inst.holdTimeout);
    await releaseKeys(inst.holding).catch(() => {});
    inst.holding = null;
    render(e.context);
    return;
  }
  const kind = inst.action.slice(PREFIX.length + 1);
  try {
    if (kind === 'agent') await pressAgent(e.context, inst.settings);
    else if (kind === 'command') await pressCommand(e.context, inst.settings);
    else if (kind === 'skill') await pressSkill(e.context, inst.settings);
    else if (kind === 'reasoning') await pressReasoning(e.context, inst.settings, 0);
    else if (kind === 'model') await pressModel(e.context, inst.settings);
    else if (kind === 'usage') await pressUsage(e.context);
  } catch (err) {
    console.error(`keyUp ${kind} failed`, err);
    sd.showAlert(e.context);
  }
});

sd.on('dialRotate', async (e) => {
  const inst = instances.get(e.context);
  if (inst?.action === `${PREFIX}.reasoning`) {
    try { await pressReasoning(e.context, inst.settings, e.payload?.ticks > 0 ? 1 : -1); }
    catch (err) { console.error('reasoning dial failed', err); sd.showAlert(e.context); }
  }
});

// Property inspectors ask for current session lists to populate dropdowns.
sd.on('sendToPlugin', (e) => {
  if (e.payload?.event === 'getSessions') {
    sd.sendToPropertyInspector(e.context, { event: 'sessions', sessions: state.get() });
  }
});

state.on('change', () => renderAll(['agent']));

// Pulse "working" keys and refresh reasoning display (config may change externally).
setInterval(() => {
  pulse = !pulse;
  if (state.get().some((s) => s.status === 'working')) renderAll(['agent']);
}, 900);

// Refresh weekly usage periodically (only if a usage key is on screen).
setInterval(async () => {
  const hasUsage = [...instances.values()].some((i) => i.action === `${PREFIX}.usage`);
  if (!hasUsage) return;
  const before = JSON.stringify(state.getUsageCached());
  await state.getUsage().catch(() => {});
  if (JSON.stringify(state.getUsageCached()) !== before) renderAll(['usage']);
}, 60000);

await sd.readyPromise;
await state.start();
await state.getUsage().catch(() => {}); // prime the usage cache before first paint
renderAll();
console.log(`agentdeck registered as ${args.pluginUUID}`);
