import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  CouncilKind,
  CouncilMemberResult,
  CouncilRequest,
  CouncilStatus,
  CouncilVerdictJson,
  SignedVerdictEnvelope,
  BusPaths,
} from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { validateOrgName } from '../utils/validate.js';

/**
 * Council state lives at `{ctxRoot}/pipelines/state/council/{id}/`. The
 * directory doubles as the per-request CWD passed to codex spawn so two
 * concurrent councils never collide on rollout files or response files.
 * (See advisor S1 review item #5 — "per-request CWD enables parallel
 * safety; uniqueId response files prevent cross-talk.")
 *
 * Inside each council dir:
 *   request.json       — the CouncilRequest record (atomic-written)
 *   stdout-{member}.txt — codex/opus raw stdout per member (debug)
 *   stderr-{member}.txt — captured stderr per member
 *
 * Status transitions:
 *   pending → running → (approved | blocked | failed | timeout)
 *
 * NOTE: Unlike `bus/approval.ts`, councils are NOT split into pending/
 * resolved subdirectories — the `status` field on the record is the
 * source of truth, and listing helpers filter on it. Councils have a
 * shorter lifecycle (5-min default budget) and the dashboard wants to
 * see resolved-with-context in the same place as pending, so a single
 * directory keeps the file walk simple.
 */

export function councilDir(paths: BusPaths, id: string): string {
  return join(paths.ctxRoot, 'pipelines', 'state', 'council', id);
}

function councilRoot(paths: BusPaths): string {
  return join(paths.ctxRoot, 'pipelines', 'state', 'council');
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Create a new council request in `pending` status. The caller (router.ts)
 * is responsible for transitioning to `running`, dispatching members, and
 * calling `finalizeCouncil` when quorum is reached.
 *
 * Synchronous — no Telegram fan-out (councils are agent-internal). The
 * dashboard reads council state from disk via the same shape.
 */
export function createCouncil(
  paths: BusPaths,
  org: string,
  requestingAgent: string,
  kind: CouncilKind,
  plan: string,
): CouncilRequest {
  validateOrgName(org);

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const id = `council_${epoch}_${rand}`;
  const now = nowIso();

  const request: CouncilRequest = {
    id,
    kind,
    org,
    requesting_agent: requestingAgent,
    plan,
    status: 'pending',
    created_at: now,
    updated_at: now,
    resolved_at: null,
    results: [],
    merged: null,
    signed_envelope: null,
    outcome: null,
    outcome_labeled_at: null,
  };

  const dir = councilDir(paths, id);
  ensureDir(dir);
  atomicWriteSync(join(dir, 'request.json'), JSON.stringify(request, null, 2));

  return request;
}

export function readCouncil(paths: BusPaths, id: string): CouncilRequest {
  const file = join(councilDir(paths, id), 'request.json');
  return JSON.parse(readFileSync(file, 'utf-8')) as CouncilRequest;
}

export function writeCouncil(paths: BusPaths, request: CouncilRequest): void {
  const file = join(councilDir(paths, request.id), 'request.json');
  atomicWriteSync(file, JSON.stringify(request, null, 2));
}

export function setCouncilStatus(
  paths: BusPaths,
  id: string,
  status: CouncilStatus,
): CouncilRequest {
  const request = readCouncil(paths, id);
  request.status = status;
  request.updated_at = nowIso();
  if (status === 'approved' || status === 'blocked' || status === 'failed' || status === 'timeout') {
    request.resolved_at = request.updated_at;
  }
  writeCouncil(paths, request);
  return request;
}

export function appendMemberResult(
  paths: BusPaths,
  id: string,
  result: CouncilMemberResult,
): CouncilRequest {
  const request = readCouncil(paths, id);
  request.results.push(result);
  request.updated_at = nowIso();
  writeCouncil(paths, request);
  return request;
}

/**
 * Mark a council resolved with a merged verdict. Sets status to
 * 'approved' or 'blocked' based on the merged verdict, or 'failed'
 * when the merger could not produce a verdict (e.g., every member
 * returned null).
 */
export function finalizeCouncil(
  paths: BusPaths,
  id: string,
  merged: CouncilVerdictJson | null,
  signedEnvelope: SignedVerdictEnvelope | null = null,
): CouncilRequest {
  const request = readCouncil(paths, id);
  request.merged = merged;
  request.signed_envelope = signedEnvelope;
  request.updated_at = nowIso();
  request.resolved_at = request.updated_at;
  if (!merged) {
    request.status = 'failed';
    request.outcome = null;
    request.outcome_labeled_at = null;
  } else {
    request.status = merged.verdict === 'approve' ? 'approved' : 'blocked';
    // Council-self trajectory label (ruflo W1): merged verdict IS the outcome.
    request.outcome = merged.verdict === 'approve' ? 'success' : 'failure';
    request.outcome_labeled_at = request.updated_at;
  }
  writeCouncil(paths, request);
  return request;
}

export function listCouncils(paths: BusPaths, statusFilter?: CouncilStatus): CouncilRequest[] {
  const root = councilRoot(paths);
  let ids: string[];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('council_'))
      .map((d) => d.name);
  } catch {
    return [];
  }

  const out: CouncilRequest[] = [];
  for (const id of ids) {
    try {
      const req = readCouncil(paths, id);
      if (!statusFilter || req.status === statusFilter) {
        out.push(req);
      }
    } catch {
      // Skip corrupt — surfaced separately by `cortextos doctor`.
    }
  }
  return out.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export function listPendingCouncils(paths: BusPaths): CouncilRequest[] {
  return listCouncils(paths).filter((c) => c.status === 'pending' || c.status === 'running');
}
