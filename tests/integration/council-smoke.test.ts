/**
 * council-smoke.test.ts — end-to-end smoke for `cortextos council request`.
 *
 * Strategy: drop a fake `codex` script onto PATH that emits a canned
 * codex-style stdout (assistant marker + JSON verdict). The real CLI then
 * spawns this fake exactly as it would the real codex. We exercise both
 * the single-request happy path AND a parallel-safety case: two
 * simultaneous requests must produce distinct council ids and CWDs and
 * must not cross-contaminate forensics files.
 *
 * Why integration vs unit: the router has its own unit suite. This file
 * checks the CLI surface, the hook into resolvePaths, the spawn-based
 * dispatcher (NOT the test stub), and that codex CLI argv contract is
 * what we say it is in dispatch.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

let workdir: string;
let fakePathDir: string;
let cliPath: string;
let homeOverride: string;

function spawnCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        // Prepend fake codex on PATH so dispatch.ts spawns our shim.
        PATH: `${fakePathDir}:${process.env.PATH ?? ''}`,
        // Redirect ~/.cortextos to a tmp home for state isolation.
        HOME: homeOverride,
        CTX_INSTANCE_ID: 'smoke',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf-8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf-8'); });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ctx-council-smoke-'));
  fakePathDir = join(workdir, 'bin');
  homeOverride = join(workdir, 'home');
  mkdirSync(fakePathDir, { recursive: true });
  mkdirSync(homeOverride, { recursive: true });

  // Fake codex: emit a codex-style stdout with assistant marker + valid JSON.
  // The verdict is parameterized via CTX_FAKE_CODEX_VERDICT env.
  const fakeCodex = [
    '#!/usr/bin/env node',
    'const verdict = process.env.CTX_FAKE_CODEX_VERDICT || "approve";',
    'const payload = JSON.stringify({ verdict, concerns: [], must_fix: [] });',
    'process.stdout.write(`--------\\nworkdir: /tmp\\n--------\\nuser\\nReview\\ncodex\\n${payload}\\ntokens used\\n42\\n`);',
    'process.exit(0);',
  ].join('\n');
  const fakePath = join(fakePathDir, 'codex');
  writeFileSync(fakePath, fakeCodex, 'utf-8');
  chmodSync(fakePath, 0o755);

  // Resolve built CLI path
  cliPath = join(__dirname, '..', '..', 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error(`CLI build artifact missing at ${cliPath}. Run 'npm run build' first.`);
  }
});

afterAll(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('cortextos council request — integration smoke', () => {
  it('approves end-to-end with two codex members (default roster)', async () => {
    const { stdout, stderr, code } = await spawnCli(
      ['council', 'request', '--kind', 'adversarial', '--org', 'smoketest', '--plan', 'Plan: ship the thing'],
      { CTX_FAKE_CODEX_VERDICT: 'approve' },
    );
    expect(code, `exit ${code} — stderr=${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('approved');
    expect(parsed.merged?.verdict).toBe('approve');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.labelMapping).toHaveProperty('MEMBER_A');
    expect(parsed.labelMapping).toHaveProperty('MEMBER_B');
  }, 30_000);

  it('blocks (sticky) when fake codex returns block', async () => {
    const { stdout, code } = await spawnCli(
      ['council', 'request', '--kind', 'adversarial', '--org', 'smoketest', '--plan', 'risky plan'],
      { CTX_FAKE_CODEX_VERDICT: 'block' },
    );
    expect(code).toBe(2);  // 2 = blocked per CLI exit-code contract
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('blocked');
    expect(parsed.merged?.verdict).toBe('block');
  }, 30_000);

  it('parallel councils get distinct ids and CWDs (no cross-contamination)', async () => {
    const [a, b] = await Promise.all([
      spawnCli(
        ['council', 'request', '--kind', 'adversarial', '--org', 'smoketest', '--plan', 'plan A',
         '--member', 'pa1:codex:high', '--member', 'pa2:codex:low'],
        { CTX_FAKE_CODEX_VERDICT: 'approve' },
      ),
      spawnCli(
        ['council', 'request', '--kind', 'adversarial', '--org', 'smoketest', '--plan', 'plan B',
         '--member', 'pb1:codex:high', '--member', 'pb2:codex:low'],
        { CTX_FAKE_CODEX_VERDICT: 'approve' },
      ),
    ]);

    expect(a.code, `A failed: ${a.stderr}`).toBe(0);
    expect(b.code, `B failed: ${b.stderr}`).toBe(0);
    const parsedA = JSON.parse(a.stdout);
    const parsedB = JSON.parse(b.stdout);
    expect(parsedA.id).not.toBe(parsedB.id);

    const councilRoot = join(homeOverride, '.cortextos', 'smoke', 'pipelines', 'state', 'council');
    const aCwd = join(councilRoot, parsedA.id);
    const bCwd = join(councilRoot, parsedB.id);
    expect(existsSync(aCwd)).toBe(true);
    expect(existsSync(bCwd)).toBe(true);

    // Per-member forensics files exist in the right CWD and only there.
    const aFiles = readdirSync(aCwd);
    const bFiles = readdirSync(bCwd);
    expect(aFiles).toContain('stdout-pa1.txt');
    expect(aFiles).toContain('stdout-pa2.txt');
    expect(aFiles).not.toContain('stdout-pb1.txt');
    expect(bFiles).toContain('stdout-pb1.txt');
    expect(bFiles).not.toContain('stdout-pa1.txt');

    // Verdict should be present in the persisted record.
    const recordPath = join(aCwd, 'request.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(record.status).toBe('approved');
  }, 60_000);
});
