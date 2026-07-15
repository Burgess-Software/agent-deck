// Tiny dependency-free PNG encoder + drawing helpers for 72x72 key images.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export class Canvas {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.px = Buffer.alloc(width * height * 4); // RGBA
  }

  set(x, y, [r, g, b, a = 255]) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (a === 255) {
      this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = 255;
    } else {
      const na = a / 255;
      this.px[i] = Math.round(r * na + this.px[i] * (1 - na));
      this.px[i + 1] = Math.round(g * na + this.px[i + 1] * (1 - na));
      this.px[i + 2] = Math.round(b * na + this.px[i + 2] * (1 - na));
      this.px[i + 3] = Math.max(this.px[i + 3], a);
    }
  }

  fillRect(x, y, w, h, color) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, color);
  }

  // Rounded rectangle via corner-distance test.
  fillRoundRect(x, y, w, h, r, color) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const dx = i < x + r ? x + r - i : i > x + w - 1 - r ? i - (x + w - 1 - r) : 0;
        const dy = j < y + r ? y + r - j : j > y + h - 1 - r ? j - (y + h - 1 - r) : 0;
        if (dx * dx + dy * dy <= r * r) this.set(i, j, color);
      }
    }
  }

  fillCircle(cx, cy, r, color) {
    for (let j = cy - r; j <= cy + r; j++) {
      for (let i = cx - r; i <= cx + r; i++) {
        if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) this.set(i, j, color);
      }
    }
  }

  ringSegment(cx, cy, rOuter, rInner, fromDeg, toDeg, color) {
    for (let j = cy - rOuter; j <= cy + rOuter; j++) {
      for (let i = cx - rOuter; i <= cx + rOuter; i++) {
        const d2 = (i - cx) ** 2 + (j - cy) ** 2;
        if (d2 > rOuter * rOuter || d2 < rInner * rInner) continue;
        let ang = (Math.atan2(j - cy, i - cx) * 180) / Math.PI; // -180..180, 0 = east
        if (ang < 0) ang += 360;
        if (ang >= fromDeg && ang <= toDeg) this.set(i, j, color);
      }
    }
  }

  toPNG() {
    const stride = this.w * 4;
    const raw = Buffer.alloc((stride + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (stride + 1)] = 0; // filter: none
      this.px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  toDataURI() {
    return `data:image/png;base64,${this.toPNG().toString('base64')}`;
  }
}

export function hex(str) {
  const s = str.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
}
