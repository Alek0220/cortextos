import { describe, it, expect } from 'vitest';
import {
  computeCouncilStats,
  RUFLO_W5_6_TRAJECTORY_THRESHOLD,
} from '../../../src/cli/council.js';
import type { CouncilRequest } from '../../../src/types/index.js';

function mk(partial: Partial<CouncilRequest>): CouncilRequest {
  return {
    id: partial.id ?? 'c1',
    org: 'o',
    requestingAgent: 'a',
    kind: 'adversarial',
    plan: 'p',
    members: [],
    results: [],
    status: partial.status ?? 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as CouncilRequest;
}

describe('computeCouncilStats', () => {
  it('empty list → all zeros, ruflo not ready, 0%', () => {
    const s = computeCouncilStats([]);
    expect(s.counts).toEqual({
      total: 0, approved: 0, blocked: 0, failed: 0, timeout: 0, pending: 0, running: 0,
    });
    expect(s.ruflo).toEqual({
      labeled_trajectories: 0,
      w5_6_threshold: RUFLO_W5_6_TRAJECTORY_THRESHOLD,
      w5_6_ready: false,
      progress_pct: 0,
    });
  });

  it('mixed status counts tally correctly', () => {
    const s = computeCouncilStats([
      mk({ status: 'approved' }),
      mk({ status: 'approved' }),
      mk({ status: 'blocked' }),
      mk({ status: 'failed' }),
      mk({ status: 'timeout' }),
      mk({ status: 'pending' }),
      mk({ status: 'running' }),
    ]);
    expect(s.counts.total).toBe(7);
    expect(s.counts.approved).toBe(2);
    expect(s.counts.blocked).toBe(1);
    expect(s.counts.failed).toBe(1);
    expect(s.counts.timeout).toBe(1);
    expect(s.counts.pending).toBe(1);
    expect(s.counts.running).toBe(1);
  });

  it('labeled trajectories count explicit outcomes', () => {
    const s = computeCouncilStats([
      mk({ outcome: 'success' as any, status: 'pending' }),
      mk({ outcome: 'failure' as any, status: 'pending' }),
      mk({ outcome: null as any, status: 'pending' }),
      mk({ status: 'pending' }),
    ]);
    expect(s.ruflo.labeled_trajectories).toBe(2);
  });

  it('labeled trajectories backfill: terminal status counts when outcome absent', () => {
    // Legacy councils written before W1 added the outcome field still have a
    // verdict (status=approved/blocked), and the verdict IS the label.
    const s = computeCouncilStats([
      mk({ status: 'approved' }),     // legacy approved → labeled
      mk({ status: 'blocked' }),      // legacy blocked → labeled
      mk({ status: 'failed' }),       // failed → NOT labeled
      mk({ status: 'pending' }),      // pending → NOT labeled
      mk({ status: 'running' }),      // running → NOT labeled
      mk({ status: 'timeout' }),      // timeout → NOT labeled
    ]);
    expect(s.ruflo.labeled_trajectories).toBe(2);
  });

  it('labeled trajectories: explicit outcome and terminal status do not double-count', () => {
    const s = computeCouncilStats([
      mk({ status: 'approved', outcome: 'success' as any }),
      mk({ status: 'blocked', outcome: 'failure' as any }),
    ]);
    expect(s.ruflo.labeled_trajectories).toBe(2);
  });

  it('progress_pct is rounded and capped at 100', () => {
    // threshold 10, 5 labeled → 50%
    const half = Array.from({ length: 5 }, (_, i) =>
      mk({ id: `c${i}`, outcome: 'approve' as any }),
    );
    expect(computeCouncilStats(half, 10).ruflo.progress_pct).toBe(50);

    // exactly threshold → 100% + ready
    const exact = Array.from({ length: 10 }, (_, i) =>
      mk({ id: `c${i}`, outcome: 'approve' as any }),
    );
    const sExact = computeCouncilStats(exact, 10);
    expect(sExact.ruflo.progress_pct).toBe(100);
    expect(sExact.ruflo.w5_6_ready).toBe(true);

    // over threshold → still 100% (capped)
    const over = Array.from({ length: 25 }, (_, i) =>
      mk({ id: `c${i}`, outcome: 'approve' as any }),
    );
    const sOver = computeCouncilStats(over, 10);
    expect(sOver.ruflo.progress_pct).toBe(100);
    expect(sOver.ruflo.w5_6_ready).toBe(true);
  });

  it('w5_6_ready boundary: exactly threshold → ready, threshold-1 → not ready', () => {
    const justUnder = Array.from({ length: 9 }, (_, i) =>
      mk({ id: `c${i}`, outcome: 'approve' as any }),
    );
    expect(computeCouncilStats(justUnder, 10).ruflo.w5_6_ready).toBe(false);

    const atThreshold = Array.from({ length: 10 }, (_, i) =>
      mk({ id: `c${i}`, outcome: 'approve' as any }),
    );
    expect(computeCouncilStats(atThreshold, 10).ruflo.w5_6_ready).toBe(true);
  });

  it('default threshold is 200', () => {
    expect(RUFLO_W5_6_TRAJECTORY_THRESHOLD).toBe(200);
    const s = computeCouncilStats([]);
    expect(s.ruflo.w5_6_threshold).toBe(200);
  });
});
