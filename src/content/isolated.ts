/**
 * src/content/isolated.ts — ISOLATED-world companion (document_start,
 * all_frames, http/https). The ONLY world with chrome.storage / runtime
 * access. Four jobs (TECHNICAL-BRIEF §4):
 *
 *  1. MIRROR (sole writer of page-side mirrors): chrome.storage.local truth →
 *     localStorage['canvcdc5:off'], (Pro) localStorage['canvcdc5.ps'], and
 *     localStorage['canvcdc5.st'] (strength preset), on load and on
 *     storage.onChanged. MAIN reads mirrors synchronously at document_start;
 *     a remote change may hook one transitional load (spec-accepted,
 *     TRANSITIONAL state).
 *  2. COUNTER: listens for MAIN's EVT_HIT DOM events, batches deltas
 *     (≤2 runtime messages/sec) to the SW as MSG_COUNT_DELTA — the SW keys
 *     by sender.tab.id because a content script cannot learn its own tabId
 *     (brief Phase 1.5 resolution). Frame-local in-memory count is the
 *     informational PageState.count fallback. The TOP frame additionally
 *     folds each flush into the Pro stats history (statsLogAdd) — one
 *     writer per tab keeps the read-modify-write race window minimal;
 *     per-host rows key on the top frame's hostname, which IS the site.
 *  3. MESSAGES: PageQuery responder + SiteSet handler for the popup
 *     (tabs.sendMessage). SiteSet writes storage.local truth AND the
 *     localStorage mirror AND dispatches EVT_STATE so live hooks flip
 *     without reload (DISABLED_LIVE ↔ PROTECTED).
 *  4. SYNC (Pro opt-in, settings.syncExceptions): when enabled, merge
 *     chrome.storage.sync.siteExceptions into local on boot (top frame) and
 *     on sync-area changes — union, newer addedAt wins a conflict. The
 *     local→sync push happens in options at enable time; here we only pull.
 *
 * Failure posture: any isolated-side failure leaves protection unaffected —
 * the MAIN world never depends on this script (brief §6). Everything here is
 * wrapped; nothing throws to the page.
 */
import { isExcepted } from '../shared/exceptions.js';
import {
  EVT_HIT,
  EVT_STATE,
  isPageQuery,
  isSiteSet,
  MSG_COUNT_DELTA,
  type CountDelta,
  type PageState,
  type StateDetail,
} from '../shared/messages.js';
import { isPro } from '../shared/license.js';
import {
  localGet,
  localSet,
  statsLogAdd,
  syncGet,
  type SiteExceptionEntry,
} from '../shared/storage.js';

const LS_OFF = 'canvcdc5:off';
const LS_PINNED = 'canvcdc5.ps';
const LS_STRENGTH = 'canvcdc5.st';

function isTopFrame(): boolean {
  try {
    return window === window.top;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ mirror
async function currentOff(hostname: string): Promise<boolean> {
  const map = (await localGet('siteExceptions')) ?? {};
  return Object.prototype.hasOwnProperty.call(map, hostname);
}

function writeOffMirror(off: boolean): void {
  try {
    if (off) localStorage.setItem(LS_OFF, '1');
    else localStorage.removeItem(LS_OFF);
  } catch {
    // sandboxed frame — MAIN's try/catch mirrors the same posture
  }
}

async function writePinnedMirror(): Promise<void> {
  try {
    const pinned = (await localGet('pinnedSeeds')) ?? {};
    if (Object.keys(pinned).length > 0) {
      localStorage.setItem(LS_PINNED, JSON.stringify(pinned));
    } else {
      localStorage.removeItem(LS_PINNED);
    }
  } catch {
    // sandboxed frame
  }
}

async function writeStrengthMirror(): Promise<void> {
  try {
    const settings = await localGet('settings');
    const strength = settings?.strength;
    if (strength === 'low' || strength === 'medium' || strength === 'high') {
      localStorage.setItem(LS_STRENGTH, strength);
    } else {
      localStorage.removeItem(LS_STRENGTH); // corrupt/absent → MAIN defaults medium
    }
  } catch {
    // sandboxed frame
  }
}

function dispatchState(detail: StateDetail): void {
  try {
    document.dispatchEvent(new CustomEvent<StateDetail>(EVT_STATE, { detail }));
  } catch {
    // MAIN listener absent (hooks not installed) — next load applies
  }
}

async function mirrorAll(hostname: string): Promise<void> {
  writeOffMirror(await currentOff(hostname));
  await writePinnedMirror();
  await writeStrengthMirror();
}

// -------------------------------------------------------------------- sync
/** Union merge; on a hostname conflict the newer addedAt wins. */
function mergeExceptions(
  local: Record<string, SiteExceptionEntry>,
  remote: Record<string, SiteExceptionEntry>,
): Record<string, SiteExceptionEntry> {
  const out: Record<string, SiteExceptionEntry> = { ...local };
  for (const [host, entry] of Object.entries(remote)) {
    const have = out[host];
    if (!have || entry.addedAt > have.addedAt) out[host] = entry;
  }
  return out;
}

function sameExceptions(
  a: Record<string, SiteExceptionEntry>,
  b: Record<string, SiteExceptionEntry>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k]?.addedAt === a[k]?.addedAt);
}

