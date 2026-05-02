/**
 * council/signing.ts — ed25519 signed envelopes for merged council verdicts (S1.8).
 *
 * Single-machine, sign-only. The signature proves "this verdict came out of
 * THIS cortextOS install at THIS time covering THIS member set" — useful for
 * later forensics and to detect verdict tampering between finalize and any
 * downstream consumer (dashboard, telegram audit log).
 *
 * Out of scope: mTLS, HMAC, key rotation, multi-machine federation. Those
 * belong to the (future) Supabase + A2A path, not here.
 *
 * Keypair lives at `~/.cortextos/council/keypair.json` (mode 0600). One
 * keypair per machine — generated lazily on first sign. Override the path
 * via `CORTEXTOS_COUNCIL_KEY_PATH` for tests.
 *
 * Envelope shape (canonical-JSON-serialized over the {verdict, council_id,
 * members, timestamp} payload, sorted keys, then ed25519-signed):
 *   {
 *     verdict: CouncilVerdictJson,
 *     council_id: string,
 *     members: string[],            // member ids that contributed (any verdict, incl. null)
 *     timestamp: string,            // ISO 8601, signing time
 *     signing_pubkey: string,       // hex
 *     signature: string,            // hex
 *     algorithm: 'ed25519'
 *   }
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import * as ed from '@noble/ed25519';
import type { CouncilVerdictJson } from '../types/index.js';

interface StoredKeypair {
  algorithm: 'ed25519';
  created_at: string;
  secret_key_hex: string;
  public_key_hex: string;
}

export interface SignedVerdictEnvelope {
  verdict: CouncilVerdictJson;
  council_id: string;
  members: string[];
  timestamp: string;
  signing_pubkey: string;
  signature: string;
  algorithm: 'ed25519';
}

function defaultKeyPath(): string {
  return process.env.CORTEXTOS_COUNCIL_KEY_PATH ?? join(homedir(), '.cortextos', 'council', 'keypair.json');
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Canonical JSON serialization: object keys sorted lexicographically at every
 * depth; arrays preserve insertion order; primitives via JSON.stringify.
 * Two semantically equal payloads always produce the same byte string.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export async function loadOrCreateKeypair(): Promise<StoredKeypair> {
  const path = defaultKeyPath();
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8')) as StoredKeypair;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const secretBytes = ed.utils.randomSecretKey();
  const publicBytes = await ed.getPublicKeyAsync(secretBytes);
  const kp: StoredKeypair = {
    algorithm: 'ed25519',
    created_at: new Date().toISOString(),
    secret_key_hex: bytesToHex(secretBytes),
    public_key_hex: bytesToHex(publicBytes),
  };
  writeFileSync(path, JSON.stringify(kp, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return kp;
}

interface SigningInput {
  verdict: CouncilVerdictJson;
  council_id: string;
  members: string[];
  /** Optional override (tests). Defaults to now. */
  timestamp?: string;
}

export async function signVerdict(input: SigningInput): Promise<SignedVerdictEnvelope> {
  const kp = await loadOrCreateKeypair();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const payload = {
    verdict: input.verdict,
    council_id: input.council_id,
    members: input.members,
    timestamp,
  };
  const msg = new TextEncoder().encode(canonicalize(payload));
  const sig = await ed.signAsync(msg, hexToBytes(kp.secret_key_hex));
  return {
    ...payload,
    signing_pubkey: kp.public_key_hex,
    signature: bytesToHex(sig),
    algorithm: 'ed25519',
  };
}

export async function verifyVerdict(envelope: SignedVerdictEnvelope): Promise<boolean> {
  if (envelope.algorithm !== 'ed25519') return false;
  const { signature, signing_pubkey, algorithm: _alg, ...payload } = envelope;
  const msg = new TextEncoder().encode(canonicalize(payload));
  try {
    return await ed.verifyAsync(hexToBytes(signature), msg, hexToBytes(signing_pubkey));
  } catch {
    return false;
  }
}
