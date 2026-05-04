/**
 * cli/council.ts — `cortextos council` subcommands.
 *
 * S1 surface (the smoke target the plan doc calls out):
 *
 *   cortextos council request --kind adversarial --org schmiegelow [\
 *     --plan-file path/to/plan.md | --plan "<inline>" | (read from stdin)] [\
 *     --member id:provider[:reasoning] ...] [--timeout-ms 300000]
 *
 *   cortextos council list   [--org <org>] [--instance <id>] [--status <s>]
 *   cortextos council show   <id> [--instance <id>] [--org <org>]
 *
 * The CLI is thin: it resolves BusPaths via resolvePaths() (mirroring
 * hook-council-gate), then delegates to runCouncil / readCouncil.
 *
 * Exit codes mirror council outcomes for CI scripting:
 *   0 — approved
 *   1 — failed (parse / timeout / dispatch)
 *   2 — blocked
 */

import { Command } from 'commander';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from '../utils/paths.js';
import { runCouncil } from '../council/router.js';
import { readCouncil, listCouncils } from '../bus/council.js';
import type { CouncilMember } from '../council/dispatch.js';
import type { CouncilKind, CouncilProvider } from '../types/index.js';

function parseMemberSpec(spec: string): CouncilMember {
  // Format: id:provider[:reasoning]
  const parts = spec.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid --member '${spec}'. Expected id:provider[:reasoning]`);
  }
  const [id, provider, reasoning] = parts;
  if (provider !== 'codex' && provider !== 'opus') {
    throw new Error(`Invalid provider '${provider}'. Must be 'codex' or 'opus'.`);
  }
  if (reasoning && !['low', 'medium', 'high'].includes(reasoning)) {
    throw new Error(`Invalid reasoning '${reasoning}'. Must be low|medium|high.`);
  }
  const member: CouncilMember = { id, provider: provider as CouncilProvider };
  if (reasoning) member.reasoning_effort = reasoning as 'low' | 'medium' | 'high';
  return member;
}

function readStdinSync(): string {
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf-8');
}

function defaultMembers(): CouncilMember[] {
  return [
    { id: 'codex-high', provider: 'codex', reasoning_effort: 'high' },
    { id: 'codex-low', provider: 'codex', reasoning_effort: 'low' },
  ];
}

export const councilCommand = new Command('council')
  .description('Run and inspect adversarial / advisory model councils');

councilCommand
  .command('request')
  .description('Dispatch a council request and wait for a merged verdict')
  .requiredOption('--kind <kind>', 'adversarial | advisory')
  .requiredOption('--org <org>', 'Org name (used for path scoping)')
  .option('--plan <text>', 'Inline plan text')
  .option('--plan-file <path>', 'Read plan from file')
  .option('--member <spec...>', 'Member spec id:provider[:reasoning]; repeatable. Default: codex-high + codex-low')
  .option('--agent <name>', 'Requesting agent name (default: $CTX_AGENT_NAME or "cli")')
  .option('--instance <id>', 'cortextos instance id (default: $CTX_INSTANCE_ID or "default")')
  .option('--timeout-ms <ms>', '5-min default; per-request wall-clock budget', (v) => parseInt(v, 10))
  .action(async (opts: {
    kind: string;
    org: string;
    plan?: string;
    planFile?: string;
    member?: string[];
    agent?: string;
    instance?: string;
    timeoutMs?: number;
  }) => {
    if (opts.kind !== 'adversarial' && opts.kind !== 'advisory') {
      process.stderr.write(`Invalid --kind '${opts.kind}'. Must be 'adversarial' or 'advisory'.\n`);
      process.exit(1);
    }

    let plan: string;
    if (opts.planFile) {
      if (!existsSync(opts.planFile)) {
        process.stderr.write(`--plan-file not found: ${opts.planFile}\n`);
        process.exit(1);
      }
      plan = readFileSync(opts.planFile, 'utf-8');
    } else if (opts.plan) {
      plan = opts.plan;
    } else {
      plan = readStdinSync();
    }
    if (!plan.trim()) {
      process.stderr.write('Plan is empty. Provide --plan, --plan-file, or pipe via stdin.\n');
      process.exit(1);
    }

    let members: CouncilMember[];
    try {
      members = (opts.member ?? []).map(parseMemberSpec);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (members.length === 0) members = defaultMembers();

    const agent = opts.agent ?? process.env.CTX_AGENT_NAME ?? 'cli';
    const instance = opts.instance ?? process.env.CTX_INSTANCE_ID ?? 'default';
    const paths = resolvePaths(agent, instance, opts.org);

    process.stderr.write(`council: dispatching ${members.length} member(s) — ${members.map((m) => m.id).join(', ')}\n`);
    const { request, labelMapping } = await runCouncil({
      paths,
      org: opts.org,
      requestingAgent: agent,
      kind: opts.kind as CouncilKind,
      plan,
      members,
      timeoutMs: opts.timeoutMs,
    });

    process.stdout.write(JSON.stringify({
      id: request.id,
      status: request.status,
      merged: request.merged,
      results: request.results,
      labelMapping,
    }, null, 2) + '\n');

    if (request.status === 'approved') process.exit(0);
    if (request.status === 'blocked') process.exit(2);
    process.exit(1);
  });

councilCommand
  .command('list')
  .description('List council requests')
  .requiredOption('--org <org>', 'Org name')
  .option('--instance <id>', 'cortextos instance id (default: default)')
  .option('--agent <name>', 'Requesting agent name (default: cli)')
  .option('--status <status>', 'Filter by status')
  .action((opts: { org: string; instance?: string; agent?: string; status?: string }) => {
    const agent = opts.agent ?? 'cli';
    const instance = opts.instance ?? 'default';
    const paths = resolvePaths(agent, instance, opts.org);
    const all = listCouncils(paths);
    const filtered = opts.status ? all.filter((r) => r.status === opts.status) : all;
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
  });

councilCommand
  .command('show')
  .argument('<id>', 'Council request id')
  .description('Show a council request by id')
  .requiredOption('--org <org>', 'Org name')
  .option('--instance <id>', 'cortextos instance id (default: default)')
  .option('--agent <name>', 'Requesting agent name (default: cli)')
  .action((id: string, opts: { org: string; instance?: string; agent?: string }) => {
    const agent = opts.agent ?? 'cli';
    const instance = opts.instance ?? 'default';
    const paths = resolvePaths(agent, instance, opts.org);
    const r = readCouncil(paths, id);
    if (!r) {
      process.stderr.write(`No council request found: ${id}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  });

