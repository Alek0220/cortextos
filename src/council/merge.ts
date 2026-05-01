/**
 * council/merge.ts — combine per-member verdicts into one merged verdict.
 *
 * Adversarial council semantics (S1):
 *   - At least one member must have a parseable verdict; otherwise return
 *     null (caller will mark the council `failed`, default-deny).
 *   - The merged verdict is `block` if ANY member blocked, otherwise
 *     `approve`. Codex and Opus disagree intentionally — block is sticky.
 *   - Concerns and must_fix lists are unioned across members and
 *     deduplicated by NORMALIZED form (advisor S1 review item #6 — without
 *     a written rule, "Add tests" and "add tests." would survive merge as
 *     duplicates and the operator would see a noisy verdict).
 *
 * Normalize rule (TESTED below):
 *   1. Lowercase.
 *   2. Collapse any run of whitespace (spaces, tabs, newlines) to a
 *      single space.
 *   3. Trim leading and trailing whitespace.
 *   4. Strip trailing punctuation `.`, `,`, `;`, `:`, `!`, `?` (any
 *      number of them, repeatedly — e.g. "fix it!!" → "fix it").
 *
 * The normalized form is the DEDUP KEY ONLY — the original (first-seen)
 * spelling is preserved in the output so the operator reads natural text.
 */

import type { CouncilMemberResult, CouncilVerdictJson } from '../types/index.js';

const TRAILING_PUNCT = /[.,;:!?]+$/;

export function normalizeFinding(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_PUNCT, '')
    .trim();
}

/**
 * Dedup an array preserving first-seen order, with normalize() as the key.
 * Empty strings (after normalization) are dropped.
 */
function dedupByNormalized(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const key = normalizeFinding(raw);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

export function mergeVerdicts(results: CouncilMemberResult[]): CouncilVerdictJson | null {
  const valid = results.filter(
    (r): r is CouncilMemberResult & { verdict: CouncilVerdictJson } => r.verdict !== null,
  );
  if (valid.length === 0) return null;

  const anyBlock = valid.some((r) => r.verdict.verdict === 'block');
  const verdict: 'approve' | 'block' = anyBlock ? 'block' : 'approve';

  const allConcerns: string[] = [];
  const allMustFix: string[] = [];
  for (const r of valid) {
    allConcerns.push(...r.verdict.concerns);
    allMustFix.push(...r.verdict.must_fix);
  }

  return {
    verdict,
    concerns: dedupByNormalized(allConcerns),
    must_fix: dedupByNormalized(allMustFix),
  };
}
