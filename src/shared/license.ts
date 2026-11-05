/**
 * src/shared/license.ts — SERVER-verified license for canvas-veil.
 *
 * Grant semantics (HARD invariants — fleet licensing standard 2026-08-21):
 *   - The ONLY path to Pro is a schema-validated `{valid:true}` response from
 *     the license server. There is NO client-side authenticity check, because
 *     a secret shipped inside a publicly downloadable extension is not a
 *     secret. Every offline/error path fails CLOSED to FREE.
 *   - The tier (monthly vs lifetime) comes from the SERVER's `tier` field and
 *     from nowhere else. It is never derived from the key string.
 *   - NO backdoor keys, NO demo keys, NO hardcoded valid keys.
 *
 * Two retired schemes preceded this, both of which rejected 100% of real
 * customers because their grammar was disjoint from what checkout mints:
 *   1. `CANV-XXXX-XXXX-XXXX-XXXXXXXX` + an FNV-1a checksum over a salt that
 *      shipped in the bundle — so it stopped customers, never copiers, and it
 *      encoded the PLAN in the payload's first character, letting a forger
 *      pick their own tier.
 *   2. `ZOVO-CANV-1.<payload>.<signature>`, an ECDSA P-256 scheme that fixed
 *      the forgeability but kept a shape no customer has ever held, and still
 *      read the plan out of the (signed) payload.
 * Both are gone. Authenticity and tier are the server's job alone.
 *
 * NETWORK POSTURE (this product is sold on privacy — read this):
 * the ONE endpoint in this file is called from exactly two places:
 *   1. activate() — only ever called by the options page's Activate button
 *      (an explicit user gesture), and
 *   2. revalidateIfDue() — a silent re-check of an ALREADY-granted key, only
 *      after the 7-day offline grace has lapsed and only while online.
 * Nothing here runs on install, on a timer, or from a content script on the
 * protection path: isPro() and getLicense() are pure storage reads. A user
 * who never types a key never makes a request. Store/onboarding copy must
 * say "no network except license verification" — never "zero network".
 */
import {
  localGet,
  localRemove,
  localSet,
  LICENSE_STORAGE_KEY,
  type LicenseRecord,
} from './storage.js';

/**
 * Key shape: `ZOVO-` + four 4-char alphanumeric groups (24 chars total).
 *
 * This is the shape the checkout actually mints and the shape the live
 * `verify-extension-license` function accepts — verified against every key on
 * record: 66/66 live customer keys match.
 *
 * The character class is deliberately the permissive `[A-Z0-9]` rather than a
 * specific alphabet. Two generators are in use — production keys contain L, O
 * and U while the vault pool contains 0 and 1 — so any narrower class silently
 * rejects real paying customers. A Crockford class was measured to reject 43
 * of the 66 live keys. The client checks SHAPE only.
 *
 * Tested against the NORMALIZED uppercase form only, never raw input. The
 * regex stays a literal so static scanners can grep the shape.
 */
export const PRO_KEY_PATTERN = /^ZOVO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export const KEY_PREFIX = 'ZOVO-' as const;
/** Extension slug sent to the server. Matches the conversion-sidebar SLUG. */
export const EXTENSION_KEY = 'canvas-veil' as const;

/** SINGLE string literal (extqa L3 rule) — never template-interpolated. */
export const LICENSE_VERIFY_URL =
  'https://zgubxqomnbmxgbdhvwja.supabase.co/functions/v1/verify-extension-license';

/**
 * Supabase publishable key. Public by design — it authorizes nothing beyond
 * calling this one edge function, and it is a LITERAL here rather than an
 * esbuild `define`: a missing define silently ships an empty string, which
 * kills the paid tier with no error (fleet incident, zovo-license build key).
 */
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_RG4IVO9Qm23_xPzdQjdFPQ_QHBwbOLv';

export const LICENSE_VERIFY_TIMEOUT_MS = 8_000;

/**
 * Canonical zovo-license.js timing (fleet SDK, 18 extensions ship it):
 * a stored grant is re-verified silently at most once per day, and kept
 * readable for up to 7 days from the last SUCCESSFUL verification so a
 * member keeps Pro on a plane. This project's architecture splits the SDK's
 * self-revalidating status() into pure storage reads (getLicense/isPro —
 * content scripts must never fetch) plus the explicit revalidateIfDue().
 */
export const REVALIDATE_MS = 24 * 60 * 60 * 1000;

/**
 * Offline grace: a server-verified grant stays readable for 7 days from the
 * last successful verification (verifiedAt). Past grace the grant reads as
 * FREE until a silent revalidation (revalidateIfDue) succeeds. A record with
 * verifiedAt = 0 — never verified — is ALWAYS past grace and reads FREE
 * immediately: there is no offline path to Pro (fail-closed).
 */
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Generous on purpose: clipping a pasted key to its exact length is the
 *  documented SelectCalc failure. Never set an input maxlength at key length. */
