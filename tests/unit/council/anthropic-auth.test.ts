/**
 * anthropic-auth.test.ts — pin the auth resolver's two-mode contract.
 *
 * The resolver is the gate between dispatchOpus and the outside world
 * (env, keychain, clock). Three behaviors must NOT silently change:
 *   1. ANTHROPIC_API_KEY in env wins, period — keychain is never consulted
 *      when the env is set. (Lets ops override locally without log-out side
 *      effects.)
 *   2. Keychain JSON shape is parsed strictly — claudeAiOauth.{accessToken,
 *      expiresAt} required. Anything else is keychain-malformed.
 *   3. Single-writer policy: the resolver NEVER refreshes. If the token is
 *      within MIN_LIFETIME_MS (30s) of expiry, return `oauth-expired` and
 *      let the dispatcher's reactive-refresh path handle it.
 */
import { describe, it, expect } from 'vitest';
import { resolveAnthropicAuth } from '../../../src/council/anthropic-auth';

const validBlob = (overrides: Partial<{ accessToken: string; expiresAt: number }> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: overrides.accessToken ?? 'sk-ant-oat01-real',
      refreshToken: 'sk-ant-ort01-fake',
      expiresAt: overrides.expiresAt ?? Date.now() + 3600_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  });

describe('resolveAnthropicAuth', () => {
  it('returns api-key mode when ANTHROPIC_API_KEY is set (keychain not consulted)', () => {
    let keychainCalled = false;
    const result = resolveAnthropicAuth({
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-real' },
      readKeychain: () => {
        keychainCalled = true;
        return validBlob();
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.mode).toBe('api-key');
      expect(result.auth.token).toBe('sk-ant-api03-real');
    }
    expect(keychainCalled).toBe(false);
  });

  it('falls back to OAuth when env is unset and keychain has a fresh token', () => {
    const expiresAt = Date.now() + 3600_000;
    const result = resolveAnthropicAuth({
      env: {},
      readKeychain: () => validBlob({ expiresAt }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.mode).toBe('oauth');
      expect(result.auth.token).toBe('sk-ant-oat01-real');
      if (result.auth.mode === 'oauth') {
        expect(result.auth.expiresAt).toBe(expiresAt);
      }
    }
  });

  it('returns oauth-expired (no silent refresh) when token is within 30s of expiry', () => {
    const now = 1_000_000;
    const result = resolveAnthropicAuth({
      env: {},
      now: () => now,
      readKeychain: () => validBlob({ expiresAt: now + 10_000 }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('oauth-expired');
      expect(result.detail).toMatch(/cortextOS does not refresh/);
      expect(result.detail).toMatch(/claude -p|claude/);
    }
  });

  it('returns keychain-empty when `security` exits non-zero', () => {
    const result = resolveAnthropicAuth({
      env: {},
      readKeychain: () => {
        throw new Error('The specified item could not be found in the keychain.');
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('keychain-empty');
    }
  });

  it('returns keychain-malformed when stored value is not JSON', () => {
    const result = resolveAnthropicAuth({
      env: {},
      readKeychain: () => 'not json at all',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('keychain-malformed');
    }
  });

  it('returns keychain-malformed when claudeAiOauth blob lacks required fields', () => {
    const result = resolveAnthropicAuth({
      env: {},
      readKeychain: () => JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }), // no expiresAt
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('keychain-malformed');
      expect(result.detail).toMatch(/expiresAt|accessToken/);
    }
  });
});
