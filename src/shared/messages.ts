/**
 * src/shared/messages.ts — every cross-context message/event type, locked
 * (TECHNICAL-BRIEF §4 "Message passing" + Phase 1.5 counter-ingress
 * amendment). Import types from here ONLY — never re-literal a type string.
 *
 * Channels:
 *   popup → isolated  : chrome.tabs.sendMessage (PageQuery / SiteSet)
 *   isolated → SW     : chrome.runtime.sendMessage (CountDelta — the ONE
 *                       message type the SW receives; see brief Phase 1.5)
 *   MAIN ↔ isolated   : DOM CustomEvents on `document`, primitive details
 *                       ONLY (worlds share the DOM; objects do not cross
 *                       cleanly). 'canvcdc5:hit' detail: ReadApi;
 *                       'canvcdc5:state' detail: 'on' | 'off'.
 */

export type ReadApi = 'toDataURL' | 'toBlob' | 'getImageData';

// ------------------------------------------------------- runtime messages
export const MSG_PAGE_QUERY = 'canvcdc5.page.query' as const;
export const MSG_SITE_SET = 'canvcdc5.site.set' as const;
export const MSG_COUNT_DELTA = 'canvcdc5.count.delta' as const;

/** popup → isolated (tabs.sendMessage): "what is the state on this page?" */
export interface PageQuery {
  type: typeof MSG_PAGE_QUERY;
}

/** isolated → popup sendMessage response. */
export interface PageState {
  hostname: string;
  off: boolean;
  autoExcepted: boolean;
  /** Frame-local informational count. The popup PREFERS its own direct
   *  storage.session.tabCounts[tabId] read (per-tab truth; brief §4). */
  count: number;
  pro: boolean;
  /** Isolated cannot observe MAIN-world state; always true. The popup infers
   *  live-vs-reload-needed from the off-at-load record it last wrote. */
  liveHooks: boolean;
}

/** popup → isolated (tabs.sendMessage): set per-site OFF. Ack = boolean. */
export interface SiteSet {
  type: typeof MSG_SITE_SET;
  off: boolean;
}

/** isolated → SW (runtime.sendMessage): batched hit deltas. SW keys by
 *  sender.tab.id — the only honest tabId channel (brief Phase 1.5). */
export interface CountDelta {
  type: typeof MSG_COUNT_DELTA;
  n: number;
}

// --------------------------------------------------------- DOM CustomEvents
export const EVT_HIT = 'canvcdc5:hit' as const; // MAIN → isolated, detail: ReadApi
export const EVT_STATE = 'canvcdc5:state' as const; // isolated → MAIN, detail: StateDetail
export type StateDetail = 'on' | 'off';

// -------------------------------------------------------------- type guards
export function isPageQuery(msg: unknown): msg is PageQuery {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === MSG_PAGE_QUERY
  );
}

export function isSiteSet(msg: unknown): msg is SiteSet {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; off?: unknown };
  return m.type === MSG_SITE_SET && typeof m.off === 'boolean';
}

export function isCountDelta(msg: unknown): msg is CountDelta {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; n?: unknown };
  return m.type === MSG_COUNT_DELTA && typeof m.n === 'number' && Number.isFinite(m.n);
}