/**
 * Glob a phase directory for *-PLAN.md files. Matches gsd's
 * `.planning/phases/{NN}-{slug}/` convention. Pure / unit-testable —
 * exported for tests/unit/cli/council-on-plans.test.ts.
 */
export function findPlanFiles(phaseDir: string): string[] {
  if (!existsSync(phaseDir) || !statSync(phaseDir).isDirectory()) {
    return [];
  }
  return readdirSync(phaseDir)
    .filter((f) => /-PLAN\.md$/i.test(f) || /^PLAN\.md$/i.test(f))
    .sort()
    .map((f) => join(phaseDir, f));
}

/**
 * Ruflo trajectory readiness threshold for the deferred W5-6 neural
 * router. Tracked here so `cortextos council stats` can report the
 * gate's progress without operators having to remember it.
 */
export const RUFLO_W5_6_TRAJECTORY_THRESHOLD = 200;

export interface CouncilStats {
  counts: {
    total: number;
    approved: number;
    blocked: number;
    failed: number;
    timeout: number;
    pending: number;
    running: number;
  };
  ruflo: {
    labeled_trajectories: number;
    w5_6_threshold: number;
    w5_6_ready: boolean;
    progress_pct: number;
  };
}

/** Pure tally — exported for unit tests. */
export function computeCouncilStats(
  all: import('../types/index.js').CouncilRequest[],
  threshold: number = RUFLO_W5_6_TRAJECTORY_THRESHOLD,
): CouncilStats {
  const counts = {
    total: all.length,
    approved: all.filter((c) => c.status === 'approved').length,
    blocked: all.filter((c) => c.status === 'blocked').length,
    failed: all.filter((c) => c.status === 'failed').length,
    timeout: all.filter((c) => c.status === 'timeout').length,
    pending: all.filter((c) => c.status === 'pending').length,
    running: all.filter((c) => c.status === 'running').length,
  };
  // Labeled trajectories = anything with an explicit W1 outcome OR a terminal
  // verdict (approved/blocked) on legacy councils that predate the outcome
  // field. The verdict IS the label by W1's own circular-by-design contract,
  // so legacy records count toward the W5-6 training corpus gate.
  const labeled = all.filter(
    (c) => c.outcome != null || c.status === 'approved' || c.status === 'blocked',
  ).length;
  return {
    counts,
    ruflo: {
      labeled_trajectories: labeled,
      w5_6_threshold: threshold,
      w5_6_ready: labeled >= threshold,
      progress_pct: Math.min(100, Math.round((labeled / threshold) * 100)),
    },
  };
}

