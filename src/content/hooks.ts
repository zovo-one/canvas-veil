/**
 * src/content/hooks.ts — DOM-touching hook installer (TECHNICAL-BRIEF §4).
 * THE core builder deliverable. Everything in this file touches page
 * prototypes; everything pure lives in src/shared/noise.ts + prng.ts (the
 * split is mandatory for gate 8.2 — vitest imports the pure modules, and
 * reaches this file only through the HookTargets DI seam).
 *
 * Behavior (implemented verbatim from TECHNICAL-BRIEF §4):
 *
 *  - installHooks(seed, isDisabled) hooks, on HTMLCanvasElement.prototype:
 *      toDataURL, toBlob; on CanvasRenderingContext2D.prototype: getImageData.
 *  - getImageData(x,y,w,h): call native FIRST (tainted canvas → native throws
 *    the authentic SecurityError for us); on success noise the RETURNED
 *    ImageData via noiseImageData(data, w, h, streamKey(seed, 'getImageData',
 *    {x,y,w,h})); return the same object; emit EVT_HIT when pairs changed.
 *  - toDataURL/toBlob: zero-dimension → native passthrough on the ORIGINAL
 *    canvas. Else canvas.getContext('2d'); null → native passthrough (WebGL,
 *    untouched). Else per-frame reusable scratch canvas (never DOM-attached):
 *    resize (clears) → drawImage(original,0,0) → NATIVE getImageData on the
 *    scratch (the captured native — the prototype method is hooked by us, so
 *    an instance call would double-noise and double-count) → noiseImageData
 *    with geometry {0,0,w,h} → putImageData → NATIVE toDataURL/toBlob ON THE
 *    SCRATCH with the original args (toBlob keeps native async callback
 *    semantics). Any scratch SecurityError → invoke the ORIGINAL native
 *    method on the ORIGINAL canvas to reproduce and rethrow the authentic
 *    error object/message — never swallow, substitute, or wrap
 *    (byte-identical to stock Chrome).
 *  - Success path dispatches document CustomEvent(EVT_HIT, {detail: kind})
 *    AFTER the read (primitive detail only — DOM events cross worlds).
 *  - isDisabled() is checked per call (cheap): true → native passthrough
 *    (live-toggle DISABLED_LIVE state, brief §4).
 *  - Identity spoofing (brief §4): WeakMap<Function,string> →
 *    `function ${name}() { [native code] }`; patch Function.prototype.toString
 *    ONCE as a named function expression (`.name === 'toString'`); the map
 *    contains the patched toString itself; defineProperty each hook's
 *    name/length to the native values; redefine each prototype method with
 *    the stock descriptor {writable:true, enumerable:false, configurable:true}.
 *    NO eval, NO new Function (CSP-clean; dist scan fails on either).
 *
 * targets is the DI seam for node-env tests (spoof-shape + passthrough
 * gates): tests pass fake prototypes/documents; production omits it and
 * natives are used.
 */
import { EVT_HIT, type ReadApi } from '../shared/messages.js';
import { noiseImageData } from '../shared/noise.js';
import { streamKey } from '../shared/prng.js';
import type { Strength } from '../shared/storage.js';

export interface HookTargets {
  /** HTMLCanvasElement.prototype in production. */
  canvasProto: object;
  /** CanvasRenderingContext2D.prototype in production. */
  ctx2dProto: object;
  /** Function.prototype in production. */
  functionProto: object;
  /** document in production (scratch canvas + EVT_HIT dispatch). */
  documentRef: Document;
}

export interface HookHandle {
  readonly installed: boolean;
  /** Unwind every patch (restore stock descriptors). Diagnostic/testing. */
  restore(): void;
}

const SECURITY_ERROR = 'SecurityError';

/** Pro strength preset → budget multiplier (medium = the spec rule, 1). */
const STRENGTH_SCALE: Readonly<Record<Strength, number>> = {
  low: 0.5,
  medium: 1,
  high: 2,
};

function defaultTargets(): HookTargets {
  return {
    canvasProto: HTMLCanvasElement.prototype,
    ctx2dProto: CanvasRenderingContext2D.prototype,
    functionProto: Function.prototype,
    documentRef: document,
  };
}

/** Cosmetic-only hit signal; a missing CustomEvent binding must never
 *  break a page read (node-env tests polyfill CustomEvent to observe it). */
function emitHit(doc: Document, kind: ReadApi): void {
  try {
    const CE = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;
    if (typeof CE !== 'function') return;
    doc.dispatchEvent(new CE(EVT_HIT, { detail: kind }));
  } catch {
    /* the counter is cosmetic; protection never depends on it */
  }
}

