/**
 * src/popup/popup.ts — hero toggle + session count + Pro row (TECHNICAL-BRIEF
 * Phase 2 journey, verbatim states). No `tabs` permission: tab.id comes from
 * tabs.query (needs none); the hostname comes from the isolated script's
 * PageState (tab.url would need the permission).
 *
 * Count truth: the popup reads storage.session.tabCounts[tabId] DIRECTLY
 * (brief §4); PageState.count is only the frame-local fallback.
 *
 * Pro row, two modes:
 *  - FREE: locked "Pin this site's identity" row → peek panel (3 real
 *    benefits, upgrade CTA, Maybe later). Ask gate (Phase 2, "by design —
 *    never gut it"): the peek opens at most once per browser session
 *    (chrome.storage.session askGate.popupPin).
 *  - PRO: the row is live — click pins/unpins a persistent seed for this
 *    site (crypto-generated, storage.local.pinnedSeeds → isolated mirrors
 *    to localStorage['canvcdc5.ps'] → MAIN reads it next load). Hint copy
 *    says it applies from the next load.
 *
 * Failure posture: inline error/revert, never crash (brief §6).
 */
import { bootDataI18n, msg } from '../shared/i18n.js';
import { revalidateIfDue } from '../shared/license.js';
import {
  MSG_PAGE_QUERY,
  MSG_SITE_SET,
  type PageQuery,
  type PageState,
  type SiteSet,
} from '../shared/messages.js';
import { localGet, localSet, sessionGet, sessionSet } from '../shared/storage.js';
import { emit } from '../shared/analytics.js';

const ASK_GATE_KEY = 'popupPin';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`canvcdc5: missing #${id}`);
  return node as T;
}

function showState(name: 'main' | 'excepted' | 'unavailable'): void {
  el('canvcdc5-state-main').hidden = name !== 'main';
  el('canvcdc5-state-excepted').hidden = name !== 'excepted';
  el('canvcdc5-state-unavailable').hidden = name !== 'unavailable';
}

async function askGateSeen(): Promise<boolean> {
  const gate = (await sessionGet('askGate')) ?? {};
  return gate[ASK_GATE_KEY] === true;
}

async function askGateMark(): Promise<void> {
  const gate = { ...((await sessionGet('askGate')) ?? {}) };
  gate[ASK_GATE_KEY] = true;
  await sessionSet('askGate', gate);
}

function setHint(text: string): void {
  const hint = el('canvcdc5-hint');
  hint.hidden = false;
  hint.textContent = text;
}

/**
 * Feature-locked gate: the FREE "Pin this site's identity" row is a locked Pro
 * feature. Tapping it is the peak-intent moment, so we open the peek paywall
 * here (cap-hit / feature-locked path) rather than from a cold static button.
 * Respects the once-per-session ask gate (never gut it).
 */
async function gate(featureLocked: string): Promise<void> {
  const peek = el('canvcdc5-peek');
  if (!peek.hidden) return;
  if (await askGateSeen()) return; // once per session — respected
  peek.hidden = false;
  emit('paywall_shown', featureLocked);
  await askGateMark();
}

/** FREE mode: locked row opens the peek at most once per session. */
function wirePeek(): void {
  const row = el<HTMLButtonElement>('canvcdc5-pro-row');
  const peek = el('canvcdc5-peek');
  const upgrade = el<HTMLAnchorElement>('canvcdc5-upgrade');
  // onLocked / feature-locked path: the locked "Pin" row gates to the paywall.
  row.addEventListener('click', () => {
    void gate('popup-pin');
  });
  upgrade.addEventListener('click', () => {
    emit('cta_click', 'popup-pin');
  });
  el<HTMLButtonElement>('canvcdc5-maybe-later').addEventListener('click', () => {
    peek.hidden = true;
    emit('maybe_later', 'popup-pin');
  });
}

