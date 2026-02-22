// Generates icon16.png, icon48.png, icon128.png using ONLY Node.js built-ins.
// No npm install needed. Run: node generate-icons.js

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 (required by PNG spec) ─────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const lenB  = Buffer.allocUnsafe(4); lenB.writeUInt32BE(data.length);
  const crcB  = Buffer.allocUnsafe(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([lenB, typeB, data, crcB]);
}

// ── PNG encoder (RGBA, no interlace) ─────────────────────────
function makePNG(size, drawFn) {
  // drawFn(x, y, size) → [r, g, b, a]

  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0); // filter = None
    for (let x = 0; x < size; x++) {
      raw.push(...drawFn(x, y, size));
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const idat = zlib.deflateSync(Buffer.from(raw), { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon design: X (Twitter/X logo style) + purge (white→red gradient) ──
//
// Black square background, thick white X strokes (X.com brand),
// bottom half of strokes burns red — "X on fire" = purge signal.
//
function drawIcon(x, y, size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;

  // ── Background: black square with slight rounded corners ──
  const cornerR = size * 0.18;
  const ax = Math.abs(dx) - (cx - cornerR);
  const ay = Math.abs(dy) - (cy - cornerR);
  const outsideCorner = ax > 0 && ay > 0 && Math.hypot(ax, ay) > cornerR;
  if (outsideCorner) return [0, 0, 0, 0]; // transparent outside rounded corners

  // ── X strokes ──
  // The X.com logo uses two thick diagonal bars.
  // We use distance-from-diagonal formula for clean anti-aliased strokes.
  const pad     = size * 0.13;            // inset from edge
  const extent  = cx - pad;              // how far strokes reach from center
  const strokeW = Math.max(1.2, size * 0.145); // stroke half-width

  // Distance from the two 45° diagonals
  const d1 = Math.abs(dx - dy) * Math.SQRT1_2; // top-left → bottom-right
  const d2 = Math.abs(dx + dy) * Math.SQRT1_2; // top-right → bottom-left

  // Clamp strokes to within the extent box (so they don't bleed to edges)
  const inExtent = Math.max(Math.abs(dx), Math.abs(dy)) <= extent + strokeW * 0.6;
  const onStroke = inExtent && (d1 < strokeW || d2 < strokeW);

  if (!onStroke) return [0, 0, 0, 255]; // black background

  // ── Purge colour: white (top) → orange → red (bottom) ──
  //    yRatio 0 = top of icon, 1 = bottom
  const yRatio = y / (size - 1);

  if (yRatio < 0.42) {
    return [255, 255, 255, 255]; // pure white (X brand)
  }
  if (yRatio > 0.72) {
    return [220, 38, 38, 255];   // pure red (danger/purge)
  }
  // Smooth gradient in transition zone
  const t = (yRatio - 0.42) / 0.30;          // 0 → 1
  const r = 255;
  const g = Math.round(255 * (1 - t) * (1 - t * 0.6)); // white→orange→red
  const b = Math.round(255 * (1 - t));
  return [r, g, b, 255];
}

// ── Generate ─────────────────────────────────────────────────
for (const size of [16, 48, 128]) {
  const png  = makePNG(size, drawIcon);
  const file = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓ icon${size}.png  (${png.length} bytes)`);
}
