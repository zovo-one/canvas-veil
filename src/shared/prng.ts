/**
 * src/shared/prng.ts — pure deterministic PRNG helpers (TECHNICAL-BRIEF §4).
 * DOM-free, importable from node-env vitest. No call-count state anywhere:
 * the same (seed, kind, geometry) always yields the same stream — that IS
 * the anti-breakage property (sites reading twice see a stable fingerprint).
 *
 * ARCHITECT LOCK: the streamKey fold below is the single source of truth.
 * Do not re-tune it after tests pin its behavior (Phase 8 gate 2).
 */

/** FNV-1a 32-bit over UTF-16 code units (inputs are ASCII by contract). */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded with a u32; returns a next-u32 function (not floats). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export interface NoiseGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Stream key for one read call: fnv1a32 over `kind|x|y|w|h` folded with all
 * four seed words (golden-gamma multiply + xorshift per fold step) into one
 * u32 that seeds mulberry32. Pure function of (seed, kind, geometry) — zero
 * dependence on call order or call count.
 */
export function streamKey(
  seed: Uint32Array,
  kind: string,
  geo: NoiseGeometry,
): () => number {
  const h = fnv1a32(`${kind}|${geo.x}|${geo.y}|${geo.w}|${geo.h}`);
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    const word = ((seed[i] ?? 0) ^ h) >>> 0;
    acc = Math.imul(acc ^ word, 0x9e3779b1) >>> 0;
    acc = (acc ^ (acc >>> 15)) >>> 0;
  }
  return mulberry32(acc >>> 0);
}
