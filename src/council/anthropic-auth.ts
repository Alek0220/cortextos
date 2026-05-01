/**
 * council/anthropic-auth.ts — resolves how dispatchOpus authenticates.
 *
 * Two modes, in priority order:
 *
 *   1. `api-key` — process.env.ANTHROPIC_API_KEY is set. Sent as `x-api-key`
 *      on the Messages API call. This is the simple raw-API-key path; no
 *      keychain needed.
 *
 *   2. `oauth` — falls back to the Claude Code Max subscription's OAuth
 *      access token, read out of the macOS keychain
 *      (service: "Claude Code-credentials"). Sent as `Authorization: Bearer`
 *      with `anthropic-beta: oauth-2025-04-20` and the Claude Code system
 *      prompt — these three are required for the OAuth surface to honour
 *      the request.
 *
 * Single-writer policy (chosen 2026-05-01):
 *   This module NEVER refreshes the OAuth token. The OAuth provider rotates
 *   refresh_token on every refresh, so two processes refreshing in parallel
 *   would invalidate each other's cached token and log the user out of
 *   Claude Code. To avoid that, only Claude Code itself refreshes.
 *
 *   If the keychain token is expired (or within MIN_LIFETIME_MS of expiry),
 *   we return a structured oauth-expired result and let the dispatcher
 *   handle it. The dispatcher's reactive-refresh path then spawns
 *   `claude -p ping` to TRIGGER a Claude Code SDK refresh (Claude Code
 *   stays the sole writer; we just kick it). See dispatch.ts.
 *
 * Failure modes returned via {ok:false}:
 *   - keychain-missing: `security` command not found / not on macOS
 *   - keychain-empty:  service entry not found (Claude Code never logged in)
 *   - keychain-malformed: stored value isn't JSON / missing claudeAiOauth
 *   - oauth-expired: accessToken expired or about to expire
 *
 * The dispatcher converts these into a structured DispatchResult
 * (exitCode:1, actionable stderr) so the council records it as a member-level
 * error rather than crashing the run.
 */

import { execFileSync } from 'child_process';

export interface ApiKeyAuth {
  mode: 'api-key';
  token: string;
}

export interface OAuthAuth {
  mode: 'oauth';
  token: string;
  /** Epoch ms — when the access token expires. Informational only. */
  expiresAt: number;
}

export type AnthropicAuth = ApiKeyAuth | OAuthAuth;

export type AuthFailure =
  | { ok: false; reason: 'keychain-missing'; detail: string }
  | { ok: false; reason: 'keychain-empty'; detail: string }
  | { ok: false; reason: 'keychain-malformed'; detail: string }
  | { ok: false; reason: 'oauth-expired'; detail: string };

export type AuthResult = { ok: true; auth: AnthropicAuth } | AuthFailure;

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Refuse to use a token within this many ms of expiry (matches Claude Code's MEH=30s buffer). */
const MIN_LIFETIME_MS = 30_000;

/**
 * Read the Claude Code OAuth credential blob from the macOS keychain.
 *
 * Exposed for tests so they can mock the keychain layer without prodding
 * the real `security` command. In production, returns the raw JSON string
 * stored under service "Claude Code-credentials".
 */
export function readKeychainCredential(): string {
  return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface ClaudeAiOauthBlob {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

interface KeychainPayload {
  claudeAiOauth?: ClaudeAiOauthBlob;
}

export interface ResolveAuthOptions {
  /** Inject env for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Inject keychain reader for tests. Defaults to readKeychainCredential. */
  readKeychain?: () => string;
  /** Inject clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function resolveAnthropicAuth(opts: ResolveAuthOptions = {}): AuthResult {
  const env = opts.env ?? process.env;
  const readKeychain = opts.readKeychain ?? readKeychainCredential;
  const now = opts.now ?? Date.now;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length > 0) {
    return { ok: true, auth: { mode: 'api-key', token: apiKey } };
  }

  let raw: string;
  try {
    raw = readKeychain();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/command not found|ENOENT/i.test(detail)) {
      return { ok: false, reason: 'keychain-missing', detail };
    }
    return { ok: false, reason: 'keychain-empty', detail };
  }

  let parsed: KeychainPayload;
  try {
    parsed = JSON.parse(raw) as KeychainPayload;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'keychain-malformed', detail: `not JSON: ${detail}` };
  }

  const blob = parsed.claudeAiOauth;
  if (!blob || typeof blob.accessToken !== 'string' || typeof blob.expiresAt !== 'number') {
    return { ok: false, reason: 'keychain-malformed', detail: 'missing claudeAiOauth.{accessToken,expiresAt}' };
  }

  const remaining = blob.expiresAt - now();
  if (remaining < MIN_LIFETIME_MS) {
    return {
      ok: false,
      reason: 'oauth-expired',
      detail:
        `Claude Code OAuth access token has ${Math.floor(remaining / 1000)}s of life left ` +
        `(below ${MIN_LIFETIME_MS / 1000}s buffer). cortextOS does not refresh tokens — ` +
        `the dispatcher will trigger a refresh via \`claude -p\` and retry once.`,
    };
  }

  return {
    ok: true,
    auth: { mode: 'oauth', token: blob.accessToken, expiresAt: blob.expiresAt },
  };
}
