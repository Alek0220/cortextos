import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCouncil } from '../../../src/council/router.js';
import type { Dispatcher } from '../../../src/council/dispatch.js';
import type { BusPaths } from '../../../src/types/index.js';
import { councilDir } from '../../../src/bus/council.js';

let tmpRoot: string;
let paths: BusPaths;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ctx-router-'));
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

const stubDispatcher = (
  responses: Record<string, { stdout: string; stderr?: string; exitCode?: number; latency_ms?: number }>,
): Dispatcher => async (member) => {
  const r = responses[member.id];
  if (!r) throw new Error(`stub dispatcher: no response for member ${member.id}`);
  return {
    stdout: r.stdout,
    stderr: r.stderr ?? '',
    exitCode: r.exitCode ?? 0,
    latency_ms: r.latency_ms ?? 100,
  };
};

const codexOutput = (verdict: 'approve' | 'block', mustFix: string[] = []): string =>
  `--------\nworkdir: /tmp\n--------\nuser\nReview\ncodex\n${JSON.stringify({
    verdict,
    concerns: [],
    must_fix: mustFix,
  })}\ntokens used\n100\n`;

describe('runCouncil — end-to-end with stub dispatcher', () => {
  it('approves when both members approve', async () => {
    const dispatch = stubDispatcher({
      m1: { stdout: codexOutput('approve') },
      m2: { stdout: codexOutput('approve') },
    });
    const { request, labelMapping } = await runCouncil({
      paths,
      org: 'test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'Plan: ship the thing',
      members: [
        { id: 'm1', provider: 'codex' },
        { id: 'm2', provider: 'codex' },
      ],
      dispatch,
    });
    expect(request.status).toBe('approved');
    expect(request.merged?.verdict).toBe('approve');
    expect(request.results).toHaveLength(2);
    expect(labelMapping).toEqual({ MEMBER_A: 'm1', MEMBER_B: 'm2' });
  });

  it('blocks when any member blocks (sticky)', async () => {
    const dispatch = stubDispatcher({
      m1: { stdout: codexOutput('approve') },
      m2: { stdout: codexOutput('block', ['add tests']) },
    });
    const { request } = await runCouncil({
      paths,
      org: 'test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'plan',
      members: [
        { id: 'm1', provider: 'codex' },
        { id: 'm2', provider: 'codex' },
      ],
      dispatch,
    });
    expect(request.status).toBe('blocked');
    expect(request.merged?.must_fix).toEqual(['add tests']);
  });

  it('records null verdict + parse-failed error when output has no JSON', async () => {
    const dispatch = stubDispatcher({
      m1: { stdout: 'codex\nI cannot determine a verdict.\ntokens used\n42\n' },
      m2: { stdout: codexOutput('approve') },
    });
    const { request } = await runCouncil({
      paths,
      org: 'test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'plan',
      members: [
        { id: 'm1', provider: 'codex' },
        { id: 'm2', provider: 'codex' },
      ],
      dispatch,
    });
    const m1 = request.results.find((r) => r.member_id === 'm1');
    expect(m1?.verdict).toBeNull();
    expect(m1?.error).toBe('parse-failed');
    // m2 approved → merger has one valid → approve
    expect(request.status).toBe('approved');
  });

  it('marks council failed when EVERY member returns null verdict', async () => {
    const dispatch = stubDispatcher({
      m1: { stdout: 'no JSON here', exitCode: 1 },
      m2: { stdout: 'also no JSON', exitCode: 1 },
    });
    const { request } = await runCouncil({
      paths,
      org: 'test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'plan',
      members: [
        { id: 'm1', provider: 'codex' },
        { id: 'm2', provider: 'codex' },
      ],
      dispatch,
    });
    expect(request.status).toBe('failed');
    expect(request.merged).toBeNull();
    const m1 = request.results.find((r) => r.member_id === 'm1');
    expect(m1?.error).toBe('exit-1');
  });

  it('persists per-member stdout + stderr to council CWD for forensics', async () => {
    const dispatch = stubDispatcher({
      m1: { stdout: codexOutput('approve'), stderr: 'some warning' },
    });
    const { request } = await runCouncil({
      paths,
      org: 'test',
      requestingAgent: 'orch',
      kind: 'adversarial',
      plan: 'plan',
      members: [{ id: 'm1', provider: 'codex' }],
      dispatch,
    });
    const cwd = councilDir(paths, request.id);
    expect(existsSync(join(cwd, 'stdout-m1.txt'))).toBe(true);
    expect(existsSync(join(cwd, 'stderr-m1.txt'))).toBe(true);
    expect(readFileSync(join(cwd, 'stderr-m1.txt'), 'utf-8')).toBe('some warning');
  });

  it('parallel councils do not collide on CWD or response files', async () => {
    const dispatch: Dispatcher = async (member, _plan, cwd) => ({
      stdout: codexOutput('approve'),
      stderr: '',
      exitCode: 0,
      latency_ms: 50,
      // also write a file into cwd to verify isolation
      ...(((): object => {
        require('fs').writeFileSync(require('path').join(cwd, `marker-${member.id}.txt`), member.id);
        return {};
      })()),
    });

    const [a, b] = await Promise.all([
      runCouncil({
        paths, org: 'test', requestingAgent: 'orch', kind: 'adversarial', plan: 'A',
        members: [{ id: 'p1', provider: 'codex' }], dispatch,
      }),
      runCouncil({
        paths, org: 'test', requestingAgent: 'orch', kind: 'adversarial', plan: 'B',
        members: [{ id: 'p2', provider: 'codex' }], dispatch,
      }),
    ]);

    expect(a.request.id).not.toBe(b.request.id);
    expect(councilDir(paths, a.request.id)).not.toBe(councilDir(paths, b.request.id));
    expect(existsSync(join(councilDir(paths, a.request.id), 'marker-p1.txt'))).toBe(true);
    expect(existsSync(join(councilDir(paths, b.request.id), 'marker-p2.txt'))).toBe(true);
    // Cross-contamination check: A's CWD should NOT contain p2's marker.
    expect(existsSync(join(councilDir(paths, a.request.id), 'marker-p2.txt'))).toBe(false);
    expect(existsSync(join(councilDir(paths, b.request.id), 'marker-p1.txt'))).toBe(false);
  });

  it('respects timeoutMs — slow members report verdict=null with error=timeout', async () => {
    const dispatch: Dispatcher = (_member, _plan, _cwd, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({
          stdout: codexOutput('approve'), stderr: '', exitCode: 0, latency_ms: 5000,
        }), 5000);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });

    const { request } = await runCouncil({
      paths, org: 'test', requestingAgent: 'orch', kind: 'adversarial', plan: 'plan',
      members: [{ id: 'slow', provider: 'codex' }],
      dispatch,
      timeoutMs: 50,
    });
    const slow = request.results.find((r) => r.member_id === 'slow');
    expect(slow?.verdict).toBeNull();
    expect(slow?.error).toBe('timeout');
    expect(request.status).toBe('failed');
  });
});
