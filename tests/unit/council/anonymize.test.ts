import { describe, it, expect } from 'vitest';
import { blindLabel, restoreLabels } from '../../../src/council/anonymize.js';
import type { CouncilMemberResult } from '../../../src/types/index.js';

const opus: CouncilMemberResult = {
  member_id: 'opus',
  provider: 'opus',
  verdict: { verdict: 'approve', concerns: ['x'], must_fix: [] },
  latency_ms: 1500,
};
const codex: CouncilMemberResult = {
  member_id: 'codex',
  provider: 'codex',
  verdict: { verdict: 'block', concerns: ['y'], must_fix: ['z'] },
  latency_ms: 75000,
};

describe('blindLabel', () => {
  it('replaces member_id with MEMBER_A, MEMBER_B in input order', () => {
    const { blinded, mapping } = blindLabel([opus, codex]);
    expect(blinded[0].member_id).toBe('MEMBER_A');
    expect(blinded[1].member_id).toBe('MEMBER_B');
    expect(mapping.toOriginal).toEqual({ MEMBER_A: 'opus', MEMBER_B: 'codex' });
    expect(mapping.providerByLabel).toEqual({ MEMBER_A: 'opus', MEMBER_B: 'codex' });
  });

  it('preserves verdict, concerns, must_fix, latency, error verbatim', () => {
    const { blinded } = blindLabel([opus, codex]);
    expect(blinded[0].verdict).toEqual(opus.verdict);
    expect(blinded[1].verdict).toEqual(codex.verdict);
    expect(blinded[0].latency_ms).toBe(opus.latency_ms);
    expect(blinded[1].latency_ms).toBe(codex.latency_ms);
  });

  it('does not mutate the input array or its members (purity)', () => {
    const inputs = [opus, codex];
    const snapshot = JSON.stringify(inputs);
    blindLabel(inputs);
    expect(JSON.stringify(inputs)).toBe(snapshot);
  });

  it('returns an empty result for empty input', () => {
    const { blinded, mapping } = blindLabel([]);
    expect(blinded).toEqual([]);
    expect(mapping.toOriginal).toEqual({});
    expect(mapping.providerByLabel).toEqual({});
  });
});

describe('restoreLabels', () => {
  it('round-trips back to original member_ids', () => {
    const { blinded, mapping } = blindLabel([opus, codex]);
    const restored = restoreLabels(blinded, mapping);
    expect(restored[0].member_id).toBe('opus');
    expect(restored[1].member_id).toBe('codex');
  });

  it('passes through unknown labels unchanged (defensive)', () => {
    const { blinded, mapping } = blindLabel([opus]);
    const stranger: CouncilMemberResult = { ...codex, member_id: 'MEMBER_Z' };
    const restored = restoreLabels([...blinded, stranger], mapping);
    expect(restored[0].member_id).toBe('opus');
    expect(restored[1].member_id).toBe('MEMBER_Z');
  });
});
