import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractCouncilVerdict } from '../../../src/utils/codex-output.js';

const FIXTURES = join(__dirname, 'fixtures', 'codex-output');
const fx = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

describe('extractCouncilVerdict', () => {
  it('extracts verdict from real codex output (block case, JSON re-printed at footer)', () => {
    const v = extractCouncilVerdict(fx('01-success-block.txt'));
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('block');
    expect(v!.concerns.length).toBeGreaterThan(0);
    expect(v!.must_fix.length).toBeGreaterThan(0);
    expect(v!.concerns[0]).toMatch(/authentication/i);
  });

  it('returns null when codex emits prose-only with no JSON', () => {
    const v = extractCouncilVerdict(fx('02-missing-json.txt'));
    expect(v).toBeNull();
  });

  it('returns null when JSON is malformed (broken syntax)', () => {
    const v = extractCouncilVerdict(fx('03-malformed-json.txt'));
    expect(v).toBeNull();
  });

  it('extracts pretty-printed multi-line JSON', () => {
    const v = extractCouncilVerdict(fx('04-multiline-json.txt'));
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('approve');
    expect(v!.must_fix).toContain('Add CHANGELOG.md entry before merge');
  });

  it('extracts JSON when the assistant turn includes prose before and after', () => {
    const v = extractCouncilVerdict(fx('05-prose-then-json.txt'));
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('approve');
    expect(v!.concerns).toEqual([]);
    expect(v!.must_fix).toEqual(['Document the rollback procedure']);
  });

  it('does NOT extract the JSON-schema example from the echoed prompt', () => {
    // The schema placeholder `"approve" | "block"` is invalid JSON, but we still
    // assert that even if a *parseable* JSON shows up before `\ncodex\n` we
    // ignore it — the assistant marker is the source of truth.
    const stdout = [
      '--------',
      'workdir: /tmp',
      '--------',
      'user',
      'Your output schema:',
      '{"verdict":"approve","concerns":[],"must_fix":[]}',
      '',
      'Plan: foo',
      '',
      'codex',
      '{"verdict":"block","concerns":["bad"],"must_fix":["fix it"]}',
      'tokens used',
      '42',
    ].join('\n');
    const v = extractCouncilVerdict(stdout);
    expect(v).not.toBeNull();
    // The block from the assistant turn wins, NOT the approve from the prompt echo.
    expect(v!.verdict).toBe('block');
    expect(v!.concerns).toEqual(['bad']);
  });

  it('falls back to stderr when stdout has no assistant verdict', () => {
    const stdout = 'OpenAI Codex v0.125.0\n--------\nworkdir: /tmp\n--------\nuser\nReview\n';
    const stderr = 'codex\n{"verdict":"approve","concerns":[],"must_fix":[]}\n';
    const v = extractCouncilVerdict(stdout, stderr);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('approve');
  });

  it('rejects JSON-shaped objects that lack a verdict field', () => {
    const stdout = 'codex\n{"some":"other","object":true}\n';
    const v = extractCouncilVerdict(stdout);
    expect(v).toBeNull();
  });

  it('handles braces inside strings without false-positive structure counting', () => {
    const stdout =
      'codex\n{"verdict":"approve","concerns":["payload was {\\"a\\":1}"],"must_fix":[]}\n';
    const v = extractCouncilVerdict(stdout);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('approve');
    expect(v!.concerns[0]).toContain('payload was');
  });

  it('takes the LAST codex turn when multiple are present (multi-turn safe)', () => {
    const stdout = [
      'codex',
      '{"verdict":"approve","concerns":[],"must_fix":[]}',
      'user',
      'follow-up',
      'codex',
      '{"verdict":"block","concerns":["changed mind"],"must_fix":["redo"]}',
      'tokens used',
      '99',
    ].join('\n');
    const v = extractCouncilVerdict(stdout);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('block');
    expect(v!.must_fix).toEqual(['redo']);
  });
});
