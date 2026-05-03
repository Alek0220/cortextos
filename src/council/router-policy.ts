/**
 * council/router-policy.ts — pluggable member-selection policy (ruflo W4).
 *
 * The router calls `policy(ctx)` BEFORE dispatch to decide which of the
 * caller-supplied members actually run. The decision is persisted into
 * `CouncilRequest.policy_decision` so the upcoming success-reranker
 * (W2-3) and the deferred neural router (W5-6) have training tuples
 * even when the heuristic narrowed the set.
 *
 * Two policies ship today:
 *   - `defaultPolicy` — no-op. Includes every member. Zero behavior
 *     change vs pre-W4 callers. Used as the runCouncil default.
 *   - `heuristicPolicy` — kind+plan-length thresholds. Drops opus on
 *     short advisory plans (cheap-loop optimization). Opt-in by passing
 *     `policy: heuristicPolicy` to runCouncil.
 *
 * Both policies must be deterministic and pure (no I/O, no randomness)
 * so the trajectory record is reproducible. The neural router in W5-6
 * will replace `heuristicPolicy` with a learned classifier behind the
 * same interface — no router.ts changes needed.
 */

import type { CouncilKind, PolicyDecision, PolicyExclusion } from '../types/index.js';
import type { CouncilMember } from './dispatch.js';

export type { PolicyDecision, PolicyExclusion } from '../types/index.js';

export interface PolicyContext {
  kind: CouncilKind;
  plan: string;
  members: CouncilMember[];
  requesting_agent: string;
}

export interface RouterPolicy {
  (ctx: PolicyContext): PolicyDecision;
}

/** No-op: include every member. Used as the runCouncil default for backward compat. */
export const defaultPolicy: RouterPolicy = (ctx) => ({
  policy_id: 'default-include-all/v1',
  included: ctx.members.map((m) => m.id),
  excluded: [],
});

/**
 * Heuristic thresholds (W4). Conservative by design — only narrows when
 * the cheap path is clearly safe. Tuned for current cortextOS workload
 * (~7 historical councils, all adversarial); revisit when N>=200 and
 * the W5-6 neural router replaces this entirely.
 */
const ADVISORY_OPUS_PLAN_LENGTH_THRESHOLD = 1500;

/**
 * Drop opus members on short advisory plans. Adversarial plans always
 * include the full set (highest-stakes path; cost is the trade-off).
 */
export const heuristicPolicy: RouterPolicy = (ctx) => {
  const isShortAdvisory =
    ctx.kind === 'advisory' && ctx.plan.length < ADVISORY_OPUS_PLAN_LENGTH_THRESHOLD;
  const included: string[] = [];
  const excluded: PolicyExclusion[] = [];
  for (const m of ctx.members) {
    if (isShortAdvisory && m.provider === 'opus') {
      excluded.push({
        member_id: m.id,
        reason: `heuristic: advisory plan length ${ctx.plan.length} < ${ADVISORY_OPUS_PLAN_LENGTH_THRESHOLD}, opus skipped`,
      });
    } else {
      included.push(m.id);
    }
  }
  return {
    policy_id: 'heuristic-advisory-length/v1',
    included,
    excluded,
  };
};
