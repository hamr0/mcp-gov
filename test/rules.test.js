/**
 * Tests for the shared rules normalizer (src/rules.js).
 * Verifies all three legacy rule shapes normalize to one canonical form and
 * that isAllowed applies explicit rules and defaultPolicy correctly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeRules, isAllowed } from '../src/rules.js';

describe('normalizeRules - format detection', () => {
  it('normalizes array format (mcp-gov-wrap output)', () => {
    const n = normalizeRules({
      defaultPolicy: 'deny',
      rules: [
        { service: 'github', operations: ['read', 'write'], permission: 'allow' },
        { service: 'github', operations: ['delete'], permission: 'deny' }
      ]
    });
    assert.strictEqual(n.defaultPolicy, 'deny');
    assert.deepStrictEqual(n.services.github, { read: 'allow', write: 'allow', delete: 'deny' });
  });

  it('normalizes legacy object format ({ services: { svc: { operations } } })', () => {
    const n = normalizeRules({
      services: { github: { operations: { delete: 'deny', read: 'allow' } } }
    });
    assert.strictEqual(n.defaultPolicy, 'allow');
    assert.deepStrictEqual(n.services.github, { delete: 'deny', read: 'allow' });
  });

  it('normalizes SDK nested-map format ({ svc: { op: perm } })', () => {
    const n = normalizeRules({
      github: { read: 'allow', delete: 'deny', execute: 'allow' }
    });
    assert.deepStrictEqual(n.services.github, { read: 'allow', delete: 'deny', execute: 'allow' });
  });

  it('treats top-level metadata keys as reserved, not services (nested-map)', () => {
    const n = normalizeRules({
      _comment: 'note',
      defaultPolicy: 'deny',
      github: { read: 'allow' }
    });
    assert.strictEqual(n.defaultPolicy, 'deny');
    assert.deepStrictEqual(Object.keys(n.services), ['github']);
  });

  it('does NOT misdetect a nested-map service named "services" as legacy', () => {
    // { services: { read: 'deny' } } is a nested-map with a service named
    // "services" — it must NOT be treated as the legacy wrapper and dropped.
    const n = normalizeRules({ services: { read: 'deny' } });
    assert.deepStrictEqual(n.services, { services: { read: 'deny' } });
    assert.strictEqual(isAllowed(n, 'services', 'read'), false);
  });

  it('does NOT drop a nested-map service named "rules"', () => {
    // { rules: { read: 'deny' } } — "rules" is an object here, not an array,
    // so it is a service name, not the array format.
    const n = normalizeRules({ rules: { read: 'deny' } });
    assert.deepStrictEqual(n.services, { rules: { read: 'deny' } });
    assert.strictEqual(isAllowed(n, 'rules', 'read'), false);
  });

  it('still detects legacy when services entries wrap operations', () => {
    const n = normalizeRules({ services: { db: { operations: { delete: 'deny' } } } });
    assert.deepStrictEqual(n.services, { db: { delete: 'deny' } });
  });

  it('last rule wins for duplicate service+operation in array format', () => {
    const n = normalizeRules({ rules: [
      { service: 'github', operations: ['delete'], permission: 'allow' },
      { service: 'github', operations: ['delete'], permission: 'deny' }
    ]});
    assert.strictEqual(isAllowed(n, 'github', 'delete'), false);
  });
});

describe('normalizeRules - defaultPolicy handling', () => {
  it('defaults to allow when unspecified', () => {
    assert.strictEqual(normalizeRules({ rules: [] }).defaultPolicy, 'allow');
  });

  it('rules defaultPolicy takes precedence over fallback', () => {
    assert.strictEqual(normalizeRules({ defaultPolicy: 'allow', rules: [] }, 'deny').defaultPolicy, 'allow');
  });

  it('uses caller fallback when rules omit defaultPolicy', () => {
    assert.strictEqual(normalizeRules({ rules: [] }, 'deny').defaultPolicy, 'deny');
  });

  it('handles null/garbage input safely', () => {
    assert.deepStrictEqual(normalizeRules(null), { defaultPolicy: 'allow', services: {} });
    assert.strictEqual(normalizeRules(undefined, 'deny').defaultPolicy, 'deny');
  });

  it('ignores malformed rule entries without throwing', () => {
    const n = normalizeRules({ rules: [null, { service: 'x' }, { operations: ['read'] }, { service: 'y', operations: ['read'], permission: 'bogus' }] });
    assert.deepStrictEqual(n.services, {});
  });
});

describe('isAllowed', () => {
  const n = normalizeRules({
    defaultPolicy: 'deny',
    rules: [
      { service: 'github', operations: ['read', 'write'], permission: 'allow' },
      { service: 'github', operations: ['delete'], permission: 'deny' }
    ]
  });

  it('allows explicitly-allowed operations', () => {
    assert.strictEqual(isAllowed(n, 'github', 'read'), true);
    assert.strictEqual(isAllowed(n, 'github', 'write'), true);
  });

  it('denies explicitly-denied operations', () => {
    assert.strictEqual(isAllowed(n, 'github', 'delete'), false);
  });

  it('applies defaultPolicy=deny to unmatched operations', () => {
    assert.strictEqual(isAllowed(n, 'github', 'execute'), false);
    assert.strictEqual(isAllowed(n, 'unknown', 'read'), false);
  });

  it('applies defaultPolicy=allow (default) to unmatched operations', () => {
    const a = normalizeRules({ rules: [{ service: 'github', operations: ['delete'], permission: 'deny' }] });
    assert.strictEqual(isAllowed(a, 'github', 'read'), true);
    assert.strictEqual(isAllowed(a, 'github', 'delete'), false);
    assert.strictEqual(isAllowed(a, 'other', 'write'), true);
  });
});
