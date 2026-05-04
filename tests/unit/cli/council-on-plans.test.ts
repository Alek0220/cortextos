import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findPlanFiles,
  summarizeOnPlans,
  type OnPlansResult,
} from '../../../src/cli/council.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ctx-on-plans-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('findPlanFiles', () => {
  it('returns [] for a path that does not exist', () => {
    expect(findPlanFiles(join(tmpRoot, 'no-such-dir'))).toEqual([]);
  });

  it('returns [] for a path that is a file, not a directory', () => {
    const file = join(tmpRoot, 'a-PLAN.md');
    writeFileSync(file, 'plan');
    expect(findPlanFiles(file)).toEqual([]);
  });

  it('returns [] for an empty directory', () => {
    expect(findPlanFiles(tmpRoot)).toEqual([]);
  });

  it('matches *-PLAN.md and PLAN.md, ignores README.md and other files', () => {
    writeFileSync(join(tmpRoot, '01-foo-PLAN.md'), 'a');
    writeFileSync(join(tmpRoot, '02-bar-PLAN.md'), 'b');
    writeFileSync(join(tmpRoot, 'PLAN.md'), 'c');
    writeFileSync(join(tmpRoot, 'README.md'), 'noise');
    writeFileSync(join(tmpRoot, 'plan.md'), 'noise-lowercase'); // missing -PLAN suffix → ignored
    writeFileSync(join(tmpRoot, 'PLAN-something.md'), 'noise-prefix'); // not -PLAN.md suffix → ignored
    const out = findPlanFiles(tmpRoot);
    expect(out.map((p) => p.replace(tmpRoot + '/', ''))).toEqual([
      '01-foo-PLAN.md',
      '02-bar-PLAN.md',
      'PLAN.md',
    ]);
  });

  it('returns sorted (stable, deterministic) order', () => {
    writeFileSync(join(tmpRoot, '03-z-PLAN.md'), 'a');
    writeFileSync(join(tmpRoot, '01-a-PLAN.md'), 'b');
    writeFileSync(join(tmpRoot, '02-m-PLAN.md'), 'c');
    const out = findPlanFiles(tmpRoot).map((p) => p.replace(tmpRoot + '/', ''));
    expect(out).toEqual(['01-a-PLAN.md', '02-m-PLAN.md', '03-z-PLAN.md']);
  });

  it('does not descend into subdirectories', () => {
    mkdirSync(join(tmpRoot, 'nested'));
    writeFileSync(join(tmpRoot, 'nested', '99-nested-PLAN.md'), 'nope');
    writeFileSync(join(tmpRoot, '01-top-PLAN.md'), 'yes');
    const out = findPlanFiles(tmpRoot).map((p) => p.replace(tmpRoot + '/', ''));
    expect(out).toEqual(['01-top-PLAN.md']);
  });
});

function mk(file: string, status: OnPlansResult['status'], must_fix: string[] = []): OnPlansResult {
  return { file, status, must_fix, request_id: `r-${file}` };
}

describe('summarizeOnPlans', () => {
  it('empty results → 0/0/0/0, exit 0', () => {
    const s = summarizeOnPlans([], false);
    expect(s).toEqual({ total: 0, approved: 0, blocked: 0, failed: 0, exitCode: 0 });
  });

  it('all approved → exit 0 regardless of blockOnVerdict', () => {
    const r = [mk('a', 'approved'), mk('b', 'approved')];
    expect(summarizeOnPlans(r, false).exitCode).toBe(0);
    expect(summarizeOnPlans(r, true).exitCode).toBe(0);
  });

  it('blocked + report-only (default) → exit 0, blocked counted', () => {
    const r = [mk('a', 'approved'), mk('b', 'blocked', ['add tests'])];
    const s = summarizeOnPlans(r, false);
    expect(s.exitCode).toBe(0);
    expect(s.blocked).toBe(1);
    expect(s.approved).toBe(1);
  });

  it('blocked + --block-on-verdict → exit 2', () => {
    const r = [mk('a', 'approved'), mk('b', 'blocked', ['add tests'])];
    expect(summarizeOnPlans(r, true).exitCode).toBe(2);
  });

  it('failed always trumps blocked → exit 1 even with --block-on-verdict', () => {
    const r = [mk('a', 'failed'), mk('b', 'blocked')];
    expect(summarizeOnPlans(r, false).exitCode).toBe(1);
    expect(summarizeOnPlans(r, true).exitCode).toBe(1);
  });

  it('timeout counts as failed', () => {
    const r = [mk('a', 'timeout'), mk('b', 'approved')];
    const s = summarizeOnPlans(r, true);
    expect(s.failed).toBe(1);
    expect(s.exitCode).toBe(1);
  });

  it('mixed: 3 approved, 2 blocked, 1 failed → failed wins', () => {
    const r = [
      mk('1', 'approved'),
      mk('2', 'approved'),
      mk('3', 'approved'),
      mk('4', 'blocked'),
      mk('5', 'blocked'),
      mk('6', 'failed'),
    ];
    const s = summarizeOnPlans(r, true);
    expect(s).toEqual({ total: 6, approved: 3, blocked: 2, failed: 1, exitCode: 1 });
  });

  it('non-terminal statuses (pending, running) are not counted as failed/blocked/approved', () => {
    const r = [mk('a', 'pending'), mk('b', 'running')];
    const s = summarizeOnPlans(r, true);
    expect(s).toEqual({ total: 2, approved: 0, blocked: 0, failed: 0, exitCode: 0 });
  });
});
