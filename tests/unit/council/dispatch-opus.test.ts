/**
 * dispatch-opus.test.ts — pin the Anthropic Messages API contract.
 *
 * The dispatcher is a thin fetch wrapper, but it owns several behaviors that
 * silently breaking would break the council:
 *   1. Auth resolution failure (no API key + no keychain) returns a
 *      structured failure (exitCode:1) instead of throwing, so the router
 *      records it as a member-level error rather than crashing the council.
 *   2. The request shape (URL, headers, model, messages) matches the
 *      Anthropic Messages API contract.
 *   3. The response decoder concatenates `content[].text` blocks into stdout.
 *   4. OAuth mode sends Bearer + beta header + Claude Code system prompt;
 *      no x-api-key leak.
 *   5. Reactive refresh: when the resolver returns oauth-expired, OR the API
 *      returns 401 in oauth mode, the dispatcher spawns `claude -p ping` once
 *      and retries. The retry guard ensures we never refresh twice for one
 *      dispatch call (no infinite loops). cortextOS still doesn't refresh
 *      tokens itself — Claude Code is the sole writer; we just trigger it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatchOpus, _resetInflightRefresh, type CouncilMember } from '../../../src/council/dispatch';
import type { AuthResult } from '../../../src/council/anthropic-auth';

const opusMember: CouncilMember = {
  id: 'opus-a',
  provider: 'opus',
};

const framedPlan = 'You are an ADVERSARIAL council reviewer.\n... PLAN ...';

const oauthAuth = (token = 'sk-ant-oat01-fake', expiresAt = Date.now() + 3600_000): AuthResult => ({
  ok: true,
  auth: { mode: 'oauth', token, expiresAt },
});

describe('dispatchOpus', () => {
  let originalKey: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    _resetInflightRefresh();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    fetchSpy.mockRestore();
  });

  it('returns exitCode:1 with explanatory stderr when no auth is configured', async () => {
    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => ({ ok: false, reason: 'keychain-empty', detail: 'no entry' }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ANTHROPIC_API_KEY|keychain/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('oauth-expired: triggers `claude -p` refresh, then retries; if still expired returns exitCode:1', async () => {
    let resolveCalls = 0;
    let refreshCalls = 0;
    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => {
        resolveCalls++;
        return {
          ok: false,
          reason: 'oauth-expired',
          detail: 'Claude Code OAuth access token has -10s of life left.',
        };
      },
      refresh: async () => {
        refreshCalls++;
      },
    });

    // Single-retry guard: refresh runs exactly once even though resolver
    // keeps returning expired. We must not loop.
    expect(refreshCalls).toBe(1);
    expect(resolveCalls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/expired|life left/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('oauth-expired: refresh succeeds and unblocks API call (happy reactive path)', async () => {
    const oauthFresh = oauthAuth('sk-ant-oat01-fresh');
    const oauthStale: AuthResult = {
      ok: false,
      reason: 'oauth-expired',
      detail: 'expired',
    };
    let resolveCalls = 0;
    let refreshCalls = 0;
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"approve","concerns":[],"must_fix":[]}' }] }),
      { status: 200 },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => {
        resolveCalls++;
        return resolveCalls === 1 ? oauthStale : oauthFresh;
      },
      refresh: async () => {
        refreshCalls++;
      },
    });

    expect(refreshCalls).toBe(1);
    expect(resolveCalls).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-ant-oat01-fresh');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"verdict":"approve","concerns":[],"must_fix":[]}');
  });

  it('oauth-expired: if `claude -p` refresh subprocess fails, surface the spawn error', async () => {
    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => ({
        ok: false,
        reason: 'oauth-expired',
        detail: 'expired',
      }),
      refresh: async () => {
        throw new Error('claude -p ping exited with code 127');
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/refresh failed/i);
    expect(result.stderr).toMatch(/code 127/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a Messages API request with the framed plan as user content and returns text in stdout', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({
        content: [{ type: 'text', text: '{"verdict":"approve","concerns":[],"must_fix":[]}' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([{ role: 'user', content: framedPlan }]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('{"verdict":"approve","concerns":[],"must_fix":[]}');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('honours member.model override (lets advisory councils pick a cheaper Opus variant)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{}' }] }),
      { status: 200 },
    ));

    await dispatchOpus({ ...opusMember, model: 'claude-opus-4-7-preview' }, framedPlan, '/tmp');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-opus-4-7-preview');
  });

  it('concatenates multiple text content blocks into stdout (no separator artifacts)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({
        content: [
          { type: 'text', text: '{"verdict":"approve",' },
          { type: 'text', text: '"concerns":[],"must_fix":[]}' },
        ],
      }),
      { status: 200 },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp');

    expect(result.stdout).toBe('{"verdict":"approve","concerns":[],"must_fix":[]}');
  });

  it('returns exitCode:1 with API error body in stderr on non-2xx response', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    fetchSpy.mockResolvedValue(new Response(
      '{"error":{"type":"invalid_request_error","message":"bad model"}}',
      { status: 400, statusText: 'Bad Request' },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/HTTP 400/);
    expect(result.stderr).toMatch(/bad model/);
  });

  it('forwards AbortSignal to fetch (so router timeout cancels the API call)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{}' }] }),
      { status: 200 },
    ));

    const ac = new AbortController();
    await dispatchOpus(opusMember, framedPlan, '/tmp', ac.signal);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(ac.signal);
  });

  it('ignores non-text content blocks (defends against future tool-use turns)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'should not appear' },
          { type: 'text', text: '{"verdict":"approve","concerns":[],"must_fix":[]}' },
          { type: 'tool_use', id: 'x', name: 'y', input: {} },
        ],
      }),
      { status: 200 },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp');

    expect(result.stdout).toBe('{"verdict":"approve","concerns":[],"must_fix":[]}');
    expect(result.stdout).not.toMatch(/should not appear/);
  });

  it('OAuth mode: Bearer auth + beta header + Claude Code system prompt; no x-api-key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({
        content: [{ type: 'text', text: '{"verdict":"approve","concerns":[],"must_fix":[]}' }],
      }),
      { status: 200 },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => oauthAuth('sk-ant-oat01-fake'),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-ant-oat01-fake');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.system).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.messages).toEqual([{ role: 'user', content: framedPlan }]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"verdict":"approve","concerns":[],"must_fix":[]}');
  });

  it('OAuth mode 401: triggers refresh, retries once; if still 401 returns exitCode:1 with re-auth hint', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let refreshCalls = 0;
    fetchSpy.mockResolvedValue(new Response(
      '{"error":{"type":"authentication_error","message":"invalid bearer token"}}',
      { status: 401, statusText: 'Unauthorized' },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => oauthAuth('sk-ant-oat01-fake'),
      refresh: async () => {
        refreshCalls++;
      },
    });

    // Single-retry guard: 401 → refresh → still 401 → give up. No loop.
    expect(refreshCalls).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/HTTP 401/);
    expect(result.stderr).toMatch(/claude/);
    expect(result.stderr).toMatch(/refresh/i);
  });

  it('OAuth mode 401: refresh recovers — second fetch with fresh token succeeds', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let resolveCalls = 0;
    let refreshCalls = 0;
    fetchSpy
      .mockResolvedValueOnce(new Response(
        '{"error":{"type":"authentication_error","message":"invalid bearer token"}}',
        { status: 401, statusText: 'Unauthorized' },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"approve","concerns":[],"must_fix":[]}' }] }),
        { status: 200 },
      ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => {
        resolveCalls++;
        return resolveCalls === 1
          ? oauthAuth('sk-ant-oat01-stale')
          : oauthAuth('sk-ant-oat01-fresh');
      },
      refresh: async () => {
        refreshCalls++;
      },
    });

    expect(refreshCalls).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (fetchSpy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders['authorization']).toBe('Bearer sk-ant-oat01-stale');
    expect(secondHeaders['authorization']).toBe('Bearer sk-ant-oat01-fresh');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"verdict":"approve","concerns":[],"must_fix":[]}');
  });

  it('api-key mode: 401 does NOT trigger refresh (refresh is oauth-only)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    let refreshCalls = 0;
    fetchSpy.mockResolvedValue(new Response(
      '{"error":{"type":"authentication_error","message":"invalid api key"}}',
      { status: 401, statusText: 'Unauthorized' },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      refresh: async () => {
        refreshCalls++;
      },
    });

    expect(refreshCalls).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/HTTP 401/);
  });

  it('keychain-empty: does NOT trigger refresh (only oauth-expired is recoverable)', async () => {
    let refreshCalls = 0;
    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => ({ ok: false, reason: 'keychain-empty', detail: 'no entry' }),
      refresh: async () => {
        refreshCalls++;
      },
    });

    expect(refreshCalls).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('process-wide dedup: concurrent oauth-expired callers share one refresh', async () => {
    // Council fires N members in parallel. If the token is expired, all N
    // dispatchOpus calls observe oauth-expired simultaneously. Without
    // process-wide deduplication, all N would spawn `claude -p ping`
    // concurrently — the OAuth provider rotates refresh_token on every
    // refresh, so two simultaneous refreshes invalidate each other (the
    // single-writer race the design must prevent). The module-level inflight
    // promise must collapse N concurrent refreshes into one.
    delete process.env.ANTHROPIC_API_KEY;

    let resolveCalls = 0;
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((res) => {
      releaseRefresh = res;
    });

    // Factory, not shared instance — Response body can only be read once.
    fetchSpy.mockImplementation(async () => new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"approve","concerns":[],"must_fix":[]}' }] }),
      { status: 200 },
    ));

    const opts = {
      resolveAuth: () => {
        // First call from each of the two dispatchOpus invocations sees
        // expired; their post-refresh re-resolve sees fresh.
        resolveCalls++;
        return resolveCalls <= 2
          ? ({ ok: false, reason: 'oauth-expired', detail: 'expired' } as AuthResult)
          : oauthAuth('sk-ant-oat01-fresh');
      },
      refresh: async () => {
        refreshCalls++;
        // Block until the test releases — guarantees both dispatchOpus calls
        // hit the inflight slot simultaneously, proving dedup (not just
        // sequential ordering).
        await refreshGate;
      },
    } as const;

    const a = dispatchOpus(opusMember, framedPlan, '/tmp', undefined, opts);
    const b = dispatchOpus(opusMember, framedPlan, '/tmp', undefined, opts);

    // Yield so both reach the refresh-await point before we release the gate.
    await new Promise((r) => setImmediate(r));
    releaseRefresh();

    const [resA, resB] = await Promise.all([a, b]);

    // The whole point: one refresh for two concurrent oauth-expired observers.
    expect(refreshCalls).toBe(1);
    expect(resA.exitCode).toBe(0);
    expect(resB.exitCode).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('api-key mode: does NOT send the Claude Code system prompt or beta header', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{}' }] }),
      { status: 200 },
    ));

    await dispatchOpus(opusMember, framedPlan, '/tmp');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.system).toBeUndefined();
  });
});
