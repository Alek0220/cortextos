import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  signVerdict,
  verifyVerdict,
  loadOrCreateKeypair,
  canonicalize,
} from '../../../src/council/signing.js';
import type { CouncilVerdictJson, SignedVerdictEnvelope } from '../../../src/types/index.js';

const VERDICT: CouncilVerdictJson = {
  verdict: 'approve',
  concerns: ['minor: spelling in error message'],
  must_fix: [],
};

let tmpDir: string;
let prevKeyPath: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-signing-test-'));
  prevKeyPath = process.env.CORTEXTOS_COUNCIL_KEY_PATH;
  process.env.CORTEXTOS_COUNCIL_KEY_PATH = join(tmpDir, 'keypair.json');
});

afterEach(() => {
  if (prevKeyPath === undefined) delete process.env.CORTEXTOS_COUNCIL_KEY_PATH;
  else process.env.CORTEXTOS_COUNCIL_KEY_PATH = prevKeyPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('canonicalize', () => {
  it('produces stable output regardless of key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested structures with sorted keys', () => {
    const out = canonicalize({ z: { b: 2, a: 1 }, a: [1, 2] });
    expect(out).toBe('{"a":[1,2],"z":{"a":1,"b":2}}');
  });
});

describe('loadOrCreateKeypair', () => {
  it('creates a keypair on first call and persists it', async () => {
    const kp1 = await loadOrCreateKeypair();
    expect(kp1.algorithm).toBe('ed25519');
    expect(kp1.secret_key_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp1.public_key_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(process.env.CORTEXTOS_COUNCIL_KEY_PATH!)).toBe(true);
  });

  it('returns the same keypair on subsequent calls', async () => {
    const kp1 = await loadOrCreateKeypair();
    const kp2 = await loadOrCreateKeypair();
    expect(kp2.secret_key_hex).toBe(kp1.secret_key_hex);
    expect(kp2.public_key_hex).toBe(kp1.public_key_hex);
  });
});

describe('signVerdict + verifyVerdict round-trip', () => {
  it('verifies a freshly signed envelope', async () => {
    const env = await signVerdict({
      verdict: VERDICT,
      council_id: 'council_1234567890_abcde',
      members: ['opus', 'codex'],
    });
    expect(env.algorithm).toBe('ed25519');
    expect(env.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(await verifyVerdict(env)).toBe(true);
  });

  it('uses the persisted public key in the envelope', async () => {
    const kp = await loadOrCreateKeypair();
    const env = await signVerdict({
      verdict: VERDICT,
      council_id: 'c1',
      members: ['opus'],
    });
    expect(env.signing_pubkey).toBe(kp.public_key_hex);
  });
});

describe('tamper detection', () => {
  let env: SignedVerdictEnvelope;

  beforeEach(async () => {
    env = await signVerdict({
      verdict: VERDICT,
      council_id: 'council_x',
      members: ['opus', 'codex'],
    });
  });

  it('detects a flipped verdict', async () => {
    const tampered: SignedVerdictEnvelope = {
      ...env,
      verdict: { ...env.verdict, verdict: 'block' },
    };
    expect(await verifyVerdict(tampered)).toBe(false);
  });

  it('detects a mutated council_id', async () => {
    expect(await verifyVerdict({ ...env, council_id: 'council_y' })).toBe(false);
  });

  it('detects a mutated member list', async () => {
    expect(await verifyVerdict({ ...env, members: ['opus'] })).toBe(false);
  });

  it('detects a mutated timestamp', async () => {
    expect(await verifyVerdict({ ...env, timestamp: '2099-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('detects an injected concern', async () => {
    const tampered: SignedVerdictEnvelope = {
      ...env,
      verdict: { ...env.verdict, concerns: [...env.verdict.concerns, 'injected concern'] },
    };
    expect(await verifyVerdict(tampered)).toBe(false);
  });

  it('detects a mutated signature', async () => {
    const flipFirstByte = (env.signature[0] === '0' ? '1' : '0') + env.signature.slice(1);
    expect(await verifyVerdict({ ...env, signature: flipFirstByte })).toBe(false);
  });

  it('rejects an unknown algorithm', async () => {
    expect(await verifyVerdict({ ...env, algorithm: 'rsa' as 'ed25519' })).toBe(false);
  });
});

describe('keypair file persistence shape', () => {
  it('keypair.json on disk parses to the expected shape', async () => {
    await loadOrCreateKeypair();
    const raw = readFileSync(process.env.CORTEXTOS_COUNCIL_KEY_PATH!, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      algorithm: 'ed25519',
      created_at: expect.any(String),
      secret_key_hex: expect.stringMatching(/^[0-9a-f]{64}$/),
      public_key_hex: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
