/**
 * tests/noise.test.ts — Phase 8 gate 2 (seed stability + noise budget).
 * Pure modules only (src/shared/prng.ts, src/shared/noise.ts) — the DOM
 * lives in hooks.ts and is covered via its DI seam in spoof-shape.test.ts.
 *
 * Pins:
 *  - same seed + same geometry → byte-identical output across repeated reads
 *  - a different seed → different output
 *  - budget = max(8, floor(w*h*0.004)) — ≤0.4% of pixels, ≥8
 *  - exactly ±1 on exactly one channel per picked pixel; pairs unique
 *  - zero-dimension input is a no-op
 */
import { describe, expect, it } from 'vitest';
import { fnv1a32, mulberry32, streamKey } from '../src/shared/prng.js';
import { noiseImageData, pickBudget } from '../src/shared/noise.js';

const SEED_A = new Uint32Array([0x11111111, 0x22222222, 0x33333333, 0x44444444]);
const SEED_B = new Uint32Array([0x55555555, 0x66666666, 0x77777777, 0x88888888]);
const GEO = { x: 0, y: 0, w: 64, h: 64 };

function filled(w: number, h: number, v: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  d.fill(v);
  return d;
}

function changedPairs(before: Uint8ClampedArray, after: Uint8ClampedArray): number[] {
  const out: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) out.push(i);
  }
  return out;
}

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5); // offset basis
    expect(fnv1a32('a')).toBe(0xe40c292c); // standard vector
  });
});

