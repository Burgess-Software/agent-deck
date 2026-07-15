// Runtime key images (72x72 PNG data URIs). Text goes on top via setTitle,
// so these render the status color field and simple glyphs.
import { Canvas, hex } from './png.mjs';

export const STATUS_COLORS = {
  idle: '#3a3f4b',
  working: '#f7821b',
  needs_input: '#3d8bfd',
  done: '#27ae60',
  error: '#e74c3c',
  empty: '#1b1e26',
};

const ACCENT = '#e8e8e3'; // Codex off-white

const S = 72;

function base(bg) {
  const c = new Canvas(S, S);
  c.fillRect(0, 0, S, S, hex('#111318'));
  c.fillRoundRect(3, 3, S - 6, S - 6, 12, hex(bg));
  return c;
}

/** Agent status key: colored field + status glyph. */
export function agentKey({ status = 'empty', dim = false } = {}) {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.idle;
  let [r, g, b] = hex(color);
  if (dim) { r = Math.round(r * 0.55); g = Math.round(g * 0.55); b = Math.round(b * 0.55); }
  const c = base('#111318');
  c.fillRoundRect(3, 3, S - 6, S - 6, 12, [r, g, b, 255]);
  const ink = status === 'idle' || status === 'empty' ? hex('#8a8f9c') : hex('#111318');
  const cx = S / 2, cy = 30;
  if (status === 'working') {
    // three dots
    c.fillCircle(cx - 14, cy, 4, ink);
    c.fillCircle(cx, cy, 4, ink);
    c.fillCircle(cx + 14, cy, 4, ink);
  } else if (status === 'needs_input') {
    // hollow circle + dot
    c.fillCircle(cx, cy - 4, 9, ink);
    c.fillCircle(cx, cy - 4, 5, [r, g, b, 255]);
    c.fillCircle(cx, cy + 12, 3, ink);
  } else if (status === 'done') {
    // check mark from rects
    for (let i = 0; i < 7; i++) c.fillRect(cx - 12 + i, cy - 2 + i, 3, 3, ink);
    for (let i = 0; i < 12; i++) c.fillRect(cx - 6 + i, cy + 4 - i, 3, 3, ink);
  } else if (status === 'error') {
    for (let i = 0; i < 16; i++) {
      c.fillRect(cx - 8 + i, cy - 8 + i, 3, 3, ink);
      c.fillRect(cx + 5 - i, cy - 8 + i, 3, 3, ink);
    }
  } else if (status === 'empty') {
    c.fillCircle(cx, cy, 3, hex('#3a3f4b'));
  } else {
    // idle: small hollow circle
    c.fillCircle(cx, cy, 8, ink);
    c.fillCircle(cx, cy, 5, [r, g, b, 255]);
  }
  return c.toDataURI();
}

/** Command / skill key: dark tile + accent bar. */
export function commandKey({ accent = '#f7821b' } = {}) {
  const c = base('#262a34');
  c.fillRoundRect(14, 26, S - 28, 8, 4, hex(accent));
  return c.toDataURI();
}

/** Reasoning dial: gauge arc filled to level. */
export function reasoningKey({ frac = 1 } = {}) {
  const c = base('#262a34');
  const cx = S / 2, cy = 38;
  // background ring (upper half: angles 180..360 in atan2-space)
  c.ringSegment(cx, cy, 20, 13, 180, 360, hex('#3a3f4b'));
  const sweep = Math.max(4, Math.round(180 * frac));
  c.ringSegment(cx, cy, 20, 13, 180, 180 + sweep, hex(ACCENT));
  return c.toDataURI();
}

/** Static manifest icons, rendered at install time. */
export function manifestIcon(kind, size = 144) {
  const c = new Canvas(size, size);
  const u = size / 72;
  c.fillRoundRect(Math.round(4 * u), Math.round(4 * u), size - Math.round(8 * u), size - Math.round(8 * u), Math.round(14 * u), hex('#262a34'));
  const cx = size / 2, cy = size / 2;
  if (kind === 'plugin' || kind === 'agent') {
    c.fillCircle(cx - 14 * u, cy - 14 * u, 7 * u, hex('#f7821b'));
    c.fillCircle(cx + 14 * u, cy - 14 * u, 7 * u, hex('#27ae60'));
    c.fillCircle(cx - 14 * u, cy + 14 * u, 7 * u, hex('#3d8bfd'));
    c.fillCircle(cx + 14 * u, cy + 14 * u, 7 * u, hex('#e8e8e3'));
  } else if (kind === 'command') {
    for (let i = 0; i < 10 * u; i++) c.fillRect(cx - 16 * u + i, cy + 2 * u + i * 0.8, 4 * u, 4 * u, hex('#27ae60'));
    for (let i = 0; i < 18 * u; i++) c.fillRect(cx - 6 * u + i, cy + 10 * u - i * 0.8, 4 * u, 4 * u, hex('#27ae60'));
  } else if (kind === 'skill') {
    // lightning bolt-ish
    for (let i = 0; i < 14 * u; i++) c.fillRect(cx + 2 * u - i * 0.7, cy - 20 * u + i, 5 * u, 3 * u, hex('#f7c744'));
    for (let i = 0; i < 14 * u; i++) c.fillRect(cx + 4 * u - i * 0.7, cy + 2 * u + i, 5 * u, 3 * u, hex('#f7c744'));
    c.fillRect(cx - 8 * u, cy - 2 * u, 16 * u, 4 * u, hex('#f7c744'));
  } else if (kind === 'reasoning') {
    c.ringSegment(cx, cy + 8 * u, 22 * u, 14 * u, 180, 360, hex('#3a3f4b'));
    c.ringSegment(cx, cy + 8 * u, 22 * u, 14 * u, 180, 320, hex('#3d8bfd'));
  }
  return c.toPNG();
}