export const KEY_MAX_LENGTH = 64 as const;

/** Typed refusal returned instead of throwing across a module boundary. */
export interface LicenseError {
  error:
    | 'invalid-key' //     failed the shape gate — never reached the network
    | 'declined' //        the server said no
    | 'unreachable' //     offline, timeout, non-2xx, or unreadable verdict
    | 'storage-failure';
}
export type ActivateResult = { record: LicenseRecord } | LicenseError;

/** trim + uppercase + bound. Returns the NORMALIZED key; callers test
 *  PRO_KEY_PATTERN against this form, never against raw input. */
export function normalize(input: unknown): string {
  if (typeof input !== 'string' || input.length > KEY_MAX_LENGTH) return '';
  return input.trim().toUpperCase();
}

/** Shape gate. Cheap, offline, and NEVER a grant — the server decides. */
export function validateFormat(input: unknown): boolean {
  return PRO_KEY_PATTERN.test(normalize(input));
}

/** Minimal shape accepted back from the verify endpoint (schema guard — a
 *  malformed or hostile body can never read as a grant). */
interface VerifyResponse {
  valid: boolean;
  tier?: unknown;
  exp?: unknown;
}

function isVerifyResponse(v: unknown): v is VerifyResponse {
  if (typeof v !== 'object' || v === null) return false;
  return typeof (v as Record<string, unknown>)['valid'] === 'boolean';
}

/**
 * Map the server's tier onto this product's two plans. The server returns
 * `"pro"` for a monthly subscription and `"lifetime"` for a one-time purchase;
 * 22 of 66 customers are lifetime, so anything but an explicit "lifetime"
 * degrades to monthly rather than guessing. NEVER reads the key string.
 */
export function planFromTier(tier: unknown): 'monthly' | 'lifetime' {
  return typeof tier === 'string' && tier.trim().toLowerCase() === 'lifetime'
    ? 'lifetime'
    : 'monthly';
}

export interface CheckResult {
  valid: boolean;
  plan: 'monthly' | 'lifetime';
  /** Server-supplied grant expiry (epoch ms); 0 = none on record. */
  exp: number;
  error?: LicenseError['error'];
}

const FREE: CheckResult = { valid: false, plan: 'monthly', exp: 0 };

/**
 * The one network call in this extension. Server-first, fail-closed: any
 * non-2xx, non-JSON, schema-invalid, timed-out or offline outcome returns
 * FREE. Never throws, never self-grants.
 *
 * GRANT RULE: Pro on `valid === true` alone. Requiring `tier === 'pro'` locked
 * every lifetime customer out in three sibling packages — the tier selects
 * which plan is stored, it never gates the grant.
 */
