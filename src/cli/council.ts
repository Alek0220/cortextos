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
import { readFileSync, existsSync } from 'fs';
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
