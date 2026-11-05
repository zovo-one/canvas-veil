/**
 * src/shared/storage.ts — typed wrappers over chrome.storage.local / .session
 * / .sync, owning the schemas (TECHNICAL-BRIEF §4 "Storage schema"). Quota-
 * safe per Phase 7: statsLog trims to cap and retries once; flags and the
 * license record are never trimmed.
 *
 * Every entry point is guarded: a missing chrome.storage binding (unit-test
 * import, dead SW context) resolves to defaults / resolves false — it NEVER
 * throws across this module boundary. Core protection must not depend on
 * storage health.
 */

export interface SiteExceptionEntry {
  addedAt: number;
}

export type Strength = 'low' | 'medium' | 'high';

export interface StatsEntry {
  day: string; // YYYY-MM-DD (local)
  hostname: string;
  count: number;
}

export interface LicenseRecord {
  key: string;
  /** Server-supplied tier, mapped. NEVER derived from the key string. */
  plan: 'monthly' | 'lifetime';
  activatedAt: number;
  /**
   * Last successful SERVER verification (epoch ms). A grant stays readable
   * for OFFLINE_GRACE_MS from this stamp; past grace it reads FREE until a
   * silent revalidation succeeds. 0/absent = never verified → ALWAYS past
   * grace → reads FREE (fail-closed).
   */
  verifiedAt: number;
  /** Server-supplied grant expiry (epoch ms). Absent = none on record. */
  exp?: number;
}

export interface LocalSchema {
  siteExceptions: Record<string, SiteExceptionEntry>;
  pinnedSeeds: Record<string, number[]>; // PRO: hostname → [u32×4]
  settings: {
    strength: Strength;
    /** PRO opt-in: mirror siteExceptions into chrome.storage.sync. */
    syncExceptions: boolean;
  };
  statsLog: StatsEntry[]; // PRO, cap 500 entries / 90 days
  canvcdc5_license?: LicenseRecord;
}

export interface SessionSchema {
  tabCounts: Record<string, number>; // key: String(tabId) — SW writes (brief Phase 1.5)
  /** Once-per-session ask gates (brief Phase 2: "by design — never gut it").
   *  Keys: 'popupPin' (peek shown), … Values: true. Session-scoped, so the
   *  gate resets with the browser session. */
  askGate?: Record<string, true>;
}

export interface SyncSchema {
  siteExceptions: Record<string, SiteExceptionEntry>; // PRO mirror, opt-in
}

export const LICENSE_STORAGE_KEY = 'canvcdc5_license' as const;
export const STATS_LOG_CAP = 500;
export const STATS_LOG_MAX_AGE_DAYS = 90;

export const LOCAL_DEFAULTS: Readonly<Omit<LocalSchema, 'canvcdc5_license'>> = {
  siteExceptions: {},
  pinnedSeeds: {},
  settings: { strength: 'medium', syncExceptions: false },
  statsLog: [],
};

function hasStorage(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local;
  } catch {
    return false;
  }
}

/** local.get with schema defaults merged; corrupt/absent values → defaults. */
export async function localGet<K extends keyof LocalSchema>(
  key: K,
): Promise<LocalSchema[K] | undefined> {
  if (!hasStorage()) return undefined;
  try {
    const fallback =
      key === LICENSE_STORAGE_KEY
        ? undefined
        : LOCAL_DEFAULTS[key as keyof typeof LOCAL_DEFAULTS];
    const raw = await chrome.storage.local.get({ [key]: fallback });
    return (raw as Record<string, unknown>)[key] as LocalSchema[K] | undefined;
  } catch {
    return undefined;
  }
}

