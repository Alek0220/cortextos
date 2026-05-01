import { describe, it, expect } from 'vitest';
import { normalizeFinding, mergeVerdicts } from '../../../src/council/merge.js';
import type { CouncilMemberResult } from '../../../src/types/index.js';

const opus = (verdict: 'approve' | 'block', concerns: string[], must_fix: string[]): CouncilMemberResult => ({
  member_id: 'opus',
  provider: 'opus',
  verdict: { verdict, concerns, must_fix },
  latency_ms: 1500,
});

const codex = (verdict: 'approve' | 'block', concerns: string[], must_fix: string[]): CouncilMemberResult => ({
  member_id: 'codex',
  provider: 'codex',
  verdict: { verdict, concerns, must_fix },
  latency_ms: 75000,
});

const failedMember: CouncilMemberResult = {
  member_id: 'codex',
  provider: 'codex',
  verdict: null,
  latency_ms: 5000,
  error: 'parse-failed',
};

describe('normalizeFinding', () => {
  it('lowercases', () => {
    expect(normalizeFinding('Add Tests')).toBe('add tests');
  });
  it('collapses whitespace runs', () => {
    expect(normalizeFinding('add\t  tests\n  here')).toBe('add tests here');
  });
  it('trims edges', () => {
    expect(normalizeFinding('   add tests   ')).toBe('add tests');
  });
  it('strips trailing punctuation runs', () => {
    expect(normalizeFinding('Add tests.')).toBe('add tests');
    expect(normalizeFinding('Fix it!!!')).toBe('fix it');
    expect(normalizeFinding('Hurry??!!')).toBe('hurry');
    expect(normalizeFinding('Step 1: do it.')).toBe('step 1: do it');
  });
  it('treats whitespace-only and empty as empty', () => {
    expect(normalizeFinding('   ')).toBe('');
    expect(normalizeFinding('')).toBe('');
  });
});

describe('mergeVerdicts', () => {
  it('returns null when no member has a verdict', () => {
    expect(mergeVerdicts([])).toBeNull();
    expect(mergeVerdicts([failedMember])).toBeNull();
  });

  it('block is sticky — any block makes merged verdict block', () => {
    const merged = mergeVerdicts([
      opus('approve', [], []),
      codex('block', ['serious issue'], ['stop']),
    ]);
    expect(merged!.verdict).toBe('block');
  });

  it('approve only when ALL non-null members approve', () => {
    const merged = mergeVerdicts([opus('approve', [], []), codex('approve', [], [])]);
    expect(merged!.verdict).toBe('approve');
  });

  it('treats a null member as absent (does not flip verdict)', () => {
    const merged = mergeVerdicts([opus('approve', [], []), failedMember]);
    expect(merged!.verdict).toBe('approve');
  });

  it('dedupes concerns across members by normalized form, preserving first spelling', () => {
    const merged = mergeVerdicts([
      opus('block', ['Add tests', 'Document the rollback procedure.'], []),
      codex('block', ['add tests.', 'add tests!', 'New concern about scope'], []),
    ]);
    expect(merged!.concerns).toEqual([
      'Add tests',
      'Document the rollback procedure.',
      'New concern about scope',
    ]);
  });

  it('dedupes must_fix across members independently of concerns', () => {
    const merged = mergeVerdicts([
      opus('block', [], ['Wire CSRF protection']),
      codex('block', [], ['wire csrf protection.', 'Add changelog entry']),
    ]);
    expect(merged!.must_fix).toEqual(['Wire CSRF protection', 'Add changelog entry']);
  });

  it('drops empty / whitespace-only entries', () => {
    const merged = mergeVerdicts([
      opus('approve', ['', '   '], ['  ', 'Real item']),
      codex('approve', [], []),
    ]);
    expect(merged!.concerns).toEqual([]);
    expect(merged!.must_fix).toEqual(['Real item']);
  });

  it('whitespace-collapse merges multiline duplicates of the same finding', () => {
    const merged = mergeVerdicts([
      opus('block', ['Add\n  tests\there'], []),
      codex('block', ['add tests here'], []),
    ]);
    expect(merged!.concerns).toEqual(['Add\n  tests\there']);
  });
});
