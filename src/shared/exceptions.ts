/**
 * src/shared/exceptions.ts — the compile-time automatic exception list
 * (SPEC §1, TECHNICAL-BRIEF §1). Captcha + payment hosts are NEVER hooked.
 *
 * ONE exported constant, by design: GATE 2 (captcha protocol) may extend the
 * list without any redesign — append entries here and every consumer
 * (MAIN world pre-hook check, isolated PageQuery, options read-only render)
 * picks it up.
 *
 * Normalization locked by the Architect: SPEC's `*.host.com` shapes fold to
 * bare `host.com`; matching is `host === entry || host.endsWith('.' + entry)`
 * — so an entry covers the apex AND every subdomain. TLD wildcards like
 * `*.stripe.*` are INVALID by rule and never appear here (enumerate hosts).
 *
 * Resolved ambiguities (TECHNICAL-BRIEF §1): `www.google.com` is a whole-host
 * exception (matcher is hostname-only; recaptcha paths cannot be expressed).
 * Negatives that must NEVER match (pinned by tests): `stripe.com` apex vs
 * `js.stripe.com`/`m.stripe.com` entries; `hcaptcha.com.evil.com`.
 */
export const AUTO_EXCEPTIONS: readonly string[] = [
  // ---- captcha (SPEC §1) ----
  'hcaptcha.com',
  'challenges.cloudflare.com',
  'www.google.com',
  'recaptcha.net',
  'gstatic.com',
  'arkoselabs.com',
  'funcaptcha.com',
  // ---- payment (SPEC §1) ----
  'js.stripe.com',
  'm.stripe.com',
  'm.stripe.network',
  'paypal.com',
  'paypalobjects.com',
  'braintreegateway.com',
  'adyen.com',
  'square.site',
  'squareup.com',
  'pay.google.com',
  'checkout.shopify.com',
];

/**
 * Hostname matcher. Case-insensitive; exact host or dot-boundary suffix.
 * Never throws: garbage input reads as NOT excepted (fail toward protection).
 */
export function isExcepted(hostname: string): boolean {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  const host = hostname.toLowerCase();
  for (const entry of AUTO_EXCEPTIONS) {
    if (host === entry) return true;
    if (host.endsWith('.' + entry)) return true;
  }
  return false;
}
