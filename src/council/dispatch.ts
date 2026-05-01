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
 *
 * Single-writer refresh policy:
 *   cortextOS does NOT refresh the OAuth token in-process — the OAuth
 *   provider rotates refresh_token on every refresh, so two processes
 *   refreshing in parallel would invalidate each other (single-writer
 *   policy, see anthropic-auth.ts).
 *
 *   What we DO is reactively spawn `claude -p "ping"` when we observe an
 *   expired token (resolver returns oauth-expired) or an authentication
 *   failure from the API (HTTP 401). The Claude Code SDK is then the
 *   actual refresher — we just trigger it by making it run a request.
 *   After the spawn completes, we re-read the keychain and retry exactly
 *   once. The retry guard means we never loop on a bad token.
 *
 *   Why reactive instead of a cron: empirically `claude --version` and
 *   `claude -p "ping"` only refresh when the SDK's own pre-expiry buffer
 *   triggers — calling them well before expiry is a no-op. The reactive
 *   path runs them at the moment they're guaranteed to refresh: when the
 *   token is actually within the SDK's buffer or has been rejected.
 *
 * Failure modes:
 *   - Auth resolution failure (non-recoverable) → exitCode:1, stderr explains.
 *   - Non-2xx response → exitCode:1, stderr carries the API error body.
 *   - 401 after one refresh+retry → exitCode:1 with re-auth hint.
 *   - Refresh subprocess fails → exitCode:1 with the spawn error.
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
/** Refresh subprocess timeout. Claude Code SDK refreshes well under this. */
const REFRESH_TIMEOUT_MS = 30_000;
/** After SIGTERM on timeout, give the child this long to exit before SIGKILL. */
const REFRESH_KILL_GRACE_MS = 5_000;

/**
 * Reactively trigger a Claude Code SDK token refresh by running `claude -p`.
 *
 * Exposed for tests so they can stub the spawn without poking the real CLI.
 * In production, runs `claude -p "ping"` and discards its output — we only
 * care about the side-effect on the keychain (the SDK refreshes its access
 * token before making its own API call when the existing one is within its
 * pre-expiry buffer).
 *
 * The promise settles ONLY on `'close'` (or spawn `'error'`). Even on timeout,
 * we send SIGTERM, schedule SIGKILL after a grace period, and wait for
 * `'close'` before rejecting. This is critical: `dedupedRefresh` clears the
 * inflight slot in `.finally()`, so settling on the timeout deadline (while
 * the child is still alive) would let a subsequent caller spawn a second
 * `claude -p` concurrently with the first — exactly the single-writer
 * violation the deduplication exists to prevent.
 */
export async function refreshClaudeCodeOAuth(
  timeoutMs: number = REFRESH_TIMEOUT_MS,
  killGraceMs: number = REFRESH_KILL_GRACE_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', 'ping'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);
    child.stdout.on('data', () => { /* drain */ });
    child.stderr.on('data', () => { /* drain */ });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) reject(new Error(`claude -p ping timed out after ${timeoutMs}ms`));
      else if (code === 0) resolve();
      else reject(new Error(`claude -p ping exited with code ${code}`));
    });
  });
}

/**
 * Process-wide refresh deduplication.
 *
 * The council fires N members in parallel. If the token is expired, ALL N
 * dispatchOpus calls observe oauth-expired (or 401) and would each spawn
 * `claude -p ping` — exactly the concurrent-refresh race the single-writer
 * policy was meant to prevent. The OAuth provider rotates refresh_token on
 * every refresh, so two simultaneous refreshes invalidate each other.
 *
 * Solution: at most one `claude -p` runs per process. The first caller
 * starts the refresh, all concurrent callers await the same promise. After
 * it settles (success or failure), the slot clears and the NEXT
 * oauth-expired observation can trigger a fresh attempt.
 *
 * `_resetInflightRefresh` is a test-only escape hatch — the singleton state
 * is module-scoped and needs clearing between tests to avoid order-dependent
 * leakage.
 */
let inflightRefresh: Promise<void> | null = null;

