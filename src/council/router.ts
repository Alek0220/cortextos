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
  readCouncil,
  writeCouncil,
} from '../bus/council.js';
import { extractCouncilVerdict } from '../utils/codex-output.js';
import { blindLabel } from './anonymize.js';
import { mergeVerdicts } from './merge.js';
import { defaultDispatcher, type CouncilMember, type Dispatcher } from './dispatch.js';
import { frameCouncilPrompt } from './prompt.js';
import { signVerdict } from './signing.js';
import { defaultPolicy, type RouterPolicy } from './router-policy.js';
import type { SignedVerdictEnvelope } from '../types/index.js';
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
  /** Member-selection policy applied BEFORE dispatch (ruflo W4). Defaults to
   *  defaultPolicy (include-all) for backward compat. Pass heuristicPolicy or a
   *  future neural policy to narrow the set; the decision is persisted into the
   *  CouncilRequest so the success-reranker (W2-3) and neural router (W5-6)
   *  have ground-truth tuples even when the heuristic dropped members. */
  policy?: RouterPolicy;
}

export interface RouterResult {
  request: CouncilRequest;
  /** The blind-label mapping used at merge time, exposed for debug/UI. */
  labelMapping: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runCouncil(opts: RouterOptions): Promise<RouterResult> {
  const dispatch = opts.dispatch ?? defaultDispatcher;
  const policy = opts.policy ?? defaultPolicy;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const initial = createCouncil(opts.paths, opts.org, opts.requestingAgent, opts.kind, opts.plan);

  // Apply router policy BEFORE dispatch — narrows the candidate set and
  // persists the decision into the request for downstream learning loops.
  const decision = policy({
    kind: opts.kind,
    plan: opts.plan,
    members: opts.members,
    requesting_agent: opts.requestingAgent,
  });
  const includedSet = new Set(decision.included);
  const dispatchMembers = opts.members.filter((m) => includedSet.has(m.id));
  const stamped = readCouncil(opts.paths, initial.id);
  stamped.policy_decision = decision;
  writeCouncil(opts.paths, stamped);

  setCouncilStatus(opts.paths, initial.id, 'running');

  const cwd = councilDir(opts.paths, initial.id);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  // Wrap the raw plan in council-protocol framing (kind-specific JSON contract).
  // The persisted request keeps the original plan; only the model sees the framed text.
  const framedPlan = frameCouncilPrompt(opts.kind, opts.plan);

  try {
    const memberPromises = dispatchMembers.map(async (member): Promise<CouncilMemberResult> => {
      const start = Date.now();
      try {
        const dispatched = await dispatch(member, framedPlan, cwd, ac.signal);
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

    // S1.8: sign the merged verdict so downstream consumers (dashboard,
    // telegram audit log) can detect tampering between finalize and read.
    // Signing is sign-only — verification is a downstream concern. A signing
    // failure must not silently drop the council, so we record the failure
    // path but still finalize with envelope=null.
    let envelope: SignedVerdictEnvelope | null = null;
    if (merged) {
      try {
        envelope = await signVerdict({
          verdict: merged,
          council_id: initial.id,
          members: results.map((r) => r.member_id),
        });
      } catch {
        envelope = null;
      }
    }

    const finalRequest = finalizeCouncil(opts.paths, initial.id, merged, envelope);

    return { request: finalRequest, labelMapping: mapping.toOriginal };
  } finally {
    clearTimeout(timer);
  }
}
