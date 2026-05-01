/**
 * council/router.ts — orchestrates a single council request end-to-end.
 *
 * Lifecycle (matches the plan doc S1 section):
 *   1. createCouncil() — record persisted, status=pending.
 *   2. setCouncilStatus(running).
 *   3. Dispatch each member in parallel with a per-request CWD
 *      ({ctxRoot}/pipelines/state/council/{id}/) so concurrent councils
 *      can never collide on codex rollout files.
 *   4. Each member's stdout is parsed via extractCouncilVerdict; on
 *      parse failure the member result records the error and verdict=null
 *      (default-deny semantics — the merger treats null as absent).
 *   5. blindLabel the results before merging (so the merger can't bias
 *      by member identity), then mergeVerdicts.
 *   6. finalizeCouncil with the merged verdict — sets status to
 *      approved | blocked | failed.
 *
 * Wall-clock budget: the router attaches an AbortSignal that fires at
 * `timeoutMs` (default 5 min — advisor item #3). Members that have not
 * completed by then are reported with verdict=null and error='timeout';
 * the merger handles them as absent, which usually means a failed
 * council unless one member already approved/blocked. Signal also
 * cancels in-flight codex spawns cleanly.
 *
 * The dispatcher is injectable so tests can avoid burning real tokens.
 */

import { join } from 'path';
import {
  appendMemberResult,
  createCouncil,
  finalizeCouncil,
  setCouncilStatus,
  councilDir,
} from '../bus/council.js';
import { extractCouncilVerdict } from '../utils/codex-output.js';
import { blindLabel } from './anonymize.js';
import { mergeVerdicts } from './merge.js';
import { defaultDispatcher, type CouncilMember, type Dispatcher } from './dispatch.js';
import type {
  BusPaths,
  CouncilKind,
  CouncilMemberResult,
  CouncilRequest,
} from '../types/index.js';
import { writeFileSync } from 'fs';

export interface RouterOptions {
  paths: BusPaths;
  org: string;
  requestingAgent: string;
  kind: CouncilKind;
  plan: string;
  members: CouncilMember[];
  /** Wall-clock budget in ms. Default 300_000 (5 min) per advisor #3. */
  timeoutMs?: number;
  /** Test seam — inject a stub dispatcher to avoid real model calls. */
  dispatch?: Dispatcher;
}

export interface RouterResult {
  request: CouncilRequest;
  /** The blind-label mapping used at merge time, exposed for debug/UI. */
  labelMapping: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runCouncil(opts: RouterOptions): Promise<RouterResult> {
  const dispatch = opts.dispatch ?? defaultDispatcher;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const initial = createCouncil(opts.paths, opts.org, opts.requestingAgent, opts.kind, opts.plan);
  setCouncilStatus(opts.paths, initial.id, 'running');

  const cwd = councilDir(opts.paths, initial.id);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const memberPromises = opts.members.map(async (member): Promise<CouncilMemberResult> => {
      const start = Date.now();
      try {
        const dispatched = await dispatch(member, opts.plan, cwd, ac.signal);
        // Persist raw outputs for forensics (advisor #7 — capture both streams).
        try {
          writeFileSync(join(cwd, `stdout-${member.id}.txt`), dispatched.stdout, 'utf-8');
          writeFileSync(join(cwd, `stderr-${member.id}.txt`), dispatched.stderr, 'utf-8');
        } catch {
          // Forensics failure must not fail the council.
        }
        const verdict = extractCouncilVerdict(dispatched.stdout, dispatched.stderr);
        return {
          member_id: member.id,
          provider: member.provider,
          verdict,
          latency_ms: dispatched.latency_ms,
          ...(verdict === null
            ? { error: dispatched.exitCode === 0 ? 'parse-failed' : `exit-${dispatched.exitCode}` }
            : {}),
        };
      } catch (err) {
        const reason = ac.signal.aborted ? 'timeout' : (err instanceof Error ? err.message : String(err));
        return {
          member_id: member.id,
          provider: member.provider,
          verdict: null,
          latency_ms: Date.now() - start,
          error: reason,
        };
      }
    });

    const results = await Promise.all(memberPromises);
    for (const r of results) {
      appendMemberResult(opts.paths, initial.id, r);
    }

    const { blinded, mapping } = blindLabel(results);
    const merged = mergeVerdicts(blinded);
    const finalRequest = finalizeCouncil(opts.paths, initial.id, merged);

    return { request: finalRequest, labelMapping: mapping.toOriginal };
  } finally {
    clearTimeout(timer);
  }
}
