/**
 * src/options/options.ts — settings page logic (TECHNICAL-BRIEF §6):
 * Auto-excluded (read-only render of the ONE exported AUTO_EXCEPTIONS
 * constant), Your sites (manage per-site OFF list), Pinned identities (Pro:
 * persistent per-site seeds — pin/unpin happens in the popup; this section
 * lists and removes), Noise & strength + exception sync (Pro gates — show,
 * don't hide), License (server-verified activate/deactivate; activate button
 * carries aria-label "Activate Pro license" — extqa L3 rule), Stats (Pro),
 * Privacy & Data (export/wipe), About. Conversion sidebar mounted in
 * #canvcdc5-sidebar (SLUG=canvas-veil, 3 real Pro benefits, own funnel
 * only — NO sibling cross-sell); the Pro card hides once Pro is active.
 *
 * Sync semantics (settings.syncExceptions, Pro opt-in): enabling merges
 * sync↔local (union, newer addedAt wins) and writes BOTH stores so the
 * cloud copy converges immediately; the isolated content script pulls
 * sync→local on later changes. Disabling removes the synced copy — the
 * honest privacy reading of "off".
 *
 * Failure posture: inline error text, never a crash (brief §6).
 */
import { AUTO_EXCEPTIONS } from '../shared/exceptions.js';
import { bootDataI18n, msg } from '../shared/i18n.js';
import { activate, deactivate, getLicense, isPro, revalidateIfDue } from '../shared/license.js';
import { emit } from '../shared/analytics.js';
import {
  exportAll,
  localGet,
  localSet,
  syncGet,
  syncSet,
  wipeAll,
  type SiteExceptionEntry,
  type Strength,
} from '../shared/storage.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`canvcdc5: missing #${id}`);
  return node as T;
}

function renderAutoList(): void {
  const ul = el('canvcdc5-auto-list');
  ul.textContent = '';
  for (const host of AUTO_EXCEPTIONS) {
    const li = document.createElement('li');
    li.textContent = host;
    ul.appendChild(li);
  }
}

/** One removable host row (Your sites / Pinned identities share the shape). */
function hostRow(host: string, onRemove: () => Promise<void>): HTMLLIElement {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = host; // textContent only — storage-derived, never innerHTML
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvcdc5-row-remove';
  btn.textContent = msg('optionsRemove');
  btn.setAttribute('aria-label', `${msg('optionsRemove')} ${host}`);
  btn.addEventListener('click', () => {
    void onRemove();
  });
  li.append(name, btn);
  return li;
}

async function renderSites(): Promise<void> {
  const map = (await localGet('siteExceptions')) ?? {};
  const hosts = Object.keys(map).sort();
  const ul = el('canvcdc5-sites-list');
  ul.textContent = '';
  el('canvcdc5-sites-empty').hidden = hosts.length > 0;
  for (const host of hosts) {
    ul.appendChild(
      hostRow(host, async () => {
        const current = { ...((await localGet('siteExceptions')) ?? {}) };
        delete current[host];
        await localSet('siteExceptions', current);
        await pushExceptionsToSyncIfEnabled(current);
        await renderSites();
      }),
    );
  }
}

async function renderPinned(): Promise<void> {
  const pro = await isPro();
  const seeds = (await localGet('pinnedSeeds')) ?? {};
  const hosts = Object.keys(seeds).sort();
  const ul = el('canvcdc5-pinned-list');
  ul.textContent = '';
  el('canvcdc5-pinned-lock').hidden = pro;
  el('canvcdc5-pinned-empty').hidden = !pro || hosts.length > 0;
  if (!pro) return; // show, don't hide: the section explains, the list stays empty
  for (const host of hosts) {
    ul.appendChild(
      hostRow(host, async () => {
        const current = { ...((await localGet('pinnedSeeds')) ?? {}) };
        delete current[host];
        await localSet('pinnedSeeds', current);
        await renderPinned();
      }),
    );
  }
}

async function renderLicense(): Promise<void> {
  const record = await getLicense();
  const status = el('canvcdc5-license-status');
  const form = el('canvcdc5-license-form');
  const removeBtn = el<HTMLButtonElement>('canvcdc5-deactivate');
  if (record) {
    status.textContent = `${msg('optionsProActive')} (${record.plan})`;
    form.hidden = true;
    removeBtn.hidden = false;
  } else {
    status.textContent = '';
    form.hidden = false;
    removeBtn.hidden = true;
  }
}

/** The sidebar's Pro card sells the upgrade; it hides once Pro is active. */
async function renderSidebar(): Promise<void> {
  const card = document.querySelector<HTMLElement>('[data-canvcdc5-sb="pro"]');
  if (card) card.hidden = await isPro();
  const cta = card?.querySelector<HTMLAnchorElement>('.canvcdc5-sb-cta');
  if (cta && !cta.dataset.wired) {
    cta.dataset.wired = '1';
    cta.addEventListener('click', () => emit('cta_click', 'sidebar'));
  }
}

