import test from 'node:test';
import assert from 'node:assert/strict';

import { agentKey, STATUS_COLORS } from '../plugin/bin/lib/icons.mjs';
import { Canvas, hex } from '../plugin/bin/lib/png.mjs';

function plainAgentKey(status, dim = false) {
  let [r, g, b] = hex(STATUS_COLORS[status]);
  if (dim) {
    r = Math.round(r * 0.55);
    g = Math.round(g * 0.55);
    b = Math.round(b * 0.55);
  }

  const canvas = new Canvas(72, 72);
  canvas.fillRect(0, 0, 72, 72, hex('#111318'));
  canvas.fillRoundRect(3, 3, 66, 66, 12, [r, g, b, 255]);
  return canvas.toDataURI();
}

test('session status keys are unobstructed color fields without glyphs', () => {
  for (const status of Object.keys(STATUS_COLORS)) {
    assert.equal(agentKey({ status }), plainAgentKey(status));
  }
  assert.equal(agentKey({ status: 'working', dim: true }), plainAgentKey('working', true));
});
