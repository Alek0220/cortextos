/**
 * prompt.test.ts — adversarial/advisory framing covers the JSON contract.
 *
 * Why this exists: framing is what makes real codex actually return JSON
 * instead of prose. The fake-codex shim in the integration smoke hardcodes
 * the JSON shape, so it never exercises the framing. This unit test pins:
 *   - The framing always demands `{verdict,concerns,must_fix}`.
 *   - The framing forbids prose / markdown fences (codex's default
 *     behavior wraps JSON in ```json which would fail balanced-brace
 *     extraction if it appeared inside a string but pass otherwise —
 *     we forbid it explicitly).
 *   - The original plan text is preserved verbatim inside the framing
 *     (operators reading forensics see exactly what the model saw).
 *   - Adversarial vs advisory differ in attitude (block vs approve default).
 */
import { describe, it, expect } from 'vitest';
import { frameCouncilPrompt } from '../../../src/council/prompt';

describe('frameCouncilPrompt', () => {
  const plan = 'Plan: rename helper foo to fooHelper.\n';

  it('adversarial framing demands the JSON schema and includes the plan', () => {
    const out = frameCouncilPrompt('adversarial', plan);
    expect(out).toContain('ADVERSARIAL council reviewer');
    expect(out).toContain('{"verdict":"approve"|"block","concerns":["..."],"must_fix":["..."]}');
    expect(out).toMatch(/No prose, no markdown\s+fences/);
    expect(out).toContain('rename helper foo to fooHelper');
  });

  it('advisory framing leans approve and demands the same schema', () => {
    const out = frameCouncilPrompt('advisory', plan);
    expect(out).toContain('ADVISORY council reviewer');
    expect(out).toContain('Default\nto "approve"');
    expect(out).toContain('{"verdict":"approve"|"block","concerns":["..."],"must_fix":["..."]}');
    expect(out).toContain('rename helper foo to fooHelper');
  });

  it('preserves the plan body unchanged (no transformation)', () => {
    const tricky = 'Multi-line plan.\nWith braces { and } and "quotes".\nLast line.';
    const out = frameCouncilPrompt('adversarial', tricky);
    expect(out).toContain(tricky);
  });
});
