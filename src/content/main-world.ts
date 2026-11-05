/**
 * src/content/main-world.ts — MAIN-world entry (document_start, all_frames,
 * http/https). GATE 1 design implemented EXACTLY (SPEC §1 / TECHNICAL-BRIEF
 * §4): every input the hooks need is synchronously available in the page
 * world at document_start. ZERO async on the seed path.
 *
 * Seed resolution order (brief §4, exact):
 *   1. isExcepted(location.hostname) → bail (EXCEPTED).
 *   2. localStorage['canvcdc5:off'] (try/catch — sandboxed iframes throw)
 *      → bail (OFF_SITE).
 *   3. Pro pinned: localStorage['canvcdc5.ps'] JSON {"<hostname>":[u32×4]}.
 *   4. sessionStorage['canvcdc5.s'] ("u32,u32,u32,u32").
 *   5. window !== window.top → try window.top.__canvcdc5Seed (cross-origin
 *      throws → fall through; per-frame crypto seed, documented).
 *   6. Fallback crypto.getRandomValues(new Uint32Array(4)), persisted to
 *      sessionStorage (survives reloads + same-tab navigations, dies with
 *      the tab session — "per-session stable" by definition).
 *   7. defineProperty __canvcdc5Seed non-enumerable, non-configurable,
 *      non-writable (same-origin child frames inherit).
 *   8. Install hooks; subscribe EVT_STATE for the live toggle.
 *
 * Failure posture (brief §7): ALL storage access wrapped; failure of every
 * path still yields a crypto seed — degraded stability, never broken. Any
 * throw anywhere in boot is swallowed: protection must never break the page.
 */
import { isExcepted } from '../shared/exceptions.js';
import { EVT_STATE, type StateDetail } from '../shared/messages.js';
import type { Strength } from '../shared/storage.js';
import { installHooks } from './hooks.js';

const LS_OFF = 'canvcdc5:off';
const LS_PINNED = 'canvcdc5.ps';
const LS_STRENGTH = 'canvcdc5.st';
const SS_SEED = 'canvcdc5.s';
const WIN_SEED = '__canvcdc5Seed';

function asSeed(value: unknown): Uint32Array | null {
  if (value instanceof Uint32Array && value.length === 4) return value;
  if (Array.isArray(value) && value.length === 4 && value.every((n) => Number.isInteger(n))) {
    return new Uint32Array(value as number[]);
  }
  return null;
}

/** Step 3 — Pro pinned seed for this hostname (page-side mirror). */
function readPinnedSeed(hostname: string): Uint32Array | null {
  try {
    const raw = localStorage.getItem(LS_PINNED);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return asSeed((parsed as Record<string, unknown>)[hostname]);
  } catch {
    return null;
  }
}

/** Step 4 — sessionStorage fast path. */
function readSessionSeed(): Uint32Array | null {
  try {
    const raw = sessionStorage.getItem(SS_SEED);
    if (!raw) return null;
    return asSeed(raw.split(',').map((p) => Number(p)));
  } catch {
    return null;
  }
}

/** Step 5 — same-origin top-frame inheritance. */
function readTopFrameSeed(): Uint32Array | null {
  try {
    if (window === window.top) return null;
    return asSeed((window.top as unknown as Record<string, unknown>)[WIN_SEED]);
  } catch {
    return null; // cross-origin top — expected, fall through
  }
}

/** Step 6 — crypto fallback, persisted to sessionStorage when possible. */
function freshSeed(): Uint32Array {
  const seed = crypto.getRandomValues(new Uint32Array(4));
  try {
    sessionStorage.setItem(SS_SEED, Array.from(seed).join(','));
  } catch {
    // sandboxed frame — per-load seed, protection still works (brief §7)
  }
  return seed;
}

/** Steps 3–6 in exact order. Exported for node-env tests with stubs. */
export function resolveSeed(hostname: string): Uint32Array {
  return (
    readPinnedSeed(hostname) ?? readSessionSeed() ?? readTopFrameSeed() ?? freshSeed()
  );
}

/**
 * Pro strength preset, mirrored to localStorage by the isolated script
 * (same synchronous-mirror pattern as the off flag — zero async on the
 * protection path). Read once at boot; applies from this load. Absent or
 * garbage → 'medium', the free default and the spec's tested rule.
 */
function readStrength(): Strength {
  try {
    const v = localStorage.getItem(LS_STRENGTH);
    if (v === 'low' || v === 'medium' || v === 'high') return v;
  } catch {
    // sandboxed frame — default medium (brief §7 posture)
  }
  return 'medium';
}

function boot(): void {
  try {
    const hostname = location.hostname;
    if (!hostname || isExcepted(hostname)) return; // EXCEPTED — stock behavior
    try {
      if (localStorage.getItem(LS_OFF)) return; // OFF_SITE — hooks never installed
    } catch {
      // sandboxed iframe: storage throws → proceed protected (brief §7)
    }
    const seed = resolveSeed(hostname);
    try {
      Object.defineProperty(window, WIN_SEED, {
        value: seed,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    } catch {
      // redefine race (bfcache restore) — harmless, seed already anchored
    }
    let disabled = false;
    installHooks(seed, () => disabled, undefined, readStrength());
    document.addEventListener(EVT_STATE, (ev: Event) => {
      const detail = (ev as CustomEvent<StateDetail>).detail;
      disabled = detail === 'off';
    });
  } catch {
    // protection must never break the page (brief §7)
  }
}

boot();