councilCommand
  .command('stats')
  .description('Council outcome counts and ruflo W5-6 readiness')
  .requiredOption('--org <org>', 'Org name')
  .option('--instance <id>', 'cortextos instance id (default: default)')
  .option('--agent <name>', 'Requesting agent name (default: cli)')
  .option('--json', 'Output raw JSON')
  .action((opts: { org: string; instance?: string; agent?: string; json?: boolean }) => {
    const agent = opts.agent ?? 'cli';
    const instance = opts.instance ?? 'default';
    const paths = resolvePaths(agent, instance, opts.org);
    const stats = computeCouncilStats(listCouncils(paths));
    const { counts, ruflo } = stats;
    if (opts.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
      return;
    }
    process.stdout.write(`Council outcomes (org=${opts.org}):\n`);
    process.stdout.write(`  total:    ${counts.total}\n`);
    process.stdout.write(`  approved: ${counts.approved}\n`);
    process.stdout.write(`  blocked:  ${counts.blocked}\n`);
    process.stdout.write(`  failed:   ${counts.failed}\n`);
    process.stdout.write(`  timeout:  ${counts.timeout}\n`);
    process.stdout.write(`  pending:  ${counts.pending}\n`);
    process.stdout.write(`  running:  ${counts.running}\n`);
    process.stdout.write(`\nRuflo W5-6 readiness:\n`);
    process.stdout.write(`  labeled trajectories: ${ruflo.labeled_trajectories} / ${ruflo.w5_6_threshold} (${ruflo.progress_pct}%)\n`);
    process.stdout.write(`  ready:                ${ruflo.w5_6_ready ? 'YES — neural router unlock candidate' : 'no — keep accumulating'}\n`);
  });

/**
 * Per-plan result row used by the on-plans summary printer.
 * Exported so the unit test can drive `summarizeOnPlans` directly
 * without needing a live runCouncil dispatch.
 */
export interface OnPlansResult {
  file: string;
  status: 'approved' | 'blocked' | 'failed' | 'timeout' | 'pending' | 'running';
  must_fix: string[];
  request_id: string;
}

export interface OnPlansSummary {
  total: number;
  approved: number;
  blocked: number;
  failed: number;
  exitCode: 0 | 1 | 2;
}

/**
 * Pure summary tally + exit-code resolver for on-plans. Exported for tests.
 *
 * Exit semantics:
 *   - any failed/timeout    → 1 (operational error trumps everything)
 *   - any blocked AND blockOnVerdict → 2
 *   - else                  → 0
 *
 * Default is report-only (blockOnVerdict=false) so on-plans can run inside
 * a gsd workflow without halting it on a council disagreement — operators
 * read the must_fix list and choose. --block-on-verdict makes it a hard gate.
 */
