/**
 * hook-council-gate.ts — PermissionRequest hook that gates tools behind
 * an adversarial council review.
 *
 * Runs when CTX_COUNCIL_GATE_TOOLS lists the inbound tool_name (comma-
 * separated). For every gated call the hook synthesises a plan from
 * tool_input, dispatches a council with two codex members (low + high
 * reasoning) via the runCouncil router, and translates the merged
 * verdict into an allow/deny PermissionRequest decision.
 *
 * Default roster is codex-only (codex-high + codex-low) — opting opus into
 * a council costs an Anthropic API call per gated tool, so it stays opt-in.
 * dispatchOpus is fully implemented (S1.5–S1.7.2: Messages API, OAuth
 * keychain auth, reactive refresh, process-wide dedup, refresh backstop).
 * To enable opus on a per-agent basis, set CTX_COUNCIL_MEMBERS to a JSON
 * array including e.g. `{"id":"opus-a","provider":"opus"}`.
 *
 * Default-deny on every error path:
 *   - missing config           → deny ("council gate not configured")
 *   - council returns failed   → deny with parse/timeout reason
 *   - council returns blocked  → deny with merged must_fix list
 *   - council times out (5min) → deny ("council timed out")
 * Approve is the only path to allow.
 *
 * Wire-up: register on PermissionRequest in .claude/settings.json with
 *   "command": "cortextos bus hook-council-gate"
 *   "timeout": 360       // > 5min so the hook can finish before claude kills it
 *
 * The analyst template wires this hook on the `Bash` matcher by default and
 * sets CTX_COUNCIL_GATE_TOOLS=Bash via the settings.json env block, so any
 * Bash PermissionRequest on an analyst agent goes through the council
 * (telegram still owns Edit/Write/etc.). Other templates remain opt-in:
 * register the hook and set CTX_COUNCIL_GATE_TOOLS to activate.
 *
 * NOTE on coexistence: CTX_COUNCIL_GATE_TOOLS is a *shared coordination
 * signal*, not a private council-only filter. The catch-all
 * `hook-permission-telegram` reads the same env var and short-circuits
 * (process.exit(0), no decision emitted) for any tool listed there, so the
 * Bash matcher's council-gate becomes the sole authority on those calls
 * without telegram also asking the user. Adding/removing a tool from this
 * env CSV adjusts both hooks atomically.
 */

import { join } from 'path';
import {
  readStdin,
  parseHookInput,
  outputDecision,
  formatToolSummary,
} from './index';
import { resolvePaths } from '../utils/paths.js';
import { runCouncil } from '../council/router.js';
import type { CouncilMember } from '../council/dispatch.js';

const COUNCIL_TIMEOUT_MS = 5 * 60 * 1000;

interface GateEnv {
  agentName: string;
  instanceId: string;
  org: string;
  gatedTools: Set<string>;
  members: CouncilMember[];
}

function loadGateEnv(): GateEnv {
  const agentName = process.env.CTX_AGENT_NAME || require('path').basename(process.cwd());
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const org = process.env.CTX_COUNCIL_ORG || process.env.CTX_ORG || agentName;

  const gatedTools = new Set(
    (process.env.CTX_COUNCIL_GATE_TOOLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Default member roster: two codex members at different reasoning
  // levels. CTX_COUNCIL_MEMBERS overrides as JSON array of CouncilMember.
  const membersRaw = process.env.CTX_COUNCIL_MEMBERS;
  let members: CouncilMember[];
  if (membersRaw) {
    try {
      members = JSON.parse(membersRaw);
    } catch {
      members = [];
    }
  } else {
    members = [
      { id: 'codex-high', provider: 'codex', reasoning_effort: 'high' },
      { id: 'codex-low', provider: 'codex', reasoning_effort: 'low' },
    ];
  }

  return { agentName, instanceId, org, gatedTools, members };
}

function synthesizePlan(toolName: string, toolInput: unknown): string {
  const summary = formatToolSummary(toolName, toolInput);
  return `Tool: ${toolName}\n\n${summary}`;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  const env = loadGateEnv();

  // Pass-through: gate is opt-in. If the tool isn't listed, allow.
  if (env.gatedTools.size === 0 || !env.gatedTools.has(tool_name)) {
    outputDecision('allow');
    return;
  }

  if (env.members.length === 0) {
    outputDecision('deny', 'council gate: CTX_COUNCIL_MEMBERS misconfigured (empty roster)');
    return;
  }

  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const plan = synthesizePlan(tool_name, tool_input);

  let request;
  try {
    const result = await runCouncil({
      paths,
      org: env.org,
      requestingAgent: env.agentName,
      kind: 'adversarial',
      plan,
      members: env.members,
      timeoutMs: COUNCIL_TIMEOUT_MS,
    });
    request = result.request;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outputDecision('deny', `council gate: dispatch failed — ${reason}`);
    return;
  }

  // Build a forensic suffix that links back to the per-request CWD.
  const cwdHint = join('pipelines/state/council', request.id);

  if (request.status === 'approved') {
    outputDecision('allow');
    return;
  }

  if (request.status === 'blocked') {
    const mustFix = request.merged?.must_fix ?? [];
    const summary = mustFix.length > 0
      ? mustFix.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(no must_fix items returned)';
    outputDecision(
      'deny',
      `council blocked the call:\n${summary}\n\nForensics: ${cwdHint}`,
    );
    return;
  }

  // status === 'failed' (or any unexpected non-terminal status)
  const errors = request.results
    .map((r) => `${r.member_id}: ${r.error ?? 'no error reported'}`)
    .join('; ');
  outputDecision(
    'deny',
    `council ${request.status} — ${errors}\nForensics: ${cwdHint}`,
  );
}

main().catch((err) => {
  process.stderr.write(`hook-council-gate error: ${err}\n`);
  outputDecision('deny', `Hook error: ${err}`);
});
