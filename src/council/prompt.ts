/**
 * council/prompt.ts — wrap a raw plan in council-protocol instructions.
 *
 * The dispatcher is a dumb model-invocation seam (advisor S1 review item #2);
 * it pipes whatever it's given to codex/Opus. The council protocol — "you
 * are a reviewer, return THIS JSON shape" — is owned by the router so it can
 * vary by `kind` (adversarial vs advisory) without provider-specific code
 * paths leaking into dispatch.ts.
 *
 * Why a framing pass is necessary:
 *   Without explicit instructions, codex returns prose. The extractor in
 *   utils/codex-output.ts looks for a balanced `{verdict, concerns, must_fix}`
 *   JSON object after the assistant turn marker. Prose returns null, which
 *   the merger treats as absent → council fails default-deny. We want a
 *   structured verdict from real models, not just from the test shim.
 *
 * Framing strategy (adversarial):
 *   1. Strict role assignment — "you are an adversarial reviewer".
 *   2. Hard JSON contract with a literal example.
 *   3. Explicit "no prose, no markdown fences" rule (codex tends to wrap
 *      JSON in ```json fences when it thinks it's helpful).
 *   4. Sticky-block guidance — block on ANY material risk; an approve
 *      from this member is conditional on no other member blocking
 *      (the merger enforces sticky-block; the prompt only describes intent).
 *
 * Framing strategy (advisory):
 *   Same JSON contract, softer attitude. Advisors lean approve and surface
 *   concerns instead of blocking on speculative risk. Used by S2 idea-flow
 *   advisory councils where the goal is critique, not gating.
 */

import type { CouncilKind } from '../types/index.js';

const ADVERSARIAL_HEADER = `You are an ADVERSARIAL council reviewer.

Your job: examine the plan below for risks, missing safeguards, and unverified
assumptions. Block if there is any material risk to correctness, security,
data loss, or scope creep. Approve only if the plan is concretely sound and
the stated risks are accurate.

Respond with EXACTLY ONE JSON object and nothing else. No prose, no markdown
fences, no commentary. The schema is:

{"verdict":"approve"|"block","concerns":["..."],"must_fix":["..."]}

- "verdict" is mandatory and must be either "approve" or "block".
- "concerns" is a list of issues that don't block but are worth flagging.
- "must_fix" is a list of changes required before this plan can proceed.
  Required iff verdict="block"; should be empty (or omitted) on approve.
- Do NOT reference yourself or other reviewers in finding text.

PLAN UNDER REVIEW:
---
`;

const ADVISORY_HEADER = `You are an ADVISORY council reviewer.

Your job: read the plan below and surface concerns or improvements. Default
to "approve" — block only if the plan is dangerous, illegal, or fundamentally
broken. Use "concerns" liberally to flag soft issues; reserve "must_fix" for
non-negotiable corrections.

Respond with EXACTLY ONE JSON object and nothing else. No prose, no markdown
fences, no commentary. The schema is:

{"verdict":"approve"|"block","concerns":["..."],"must_fix":["..."]}

- "verdict" is mandatory and must be either "approve" or "block".
- "concerns" is a list of issues to flag without blocking.
- "must_fix" is a list of required changes (rare for advisory).
- Do NOT reference yourself or other reviewers in finding text.

PLAN UNDER REVIEW:
---
`;

const FOOTER = `\n---\nEnd of plan. Now respond with the verdict JSON object only.\n`;

export function frameCouncilPrompt(kind: CouncilKind, plan: string): string {
  const header = kind === 'adversarial' ? ADVERSARIAL_HEADER : ADVISORY_HEADER;
  return header + plan.trimEnd() + FOOTER;
}
