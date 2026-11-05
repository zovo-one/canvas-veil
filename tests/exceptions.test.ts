/**
 * tests/exceptions.test.ts — automatic exception list matcher (SPEC §1).
 * Positive hosts must match (apex + subdomains), negatives must never
 * over-match (apex vs subdomain entries, evil-suffix lookalikes).
 */
import { describe, expect, it } from 'vitest';
import { AUTO_EXCEPTIONS, isExcepted } from '../src/shared/exceptions.js';

describe('AUTO_EXCEPTIONS', () => {
  it('contains the spec-mandated captcha and payment anchors', () => {
    for (const host of [
      'hcaptcha.com',
      'challenges.cloudflare.com',
      'www.google.com',
      'recaptcha.net',
      'gstatic.com',
      'js.stripe.com',
      'paypal.com',
      'pay.google.com',
    ]) {
      expect(AUTO_EXCEPTIONS).toContain(host);
    }
  });

  it('never contains an invalid TLD wildcard shape', () => {
    for (const entry of AUTO_EXCEPTIONS) {
      expect(entry).not.toContain('*');
      expect(entry).toMatch(/^[a-z0-9.-]+$/);
    }
  });
});

describe('isExcepted — positives', () => {
  it.each([
    ['hcaptcha.com', true],
    ['newassets.hcaptcha.com', true],
    ['challenges.cloudflare.com', true],
    ['www.google.com', true],
    ['www.recaptcha.net', true],
    ['www.gstatic.com', true],
    ['js.stripe.com', true],
    ['m.stripe.network', true],
    ['www.paypal.com', true],
    ['checkout.shopify.com', true],
    ['pay.google.com', true],
  ])('isExcepted(%s) === %s', (host, expected) => {
    expect(isExcepted(host)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(isExcepted('WWW.GOOGLE.COM')).toBe(true);
    expect(isExcepted('JS.Stripe.COM')).toBe(true);
  });
});

describe('isExcepted — negatives (must never match)', () => {
  it.each([
    'stripe.com', // apex not excepted — only js./m. subdomains are
    'api.stripe.com',
    'hcaptcha.com.evil.com', // lookalike suffix
    'evilhcaptcha.com',
    'google.com', // only www.google.com is excepted
    'notgstatic.com',
    'shopify.com', // only checkout.shopify.com
    'example.com',
    '',
  ])('isExcepted(%s) === false', (host) => {
    expect(isExcepted(host)).toBe(false);
  });

  it('never throws on garbage input', () => {
    expect(isExcepted(undefined as unknown as string)).toBe(false);
    expect(isExcepted(null as unknown as string)).toBe(false);
    expect(isExcepted(42 as unknown as string)).toBe(false);
  });
});
