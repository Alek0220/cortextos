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
 * Opus dispatcher — STUB for S1.
 *
 * The real Opus invocation will go through the Anthropic Messages API
 * (the council needs structured JSON output from a parallel-channel
 * model, not a Claude Code session). Wiring that requires the API key
 * loader from `src/utils/env.ts` and a small fetch wrapper — both are
 * out of S1 scope.
 *
 * For S1 the router falls back to stub dispatchers in tests, and the
 * CLI smoke test runs with `--member codex,codex` (two codex members
 * with different reasoning levels) until the Opus dispatcher lands in
 * S1.5. The plan doc (line 114) flags this as the deferred slice.
 */
export async function dispatchOpus(
  _member: CouncilMember,
  _plan: string,
  _cwd: string,
  _signal?: AbortSignal,
): Promise<DispatchResult> {
  throw new Error(
    'dispatchOpus: not implemented in S1. The Opus member dispatcher is scheduled for S1.5 ' +
    '— see docs/plans/2026-05-01-cortextos-council-integration.md. Until then, run councils ' +
    'with codex-only members or inject a custom dispatcher via Router.with({ dispatch }).',
  );
}

/**
 * Default dispatcher selector — routes a member to its provider impl.
 */
export const defaultDispatcher: Dispatcher = async (member, plan, cwd, signal) => {
  if (member.provider === 'codex') return dispatchCodex(member, plan, cwd, signal);
  if (member.provider === 'opus') return dispatchOpus(member, plan, cwd, signal);
  throw new Error(`Unknown council provider: ${(member as { provider: string }).provider}`);
};
