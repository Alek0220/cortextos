/**
 * council-mixed-providers.test.ts — full router→dispatch→parse→merge pipeline
 * with one codex member AND one opus member, in-process, CI-safe.
 *
 * What this proves that the unit tests don't:
 *   1. defaultDispatcher routes by `member.provider` — codex goes to spawn,
 *      opus goes to fetch — and both happen concurrently in the same call.
 *   2. The Opus response (raw JSON in `content[0].text`) is parsed by the
 *      same extractor as codex's marker-framed output. The parser's
 *      no-marker fallback is what makes that work — if it ever regresses,
 *      this test fails.
 *   3. The merger composes verdicts across providers correctly: stickiness
 *      of `block`, must_fix union, and the labelMapping survives mixing.
 *
 * CI-safe strategy:
 *   - ANTHROPIC_API_KEY is set to a fake value so resolveAnthropicAuth
 *     short-circuits to api-key mode (keychain never consulted, no OAuth
 *     refresh path triggered).
 *   - globalThis.fetch is spied to return a canned Anthropic Messages
 *     response — NO network, no tokens spent.
 *   - A fake `codex` Node script is dropped on PATH for dispatchCodex's
 *     real spawn(). Same shim shape as council-smoke.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCouncil } from '../../src/council/router.js';
import { defaultDispatcher } from '../../src/council/dispatch.js';
import type { BusPaths } from '../../src/types/index.js';

let pathRoot: string;
let fakePathDir: string;
let originalPath: string | undefined;
let originalApiKey: string | undefined;

beforeAll(() => {
  pathRoot = mkdtempSync(join(tmpdir(), 'ctx-mixed-path-'));
  fakePathDir = join(pathRoot, 'bin');
  mkdirSync(fakePathDir, { recursive: true });

  // Fake codex: emits a codex-style stdout (assistant marker + JSON verdict).
  // Verdict and must_fix are read from env so each test can configure.
  const fakeCodex = [
    '#!/usr/bin/env node',
    'const verdict = process.env.CTX_FAKE_CODEX_VERDICT || "approve";',
    'const mustFix = process.env.CTX_FAKE_CODEX_MUSTFIX ? JSON.parse(process.env.CTX_FAKE_CODEX_MUSTFIX) : [];',
    'const payload = JSON.stringify({ verdict, concerns: [], must_fix: mustFix });',
    'process.stdout.write(`--------\\nworkdir: /tmp\\n--------\\nuser\\nReview\\ncodex\\n${payload}\\ntokens used\\n42\\n`);',
    'process.exit(0);',
  ].join('\n');
  const fakePath = join(fakePathDir, 'codex');
  writeFileSync(fakePath, fakeCodex, 'utf-8');
  chmodSync(fakePath, 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${fakePathDir}:${originalPath ?? ''}`;
  // Force api-key mode so the resolver never touches the macOS keychain.
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-mixed-test-key';
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  try { rmSync(pathRoot, { recursive: true, force: true }); } catch { /* noop */ }
});

let runRoot: string;
let paths: BusPaths;

beforeEach(() => {
  runRoot = mkdtempSync(join(tmpdir(), 'ctx-mixed-run-'));
  paths = {
    ctxRoot: runRoot,
    inbox: join(runRoot, 'inbox'),
    inflight: join(runRoot, 'inflight'),
    processed: join(runRoot, 'processed'),
    logDir: join(runRoot, 'logs'),
    stateDir: join(runRoot, 'state'),
    taskDir: join(runRoot, 'tasks'),
    approvalDir: join(runRoot, 'approvals'),
    analyticsDir: join(runRoot, 'analytics'),
    deliverablesDir: join(runRoot, 'deliverables'),
  };
});

afterEach(() => {
  try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* noop */ }
  delete process.env.CTX_FAKE_CODEX_VERDICT;
  delete process.env.CTX_FAKE_CODEX_MUSTFIX;
  vi.restoreAllMocks();
});