function wireLicense(): void {
  const input = el<HTMLInputElement>('canvcdc5-license-key');
  const error = el('canvcdc5-license-error');
  el<HTMLButtonElement>('canvcdc5-activate').addEventListener('click', () => {
    void (async () => {
      const result = await activate(input.value);
      if ('error' in result) {
        error.hidden = false;
        emit('verify_failed', 'options-license');
        return;
      }
      error.hidden = true;
      input.value = '';
      emit('key_verified', 'options-license');
      await renderAll();
    })();
  });
  el<HTMLButtonElement>('canvcdc5-deactivate').addEventListener('click', () => {
    void (async () => {
      await deactivate();
      await renderAll();
    })();
  });
  input.addEventListener('input', () => {
    error.hidden = true;
  });
}

async function readSettings(): Promise<{ strength: Strength; syncExceptions: boolean }> {
  const s = await localGet('settings');
  return {
    strength: s?.strength ?? 'medium',
    syncExceptions: s?.syncExceptions === true,
  };
}

async function renderProGates(): Promise<void> {
  const pro = await isPro();
  const strength = el<HTMLSelectElement>('canvcdc5-strength');
  const sync = el<HTMLInputElement>('canvcdc5-sync');
  strength.disabled = !pro;
  sync.disabled = !pro;
  el('canvcdc5-strength-lock').hidden = pro;
  el('canvcdc5-sync-lock').hidden = pro;
  const settings = await readSettings();
  strength.value = settings.strength;
  sync.checked = settings.syncExceptions;
}

/** Push local exceptions into storage.sync when the Pro opt-in is on. */
async function pushExceptionsToSyncIfEnabled(
  map: Record<string, SiteExceptionEntry>,
): Promise<void> {
  const settings = await readSettings();
  if (!settings.syncExceptions) return;
  if (!(await isPro())) return;
  await syncSet('siteExceptions', map);
}

function wireProControls(): void {
  el<HTMLSelectElement>('canvcdc5-strength').addEventListener('change', (ev) => {
    void (async () => {
      const value = (ev.target as HTMLSelectElement).value;
      if (value !== 'low' && value !== 'medium' && value !== 'high') return;
      const settings = await readSettings();
      await localSet('settings', { ...settings, strength: value });
      // isolated mirrors settings → localStorage['canvcdc5.st'] onChanged;
      // MAIN reads it at document_start (copy says: new tabs and reloads).
    })();
  });
  el<HTMLInputElement>('canvcdc5-sync').addEventListener('change', (ev) => {
    void (async () => {
      const on = (ev.target as HTMLInputElement).checked;
      const settings = await readSettings();
      await localSet('settings', { ...settings, syncExceptions: on });
      if (on) {
        // Enable: converge both stores — union, newer addedAt wins.
        const local = (await localGet('siteExceptions')) ?? {};
        const remote = (await syncGet('siteExceptions')) ?? {};
        const merged: Record<string, SiteExceptionEntry> = { ...local };
        for (const [host, entry] of Object.entries(remote)) {
          const have = merged[host];
          if (!have || entry.addedAt > have.addedAt) merged[host] = entry;
        }
        await localSet('siteExceptions', merged);
        await syncSet('siteExceptions', merged);
        await renderSites();
      } else {
        // Disable: remove the synced copy (honest "off").
        await chrome.storage.sync.remove('siteExceptions').catch(() => undefined);
      }
    })();
  });
}

async function renderStats(): Promise<void> {
  const pro = await isPro();
  const list = el('canvcdc5-stats-list');
  list.textContent = '';
  el('canvcdc5-stats-lock').hidden = pro;
  el('canvcdc5-stats-empty').hidden = true;
  if (!pro) return;
  const log = (await localGet('statsLog')) ?? [];
  el('canvcdc5-stats-empty').hidden = log.length > 0;
  for (const entry of log.slice(-50).reverse()) {
    const li = document.createElement('li');
    li.textContent = `${entry.day} · ${entry.hostname} · ${entry.count}`;
    list.appendChild(li);
  }
}

function wirePrivacy(): void {
  el<HTMLButtonElement>('canvcdc5-export').addEventListener('click', () => {
    void (async () => {
      const json = await exportAll();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'canvas-veil-data.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    })();
  });
  el<HTMLButtonElement>('canvcdc5-wipe').addEventListener('click', () => {
    void (async () => {
      if (!self.confirm(msg('optionsWipeConfirm'))) return;
      await wipeAll();
      await renderAll();
    })();
  });
}

/** Live refresh when the popup (or sync) changes truth while options is open. */
function wireStorageRefresh(): void {
  try {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area !== 'local') return;
      void renderSites();
      void renderPinned();
      void renderStats();
    });
  } catch {
    /* static render still correct */
  }
}

async function renderAll(): Promise<void> {
  await renderSites();
  await renderPinned();
  await renderLicense();
  await renderSidebar();
  await renderProGates();
  await renderStats();
}

async function boot(): Promise<void> {
  bootDataI18n();
  renderAutoList();
  wireLicense();
  wireProControls();
  wirePrivacy();
  wireStorageRefresh();
  // Silent re-check of an existing grant gone stale (>24h since last server
  // verification; no-op for never-activated users); re-render if it changed.
  void revalidateIfDue().then((changed) => {
    if (changed) void renderAll();
  });
  await renderAll();
}

void boot().catch(() => {
  /* options failures render inline per section, never crash (brief §6) */
});