/** The error name check that gates taint reproduction (name-only: works for
 *  real DOMExceptions and cross-realm/test doubles alike). */
function isSecurityError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === SECURITY_ERROR
  );
}

export function installHooks(
  seed: Uint32Array,
  isDisabled: () => boolean,
  targets?: HookTargets,
  strength: Strength = 'medium',
): HookHandle {
  const t = targets ?? defaultTargets();
  const budgetScale = STRENGTH_SCALE[strength];

  // ------------------------------------------------ capture natives first
  // Every prototype method we replace is captured from its own-property
  // descriptor BEFORE patching, so internal calls and native passthroughs
  // use the genuine originals even after the page-visible prototypes point
  // at our hooks.
  const toDataURLDesc = Object.getOwnPropertyDescriptor(t.canvasProto, 'toDataURL');
  const toBlobDesc = Object.getOwnPropertyDescriptor(t.canvasProto, 'toBlob');
  const getImageDataDesc = Object.getOwnPropertyDescriptor(t.ctx2dProto, 'getImageData');
  const toStringDesc = Object.getOwnPropertyDescriptor(t.functionProto, 'toString');
  if (!toDataURLDesc || !toBlobDesc || !getImageDataDesc || !toStringDesc) {
    return { installed: false, restore(): void {} }; // nothing to hook on
  }
  // Descriptor values are `any` by lib definition; narrow once here to the
  // exact shapes the hooks rely on. Variadic wrappers pass original args
  // through untouched, so the public optional-param types do not apply.
  type NativeToDataURL = (this: HTMLCanvasElement, ...args: unknown[]) => string;
  type NativeToBlob = (this: HTMLCanvasElement, ...args: unknown[]) => void;
  type NativeGetImageData = (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) => ImageData;
  type NativeFnToString = (this: unknown) => string;
  const nativeToDataURL = toDataURLDesc.value as NativeToDataURL;
  const nativeToBlob = toBlobDesc.value as NativeToBlob;
  const nativeGetImageData = getImageDataDesc.value as NativeGetImageData;
  const nativeFnToString = toStringDesc.value as NativeFnToString;

  // ------------------------------------------------- per-frame scratch pad
  // One reusable scratch canvas per frame, never DOM-attached. Resizing a
  // canvas clears it, which is exactly the reset we need between reads.
  let scratch: HTMLCanvasElement | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;
  function scratchFor(w: number, h: number): CanvasRenderingContext2D {
    if (scratch === null || scratchCtx === null) {
      scratch = t.documentRef.createElement('canvas');
      scratchCtx = scratch.getContext('2d');
      if (scratchCtx === null) {
        // A 2d context on a fresh canvas is never null in practice; if it
        // is, surface it like an operational failure (caught by callers).
        throw new Error('canvcdc5: scratch 2d context unavailable');
      }
    }
    scratch.width = w; // resize clears
    scratch.height = h;
    return scratchCtx;
  }

  // ------------------------------------------------------------ the hooks
  // Canvas-like guard: anything else (wrong `this`, zero-dimension) goes
  // straight to the native, which reproduces stock behavior byte-for-byte —
  // including the authentic TypeError on an illegal receiver.
  function asCanvas(receiver: unknown): HTMLCanvasElement | null {
    if (typeof receiver !== 'object' || receiver === null) return null;
    const c = receiver as HTMLCanvasElement;
    if (typeof c.width !== 'number' || typeof c.height !== 'number') return null;
    if (typeof c.getContext !== 'function') return null;
    return c;
  }

  const hookedToDataURL = function toDataURL(
    this: unknown,
    ...args: unknown[]
  ): string {
    const canvas = asCanvas(this);
    if (isDisabled() || canvas === null || canvas.width === 0 || canvas.height === 0) {
      return nativeToDataURL.apply(canvas ?? (this as HTMLCanvasElement), args);
    }
    // WebGL/WebGL2 → null 2d context → native passthrough, untouched.
    const ctx = canvas.getContext('2d');
    if (ctx === null) return nativeToDataURL.apply(canvas, args);
    const w = canvas.width;
    const h = canvas.height;
    try {
      const sctx = scratchFor(w, h);
      sctx.drawImage(canvas, 0, 0); // tainted source taints the scratch…
      const img = nativeGetImageData.call(sctx, 0, 0, w, h); // …so this throws
      noiseImageData(img.data, w, h, streamKey(seed, 'toDataURL', { x: 0, y: 0, w, h }), budgetScale);
      sctx.putImageData(img, 0, 0);
      const out = nativeToDataURL.apply(scratch as HTMLCanvasElement, args);
      emitHit(t.documentRef, 'toDataURL');
      return out;
    } catch (e) {
      if (isSecurityError(e)) {
        // Tainted canvas: reproduce the authentic error by running the
        // ORIGINAL native method on the ORIGINAL canvas — it throws the
        // stock SecurityError with the stock message. Never swallowed.
        return nativeToDataURL.apply(canvas, args);
      }
      throw e;
    }
  };

  const hookedToBlob = function toBlob(this: unknown, ...args: unknown[]): void {
    const canvas = asCanvas(this);
    if (isDisabled() || canvas === null || canvas.width === 0 || canvas.height === 0) {
      nativeToBlob.apply(canvas ?? (this as HTMLCanvasElement), args);
      return;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      nativeToBlob.apply(canvas, args); // WebGL passthrough
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    try {
      const sctx = scratchFor(w, h);
      sctx.drawImage(canvas, 0, 0);
      const img = nativeGetImageData.call(sctx, 0, 0, w, h);
      noiseImageData(img.data, w, h, streamKey(seed, 'toBlob', { x: 0, y: 0, w, h }), budgetScale);
      sctx.putImageData(img, 0, 0);
      // Native async callback semantics preserved: the page's callback fires
      // on the browser's schedule with the scratch's blob.
      nativeToBlob.apply(scratch as HTMLCanvasElement, args);
      emitHit(t.documentRef, 'toBlob');
    } catch (e) {
      if (isSecurityError(e)) {
        // Native toBlob on a tainted canvas throws synchronously — authentic.
        nativeToBlob.apply(canvas, args);
        return;
      }
      throw e;
    }
  };

  const hookedGetImageData = function getImageData(
    this: unknown,
    ...args: unknown[]
  ): ImageData {
    const ctx = this as CanvasRenderingContext2D;
    if (isDisabled()) return nativeGetImageData.apply(ctx, args);
    // Native FIRST: on a tainted canvas this throws the authentic
    // SecurityError before we touch anything — no special case needed.
    const img = nativeGetImageData.apply(ctx, args);
    // Native validation already guaranteed four finite numbers (it throws
    // TypeError otherwise), so narrowing args here is safe.
    const x = args[0] as number;
    const y = args[1] as number;
    const w = args[2] as number;
    const h = args[3] as number;
    const noised = noiseImageData(
      img.data,
      w,
      h,
      streamKey(seed, 'getImageData', { x, y, w, h }),
      budgetScale,
    );
    if (noised > 0) emitHit(t.documentRef, 'getImageData');
    return img;
  };

  // ------------------------------------------------------ identity spoof
  // WeakMap of hooked fn → native-looking toString output. The patched
  // Function.prototype.toString consults it and falls through to the real
  // native for everything else, so unspoofed functions keep their real
  // source text (we never widen the lie).
  const spoof = new WeakMap<Function, string>();
  const patchedToString = function toString(this: unknown): string {
    if (typeof this === 'function') {
      const s = spoof.get(this);
      if (s !== undefined) return s;
    }
    return nativeFnToString.call(this);
  };
  spoof.set(patchedToString, 'function toString() { [native code] }');

  function register(fn: Function, nativeFn: Function): void {
    spoof.set(fn, `function ${nativeFn.name}() { [native code] }`);
    Object.defineProperty(fn, 'name', { value: nativeFn.name, configurable: true });
    Object.defineProperty(fn, 'length', { value: nativeFn.length, configurable: true });
  }
  register(hookedToDataURL, nativeToDataURL);
  register(hookedToBlob, nativeToBlob);
  register(hookedGetImageData, nativeGetImageData);

  // -------------------------------------------------- install (stock desc)
  const installed: Array<{ obj: object; key: string; desc: PropertyDescriptor }> = [];
  function install(obj: object, key: string, desc: PropertyDescriptor, fn: Function): void {
    Object.defineProperty(obj, key, {
      value: fn,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    installed.push({ obj, key, desc });
  }
  install(t.canvasProto, 'toDataURL', toDataURLDesc, hookedToDataURL);
  install(t.canvasProto, 'toBlob', toBlobDesc, hookedToBlob);
  install(t.ctx2dProto, 'getImageData', getImageDataDesc, hookedGetImageData);
  install(t.functionProto, 'toString', toStringDesc, patchedToString);

  return {
    installed: true,
    restore(): void {
      for (const { obj, key, desc } of installed) {
        try {
          Object.defineProperty(obj, key, desc);
        } catch {
          /* diagnostic path only — never break the page on unwind */
        }
      }
      installed.length = 0;
    },
  };
}