function mockOpusFetch(verdict: 'approve' | 'block', mustFix: string[] = []) {
  const replyText = JSON.stringify({ verdict, concerns: [], must_fix: mustFix });
  const responseBody = JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [{ type: 'text', text: replyText }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('runCouncil — mixed-provider integration (codex + opus)', () => {
  it('approves end-to-end when both codex and opus members approve', async () => {
    process.env.CTX_FAKE_CODEX_VERDICT = 'approve';
    const fetchSpy = mockOpusFetch('approve');

    const { request, labelMapping } = await runCouncil({
      paths,
      org: 'mixed-test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'Plan: ship the thing',
      members: [
        { id: 'cx-high', provider: 'codex', reasoning_effort: 'high' },
        { id: 'op-a', provider: 'opus' },
      ],
      dispatch: defaultDispatcher,
    });

    expect(request.status).toBe('approved');
    expect(request.merged?.verdict).toBe('approve');
    expect(request.results).toHaveLength(2);

    const cxResult = request.results.find((r) => r.member_id === 'cx-high');
    const opResult = request.results.find((r) => r.member_id === 'op-a');
    expect(cxResult?.provider).toBe('codex');
    expect(cxResult?.verdict).toEqual({ verdict: 'approve', concerns: [], must_fix: [] });
    expect(opResult?.provider).toBe('opus');
    expect(opResult?.verdict).toEqual({ verdict: 'approve', concerns: [], must_fix: [] });

    // Opus path actually exercised — fetch was called once with the right shape.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-api03-mixed-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // api-key mode → no oauth beta, no Bearer, no Claude Code system prompt.
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      system?: string;
    };
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.system).toBeUndefined();
    expect(body.messages[0].content).toContain('ship the thing');

    expect(labelMapping).toHaveProperty('MEMBER_A');
    expect(labelMapping).toHaveProperty('MEMBER_B');
  });

  it('blocks (sticky) when opus blocks and codex approves — must_fix unions across providers', async () => {
    process.env.CTX_FAKE_CODEX_VERDICT = 'approve';
    process.env.CTX_FAKE_CODEX_MUSTFIX = JSON.stringify([]);
    mockOpusFetch('block', ['add load-test coverage', 'document failure modes']);

    const { request } = await runCouncil({
      paths,
      org: 'mixed-test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'Plan: risky thing',
      members: [
        { id: 'cx-high', provider: 'codex', reasoning_effort: 'high' },
        { id: 'op-a', provider: 'opus' },
      ],
      dispatch: defaultDispatcher,
    });

    expect(request.status).toBe('blocked');
    expect(request.merged?.verdict).toBe('block');
    expect(request.merged?.must_fix).toEqual(
      expect.arrayContaining(['add load-test coverage', 'document failure modes']),
    );
  });

  it('blocks even when codex approves: codex must_fix items survive merge alongside opus block', async () => {
    process.env.CTX_FAKE_CODEX_VERDICT = 'approve';
    process.env.CTX_FAKE_CODEX_MUSTFIX = JSON.stringify(['fix the typo']);
    mockOpusFetch('block', ['fix the typo.', 'add benchmarks']); // duplicate-after-normalize

    const { request } = await runCouncil({
      paths,
      org: 'mixed-test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'plan',
      members: [
        { id: 'cx-high', provider: 'codex' },
        { id: 'op-a', provider: 'opus' },
      ],
      dispatch: defaultDispatcher,
    });

    expect(request.status).toBe('blocked');
    // 'fix the typo' (codex) and 'fix the typo.' (opus) collapse to one entry —
    // codex's first-seen spelling wins per merge.ts rule.
    const mustFix = request.merged?.must_fix ?? [];
    expect(mustFix).toContain('fix the typo');
    expect(mustFix).not.toContain('fix the typo.');
    expect(mustFix).toContain('add benchmarks');
    expect(mustFix).toHaveLength(2);
  });

  it('records opus as exit-1 when Anthropic returns 401 (api-key mode does NOT trigger refresh)', async () => {
    process.env.CTX_FAKE_CODEX_VERDICT = 'approve';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } },
      ),
    );

    const { request } = await runCouncil({
      paths,
      org: 'mixed-test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'plan',
      members: [
        { id: 'cx-high', provider: 'codex' },
        { id: 'op-a', provider: 'opus' },
      ],
      dispatch: defaultDispatcher,
    });

    const op = request.results.find((r) => r.member_id === 'op-a');
    expect(op?.verdict).toBeNull();
    expect(op?.error).toBe('exit-1');
    // Critical: in api-key mode a 401 does NOT trigger `claude -p` refresh.
    // Exactly one fetch call is the contract (refresh-and-retry would be two).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // codex still approved → one valid verdict → council approves.
    expect(request.status).toBe('approved');
  });
});
