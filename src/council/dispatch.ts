/**
 * council/dispatch.ts — model-invocation seam for council members.
 *
 * The router calls `dispatchMember(member, plan, cwd)` and gets back
 * raw stdout + stderr + latency. Each provider has its own dispatcher
 * implementation (see `dispatchCodex`, `dispatchOpus` below). Tests
 * inject a stub dispatcher via `Router.with({ dispatch })` so the S1
 * end-to-end smoke can run without burning tokens.
 *
 * spawn vs PTY: codex one-shot exec runs over `child_process.spawn`,
 * NOT node-pty (advisor S1 review item #2). PTY adds zero value here
 * — there is no interactive prompt loop — and burdens us with stream
 * coupling we don't need. spawn cleanly captures stdout and stderr
 * separately (advisor item #7), which the parser falls back to when
 * stdout has no assistant turn.
 */

import { spawn } from 'child_process';
import type { CouncilProvider } from '../types/index.js';
import {
  resolveAnthropicAuth,
  type AuthResult,
  type ResolveAuthOptions,
} from './anthropic-auth.js';

export interface CouncilMember {
  id: string;
  provider: CouncilProvider;
  /** For codex: maps to `-c model_reasoning_effort=...`. */
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** Codex model name. Default: gpt-5.5. */
  model?: string;
}

export interface DispatchResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  latency_ms: number;
}

export interface Dispatcher {
  (member: CouncilMember, plan: string, cwd: string, signal?: AbortSignal): Promise<DispatchResult>;
}

/**
 * Real codex dispatcher. Runs:
 *   codex exec --model <model> -c model_reasoning_effort=<effort> --skip-git-repo-check
 * with the plan piped via stdin. Captures stdout and stderr separately.
 *
 * Pipes plan via stdin instead of as positional argument (mx-f6d2f6 —
 * codex CLI does NOT accept `-` as positional input; stdin works).
 */
export async function dispatchCodex(
  member: CouncilMember,
  plan: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const model = member.model ?? 'gpt-5.5';
  const effort = member.reasoning_effort ?? 'high';
  const args = [
    'exec',
    '--model', model,
    '-c', `model_reasoning_effort=${effort}`,
    '--skip-git-repo-check',
  ];

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
    child.on('error', (err) => reject(err));
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode, latency_ms: Date.now() - start });
    });
    child.stdin.write(plan);
    child.stdin.end();
  });
}

/**
 * Opus dispatcher — Anthropic Messages API.
 *
 * Invokes claude-opus-4-7 in single-shot mode (no tools, no streaming) and
 * returns the assistant's text reply in the `stdout` field. The framed plan
 * already enforces JSON-only output (see prompt.ts), so the reply text is
 * the council JSON object itself. The extractor (utils/codex-output.ts)
 * handles raw-JSON-in-stdout via its no-marker fallback path — no codex
 * frame fabrication needed.
 *
 * Auth: resolveAnthropicAuth() picks between two modes —
 *   - api-key  → ANTHROPIC_API_KEY env var, sent as `x-api-key`.
 *   - oauth    → Claude Code Max subscription token from the macOS keychain,
 *                sent as `Authorization: Bearer` with `anthropic-beta:
 *                oauth-2025-04-20` and the Claude Code system prompt.
 * cortextOS NEVER refreshes the OAuth token (single-writer policy — see
 * anthropic-auth.ts). If the keychain token is expired, we surface an
 * actionable stderr message instead.
 *
 * Failure modes:
 *   - Auth resolution failure → exitCode:1, stderr explains how to fix.
 *   - Non-2xx response → exitCode:1, stderr carries the API error body.
 *   - 401 in oauth mode → stderr also points at the keep-alive cron.
 *   - Network error / abort → reject (router catches and records as error).
 *
 * The cwd argument is ignored (no rollout files to isolate — the API call
 * is stateless), but kept in the signature for Dispatcher uniformity.
 */
const OPUS_MODEL_DEFAULT = 'claude-opus-4-7';
const OPUS_MAX_TOKENS = 4096;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Test seam — lets unit tests inject a stub auth resolver. */
export interface DispatchOpusOptions {
  resolveAuth?: (opts?: ResolveAuthOptions) => AuthResult;
}

function authFailureToStderr(failure: Exclude<AuthResult, { ok: true }>): string {
  switch (failure.reason) {
    case 'keychain-missing':
      return `dispatchOpus: ANTHROPIC_API_KEY not set and macOS keychain unavailable: ${failure.detail}`;
    case 'keychain-empty':
      return `dispatchOpus: ANTHROPIC_API_KEY not set and Claude Code keychain entry not found. Run \`claude\` to log in, or set ANTHROPIC_API_KEY. (${failure.detail})`;
    case 'keychain-malformed':
      return `dispatchOpus: Claude Code keychain entry is malformed: ${failure.detail}. Re-run \`claude\` to repair it.`;
    case 'oauth-expired':
      return `dispatchOpus: ${failure.detail}`;
  }
}

export async function dispatchOpus(
  member: CouncilMember,
  plan: string,
  _cwd: string,
  signal?: AbortSignal,
  options: DispatchOpusOptions = {},
): Promise<DispatchResult> {
  const start = Date.now();
  const resolve = options.resolveAuth ?? resolveAnthropicAuth;
  const authResult = resolve();
  if (!authResult.ok) {
    return {
      stdout: '',
      stderr: authFailureToStderr(authResult),
      exitCode: 1,
      latency_ms: Date.now() - start,
    };
  }
  const auth = authResult.auth;

  const model = member.model ?? OPUS_MODEL_DEFAULT;
  const bodyObj: Record<string, unknown> = {
    model,
    max_tokens: OPUS_MAX_TOKENS,
    messages: [{ role: 'user', content: plan }],
  };
  if (auth.mode === 'oauth') {
    // OAuth surface requires the Claude Code system prompt — without it the
    // API rejects requests authenticated with a `user:inference`-scoped token.
    bodyObj.system = CLAUDE_CODE_SYSTEM_PROMPT;
  }
  const body = JSON.stringify(bodyObj);

  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (auth.mode === 'api-key') {
    headers['x-api-key'] = auth.token;
  } else {
    headers['authorization'] = `Bearer ${auth.token}`;
    headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETA;
  }

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers,
    body,
    signal,
  });

  const latency_ms = Date.now() - start;

  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    const hint =
      auth.mode === 'oauth' && response.status === 401
        ? '\nHint: OAuth token rejected. Run `claude` to refresh the keychain, or check the keep-alive cron.'
        : '';
    return {
      stdout: '',
      stderr: `dispatchOpus: HTTP ${response.status} ${response.statusText}\n${errBody}${hint}`,
      exitCode: 1,
      latency_ms,
    };
  }

  const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');

  return {
    stdout: text,
    stderr: '',
    exitCode: 0,
    latency_ms,
  };
}

/**
 * Default dispatcher selector — routes a member to its provider impl.
 */
export const defaultDispatcher: Dispatcher = async (member, plan, cwd, signal) => {
  if (member.provider === 'codex') return dispatchCodex(member, plan, cwd, signal);
  if (member.provider === 'opus') return dispatchOpus(member, plan, cwd, signal);
  throw new Error(`Unknown council provider: ${(member as { provider: string }).provider}`);
};