/** PRO mode: the row pins/unpins a persistent per-site seed. */
function wirePinRow(hostname: string): void {
  const row = el<HTMLButtonElement>('canvcdc5-pro-row');
  const label = row.querySelector<HTMLElement>('[data-i18n="popupProPin"]');
  const lock = row.querySelector<HTMLElement>('.canvcdc5-lock');
  const badge = row.querySelector<HTMLElement>('.canvcdc5-pro-badge');
  if (lock) lock.hidden = true;
  if (badge) badge.hidden = true;
  row.classList.add('canvcdc5-pro-row--live');

  let pinned = false;
  const render = (): void => {
    const text = msg(pinned ? 'popupPinned' : 'popupProPin');
    if (label) label.textContent = text;
    row.setAttribute('aria-label', text);
    row.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  };

  void (async () => {
    const seeds = (await localGet('pinnedSeeds')) ?? {};
    pinned = Object.prototype.hasOwnProperty.call(seeds, hostname);
    render();
  })();

  row.addEventListener('click', () => {
    void (async () => {
      const seeds = { ...((await localGet('pinnedSeeds')) ?? {}) };
      if (pinned) {
        delete seeds[hostname];
      } else {
        seeds[hostname] = Array.from(crypto.getRandomValues(new Uint32Array(4)));
      }
      const ok = await localSet('pinnedSeeds', seeds);
      if (!ok) return; // truth unchanged — leave the row as it was
      pinned = !pinned;
      render();
      setHint(msg('popupPinHint'));
    })();
  });
}

async function boot(): Promise<void> {
  bootDataI18n();
  // Silent re-check of an existing grant gone stale (>24h since last server
  // verification). No-op for never-activated users; next open reflects changes.
  void revalidateIfDue();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (typeof tabId !== 'number') {
    showState('unavailable');
    return;
  }

  let state: PageState | null = null;
  try {
    const query: PageQuery = { type: MSG_PAGE_QUERY };
    state = (await chrome.tabs.sendMessage(tabId, query)) as PageState | null;
  } catch {
    state = null; // chrome:// / Web Store / PDF viewer — injection blocked
  }
  if (!state || typeof state.hostname !== 'string') {
    showState('unavailable');
    return;
  }
  if (state.autoExcepted) {
    showState('excepted');
    return;
  }

  showState('main');
  el('canvcdc5-host').textContent = state.hostname;
  el('canvcdc5-tier').hidden = !state.pro;
  if (state.pro) wirePinRow(state.hostname);
  else wirePeek();

  // Per-tab count: direct storage.session read wins (brief §4).
  let count = state.count;
  try {
    const counts = await sessionGet('tabCounts');
    const direct = counts?.[String(tabId)];
    if (typeof direct === 'number') count = direct;
  } catch {
    /* fallback count already set */
  }
  el('canvcdc5-count').textContent = msg('popupCount', String(count));

  const toggle = el<HTMLInputElement>('canvcdc5-toggle');
  const offAtLoad = state.off; // hooks were never installed when true
  toggle.checked = !state.off;

  toggle.addEventListener('change', () => {
    void (async () => {
      const off = !toggle.checked;
      const set: SiteSet = { type: MSG_SITE_SET, off };
      let ack = false;
      try {
        ack = (await chrome.tabs.sendMessage(tabId, set)) === true;
      } catch {
        ack = false;
      }
      if (!ack) {
        toggle.checked = !off; // revert — truth unchanged
        return;
      }
      // Live-toggle copy (brief Phase 2): hooks live → immediate; the page
      // loaded with protection OFF → reload needed (hooks were never
      // installed). Re-enabling after a live disable is immediate too.
      setHint(msg(offAtLoad && !off ? 'popupAppliesReload' : 'popupAppliesLive'));
    })();
  });
}

void boot().catch(() => {
  // popup failures render inline, never crash (brief §6)
  try {
    showState('unavailable');
  } catch {
    /* nothing else to do */
  }
});