/** Pull sync→local when the Pro opt-in is on. Never writes sync (the
 *  local→sync direction lives in options at enable time), so this listener
 *  cannot write-loop. */
async function pullSyncIntoLocal(hostname: string): Promise<void> {
  const settings = await localGet('settings');
  if (settings?.syncExceptions !== true) return;
  if (!(await isPro())) return; // lapsed Pro: keep local truth, stop pulling
  const remote = (await syncGet('siteExceptions')) ?? {};
  if (Object.keys(remote).length === 0) return;
  const local = (await localGet('siteExceptions')) ?? {};
  const merged = mergeExceptions(local, remote);
  if (sameExceptions(local, merged)) return; // nothing new — no write, no loop
  if (await localSet('siteExceptions', merged)) {
    writeOffMirror(Object.prototype.hasOwnProperty.call(merged, hostname));
  }
}

// ----------------------------------------------------------------- counter
let frameCount = 0;
let pendingDelta = 0;
let flushTimer: number | null = null;
const FLUSH_MS = 500; // ≤2 writes/sec (brief §4)

function flushDelta(hostname: string): void {
  flushTimer = null;
  if (pendingDelta <= 0) return;
  const n = pendingDelta;
  pendingDelta = 0;
  const msg: CountDelta = { type: MSG_COUNT_DELTA, n };
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {
      /* SW asleep/dead — count loss is cosmetic, protection unaffected */
    });
  } catch {
    /* no runtime binding (unit import) */
  }
  if (isTopFrame()) {
    // Pro stats history (display-gated in options). Fire-and-forget; a
    // dropped increment is informational only.
    void statsLogAdd(hostname, n).catch(() => undefined);
  }
}

function onHit(hostname: string, ev: Event): void {
  const kind = (ev as CustomEvent<string>).detail;
  if (kind !== 'toDataURL' && kind !== 'toBlob' && kind !== 'getImageData') return;
  frameCount++;
  pendingDelta++;
  if (flushTimer === null) {
    flushTimer = self.setTimeout(() => flushDelta(hostname), FLUSH_MS);
  }
}

// ---------------------------------------------------------------- messages
async function buildPageState(hostname: string): Promise<PageState> {
  return {
    hostname,
    off: await currentOff(hostname),
    autoExcepted: isExcepted(hostname),
    count: frameCount, // frame-local informational; popup prefers storage.session
    pro: await isPro(),
    liveHooks: true, // isolated cannot observe MAIN; popup infers (brief §6)
  };
}

async function handleSiteSet(hostname: string, off: boolean): Promise<boolean> {
  const map = { ...((await localGet('siteExceptions')) ?? {}) };
  if (off) {
    map[hostname] = { addedAt: Date.now() };
  } else {
    delete map[hostname];
  }
  const ok = await localSet('siteExceptions', map);
  if (!ok) return false;
  writeOffMirror(off);
  dispatchState(off ? 'off' : 'on');
  return true;
}

function registerMessages(hostname: string): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isPageQuery(msg)) {
      void buildPageState(hostname).then(sendResponse, () => sendResponse(null));
      return true; // async response
    }
    if (isSiteSet(msg)) {
      void handleSiteSet(hostname, msg.off).then(sendResponse, () => sendResponse(false));
      return true;
    }
    return false;
  });
}

// -------------------------------------------------------------------- boot
function boot(): void {
  try {
    const hostname = location.hostname;
    if (!hostname) return;
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    document.addEventListener(EVT_HIT, (ev) => onHit(hostname, ev));
    registerMessages(hostname);
    void mirrorAll(hostname); // async — transitional first load spec-accepted
    if (isTopFrame()) void pullSyncIntoLocal(hostname); // Pro opt-in pull
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          if (changes.siteExceptions) {
            void currentOff(hostname).then(writeOffMirror, () => undefined);
          }
          if (changes.pinnedSeeds) {
            void writePinnedMirror();
          }
          if (changes.settings) {
            void writeStrengthMirror();
          }
          return;
        }
        if (area === 'sync' && changes.siteExceptions && isTopFrame()) {
          void pullSyncIntoLocal(hostname);
        }
      });
    } catch {
      /* storage events unavailable — load-time mirror still applied */
    }
  } catch {
    // isolated failure must never affect the page (brief §6)
  }
}

boot();
