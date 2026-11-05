/**
 * src/shared/noise.ts — the pure noise core (TECHNICAL-BRIEF §4). DOM-free by
 * MANDATE: hooks.ts owns every DOM/prototype touch; this module operates on a
 * plain Uint8ClampedArray + dimensions + a stream-key function, so node-env
 * vitest imports it directly (gate 8.2 split — do not break it).
 *
 * Determinism contract: given the same stream key (same seed+kind+geometry),
 * the same pixels/channels/deltas are chosen — repeated identical reads
 * produce byte-identical output.
 *
 * Delta rule (brief-verbatim): chosen channel v === 255 → -1, else +1
 * (v === 0 → +1 falls out of the else branch). ±1 on exactly one channel per
 * picked pixel.
 *
 * Uniqueness: a (pixel, channel) pair is noised at most once per call —
 * collisions redraw from the stream (still fully deterministic, and it keeps
 * every changed byte at exactly ±1 vs the input, which the seed-stability
 * test asserts). Budget is the TARGET number of noised pairs, capped by the
 * available pairs on pathological tiny canvases.
 *
 * Pro strength presets (TECHNICAL-BRIEF §4 settings.strength): hooks.ts
 * passes budgetScale 0.5 (low) / 1 (medium, the default and the tested
 * rule) / 2 (high). The scale sits INSIDE the floor so the free-tier call
 * `pickBudget(w, h)` stays byte-identical to the brief rule.
 */

/**
 * Budget rule (brief-verbatim at scale 1): max(8, floor(w*h*0.004)) —
 * ≤0.4% of pixels. `budgetScale` is the Pro strength multiplier (hooks.ts
 * maps low/medium/high → 0.5/1/2); it defaults to 1 so the spec rule and
 * its pinned tests are untouched.
 */
export function pickBudget(w: number, h: number, budgetScale = 1): number {
  return Math.max(8, Math.floor(w * h * 0.004 * budgetScale));
}

/**
 * Apply deterministic LSB noise in place to `data` (RGBA, length w*h*4).
 * Zero-dimension inputs are a no-op here (hooks.ts passes those through
 * natively BEFORE reaching this module — belt and suspenders).
 * Returns the number of (pixel, channel) pairs actually noised, so the
 * caller can count only genuinely noised reads (counter honesty).
 */
export function noiseImageData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  next: () => number,
  budgetScale = 1,
): number {
  const pixels = Math.floor(w) * Math.floor(h);
  if (pixels <= 0 || data.length < pixels * 4) return 0;
  const maxPairs = pixels * 4;
  const budget = Math.min(pickBudget(w, h, budgetScale), maxPairs);
  const seen = new Set<number>();
  let noised = 0;
  let guard = budget * 8; // collision redraws are rare; never spin forever
  while (noised < budget && guard-- > 0) {
    const px = next() % pixels;
    const ch = next() % 4;
    const pair = px * 4 + ch;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const v = data[pair] ?? 0;
    data[pair] = v === 255 ? v - 1 : v + 1;
    noised++;
  }
  return noised;
}
