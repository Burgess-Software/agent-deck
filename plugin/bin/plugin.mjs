#!/usr/bin/env node
// Agent Deck — Codex Micro feature set as a Stream Deck (OpenDeck) plugin,
// controlling the Codex desktop app.
import { StreamDeck, parseArgs } from './lib/protocol.mjs';
import { AgentState } from './lib/state.mjs';
import { shouldShowUsageWhenEmpty, usesUsageWhenEmpty } from './lib/agent-display.mjs';
import { formatAgentLabel, wrapLabel } from './lib/labels.mjs';
import * as icons from './lib/icons.mjs';
import { focusOrLaunch, sendKeys, pasteText, runShell, openUri, whileFocused, holdKeys, releaseKeys, APP_WINDOW_CLASS } from './lib/inject.mjs';
import { releaseManagedHold, startManagedHold } from './lib/ptt.mjs';
import { remainingPercent } from './lib/usage.mjs';

// Codex's built-in "open model picker" shortcut (no setup needed).
const MODEL_PICKER_KEYS = 'ctrl+shift+m';
// Reasoning shortcuts — provisioned in ~/.codex/keybindings.json:
//   cycle = Ctrl+Alt+E, increase = Ctrl+Alt+Up, decrease = Ctrl+Alt+Down.
// Sends the command to Codex's CURRENT thread (composer must be visible).
const REASONING_CYCLE = 'ctrl+alt+e';
const REASONING_UP = 'ctrl+alt+up';
const REASONING_DOWN = 'ctrl+alt+down';

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
let activeSlotsTimer = null;

// OpenDeck delivers willAppear once per key, so coalesce the startup burst and
// give the allocator the complete set of visible logical slots at once.
function scheduleActiveSlots() {
  clearTimeout(activeSlotsTimer);
  activeSlotsTimer = setTimeout(() => {
    const agents = [...instances.values()]
      .filter((inst) => inst.action === `${PREFIX}.agent`);
    const slots = agents.map((inst) => Number(inst.settings?.slot ?? 0));
    const fallbackSlots = agents
      .filter((inst) => usesUsageWhenEmpty(inst.settings))
      .map((inst) => Number(inst.settings?.slot ?? 0));
    state.setActiveSlots(slots, fallbackSlots)
      .catch((error) => console.error('slot assignment failed', error));
  }, 40);
}

// ---------- rendering ----------

function renderAgent(context, settings) {
  const slot = Number(settings?.slot ?? 0);
  const s = state.get()[slot] ?? null;
  if (!s) {
    if (shouldShowUsageWhenEmpty(s, settings)) {
      renderUsage(context, settings);
      return;
    }
    sd.setImage(context, icons.agentKey({ status: 'empty' }));
    sd.setTitle(context, `\n\n\n—`);
    return;
  }
  const dim = s.status === 'working' && pulse;
  sd.setImage(context, icons.agentKey({ status: s.status, dim }));
  sd.setTitle(context, formatAgentLabel(s));
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
  // Sends the Cycle-reasoning-effort command to the current thread. Codex
  // holds the active level in UI state (not a file), so the key is a
  // stateless nudge — neutral dial glyph + label.
  sd.setImage(context, icons.reasoningKey({ frac: 0.6 }));
  sd.setTitle(context, `\n\n${wrapLabel(settings?.label || 'Reason')}`);
}

function renderModel(context, settings) {
  sd.setImage(context, icons.modelKey());
  sd.setTitle(context, `\n\n${wrapLabel(settings?.label || 'Model')}`);
}

