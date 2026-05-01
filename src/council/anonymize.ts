/**
 * council/anonymize.ts — BLIND LABELING for the merger pass.
 *
 * IMPORTANT: This module is NOT a PII or secrets scrubber. The name was
 * deliberately chosen for its narrow purpose (advisor S1 review item #4 —
 * "rename or doc-block to clarify this is for blind merge dedup, NOT PII").
 *
 * Why blind labeling matters:
 *   The merger sees concerns and must_fix items from multiple members
 *   (Opus, codex). If the merger could see "this came from Opus", it
 *   could weight one member over the other and the dedup pass becomes
 *   non-deterministic with respect to member identity. By relabeling
 *   each member to a stable opaque token (`MEMBER_A`, `MEMBER_B`, ...)
 *   in deterministic order, the merger treats member origin as opaque
 *   and the dedup logic stays purely textual.
 *
 * The blind label IS preserved on the result so the dashboard / debug
 * logs can still show "MEMBER_A = opus" via the returned mapping. Real
 * identity is restored at the presentation layer, not the merger.
 *
 * SCOPE:
 *   - Input: an array of CouncilMemberResults with concrete provider ids
 *   - Output: same array shape with member_id replaced by `MEMBER_{n}`
 *     and a {label -> originalMember} mapping for restoration.
 *   - We do NOT touch the verdict text — concerns/must_fix are passed
 *     through verbatim. Member-attribution leaks INSIDE finding text
 *     are out-of-scope (members are instructed not to self-reference
 *     in the council prompt; if they do, it's a prompt-engineering bug
 *     for S2, not an anonymizer concern).
 */

import type { CouncilMemberResult, CouncilProvider } from '../types/index.js';

export interface BlindLabelMapping {
  /** label → original member_id. */
  toOriginal: Record<string, string>;
  /** label → original provider, for downstream restoration in the dashboard. */
  providerByLabel: Record<string, CouncilProvider>;
}

export interface AnonymizedResult {
  blinded: CouncilMemberResult[];
  mapping: BlindLabelMapping;
}

/**
 * Apply blind labels to a list of member results. Order of `results`
 * determines label assignment — pass them in a stable order (e.g. the
 * order they were dispatched) for deterministic test output.
 *
 * The function is pure: it does not mutate input.
 */
export function blindLabel(results: CouncilMemberResult[]): AnonymizedResult {
  const toOriginal: Record<string, string> = {};
  const providerByLabel: Record<string, CouncilProvider> = {};
  const blinded: CouncilMemberResult[] = results.map((r, i) => {
    const label = `MEMBER_${String.fromCharCode(65 + i)}`; // A, B, C, ...
    toOriginal[label] = r.member_id;
    providerByLabel[label] = r.provider;
    return {
      ...r,
      member_id: label,
    };
  });
  return { blinded, mapping: { toOriginal, providerByLabel } };
}

/**
 * Reverse a blind labeling. Used by the dashboard / CLI to display the
 * real member identity alongside the merged verdict.
 */
export function restoreLabels(
  blinded: CouncilMemberResult[],
  mapping: BlindLabelMapping,
): CouncilMemberResult[] {
  return blinded.map((r) => ({
    ...r,
    member_id: mapping.toOriginal[r.member_id] ?? r.member_id,
  }));
}