async function dedupedRefresh(refreshFn: () => Promise<void>): Promise<void> {
  if (!inflightRefresh) {
    inflightRefresh = refreshFn().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

/** Test-only: clear the module-level inflight refresh slot. */
export function _resetInflightRefresh(): void {
  inflightRefresh = null;
}

/** Test seam — lets unit tests inject stub resolver and refresh. */
export interface DispatchOpusOptions {
  resolveAuth?: (opts?: ResolveAuthOptions) => AuthResult;
  refresh?: () => Promise<void>;
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
  const resolveFn = options.resolveAuth ?? resolveAnthropicAuth;
  const refreshFn = options.refresh ?? refreshClaudeCodeOAuth;

  // Single-shot retry guard: refresh+retry happens at most once per dispatch
  // call. The two recoverable conditions are (a) resolver returns oauth-expired
  // BEFORE we make the API call, and (b) API returns 401 in oauth mode AFTER
  // we make the call. Either one triggers `claude -p ping` (which causes the
  // Claude Code SDK to refresh the keychain), then we re-resolve and try once
  // more. After that, we surface the failure.
  let didRefresh = false;

  while (true) {
    const authResult = resolveFn();

    if (!authResult.ok) {
      if (authResult.reason === 'oauth-expired' && !didRefresh) {
        didRefresh = true;
        try {
          await dedupedRefresh(refreshFn);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return {
            stdout: '',
            stderr: `dispatchOpus: OAuth token expired and \`claude -p\` refresh failed: ${detail}`,
            exitCode: 1,
            latency_ms: Date.now() - start,
          };
        }
        continue;
      }
      // No-op refresh: subprocess exited cleanly but the keychain still shows
      // an expired token. Either Claude Code's pre-expiry buffer is wider than
      // ours, or `claude -p ping` did not actually refresh (auth dropped,
      // network failure inside the SDK, etc.). Distinguish this from "token
      // never refreshed at all" so the operator knows the subprocess ran.
      if (authResult.reason === 'oauth-expired' && didRefresh) {
        return {
          stdout: '',
          stderr:
            `dispatchOpus: \`claude -p\` refresh ran but keychain still shows an expired token. ` +
            `Run \`claude\` interactively to re-authenticate. (${authResult.detail})`,
          exitCode: 1,
          latency_ms: Date.now() - start,
        };
      }
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

    if (!response.ok) {
      // 401 in oauth mode is recoverable once: keychain may have stale token
      // even though resolver thought it was fresh (clock skew, server-side
      // revocation, etc.). Trigger a refresh and retry exactly once.
      if (response.status === 401 && auth.mode === 'oauth' && !didRefresh) {
        didRefresh = true;
        try {
          await dedupedRefresh(refreshFn);
          continue;
        } catch (err) {
          // Surface the refresh failure symmetrically with the oauth-expired
          // path. The original 401 is recoverable in principle, but if the
          // refresh subprocess itself failed (timeout, missing `claude`,
          // non-zero exit) the operator needs to see THAT cause — silently
          // returning "HTTP 401" hides the actionable failure.
          const detail = err instanceof Error ? err.message : String(err);
          return {
            stdout: '',
            stderr: `dispatchOpus: HTTP 401 from Anthropic API and \`claude -p\` refresh failed: ${detail}`,
            exitCode: 1,
            latency_ms: Date.now() - start,
          };
        }
      }
      const errBody = await response.text().catch(() => '<unreadable>');
      const hint =
        auth.mode === 'oauth' && response.status === 401
          ? '\nHint: OAuth token rejected even after `claude -p` refresh attempt. Run `claude` interactively to re-authenticate.'
          : '';
      return {
        stdout: '',
        stderr: `dispatchOpus: HTTP ${response.status} ${response.statusText}\n${errBody}${hint}`,
        exitCode: 1,
        latency_ms: Date.now() - start,
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
      latency_ms: Date.now() - start,
    };
  }
}

/**
 * Default dispatcher selector — routes a member to its provider impl.
 */
export const defaultDispatcher: Dispatcher = async (member, plan, cwd, signal) => {
  if (member.provider === 'codex') return dispatchCodex(member, plan, cwd, signal);
  if (member.provider === 'opus') return dispatchOpus(member, plan, cwd, signal);
  throw new Error(`Unknown council provider: ${(member as { provider: string }).provider}`);
};
