import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createCouncil,
  readCouncil,
  setCouncilStatus,
  appendMemberResult,
  finalizeCouncil,
  listCouncils,
  listPendingCouncils,
  councilDir,
} from '../../../src/bus/council.js';
import type { BusPaths, CouncilMemberResult } from '../../../src/types/index.js';

let tmpRoot: string;
let paths: BusPaths;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ctx-council-'));
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
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('createCouncil', () => {
  it('creates a pending council with stable id format and persists request.json', () => {
    const req = createCouncil(paths, 'schmiegelow', 'orchestrator', 'adversarial', 'Plan: ship X');
    expect(req.id).toMatch(/^council_\d+_[a-z0-9]{5}$/);
    expect(req.status).toBe('pending');
    expect(req.kind).toBe('adversarial');
    expect(req.org).toBe('schmiegelow');
    expect(req.merged).toBeNull();
    expect(req.results).toEqual([]);
    expect(existsSync(join(councilDir(paths, req.id), 'request.json'))).toBe(true);
  });

  it('rejects invalid org names', () => {
    expect(() =>
      createCouncil(paths, 'BadOrg!', 'agent', 'adversarial', 'plan'),
    ).toThrow(/Invalid org name/);
  });

  it('writes a per-request directory matching councilDir()', () => {
    const req = createCouncil(paths, 'org', 'a', 'adversarial', 'p');
    const expected = join(tmpRoot, 'pipelines', 'state', 'council', req.id);
    expect(councilDir(paths, req.id)).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it('parallel creates produce distinct ids and distinct CWDs (parallel safety)', () => {
    const a = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan a');
    const b = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan b');
    expect(a.id).not.toBe(b.id);
    expect(councilDir(paths, a.id)).not.toBe(councilDir(paths, b.id));
    expect(existsSync(councilDir(paths, a.id))).toBe(true);
    expect(existsSync(councilDir(paths, b.id))).toBe(true);
  });
});

describe('lifecycle transitions', () => {
  it('setCouncilStatus moves through running and stamps resolved_at on terminal states', () => {
    const req = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan');
    const running = setCouncilStatus(paths, req.id, 'running');
    expect(running.status).toBe('running');
    expect(running.resolved_at).toBeNull();
    const blocked = setCouncilStatus(paths, req.id, 'blocked');
    expect(blocked.status).toBe('blocked');
    expect(blocked.resolved_at).not.toBeNull();
  });

  it('appendMemberResult preserves order and updates updated_at', () => {
    const req = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan');
    const r1: CouncilMemberResult = {
      member_id: 'opus',
      provider: 'opus',
      verdict: { verdict: 'approve', concerns: [], must_fix: [] },
      latency_ms: 1200,
    };
    const r2: CouncilMemberResult = {
      member_id: 'codex',
      provider: 'codex',
      verdict: null,
      latency_ms: 78000,
      error: 'parse-failed',
    };
    appendMemberResult(paths, req.id, r1);
    const after = appendMemberResult(paths, req.id, r2);
    expect(after.results).toHaveLength(2);
    expect(after.results[0].member_id).toBe('opus');
    expect(after.results[1].error).toBe('parse-failed');
  });

  it('finalizeCouncil sets approved/blocked from merged verdict; failed when merged null', () => {
    const a = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan a');
    finalizeCouncil(paths, a.id, { verdict: 'approve', concerns: [], must_fix: [] });
    expect(readCouncil(paths, a.id).status).toBe('approved');

    const b = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan b');
    finalizeCouncil(paths, b.id, { verdict: 'block', concerns: ['x'], must_fix: ['y'] });
    expect(readCouncil(paths, b.id).status).toBe('blocked');

    const c = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan c');
    finalizeCouncil(paths, c.id, null);
    expect(readCouncil(paths, c.id).status).toBe('failed');
  });
});

describe('listCouncils / listPendingCouncils', () => {
  it('returns empty array when council root does not exist', () => {
    expect(listCouncils(paths)).toEqual([]);
    expect(listPendingCouncils(paths)).toEqual([]);
  });

  it('filters by status and lists pending+running for listPendingCouncils', () => {
    const a = createCouncil(paths, 'org', 'agent', 'adversarial', 'a');
    const b = createCouncil(paths, 'org', 'agent', 'adversarial', 'b');
    const c = createCouncil(paths, 'org', 'agent', 'adversarial', 'c');
    setCouncilStatus(paths, b.id, 'running');
    finalizeCouncil(paths, c.id, { verdict: 'approve', concerns: [], must_fix: [] });

    const pending = listPendingCouncils(paths);
    expect(pending.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const approved = listCouncils(paths, 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe(c.id);
  });

  it('persists pretty-printed JSON (operator-readable on disk)', () => {
    const req = createCouncil(paths, 'org', 'agent', 'adversarial', 'plan');
    const raw = readFileSync(join(councilDir(paths, req.id), 'request.json'), 'utf-8');
    expect(raw).toContain('\n  "id"');
  });
});
