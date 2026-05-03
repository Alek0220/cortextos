import { describe, it, expect } from 'vitest';
import {
  defaultPolicy,
  heuristicPolicy,
  type PolicyContext,
} from '../../../src/council/router-policy.js';
import type { CouncilMember } from '../../../src/council/dispatch.js';

const MEMBERS: CouncilMember[] = [
  { id: 'opus-a', provider: 'opus' },
  { id: 'codex-a', provider: 'codex' },
];

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  kind: 'adversarial',
  plan: 'Plan: ship X',
  members: MEMBERS,
  requesting_agent: 'orch',
  ...over,
});

describe('defaultPolicy', () => {
  it('includes every member and excludes none', () => {
    const decision = defaultPolicy(ctx());
    expect(decision.policy_id).toBe('default-include-all/v1');
    expect(decision.included).toEqual(['opus-a', 'codex-a']);
    expect(decision.excluded).toEqual([]);
  });

  it('produces stable policy_id regardless of inputs', () => {
    expect(defaultPolicy(ctx({ kind: 'advisory' })).policy_id).toBe('default-include-all/v1');
    expect(defaultPolicy(ctx({ plan: '' })).policy_id).toBe('default-include-all/v1');
  });

  it('is pure (same input → same output)', () => {
    const c = ctx();
    const a = defaultPolicy(c);
    const b = defaultPolicy(c);
    expect(a).toEqual(b);
  });
});

describe('heuristicPolicy', () => {
  it('drops opus members on short advisory plans (< 1500 chars)', () => {
    const decision = heuristicPolicy(ctx({ kind: 'advisory', plan: 'short plan' }));
    expect(decision.policy_id).toBe('heuristic-advisory-length/v1');
    expect(decision.included).toEqual(['codex-a']);
    expect(decision.excluded).toHaveLength(1);
    expect(decision.excluded[0].member_id).toBe('opus-a');
    expect(decision.excluded[0].reason).toMatch(/heuristic: advisory plan length \d+ < 1500, opus skipped/);
  });

  it('keeps opus members on long advisory plans (>= 1500 chars)', () => {
    const longPlan = 'x'.repeat(1500);
    const decision = heuristicPolicy(ctx({ kind: 'advisory', plan: longPlan }));
    expect(decision.included.sort()).toEqual(['codex-a', 'opus-a']);
    expect(decision.excluded).toEqual([]);
  });

  it('always includes every member on adversarial plans (no length gate)', () => {
    const decision = heuristicPolicy(ctx({ kind: 'adversarial', plan: 'short' }));
    expect(decision.included.sort()).toEqual(['codex-a', 'opus-a']);
    expect(decision.excluded).toEqual([]);
  });

  it('keeps codex even when opus is dropped (no member-removal cascade)', () => {
    const decision = heuristicPolicy(
      ctx({
        kind: 'advisory',
        plan: 'tiny',
        members: [
          { id: 'codex-1', provider: 'codex' },
          { id: 'opus-1', provider: 'opus' },
          { id: 'codex-2', provider: 'codex' },
        ],
      }),
    );
    expect(decision.included.sort()).toEqual(['codex-1', 'codex-2']);
    expect(decision.excluded.map((e) => e.member_id)).toEqual(['opus-1']);
  });

  it('includes nothing if every member is opus on a short advisory plan', () => {
    const decision = heuristicPolicy(
      ctx({
        kind: 'advisory',
        plan: 'tiny',
        members: [
          { id: 'opus-1', provider: 'opus' },
          { id: 'opus-2', provider: 'opus' },
        ],
      }),
    );
    expect(decision.included).toEqual([]);
    expect(decision.excluded.map((e) => e.member_id).sort()).toEqual(['opus-1', 'opus-2']);
  });

  it('is deterministic and pure', () => {
    const c = ctx({ kind: 'advisory', plan: 'short' });
    const a = heuristicPolicy(c);
    const b = heuristicPolicy(c);
    expect(a).toEqual(b);
  });
});
