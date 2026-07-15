#!/usr/bin/env node
// Agent Deck — Codex Micro feature set as a Stream Deck (OpenDeck) plugin.
import { StreamDeck, parseArgs } from './lib/protocol.mjs';
import { AgentState } from './lib/state.mjs';
import * as icons from './lib/icons.mjs';
import * as reasoning from './lib/reasoning.mjs';
import { focusOrLaunch, sendKeys, pasteText, runShell, openUri, whileFocused, APP_WINDOW_CLASS } from './lib/inject.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PREFIX = 'com.thomasburgess.agentdeck';

const COMMAND_PRESETS = {
  accept:    { title: 'Accept',   keys: 'enter',  accent: '#27ae60' },
  reject:    { title: 'Reject',   keys: 'esc',    accent: '#e74c3c' },
  interrupt: { title: 'Stop',     keys: 'esc',    accent: '#e74c3c' },
  newchat:   { title: 'New chat', keys: 'ctrl+n', accent: '#3d8bfd' },
  ptt:       { title: 'Voice',    appKeys: { claude: 'ctrl+d', codex: 'ctrl+shift+d' }, accent: '#b48cf2' },
  custom:    { title: 'Custom',   keys: '',       accent: '#f7821b' },
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

function appFor(settings) {
  const a = settings?.app;
  return a === 'claude' || a === 'codex' ? a : state.getTarget();
}

function sessionForSlot(app, slot) {
  return state.get(app)[slot] ?? null;
}

// ---------- rendering ----------

function renderAgent(context, settings) {
  const app = appFor(settings);
  const slot = Number(settings?.slot ?? 0);
  const s = sessionForSlot(app, slot);
  if (!s) {
    sd.setImage(context, icons.agentKey({ status: 'empty', app }));
    sd.setTitle(context, `\n\n\n—`);
    return;
  }
  const dim = s.status === 'working' && pulse;
  sd.setImage(context, icons.agentKey({ status: s.status, app, dim }));
  const name = s.title || s.project;
  const label = name.length > 9 ? `${name.slice(0, 8)}…` : name;
  sd.setTitle(context, `\n\n\n${label}`);
}

function renderCommand(context, settings) {
  const preset = COMMAND_PRESETS[settings?.command ?? 'accept'] ?? COMMAND_PRESETS.accept;
  const app = appFor(settings);
  sd.setImage(context, icons.commandKey({ app: settings?.app ? app : null, accent: preset.accent }));
  sd.setTitle(context, `\n\n\n${settings?.label || preset.title}`);
}

function renderSkill(context, settings) {
  const preset = SKILL_PRESETS[settings?.skill ?? 'review'] ?? SKILL_PRESETS.review;
  sd.setImage(context, icons.commandKey({ app: null, accent: '#f7c744' }));
  sd.setTitle(context, `\n\n\n${settings?.label || preset.title}`);
}

function renderReasoning(context, settings) {
  const app = appFor(settings);
  const levels = reasoning.LEVELS[app];
  const level = reasoning.getLevel(app);
  const frac = (levels.indexOf(level) + 1) / levels.length;
  sd.setImage(context, icons.reasoningKey({ app, frac: frac > 0 ? frac : 0.5 }));
  sd.setTitle(context, `\n\n\n${level}`);
}

function renderTarget(context) {
  const app = state.getTarget();
  sd.setImage(context, icons.targetKey({ app }));
  sd.setTitle(context, `\n\n\n${app === 'claude' ? 'Claude' : 'Codex'}`);
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
    else if (kind === 'target') renderTarget(context);
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
  const app = appFor(settings);
  const s = sessionForSlot(app, Number(settings?.slot ?? 0));
  if (!s) { await focusOrLaunch(app); return; }

  if (app === 'codex') {
    console.log(`agent key: opening codex://threads/${s.id}`);
    await openUri(`codex://threads/${s.id}`);
    await sleep(400);
    await focusOrLaunch('codex');
    return;
  }

  // Claude desktop has no deep link for local sessions (claude://code/* only
  // accepts cloud cse_… ids; claude://resume imports a duplicate). Drive the
  // in-app Ctrl+K chat switcher instead: search the title, Enter opens the
  // top match. Every injection is focus-guarded so keystrokes never land in
  // another window if the user switches away mid-flow.
  const cls = APP_WINDOW_CLASS.claude;
  console.log(`agent key: switching via ctrl+k to ${JSON.stringify(s.title)}`);
  const focused = await focusOrLaunch('claude');
  if (!focused) return; // app just launched; no chats to switch between yet
  await sleep(300);
  await whileFocused(cls, () => sendKeys('ctrl+k'));
  await sleep(450);
  await whileFocused(cls, () => pasteText(s.title, { submit: false }));
  await sleep(700); // let the palette filter settle on the top match
  await whileFocused(cls, () => sendKeys('enter'));
}

async function pressCommand(context, settings) {
  const name = settings?.command ?? 'accept';
  const preset = COMMAND_PRESETS[name] ?? COMMAND_PRESETS.accept;
  const app = appFor(settings);
  if (settings?.shell) {
    const res = await runShell(settings.shell);
    res.ok ? sd.showOk(context) : sd.showAlert(context);
    return;
  }
  if (settings?.text) {
    await focusOrLaunch(app);
    await new Promise((r) => setTimeout(r, 300));
    await pasteText(settings.text, { submit: !!settings.submit });
    sd.showOk(context);
    return;
  }
  const keys = settings?.keys || preset.appKeys?.[app] || preset.keys;
  if (!keys) { sd.showAlert(context); return; }
  await focusOrLaunch(app);
  await new Promise((r) => setTimeout(r, 300));
  await sendKeys(keys);
  sd.showOk(context);
}

async function pressSkill(context, settings) {
  const preset = SKILL_PRESETS[settings?.skill ?? 'review'] ?? SKILL_PRESETS.review;
  const prompt = settings?.prompt || preset.prompt;
  const app = appFor(settings);
  await focusOrLaunch(app);
  await new Promise((r) => setTimeout(r, 350));
  await pasteText(prompt, { submit: settings?.autosend !== false });
  sd.showOk(context);
}

function pressReasoning(context, settings, direction = 1) {
  const app = appFor(settings);
  const next = reasoning.cycleLevel(app, direction);
  console.log(`reasoning ${app} -> ${next}`);
  renderAll(['reasoning']);
}

// ---------- event wiring ----------

sd.on('willAppear', (e) => {
  instances.set(e.context, { action: e.action, settings: e.payload?.settings ?? {} });
  console.log(`willAppear ${e.action} @ ${e.context} (${instances.size} instances)`);
  render(e.context);
});

sd.on('willDisappear', (e) => instances.delete(e.context));

sd.on('didReceiveSettings', (e) => {
  const inst = instances.get(e.context);
  if (inst) inst.settings = e.payload?.settings ?? {};
  render(e.context);
});

sd.on('keyUp', async (e) => {
  const inst = instances.get(e.context);
  if (!inst) return;
  const kind = inst.action.slice(PREFIX.length + 1);
  try {
    if (kind === 'agent') await pressAgent(e.context, inst.settings);
    else if (kind === 'command') await pressCommand(e.context, inst.settings);
    else if (kind === 'skill') await pressSkill(e.context, inst.settings);
    else if (kind === 'reasoning') pressReasoning(e.context, inst.settings, 1);
    else if (kind === 'target') { state.toggleTarget(); renderAll(); }
  } catch (err) {
    console.error(`keyUp ${kind} failed`, err);
    sd.showAlert(e.context);
  }
});

sd.on('dialRotate', (e) => {
  const inst = instances.get(e.context);
  if (!inst) return;
  if (inst.action === `${PREFIX}.reasoning`) {
    pressReasoning(e.context, inst.settings, e.payload?.ticks > 0 ? 1 : -1);
  }
});

sd.on('dialUp', (e) => {
  const inst = instances.get(e.context);
  if (inst?.action === `${PREFIX}.reasoning`) { state.toggleTarget(); renderAll(); }
});

// Property inspectors ask for current session lists to populate dropdowns.
sd.on('sendToPlugin', (e) => {
  if (e.payload?.event === 'getSessions') {
    sd.sendToPropertyInspector(e.context, {
      event: 'sessions',
      claude: state.get('claude'),
      codex: state.get('codex'),
      target: state.getTarget(),
    });
  }
});

state.on('change', () => renderAll(['agent']));
state.on('target', () => renderAll());

// Pulse "working" keys and refresh reasoning display (config may change externally).
setInterval(() => {
  pulse = !pulse;
  const hasWorking = ['claude', 'codex'].some((app) => state.get(app).some((s) => s.status === 'working'));
  if (hasWorking) renderAll(['agent']);
}, 900);
setInterval(() => renderAll(['reasoning', 'target']), 5000);

await sd.readyPromise;
await state.start();
renderAll();
console.log(`agentdeck registered as ${args.pluginUUID}`);