export async function localSet<K extends keyof LocalSchema>(
  key: K,
  value: LocalSchema[K],
): Promise<boolean> {
  if (!hasStorage()) return false;
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

export async function localRemove(key: keyof LocalSchema): Promise<boolean> {
  if (!hasStorage()) return false;
  try {
    await chrome.storage.local.remove(key as string);
    return true;
  } catch {
    return false;
  }
}

export async function sessionGet<K extends keyof SessionSchema>(
  key: K,
): Promise<SessionSchema[K] | undefined> {
  if (!hasStorage()) return undefined;
  try {
    const raw = await chrome.storage.session.get(key as string);
    return (raw as Record<string, unknown>)[key] as SessionSchema[K] | undefined;
  } catch {
    return undefined;
  }
}

export async function sessionSet<K extends keyof SessionSchema>(
  key: K,
  value: SessionSchema[K],
): Promise<boolean> {
  if (!hasStorage()) return false;
  try {
    await chrome.storage.session.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

export async function syncGet<K extends keyof SyncSchema>(
  key: K,
): Promise<SyncSchema[K] | undefined> {
  if (!hasStorage()) return undefined;
  try {
    const raw = await chrome.storage.sync.get(key as string);
    return (raw as Record<string, unknown>)[key] as SyncSchema[K] | undefined;
  } catch {
    return undefined;
  }
}

export async function syncSet<K extends keyof SyncSchema>(
  key: K,
  value: SyncSchema[K],
): Promise<boolean> {
  if (!hasStorage()) return false;
  try {
    await chrome.storage.sync.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

/** Trim a statsLog to the Phase-7 policy: newest-first cap + age window. */
export function trimStatsLog(log: StatsEntry[], now: number = Date.now()): StatsEntry[] {
  const maxAgeMs = STATS_LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const fresh = log.filter((e) => {
    const t = Date.parse(e.day);
    return Number.isFinite(t) && now - t <= maxAgeMs;
  });
  return fresh.slice(-STATS_LOG_CAP);
}

/**
 * Append one stats entry with quota resilience (Phase 7): on a QUOTA-style
 * set failure, trim oldest and retry exactly once. Flags/license untouched.
 */
export async function statsLogAppend(entry: StatsEntry): Promise<boolean> {
  const current = (await localGet('statsLog')) ?? [];
  const next = trimStatsLog([...current, entry]);
  if (await localSet('statsLog', next)) return true;
  const trimmed = trimStatsLog(next).slice(-Math.floor(STATS_LOG_CAP / 2));
  return localSet('statsLog', trimmed);
}

/**
 * Aggregating stats writer (the only statsLog writer in the extension —
 * called by the isolated top frame on counter flush). Same (day, hostname)
 * folds into one row by summing counts, so the log stays compact and the
 * options list reads as one row per site per day. Read-modify-write races
 * across tabs can drop an increment — stats are informational, never
 * load-bearing, so this is accepted (Phase 7 posture).
 */
export async function statsLogAdd(
  hostname: string,
  count: number,
  now: number = Date.now(),
): Promise<boolean> {
  if (count <= 0) return true;
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const current = (await localGet('statsLog')) ?? [];
  const existing = current.find((e) => e.day === day && e.hostname === hostname);
  const next = existing
    ? current.map((e) =>
        e === existing ? { day, hostname, count: e.count + count } : e,
      )
    : [...current, { day, hostname, count }];
  const trimmed = trimStatsLog(next, now);
  if (await localSet('statsLog', trimmed)) return true;
  const halved = trimStatsLog(trimmed, now).slice(-Math.floor(STATS_LOG_CAP / 2));
  return localSet('statsLog', halved);
}

/** Whole-store snapshot for the Privacy & Data export (options). */
export async function exportAll(): Promise<string> {
  if (!hasStorage()) return '{}';
  try {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all, null, 2);
  } catch {
    return '{}';
  }
}

/** Full local wipe (Privacy & Data). Protection flags go too — user asked. */
export async function wipeAll(): Promise<boolean> {
  if (!hasStorage()) return false;
  try {
    await chrome.storage.local.clear();
    return true;
  } catch {
    return false;
  }
}