describe('mulberry32', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a1 = mulberry32(42);
    const a2 = mulberry32(42);
    const b = mulberry32(43);
    const seqA1 = [a1(), a1(), a1()];
    const seqA2 = [a2(), a2(), a2()];
    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual([b(), b(), b()]);
    for (const v of seqA1) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('streamKey', () => {
  it('is a pure function of (seed, kind, geometry) — zero call-order state', () => {
    const s1 = streamKey(SEED_A, 'toDataURL', GEO);
    const s2 = streamKey(SEED_A, 'toDataURL', GEO);
    expect([s1(), s1(), s1()]).toEqual([s2(), s2(), s2()]);
    // call-order independence: interleaving another stream does not perturb
    const other = streamKey(SEED_A, 'toBlob', GEO);
    const s3 = streamKey(SEED_A, 'toDataURL', GEO);
    const first = s3();
    other();
    other();
    expect(s3()).toBe(streamKeySecond(SEED_A));
    expect(first).toBe(streamKey(SEED_A, 'toDataURL', GEO)());
  });

  it('differs by kind and by geometry', () => {
    const base = streamKey(SEED_A, 'toDataURL', GEO)();
    expect(streamKey(SEED_A, 'toBlob', GEO)()).not.toBe(base);
    expect(streamKey(SEED_A, 'toDataURL', { ...GEO, x: 1 })()).not.toBe(base);
    expect(streamKey(SEED_B, 'toDataURL', GEO)()).not.toBe(base);
  });
});

function streamKeySecond(seed: Uint32Array): number {
  const s = streamKey(seed, 'toDataURL', GEO);
  s();
  return s();
}

describe('pickBudget', () => {
  it('is max(8, floor(w*h*0.004)) — the brief rule, ≤0.4% of pixels', () => {
    expect(pickBudget(64, 64)).toBe(16); // floor(4096*0.004)
    expect(pickBudget(10, 10)).toBe(8); // min bound
    expect(pickBudget(1, 1)).toBe(8); // min bound (cap applied by noiseImageData)
    expect(pickBudget(1000, 1000)).toBe(4000); // exactly 0.4%
    expect(pickBudget(1920, 1080)).toBeLessThanOrEqual(Math.floor(1920 * 1080 * 0.004));
  });

  it('budgetScale (Pro strength) multiplies inside the floor; default is the spec rule', () => {
    expect(pickBudget(1000, 1000)).toBe(pickBudget(1000, 1000, 1));
    expect(pickBudget(1000, 1000, 0.5)).toBe(2000); // low
    expect(pickBudget(1000, 1000, 2)).toBe(8000); // high
  });
});

describe('noiseImageData', () => {
  it('same seed + geometry → byte-identical output across repeated reads', () => {
    const d1 = filled(64, 64, 128);
    const d2 = filled(64, 64, 128);
    noiseImageData(d1, 64, 64, streamKey(SEED_A, 'getImageData', GEO));
    noiseImageData(d2, 64, 64, streamKey(SEED_A, 'getImageData', GEO));
    expect(Array.from(d1)).toEqual(Array.from(d2));
  });

  it('a different seed → different bytes', () => {
    const d1 = filled(64, 64, 128);
    const d2 = filled(64, 64, 128);
    noiseImageData(d1, 64, 64, streamKey(SEED_A, 'getImageData', GEO));
    noiseImageData(d2, 64, 64, streamKey(SEED_B, 'getImageData', GEO));
    expect(Array.from(d1)).not.toEqual(Array.from(d2));
  });

  it('noises exactly the budget in unique (pixel, channel) pairs, each ±1 on one channel', () => {
    const src = filled(64, 64, 128);
    const d = Uint8ClampedArray.from(src);
    const noised = noiseImageData(d, 64, 64, streamKey(SEED_A, 'toDataURL', GEO));
    expect(noised).toBe(16);
    const changed = changedPairs(src, d);
    expect(changed.length).toBe(16);
    expect(new Set(changed).size).toBe(changed.length); // unique pairs
    const pixels = new Set(changed.map((i) => Math.floor(i / 4)));
    // ±1 on exactly one channel per picked pixel (unique pairs ⇒ ≤1 per pixel here)
    for (const i of changed) {
      expect(Math.abs((d[i] ?? 0) - (src[i] ?? 0))).toBe(1);
    }
    expect(pixels.size).toBe(changed.length);
  });

  it('changed bytes are always ±1 even at channel extremes (255 → -1, 0 → +1)', () => {
    for (const v of [0, 255]) {
      const src = filled(32, 32, v);
      const d = Uint8ClampedArray.from(src);
      noiseImageData(d, 32, 32, streamKey(SEED_A, 'toBlob', { x: 0, y: 0, w: 32, h: 32 }));
      for (const i of changedPairs(src, d)) {
        expect(d[i]).toBe(v === 255 ? 254 : 1);
      }
    }
  });

  it('respects the ≤0.4% budget on a large canvas', () => {
    const src = filled(500, 400, 60);
    const d = Uint8ClampedArray.from(src);
    const noised = noiseImageData(
      d,
      500,
      400,
      streamKey(SEED_A, 'getImageData', { x: 0, y: 0, w: 500, h: 400 }),
    );
    expect(noised).toBe(Math.floor(500 * 400 * 0.004)); // 800
    expect(noised / (500 * 400)).toBeLessThanOrEqual(0.004);
    expect(changedPairs(src, d).length).toBe(noised);
  });

  it('caps the budget at available pairs on pathological tiny canvases', () => {
    const src = filled(1, 1, 7); // 4 pairs total, budget would be 8
    const d = Uint8ClampedArray.from(src);
    const noised = noiseImageData(d, 1, 1, streamKey(SEED_A, 'toDataURL', { x: 0, y: 0, w: 1, h: 1 }));
    expect(noised).toBe(4);
  });

  it('zero-dimension input is a no-op (hooks pass these through natively first)', () => {
    const d = filled(4, 4, 99);
    const before = Array.from(d);
    expect(noiseImageData(d, 0, 4, streamKey(SEED_A, 'toDataURL', { x: 0, y: 0, w: 0, h: 4 }))).toBe(0);
    expect(Array.from(d)).toEqual(before);
  });

  it('budgetScale scales the number of noised pairs (Pro strength presets)', () => {
    const low = filled(100, 100, 128);
    const high = filled(100, 100, 128);
    const geo = { x: 0, y: 0, w: 100, h: 100 };
    expect(noiseImageData(low, 100, 100, streamKey(SEED_A, 'toDataURL', geo), 0.5)).toBe(20);
    expect(noiseImageData(high, 100, 100, streamKey(SEED_A, 'toDataURL', geo), 2)).toBe(80);
  });
});