export async function verifyWithServer(input: unknown): Promise<CheckResult> {
  const key = normalize(input);
  if (!PRO_KEY_PATTERN.test(key)) return { ...FREE, error: 'invalid-key' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LICENSE_VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(LICENSE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
        authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
      // Canonical snake_case body (frozen zovo-license.js contract).
      body: JSON.stringify({ license_key: key, extension: EXTENSION_KEY }),
      signal: controller.signal,
    });
    // Parse the verdict on ANY status — a genuine refusal is a 404 WITH a
    // JSON {"valid":false} body (live-probed 2026-09-05), not a bare status.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null; // unreadable verdict → unreachable below
    }
    // The grant comes from the parsed body, never from the status line alone;
    // a non-2xx never grants even if a body claims valid (5xx spoof guard).
    if (res.ok && isVerifyResponse(body) && body.valid === true) {
      const exp = typeof body.exp === 'number' && Number.isFinite(body.exp) ? body.exp : 0;
      return { valid: true, plan: planFromTier(body.tier), exp };
    }
    // No grant. Classify for the UI and the grace clock: a 404 or an explicit
    // valid:false is a clean REFUSAL ('declined' → "invalid key" copy, never
    // an error state). Only throws, timeouts, 5xx and unreadable bodies are
    // 'unreachable' — solely those leave the offline grace window running.
    const refused = res.status === 404 || (isVerifyResponse(body) && body.valid === false);
    return { ...FREE, error: refused ? 'declined' : 'unreachable' };
  } catch {
    // Offline, aborted, DNS failure, CORS refusal — all fail closed.
    return { ...FREE, error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current stored record, or null when absent/corrupt/expired/past-grace
 * (reads as FREE). Pure storage read: sync-shaped, zero network — every Pro
 * gate in the popup, options page and content script lands here, and none of
 * them may touch the wire. A record written by a retired scheme fails the
 * shape test and reads as FREE, which is correct: no genuine customer key
 * ever matched those shapes. A record whose verifiedAt is missing (0) is
 * past grace by construction and reads FREE — never-verified keys grant
 * nothing offline.
 */
export async function getLicense(now: number = Date.now()): Promise<LicenseRecord | null> {
  const raw = await localGet(LICENSE_STORAGE_KEY);
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<LicenseRecord>;
  if (typeof r.key !== 'string' || !PRO_KEY_PATTERN.test(r.key)) return null;
  if (r.plan !== 'monthly' && r.plan !== 'lifetime') return null;
  if (typeof r.activatedAt !== 'number' || !Number.isFinite(r.activatedAt)) return null;
  const verifiedAt =
    typeof r.verifiedAt === 'number' && Number.isFinite(r.verifiedAt) ? r.verifiedAt : 0;
  // 7-day offline grace from the last server verification. verifiedAt = 0
  // (never verified) is always past grace → FREE (fail-closed, spec-critical).
  if (now - verifiedAt > OFFLINE_GRACE_MS) return null;
  // Honor a server-supplied expiry; absent/0 means none on record.
  if (typeof r.exp === 'number' && Number.isFinite(r.exp) && r.exp > 0 && r.exp < now) {
    return null;
  }
  const record: LicenseRecord = {
    key: r.key,
    plan: r.plan,
    activatedAt: r.activatedAt,
    verifiedAt,
  };
  if (typeof r.exp === 'number' && Number.isFinite(r.exp) && r.exp > 0) record.exp = r.exp;
  return record;
}

/** True iff a server-verified license record is stored. Never throws. */
export async function isPro(): Promise<boolean> {
  return (await getLicense()) !== null;
}

/**
 * Verify with the server, then persist. The ONLY NEW Pro grant path in the
 * extension, wired exclusively to the options page's Activate button (an
 * explicit user gesture), whose aria-label must start "Activate" (extqa L3
 * rule — enforced in options.html). The only other network caller is
 * revalidateIfDue(), which can refresh or revoke an EXISTING grant but never
 * creates one.
 */
export async function activate(input: unknown): Promise<ActivateResult> {
  const key = normalize(input);
  const result = await verifyWithServer(key);
  if (!result.valid) return { error: result.error ?? 'declined' };
  const now = Date.now();
  const record: LicenseRecord = { key, plan: result.plan, activatedAt: now, verifiedAt: now };
  if (result.exp > 0) record.exp = result.exp;
  const ok = await localSet(LICENSE_STORAGE_KEY, record);
  return ok ? { record } : { error: 'storage-failure' };
}

/**
 * Silent revalidation — the ONLY network caller besides activate(), and the
 * second half of the network contract. Canonical zovo-license.js semantics:
 * fires ONLY when a stored, shape-valid record is STALE (verifiedAt older
 * than REVALIDATE_MS = 24h). No stored record (the user never verified a
 * key) → no call, stays FREE (fail-closed). Fresh record → no call.
 *
 * On a fresh `{valid:true}` the record's verifiedAt/plan/exp are refreshed
 * and Pro continues uninterrupted. On an explicit server decline the record
 * is removed (the grant is revoked, not merely stale — the SDK persists an
 * invalid record instead; removal is observably identical for gating and
 * stops repeat calls). On offline/unreachable the record is left untouched:
 * getLicense keeps it readable until the 7-day grace lapses, so a member
 * keeps Pro on a plane — the SDK's 'grace' source, split across the read.
 *
 * Wired fire-and-forget from the service worker start and the popup/options
 * boots — all silent, none on the content-script protection path.
 *
 * @returns true iff the stored grant state changed (callers may re-render).
 */
export async function revalidateIfDue(now: number = Date.now()): Promise<boolean> {
  const raw = await localGet(LICENSE_STORAGE_KEY);
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Partial<LicenseRecord>;
  if (typeof r.key !== 'string' || !PRO_KEY_PATTERN.test(r.key)) return false;
  if (r.plan !== 'monthly' && r.plan !== 'lifetime') return false;
  if (typeof r.activatedAt !== 'number' || !Number.isFinite(r.activatedAt)) return false;
  const verifiedAt =
    typeof r.verifiedAt === 'number' && Number.isFinite(r.verifiedAt) ? r.verifiedAt : 0;
  if (now - verifiedAt < REVALIDATE_MS) return false; // fresh — verified today
  const result = await verifyWithServer(r.key);
  if (!result.valid) {
    if (result.error === 'declined') {
      // The server KNOWS this key and refuses it — the grant is gone.
      return localRemove(LICENSE_STORAGE_KEY);
    }
    return false; // unreachable: record stays, grace window keeps it readable
  }
  const record: LicenseRecord = {
    key: r.key,
    plan: result.plan,
    activatedAt: r.activatedAt,
    verifiedAt: now,
  };
  if (result.exp > 0) record.exp = result.exp;
  return localSet(LICENSE_STORAGE_KEY, record);
}

/** Remove the license (revert to FREE). Core protection is unaffected. */
export async function deactivate(): Promise<boolean> {
  return localRemove(LICENSE_STORAGE_KEY);
}