export function summarizeOnPlans(
  results: OnPlansResult[],
  blockOnVerdict: boolean,
): OnPlansSummary {
  const approved = results.filter((r) => r.status === 'approved').length;
  const blocked = results.filter((r) => r.status === 'blocked').length;
  const failed = results.filter(
    (r) => r.status === 'failed' || r.status === 'timeout',
  ).length;
  let exitCode: 0 | 1 | 2 = 0;
  if (failed > 0) exitCode = 1;
  else if (blocked > 0 && blockOnVerdict) exitCode = 2;
  return { total: results.length, approved, blocked, failed, exitCode };
}

councilCommand
  .command('on-plans')
  .argument('<phase-dir>', 'Directory containing *-PLAN.md files (e.g. .planning/phases/03-foo/)')
  .description('Dispatch council adversarial review on every PLAN.md in a phase dir (parallel)')
  .requiredOption('--org <org>', 'Org name')
  .option('--instance <id>', 'cortextos instance id (default: default)')
  .option('--agent <name>', 'Requesting agent name (default: cli)')
  .option('--member <spec...>', 'Member spec id:provider[:reasoning]; repeatable. Default: codex-high + codex-low')
  .option('--timeout-ms <ms>', '5-min default; per-request wall-clock budget', (v) => parseInt(v, 10))
  .option('--block-on-verdict', 'Exit 2 if any plan is blocked (default: report-only — exits 0 even on blocks)')
  .option('--json', 'Output raw JSON instead of human-readable summary')
  .action(async (phaseDir: string, opts: {
    org: string;
    instance?: string;
    agent?: string;
    member?: string[];
    timeoutMs?: number;
    blockOnVerdict?: boolean;
    json?: boolean;
  }) => {
    const planFiles = findPlanFiles(phaseDir);
    if (planFiles.length === 0) {
      process.stderr.write(`No *-PLAN.md files found in ${phaseDir}\n`);
      process.exit(1);
    }

    let members: CouncilMember[];
    try {
      members = (opts.member ?? []).map(parseMemberSpec);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (members.length === 0) members = defaultMembers();

    const agent = opts.agent ?? process.env.CTX_AGENT_NAME ?? 'cli';
    const instance = opts.instance ?? process.env.CTX_INSTANCE_ID ?? 'default';
    const paths = resolvePaths(agent, instance, opts.org);

    process.stderr.write(
      `council on-plans: dispatching ${planFiles.length} plan(s) × ${members.length} member(s) in parallel\n`,
    );

    const results: OnPlansResult[] = await Promise.all(
      planFiles.map(async (file): Promise<OnPlansResult> => {
        const plan = readFileSync(file, 'utf-8');
        try {
          const { request } = await runCouncil({
            paths,
            org: opts.org,
            requestingAgent: agent,
            kind: 'adversarial',
            plan,
            members,
            timeoutMs: opts.timeoutMs,
          });
          return {
            file,
            status: request.status,
            must_fix: request.merged?.must_fix ?? [],
            request_id: request.id,
          };
        } catch (err) {
          process.stderr.write(`  [error] ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
          return { file, status: 'failed', must_fix: [], request_id: '' };
        }
      }),
    );

    const summary = summarizeOnPlans(results, opts.blockOnVerdict ?? false);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
      process.exit(summary.exitCode);
    }

    process.stdout.write(
      `\n${summary.total} plan(s): ${summary.approved} approved, ${summary.blocked} blocked, ${summary.failed} failed\n\n`,
    );
    for (const r of results) {
      const tag = r.status.toUpperCase().padEnd(8);
      process.stdout.write(`  [${tag}] ${r.file}  (${r.request_id || 'no-id'})\n`);
      if (r.status === 'blocked' && r.must_fix.length > 0) {
        for (const m of r.must_fix) {
          process.stdout.write(`           - ${m}\n`);
        }
      }
    }
    if (summary.blocked > 0 && !(opts.blockOnVerdict ?? false)) {
      process.stdout.write(
        `\n(report-only: ${summary.blocked} block verdict(s) ignored. Pass --block-on-verdict to gate exit code.)\n`,
      );
    }
    process.exit(summary.exitCode);
  });
