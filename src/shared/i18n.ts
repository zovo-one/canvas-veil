/**
 * src/shared/i18n.ts — data-i18n resolver for all extension pages
 * (popup/options/onboarding). Fleet rule: NEVER `__MSG_` tokens in HTML
 * (Chrome 150 broke substitution) — HTML carries data-i18n attributes and
 * this module resolves them via chrome.i18n.getMessage.
 *
 * Placeholders: positional $1..$9 ONLY (named `$tabs$`-style placeholders
 * FAIL fleet-wide). Literal '$' in messages.json is written '$$'.
 *
 * Attributes:
 *   data-i18n="key"               → textContent
 *   data-i18n-aria="key"          → aria-label
 *   data-i18n-title="key"         → title
 *   data-i18n-placeholder="key"   → placeholder
 * Substitutions stay in TS (msg('key', value)) — attributes carry no args.
 *
 * Fail-safe: a missing chrome.i18n binding (unit tests, non-ext preview)
 * leaves the HTML's authored English text untouched.
 */

export function msg(key: string, substitutions?: string | string[]): string {
  try {
    const v = chrome.i18n.getMessage(key, substitutions);
    return typeof v === 'string' && v.length > 0 ? v : key;
  } catch {
    return key;
  }
}

function hasI18n(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.i18n?.getMessage;
  } catch {
    return false;
  }
}

export function applyDataI18n(root: ParentNode): void {
  if (!hasI18n()) return;
  const apply = (el: Element, attr: string, write: (text: string) => void) => {
    const key = el.getAttribute(attr);
    if (!key) return;
    const text = msg(key);
    if (text !== key) write(text);
  };
  const visit = (el: Element) => {
    apply(el, 'data-i18n', (t) => {
      el.textContent = t;
    });
    apply(el, 'data-i18n-aria', (t) => el.setAttribute('aria-label', t));
    apply(el, 'data-i18n-title', (t) => el.setAttribute('title', t));
    apply(el, 'data-i18n-placeholder', (t) => el.setAttribute('placeholder', t));
  };
  if (root instanceof Element) visit(root);
  for (const el of root.querySelectorAll(
    '[data-i18n], [data-i18n-aria], [data-i18n-title], [data-i18n-placeholder]',
  )) {
    visit(el);
  }
}

/** Resolve on DOMContentLoaded (or immediately when already parsed). */
export function bootDataI18n(doc: Document = document): void {
  const run = () => applyDataI18n(doc);
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
