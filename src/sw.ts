/**
 * src/sw.ts — MV3 service worker. Deliberately near-empty and STATELESS
 * (TECHNICAL-BRIEF §3/§4): all truth lives in storage areas, so SW death
 * loses nothing.
 *
 *  1. onInstalled(install) → open the premium onboarding tab.
 *  2. Badge color pinned at SW start (hue-185 swatch).
 *  3. MSG_COUNT_DELTA ingress (the ONE message type the SW receives — brief
 *     Phase 1.5): add n to storage.session.tabCounts[String(sender.tab.id)].
 *     Content scripts cannot learn their own tabId; sender.tab.id is the
 *     only honest channel. SW never answers state queries.
 *  4. storage.onChanged (session) → per-tab action.setBadgeText — badge
 *     DERIVES from storage, never from message content (brief §4 verbatim).
 *  5. tabs.onRemoved → prune dead tabCounts keys (storage.session quota
 *     hygiene; needs no permission).
 */
import { isCountDelta } from './shared/messages.js';
import { revalidateIfDue } from './shared/license.js';
import { sessionGet, sessionSet } from './shared/storage.js';

/** Hue-185 swatch (hsl(185, 60%, 38%)) — pinned identity, white badge text. */
const BADGE_COLOR = '#27919B';

chrome.action
  .setBadgeBackgroundColor({ color: BADGE_COLOR })
  .catch(() => undefined);

// Silent license revalidation (canonical zovo-license.js cadence): a no-op
// unless a stored grant is STALE (>24h since last server verification), in
// which case one verify POST refreshes or revokes it. Offline failures keep
// the record readable until its 7-day grace lapses. Never fires for a user
// who never activated a key.
void revalidateIfDue();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.tabs
    .create({ url: chrome.runtime.getURL('onboarding.html') })
    .catch(() => undefined);
});

chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
  if (!isCountDelta(msg)) return false;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || tabId < 0) return false;
  const n = Math.floor(msg.n);
  if (n <= 0) return false;
  void (async () => {
    const counts = { ...((await sessionGet('tabCounts')) ?? {}) };
    counts[String(tabId)] = (counts[String(tabId)] ?? 0) + n;
    await sessionSet('tabCounts', counts);
  })();
  return false; // no response — fire and forget
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.tabCounts) return;
  const oldV = (changes.tabCounts.oldValue ?? {}) as Record<string, number>;
  const newV = (changes.tabCounts.newValue ?? {}) as Record<string, number>;
  for (const key of Object.keys(newV)) {
    if (oldV[key] === newV[key]) continue;
    const tabId = Number(key);
    if (!Number.isInteger(tabId)) continue;
    const count = newV[key] ?? 0;
    chrome.action
      .setBadgeText({ tabId, text: count > 0 ? String(count) : '' })
      .catch(() => undefined); // tab may be gone — cosmetic only
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const counts = { ...((await sessionGet('tabCounts')) ?? {}) };
    if (!(String(tabId) in counts)) return;
    delete counts[String(tabId)];
    await sessionSet('tabCounts', counts);
  })();
});
