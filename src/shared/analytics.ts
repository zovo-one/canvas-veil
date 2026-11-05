/**
 * src/shared/analytics.ts — local-only funnel instrumentation (MONETIZE-STANDARD
 * §"Measurement contract"; psych-audit Layer 5.7). Canvas Veil has NO analytics
 * backend — its only network call is license activation — so funnel events are
 * recorded to a capped, session-scoped local log and NEVER transmitted. This
 * exists so conversion ROI is measurable on-device (paywall_shown → cta_click →
 * key_verified) without widening the network surface beyond that one call.
 *
 * Event sink pattern: `setEventSink` lets a host (none by default) observe the
 * stream; `emit` always appends to the in-memory + storage.session ring so the
 * signal survives even with no sink attached.
 */

export type FunnelEvent =
  | 'paywall_shown'
  | 'cta_click'
  | 'maybe_later'
  | 'key_verified'
  | 'verify_failed';

export interface FunnelRecord {
  event: FunnelEvent;
  /** Surface that fired it: popup-pin, sidebar, onboarding, options-license. */
  surface: string;
  at: number;
}

const MAX_EVENTS = 200;
const STORAGE_KEY = 'funnelLog';

type Sink = (rec: FunnelRecord) => void;
let sink: Sink | null = null;
let buffer: FunnelRecord[] = [];

/** Optional host observer. Pass null to detach. Local-only by design. */
export function setEventSink(next: Sink | null): void {
  sink = next;
}

function hasSession(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.session;
  } catch {
    return false;
  }
}

/** Record a funnel event. Never throws, never networks. */
export function emit(event: FunnelEvent, surface: string): void {
  const rec: FunnelRecord = { event, surface, at: Date.now() };
  buffer.push(rec);
  if (buffer.length > MAX_EVENTS) buffer = buffer.slice(-MAX_EVENTS);
  try {
    sink?.(rec);
  } catch {
    /* a broken sink must not break the product */
  }
  if (!hasSession()) return;
  // Persist a bounded copy so the signal is inspectable across popup reopen.
  void (async () => {
    try {
      const got = await chrome.storage.session.get(STORAGE_KEY);
      const log: FunnelRecord[] = Array.isArray(got?.[STORAGE_KEY]) ? got[STORAGE_KEY] : [];
      log.push(rec);
      await chrome.storage.session.set({ [STORAGE_KEY]: log.slice(-MAX_EVENTS) });
    } catch {
      /* storage is best-effort; the in-memory ring still has it */
    }
  })();
}

/** Test/host read of the current buffer (no storage round-trip). */
export function funnelBuffer(): readonly FunnelRecord[] {
  return buffer;
}
