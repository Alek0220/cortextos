/**
 * council/success-reranker.ts — ruflo W2-3 retrieval reranker.
 *
 * Pure deterministic reranker that takes generic retrieval candidates
 * and reorders them using past council outcomes as a weak success signal:
 *   - boost candidates whose content overlaps with APPROVED councils' plans
 *   - penalize candidates whose content overlaps with BLOCKED councils'
 *     must_fix items (these are the patterns reviewers explicitly rejected)
 *
 * Scoring is trigram-Jaccard token overlap — no embeddings, no model,
 * no I/O at scoring time. The trajectory corpus is fetched once via
 * loadOutcomeCorpus() (scan-on-demand) so the same corpus can be reused
 * across many rerank calls in a single tick.
 *
 * Decoupled from knowledge-base.ts on purpose (advisor W2-3 spec): the
 * input is a generic `Array<{id, content, score}>`, so any retrieval
 * source — KB, memory, web fetch — can plug in.
 *
 * NOTE on "infrastructure not gain": at current N (~7 trajectories) the
 * rerank delta is in the noise. This module ships the plumbing so the
 * signal becomes measurable as trajectories accumulate. The W5-6 neural
 * router will replace the boost/penalty heuristic with a learned scorer
 * behind the same RerankerScore interface.
 */

import { listCouncils } from '../bus/council.js';
import type { BusPaths } from '../types/index.js';

export interface RerankCandidate {
  id: string;
  content: string;
  score: number;
}

export interface RerankedCandidate extends RerankCandidate {
  /** Reranker-adjusted score: original + boost - penalty. */
  rerank_score: number;
  boost: number;
  penalty: number;
}

export interface OutcomeCorpus {
  approved_plans: string[];
  blocked_must_fix: string[];
}

const TRIGRAM_SIZE = 3;
const BOOST_WEIGHT = 0.5;
const PENALTY_WEIGHT = 0.7;

function trigrams(text: string): Set<string> {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm.length < TRIGRAM_SIZE) return new Set([norm]);
  const out = new Set<string>();
  for (let i = 0; i <= norm.length - TRIGRAM_SIZE; i++) {
    out.add(norm.slice(i, i + TRIGRAM_SIZE));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function maxJaccardAgainst(candTri: Set<string>, corpus: string[]): number {
  let best = 0;
  for (const item of corpus) {
    const score = jaccard(candTri, trigrams(item));
    if (score > best) best = score;
  }
  return best;
}

/** Scan persisted councils once and extract the success/failure corpus. */
export function loadOutcomeCorpus(paths: BusPaths): OutcomeCorpus {
  const approved_plans: string[] = [];
  const blocked_must_fix: string[] = [];
  for (const c of listCouncils(paths, 'approved')) {
    if (c.outcome === 'success' && c.plan) approved_plans.push(c.plan);
  }
  for (const c of listCouncils(paths, 'blocked')) {
    if (c.outcome === 'failure' && c.merged?.must_fix?.length) {
      blocked_must_fix.push(...c.merged.must_fix);
    }
  }
  return { approved_plans, blocked_must_fix };
}

/**
 * Pure reranker. No I/O — pass the corpus in. Stable sort: ties preserve
 * original order so callers get deterministic results.
 */
export function rerankBySuccess(
  candidates: RerankCandidate[],
  corpus: OutcomeCorpus,
): RerankedCandidate[] {
  const enriched = candidates.map((c, idx) => {
    const tri = trigrams(c.content);
    const boost = BOOST_WEIGHT * maxJaccardAgainst(tri, corpus.approved_plans);
    const penalty = PENALTY_WEIGHT * maxJaccardAgainst(tri, corpus.blocked_must_fix);
    return {
      ...c,
      boost,
      penalty,
      rerank_score: c.score + boost - penalty,
      _idx: idx,
    };
  });
  enriched.sort((a, b) =>
    b.rerank_score !== a.rerank_score ? b.rerank_score - a.rerank_score : a._idx - b._idx,
  );
  return enriched.map(({ _idx: _, ...rest }) => rest);
}
