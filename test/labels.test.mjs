import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAgentLabel, wrapLabel } from '../plugin/bin/lib/labels.mjs';

test('wrapLabel keeps OpenDeck title lines short', () => {
  assert.equal(wrapLabel('Speed up voice transcription'), 'Speed up\nvoice…');
  assert.ok(wrapLabel('Update session titles').split('\n').every((line) => line.length <= 8));
});

test('agent labels distinguish chats while retaining their project', () => {
  const voice = formatAgentLabel({ title: 'Speed up voice transcription', project: 'agent-deck' });
  const titles = formatAgentLabel({ title: 'Update session titles', project: 'agent-deck' });

  assert.equal(voice, '\nSpeed up\nvoice…\nagent-d…');
  assert.equal(titles, '\nUpdate\nsession…\nagent-d…');
  assert.notEqual(voice, titles);
});

test('agent labels keep the legacy project-only fallback', () => {
  assert.equal(
    formatAgentLabel({ title: 'agent-deck', project: 'agent-deck' }),
    '\n\nagent-de\nck',
  );
});
