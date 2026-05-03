import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadOutcomeCorpus,
  rerankBySuccess,
  type OutcomeCorpus,
  type RerankCandidate,
} from '../../../src/council/success-reranker.js';
import {
  createCouncil,
  finalizeCouncil,
} from '../../../src/bus/council.js';
import type { BusPaths } from '../../../src/types/index.js';

let tmpRoot: string;
let paths: BusPaths;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ctx-reranker-'));
  paths = {
    ctxRoot: tmpRoot,
    inbox: join(tmpRoot, 'inbox'),
    inflight: join(tmpRoot, 'inflight'),
    processed: join(tmpRoot, 'processed'),
    logDir: join(tmpRoot, 'logs'),
    stateDir: join(tmpRoot, 'state'),
    taskDir: join(tmpRoot, 'tasks'),
    approvalDir: join(tmpRoot, 'approvals'),
    analyticsDir: join(tmpRoot, 'analytics'),
    deliverablesDir: join(tmpRoot, 'deliverables'),
  };
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
});

const cands: RerankCandidate[] = [
  { id: 'a', content: 'plan ship the migration tonight', score: 0.5 },
  { id: 'b', content: 'no tests, hardcoded creds, force push to main', score: 0.5 },
  { id: 'c', content: 'unrelated wiki page about coffee', score: 0.5 },
];

describe('rerankBySuccess (pure function)', () => {
  it('returns same length and preserves all ids', () => {
    const corpus: OutcomeCorpus = { approved_plans: [], blocked_must_fix: [] };
    const out = rerankBySuccess(cands, corpus);
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('with empty corpus, rerank_score equals original score and order is stable', () => {
    const corpus: OutcomeCorpus = { approved_plans: [], blocked_must_fix: [] };
    const out = rerankBySuccess(cands, corpus);
    for (const r of out) {
      expect(r.boost).toBe(0);
      expect(r.penalty).toBe(0);
      expect(r.rerank_score).toBe(r.score);
    }
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('boosts candidates that overlap with approved plans', () => {
    const corpus: OutcomeCorpus = {
      approved_plans: ['plan ship the migration tonight'],
      blocked_must_fix: [],
    };
    const out = rerankBySuccess(cands, corpus);
    expect(out[0].id).toBe('a');
    expect(out[0].boost).toBeGreaterThan(0);
    expect(out[0].penalty).toBe(0);
  });

  it('penalizes candidates that overlap with blocked must_fix items', () => {
    const corpus: OutcomeCorpus = {
      approved_plans: [],
      blocked_must_fix: ['no tests, hardcoded creds, force push to main'],
    };
    const out = rerankBySuccess(cands, corpus);
    const b = out.find((o) => o.id === 'b')!;
    expect(b.penalty).toBeGreaterThan(0);
    expect(b.rerank_score).toBeLessThan(b.score);
    expect(out[out.length - 1].id).toBe('b');
  });

  it('combined boost+penalty: approved boost beats penalty when both present', () => {
    const corpus: OutcomeCorpus = {
      approved_plans: ['plan ship the migration tonight'],
      blocked_must_fix: ['no tests, hardcoded creds, force push to main'],
    };
    const out = rerankBySuccess(cands, corpus);
    expect(out[0].id).toBe('a');
    expect(out[out.length - 1].id).toBe('b');
  });

  it('is deterministic: same input → same output', () => {
    const corpus: OutcomeCorpus = {
      approved_plans: ['plan ship the migration tonight'],
      blocked_must_fix: ['hardcoded creds'],
    };
    const a = rerankBySuccess(cands, corpus);
    const b = rerankBySuccess(cands, corpus);
    expect(a).toEqual(b);
  });

  it('does not mutate the input array', () => {
    const corpus: OutcomeCorpus = { approved_plans: ['x'], blocked_must_fix: [] };
    const before = JSON.parse(JSON.stringify(cands));
    rerankBySuccess(cands, corpus);
    expect(cands).toEqual(before);
  });

  it('handles empty candidate list', () => {
    const corpus: OutcomeCorpus = { approved_plans: ['x'], blocked_must_fix: ['y'] };
    expect(rerankBySuccess([], corpus)).toEqual([]);
  });

  it('handles short content (< trigram size) without crashing', () => {
    const corpus: OutcomeCorpus = { approved_plans: ['ab'], blocked_must_fix: [] };
    const out = rerankBySuccess([{ id: 'x', content: 'ab', score: 0.1 }], corpus);
    expect(out).toHaveLength(1);
    expect(out[0].boost).toBeGreaterThan(0);
  });

  it('ties preserve original order (stable sort)', () => {
    const corpus: OutcomeCorpus = { approved_plans: [], blocked_must_fix: [] };
    const tied: RerankCandidate[] = [
      { id: 'first', content: 'foo', score: 0.5 },
      { id: 'second', content: 'bar', score: 0.5 },
      { id: 'third', content: 'baz', score: 0.5 },
    ];
    const out = rerankBySuccess(tied, corpus);
    expect(out.map((o) => o.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('loadOutcomeCorpus (bus integration)', () => {
  it('returns empty corpus when no councils exist', () => {
    const corpus = loadOutcomeCorpus(paths);
    expect(corpus.approved_plans).toEqual([]);
    expect(corpus.blocked_must_fix).toEqual([]);
  });

  it('extracts approved plans and blocked must_fix items', () => {
    const c1 = createCouncil(paths, 'org', 'agent', 'adversarial', 'good plan to ship feature X');
    finalizeCouncil(paths, c1.id, { verdict: 'approve', concerns: [], must_fix: [] }, null);

    const c2 = createCouncil(paths, 'org', 'agent', 'adversarial', 'sketchy plan with no tests');
    finalizeCouncil(
      paths,
      c2.id,
      { verdict: 'block', concerns: ['risky'], must_fix: ['add tests', 'remove hardcoded secret'] },
      null,
    );

    const corpus = loadOutcomeCorpus(paths);
    expect(corpus.approved_plans).toContain('good plan to ship feature X');
    expect(corpus.blocked_must_fix.sort()).toEqual(['add tests', 'remove hardcoded secret']);
  });

  it('skips failed councils (no outcome label)', () => {
    const c = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan');
    finalizeCouncil(paths, c.id, null, null);
    const corpus = loadOutcomeCorpus(paths);
    expect(corpus.approved_plans).toEqual([]);
    expect(corpus.blocked_must_fix).toEqual([]);
  });
});
