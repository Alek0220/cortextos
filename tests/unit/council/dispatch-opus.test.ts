/**
 * dispatch-opus.test.ts — pin the Anthropic Messages API contract.
 *
 * The dispatcher is a thin fetch wrapper, but it owns four behaviors that
 * silently breaking would break the council:
 *   1. Auth resolution failure (no API key + no keychain) returns a
 *      structured failure (exitCode:1) instead of throwing, so the router
 *      records it as a member-level error rather than crashing the council.
 *   2. The request shape (URL, headers, model, messages) matches the
 *      Anthropic Messages API contract. If we silently flip to a stale
 *      version header or the wrong model id, councils still "succeed"
 *      against a mocked fetch but fail in production.
 *   3. The response decoder concatenates `content[].text` blocks into the
 *      `stdout` field so the extractor's no-marker fallback can find the
 *      verdict JSON. Stripping or wrapping that text would defeat the
 *      extractor.
 *   4. OAuth mode (Claude Code Max subscription path) sends the right
 *      headers — `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`,
 *      and the Claude Code system prompt — without leaking `x-api-key`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatchOpus, type CouncilMember } from '../../../src/council/dispatch';
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

  it('returns exitCode:1 when the OAuth token has expired (no silent refresh)', async () => {
    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => ({
        ok: false,
        reason: 'oauth-expired',
        detail: 'Claude Code OAuth access token has -10s of life left.',
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/expired|life left/i);
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

  it('OAuth mode: 401 response includes a re-auth hint pointing at `claude` / cron', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    fetchSpy.mockResolvedValue(new Response(
      '{"error":{"type":"authentication_error","message":"invalid bearer token"}}',
      { status: 401, statusText: 'Unauthorized' },
    ));

    const result = await dispatchOpus(opusMember, framedPlan, '/tmp', undefined, {
      resolveAuth: () => oauthAuth('sk-ant-oat01-fake'),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/HTTP 401/);
    expect(result.stderr).toMatch(/claude/);
    expect(result.stderr).toMatch(/cron|refresh/i);
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
