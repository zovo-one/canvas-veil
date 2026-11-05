/**
 * tests/hooks.test.ts — hook behavior through the HookTargets DI seam
 * (hooks.ts never touches real DOM here). Pins:
 *  - identity spoof: hooked fns report native-looking toString/name/length
 *  - disabled → native passthrough, zero noise
 *  - 2d toDataURL → scratch-copied, noised, native read on the scratch
 *  - WebGL (null 2d context) → native passthrough, untouched
 *  - tainted canvas → the AUTHENTIC SecurityError object propagates
 *    (toDataURL re-invokes the native on the ORIGINAL canvas so the page
 *    sees the stock error, never the scratch's getImageData-flavored one)
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { installHooks, type HookTargets } from '../src/content/hooks.js';

const SEED = new Uint32Array([0x11111111, 0x22222222, 0x33333333, 0x44444444]);

class FakeCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

interface FakeCanvas {
  width: number;
  height: number;
  isOriginal?: boolean;
  getContext(kind: string): Fake2dCtx | null;
}
interface Fake2dCtx {
  drawImage(...args: unknown[]): void;
  putImageData(...args: unknown[]): void;
}

function makeCanvas(w: number, h: number, webgl = false): FakeCanvas {
  return {
    width: w,
    height: h,
    getContext(kind: string) {
      if (kind !== '2d') return null;
      if (webgl) return null; // a real WebGL canvas answers null for '2d'
      return { drawImage() {}, putImageData() {} };
    },
  };
}

interface NativeOpts {
  taintGetImageData?: Error;
  taintToDataURLOnOriginal?: Error;
}

function makeTargets(opts: NativeOpts = {}) {
  const events: Array<{ type: string; detail: unknown }> = [];
  const natives = {
    toDataURL(this: FakeCanvas, ..._args: unknown[]): string {
      if (this.isOriginal && opts.taintToDataURLOnOriginal) {
        throw opts.taintToDataURLOnOriginal;
      }
      return 'data:image/png;base64,NATIVE';
    },
    toBlob(this: FakeCanvas, cb: (b: string) => void): void {
      cb('blob:NATIVE');
    },
    getImageData(...args: unknown[]): { data: Uint8ClampedArray } {
      if (opts.taintGetImageData) throw opts.taintGetImageData;
      const w = args[2] as number;
      const h = args[3] as number;
      const d = new Uint8ClampedArray(w * h * 4);
      d.fill(128);
      return { data: d };
    },
    fnToString(this: unknown): string {
      return String(this);
    },
  };
  const targets: HookTargets = {
    canvasProto: {
      toDataURL: natives.toDataURL,
      toBlob: natives.toBlob,
    } as object,
    ctx2dProto: { getImageData: natives.getImageData } as object,
    functionProto: { toString: natives.fnToString } as object,
    documentRef: {
      createElement: () => makeCanvas(300, 150),
      dispatchEvent(ev: { type: string; detail?: unknown }) {
        events.push({ type: ev.type, detail: ev.detail ?? null });
        return true;
      },
    } as unknown as Document,
  };
  return { targets, events, natives };
}

beforeEach(() => {
  (globalThis as { CustomEvent?: unknown }).CustomEvent = FakeCustomEvent;
});

describe('identity spoofing', () => {
  it('hooked functions report native toString, name, and length', () => {
    const { targets } = makeTargets();
    const handle = installHooks(SEED, () => false, targets);
    expect(handle.installed).toBe(true);
    const proto = targets.canvasProto as { toDataURL: Function };
    const fnToString = (targets.functionProto as { toString: Function }).toString;
    expect(fnToString.call(proto.toDataURL)).toBe(
      'function toDataURL() { [native code] }',
    );
    expect(proto.toDataURL.name).toBe('toDataURL');
    // unspoofed functions fall through to the real native toString
    expect(fnToString.call(() => 1)).not.toContain('[native code]');
    handle.restore();
  });

  it('restore() unwinds every patch', () => {
    const { targets, natives } = makeTargets();
    const handle = installHooks(SEED, () => false, targets);
    handle.restore();
    expect((targets.canvasProto as { toDataURL: unknown }).toDataURL).toBe(
      natives.toDataURL,
    );
  });
});

describe('toDataURL', () => {
  it('2d canvas → scratch read, noised, native encode of the scratch', () => {
    const { targets, events } = makeTargets();
    installHooks(SEED, () => false, targets);
    const canvas = makeCanvas(64, 64);
    canvas.isOriginal = true;
    const out = (targets.canvasProto as { toDataURL: Function }).toDataURL.call(canvas);
    expect(out).toBe('data:image/png;base64,NATIVE');
    expect(events.some((e) => e.detail === 'toDataURL')).toBe(true);
  });

  it('disabled → exact native passthrough', () => {
    const { targets, events } = makeTargets();
    installHooks(SEED, () => true, targets);
    const canvas = makeCanvas(64, 64);
    const out = (targets.canvasProto as { toDataURL: Function }).toDataURL.call(canvas);
    expect(out).toBe('data:image/png;base64,NATIVE');
    expect(events.length).toBe(0); // no noise, no hit
  });

  it('WebGL canvas (null 2d context) → native passthrough, untouched', () => {
    const { targets, events } = makeTargets();
    installHooks(SEED, () => false, targets);
    const canvas = makeCanvas(64, 64, true);
    const out = (targets.canvasProto as { toDataURL: Function }).toDataURL.call(canvas);
    expect(out).toBe('data:image/png;base64,NATIVE');
    expect(events.length).toBe(0);
  });

  it('zero-dimension canvas → native passthrough', () => {
    const { targets } = makeTargets();
    installHooks(SEED, () => false, targets);
    const out = (targets.canvasProto as { toDataURL: Function }).toDataURL.call(
      makeCanvas(0, 0),
    );
    expect(out).toBe('data:image/png;base64,NATIVE');
  });

  it('tainted canvas → the AUTHENTIC SecurityError from the original canvas, not the scratch error', () => {
    const scratchErr = Object.assign(new Error('scratch read'), { name: 'SecurityError' });
    const authenticErr = Object.assign(new Error('stock toDataURL taint message'), {
      name: 'SecurityError',
    });
    const { targets } = makeTargets({
      taintGetImageData: scratchErr,
      taintToDataURLOnOriginal: authenticErr,
    });
    installHooks(SEED, () => false, targets);
    const canvas = makeCanvas(64, 64);
    canvas.isOriginal = true;
    let caught: unknown = null;
    try {
      (targets.canvasProto as { toDataURL: Function }).toDataURL.call(canvas);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(authenticErr); // byte-identical stock error, never the scratch one
  });
});

describe('getImageData', () => {
  it('noises the returned ImageData deterministically across repeated reads', () => {
    const { targets } = makeTargets();
    installHooks(SEED, () => false, targets);
    const ctx = {};
    const a = (targets.ctx2dProto as { getImageData: Function }).getImageData.call(
      ctx, 0, 0, 64, 64,
    ) as { data: Uint8ClampedArray };
    const b = (targets.ctx2dProto as { getImageData: Function }).getImageData.call(
      ctx, 0, 0, 64, 64,
    ) as { data: Uint8ClampedArray };
    expect(Array.from(a.data)).toEqual(Array.from(b.data)); // stable fingerprint
    let changed = 0;
    for (const v of a.data) if (v !== 128) changed++;
    expect(changed).toBe(16); // budget for 64x64 — noise really applied
    for (const v of a.data) expect([127, 128, 129]).toContain(v); // ±1 only
  });

  it('tainted canvas → the native SecurityError object propagates unchanged', () => {
    const taint = Object.assign(new Error('stock getImageData taint'), {
      name: 'SecurityError',
    });
    const { targets } = makeTargets({ taintGetImageData: taint });
    installHooks(SEED, () => false, targets);
    let caught: unknown = null;
    try {
      (targets.ctx2dProto as { getImageData: Function }).getImageData.call({}, 0, 0, 8, 8);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(taint);
  });

  it('disabled → no noise', () => {
    const { targets } = makeTargets();
    installHooks(SEED, () => true, targets);
    const img = (targets.ctx2dProto as { getImageData: Function }).getImageData.call(
      {}, 0, 0, 64, 64,
    ) as { data: Uint8ClampedArray };
    for (const v of img.data) expect(v).toBe(128);
  });
});
