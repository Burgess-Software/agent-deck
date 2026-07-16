#!/usr/bin/env node
// Generates a ready-made OpenDeck profile mirroring the Codex Micro layout.
// Usage: node gen-profile.mjs <deviceId>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const device = process.argv[2];
if (!device) { console.error('usage: gen-profile.mjs <deviceId>'); process.exit(1); }
const PROFILE = 'Agent Deck';
const PLUGIN = 'com.thomasburgess.agentdeck.sdPlugin';
const P = 'com.thomasburgess.agentdeck';

const state = (image) => ({
  image, image_scale: 100, background_colour: '#000000', name: '', text: '',
  show: true, colour: '#FFFFFF', stroke_colour: '#000000', alignment: 'middle',
  family: 'Liberation Sans', style: 'Regular', size: 16, stroke_size: 0, underline: false,
});

const ACTIONS = {
  agent:     { name: 'Agent Status Key', icon: 'icons/agent',     pi: 'pi/agent.html' },
  command:   { name: 'Command Key',      icon: 'icons/command',   pi: 'pi/command.html' },
  skill:     { name: 'Skill Key',        icon: 'icons/skill',     pi: 'pi/skill.html' },
  reasoning: { name: 'Reasoning Dial',   icon: 'icons/reasoning', pi: 'pi/reasoning.html' },
  model:     { name: 'Model Switcher',   icon: 'icons/model',     pi: 'pi/model.html' },
  usage:     { name: 'Weekly Usage',     icon: 'icons/usage',     pi: 'pi/usage.html' },
};

function instance(kind, position, settings) {
  const a = ACTIONS[kind];
  return {
    action: {
      name: a.name,
      uuid: `${P}.${kind}`,
      plugin: PLUGIN,
      tooltip: '',
      icon: a.icon,
      disable_automatic_states: false,
      visible_in_action_list: true,
      supported_in_multi_actions: true,
      property_inspector: a.pi,
      controllers: ['Keypad'],
      encoder: null,
      states: [state(a.icon)],
    },
    context: `${device}.${PROFILE}.Keypad.${position}.0`,
    states: [state(a.icon)],
    current_state: 0,
    settings,
    children: null,
  };
}

const keys = [
  ...Array.from({ length: 10 }, (_, slot) =>
    instance('agent', slot, {
      slot: String(slot),
      ...(slot === 9 ? { usageWhenEmpty: true } : {}),
    })),
  instance('command', 10, { command: 'accept' }),
  instance('command', 11, { command: 'reject' }),
  instance('command', 12, { command: 'newchat' }),
  instance('command', 13, { command: 'ptt' }),
  instance('command', 14, { command: 'interrupt' }),
];

const profile = { id: PROFILE, keys, sliders: [], infobars: [] };
const dir = path.join(os.homedir(), '.config/opendeck/profiles', device);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${PROFILE}.json`), JSON.stringify(profile, null, '\t'));
fs.writeFileSync(path.join(os.homedir(), '.config/opendeck/profiles', `${device}.json`),
  JSON.stringify({ selected_profile: PROFILE }, null, '\t'));
console.log(`profile "${PROFILE}" written for ${device} and selected`);