function renderUsage(context, settings) {
  const u = state.getUsageCached();
  const remaining = u ? remainingPercent(u.usedPercent) : null;
  sd.setImage(context, icons.usageKey({ remainingPercent: remaining ?? 0 }));
  sd.setTitle(context, `\n\n\n${remaining == null ? '—' : `${remaining}%`}`);
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

function isUsageSurface(inst) {
  if (inst.action === `${PREFIX}.usage`) return true;
  if (inst.action !== `${PREFIX}.agent`) return false;
  const session = state.get()[Number(inst.settings?.slot ?? 0)] ?? null;
  return shouldShowUsageWhenEmpty(session, inst.settings);
}

function renderUsageSurfaces() {
  for (const [context, inst] of instances) {
    if (isUsageSurface(inst)) render(context);
  }
}

// ---------- key behavior ----------

async function pressAgent(context, settings) {
  const s = state.get()[Number(settings?.slot ?? 0)] ?? null;
  if (shouldShowUsageWhenEmpty(s, settings)) {
    await pressUsage(context);
    return;
  }
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
  renderUsageSurfaces();
  sd.showOk(context);
}

async function pressReasoning(context, settings, direction = 0) {
  // direction 0 = cycle (key press), +1 = increase, -1 = decrease (encoder).
  const keys = direction > 0 ? (settings?.upKeys || REASONING_UP)
    : direction < 0 ? (settings?.downKeys || REASONING_DOWN)
    : (settings?.cycleKeys || REASONING_CYCLE);
  await focusOrLaunch('codex');
  await sleep(250);
  await whileFocused(CODEX_CLS, () => sendKeys(keys));
  sd.showOk(context);
}

// ---------- event wiring ----------

sd.on('willAppear', (e) => {
  instances.set(e.context, { action: e.action, settings: e.payload?.settings ?? {} });
  console.log(`willAppear ${e.action} @ ${e.context} (${instances.size} instances)`);
  if (e.action === `${PREFIX}.agent`) scheduleActiveSlots();
  render(e.context);
});

sd.on('willDisappear', (e) => {
  const inst = instances.get(e.context);
  if (inst) {
    clearTimeout(inst.holdTimeout);
    releaseManagedHold(inst, releaseKeys).catch(() => {});
  }
  instances.delete(e.context);
  if (inst?.action === `${PREFIX}.agent`) scheduleActiveSlots();
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
    const started = await startManagedHold(inst, keys, async () => {
      const hadWindow = await focusOrLaunch('codex');
      // An existing window has already been activated synchronously by KWin.
      // Only a cold app launch needs time before the focus guard can succeed.
      if (!hadWindow) await sleep(250);
      await whileFocused(CODEX_CLS, () => holdKeys(keys));
    }, releaseKeys);
    if (!started) return;
    sd.setImage(e.context, icons.commandKey({ accent: '#e74c3c' })); // recording
    // Safety net: never leave the combo stuck if keyUp gets lost.
    inst.holdTimeout = setTimeout(() => {
      releaseManagedHold(inst, releaseKeys).catch(() => {});
      render(e.context);
    }, 120000);
  } catch (err) {
    console.error('ptt keyDown failed', err);
    sd.showAlert(e.context);
  }
});

sd.on('didReceiveSettings', (e) => {
  const inst = instances.get(e.context);
  if (inst) inst.settings = e.payload?.settings ?? {};
  if (inst?.action === `${PREFIX}.agent`) scheduleActiveSlots();
  render(e.context);
});

sd.on('keyUp', async (e) => {
  const inst = instances.get(e.context);
  if (!inst) return;
  const kind = inst.action.slice(PREFIX.length + 1);
  const preset = kind === 'command' ? COMMAND_PRESETS[inst.settings?.command ?? 'accept'] : null;
  if (preset?.hold && !inst.settings?.shell && !inst.settings?.text) {
    // End (or cancel a pending start) without falling through to a second key
    // press. This also handles very quick taps safely.
    clearTimeout(inst.holdTimeout);
    inst.holdTimeout = null;
    await releaseManagedHold(inst, releaseKeys).catch(() => {});
    render(e.context);
    return;
  }
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
    sd.sendToPropertyInspector(e.context, { event: 'sessions', sessions: state.get().filter(Boolean) });
  }
});

state.on('change', () => {
  renderAll(['agent']);
  // If a departing tenth session just exposed the fallback, refresh now
  // instead of showing a usage value cached before that slot was occupied.
  if ([...instances.values()].some(isUsageSurface)) {
    state.getUsage().then(renderUsageSurfaces).catch(() => {});
  }
});

// Pulse "working" keys and refresh reasoning display (config may change externally).
setInterval(() => {
  pulse = !pulse;
  if (state.get().some((s) => s?.status === 'working')) renderAll(['agent']);
}, 900);

// Refresh weekly usage periodically (only if a usage key is on screen).
setInterval(async () => {
  const hasUsage = [...instances.values()].some(isUsageSurface);
  if (!hasUsage) return;
  const before = JSON.stringify(state.getUsageCached());
  await state.getUsage().catch(() => {});
  if (JSON.stringify(state.getUsageCached()) !== before) renderUsageSurfaces();
}, 60000);

await sd.readyPromise;
await state.start();
await state.getUsage().catch(() => {}); // prime the usage cache before first paint
renderAll();
console.log(`agentdeck registered as ${args.pluginUUID}`);
