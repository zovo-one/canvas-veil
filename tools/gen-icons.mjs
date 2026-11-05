#!/usr/bin/env node
/**
 * tools/gen-icons.mjs — programmatic icon renderer for canvas-veil (#107),
 * dev-only. Draws the "canvas tile under a veil wave" motif in the hue-185
 * palette (SPEC identity lock: ns canvcdc5, hue 185) at 16/32/48/128 and
 * writes real PNGs to icons/. Pure Node (zlib + hand-rolled PNG chunks) —
 * no dependencies, no canvas, no network.
 *
 * Motif: a rounded-square badge in the teal primary gradient carrying a
 * near-white rounded "canvas" tile; a solid veil wave band (primaryDark)
 * crosses the tile horizontally — the fingerprint read, veiled. Flat,
 * readable at 16px. No trademarks, no sibling motifs (5.9 divergence-scan
 * verifies later).
 *
 * Palette (locked, hue 185):
 *   PRIMARY       hsl(185, 55%, 45%)  #34a7b2  (SW badge uses #27919b, same hue family)
 *   PRIMARY_DARK  hsl(185, 60%, 28%)  #1d6b72
 *   PRIMARY_50    hsl(185, 55%, 95%)  #effafa  (canvas tile fill)
 *
 * Usage: node tools/gen-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'icons');

const PRIMARY = [0x34, 0xa7, 0xb2];
const PRIMARY_DARK = [0x1d, 0x6b, 0x72];
const PRIMARY_50 = [0xef, 0xfa, 0xfa];

/* ---------------------------------------------------------------- PNG encode */
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- SDF shapes */
function lerp(a, b, t) { return a + (b - a) * t; }

/** Rounded-square badge: signed distance to rect [0,1]^2, corner radius R. */
const CORNER_R = 0.22;
function inBadge(u, v) {
  const cx = Math.max(CORNER_R, Math.min(1 - CORNER_R, u));
  const cy = Math.max(CORNER_R, Math.min(1 - CORNER_R, v));
  return Math.hypot(u - cx, v - cy) <= CORNER_R;
}

/** Signed distance to a rounded box centered at (cx,cy), half-size (bx,by). */
function sdRoundBox(u, v, cx, cy, bx, by, r) {
  const qx = Math.abs(u - cx) - bx + r;
  const qy = Math.abs(v - cy) - by + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/* ------------------------------------------------------ motif (unit coords) */
/* Canvas tile: centered near-white rounded square. */
const TILE = { cx: 0.5, cy: 0.5, bx: 0.27, by: 0.27, r: 0.07 };
/* Veil wave: horizontal sinusoid band across the tile, amplitude gentle,
   half-thickness tuned to read at 16px. */
const WAVE = { center: 0.52, amp: 0.09, freq: 1.35, half: 0.075 };
function inWave(u, v) {
  const vc = WAVE.center + WAVE.amp * Math.sin(u * Math.PI * 2 * WAVE.freq);
  return Math.abs(v - vc) <= WAVE.half;
}

/* Coverage sampler with 4x supersampling per axis (16 samples/pixel).
   4x4 Bayer matrix dithers the badge gradient (anti-banding at 128px). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function render(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          let sr = 0, sg = 0, sb = 0, sa = 0;
          if (inBadge(u, v)) {
            // vertical gradient primary -> primaryDark across the badge
            let c = [
              lerp(PRIMARY[0], PRIMARY_DARK[0], v),
              lerp(PRIMARY[1], PRIMARY_DARK[1], v),
              lerp(PRIMARY[2], PRIMARY_DARK[2], v),
            ];
            // the canvas tile (near-white, flat)
            if (sdRoundBox(u, v, TILE.cx, TILE.cy, TILE.bx, TILE.by, TILE.r) <= 0) {
              c = PRIMARY_50;
            }
            // the veil wave across it (primaryDark, solid)
            if (inWave(u, v)) {
              c = PRIMARY_DARK;
            }
            sr = c[0]; sg = c[1]; sb = c[2];
            sa = 1;
          }
          r += sr; g += sg; b += sb; a += sa;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (a === 0) continue; // fully transparent pixel stays pure-zero
      const d = (BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 4;
      const clamp8 = (q) => Math.max(0, Math.min(255, Math.round(q)));
      rgba[o] = clamp8(r / n + d);
      rgba[o + 1] = clamp8(g / n + d);
      rgba[o + 2] = clamp8(b / n + d);
      rgba[o + 3] = Math.round((a / n) * 255);
    }
  }
  return rgba;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, render(size));
  const file = path.join(OUT, `${size}.png`); // manifest: icons/16.png …
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
