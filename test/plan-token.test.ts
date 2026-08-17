import { describe, expect, it } from 'vitest';
import {
  canonicalPayload,
  computePlanToken,
  dedupeByFirstOccurrence,
  PLAN_TOKEN_VERSION,
  verifyPlanToken,
  type PlanFingerprint,
  type PlanScope,
} from '../src/plan-token.js';

const attachScope: PlanScope = {
  command: 'attach',
  owner: 'akholod',
  repo: 'easy-cast',
  kind: 'pr',
  number: 42,
  key: 'attach-0badc0de',
  convertPolicy: 'auto',
};

const fp = (over: Partial<PlanFingerprint> = {}): PlanFingerprint => ({
  scope: attachScope,
  sourceHashes: ['aaa', 'bbb'],
  ...over,
});

const withScope = (over: Partial<PlanScope>): PlanFingerprint =>
  fp({ scope: { ...attachScope, ...over } });

describe('plan token', () => {
  it('is stable for an unchanged fingerprint', () => {
    expect(computePlanToken(fp())).toBe(computePlanToken(fp()));
  });

  // Written against the constant rather than a literal: the version is expected
  // to move — it moved to v2 when the report spec joined the fingerprint — and a
  // hardcoded one only ever fails at the moment the change is deliberate.
  it('carries its format version so a future format is never guessed at', () => {
    expect(computePlanToken(fp())).toMatch(new RegExp(`^${PLAN_TOKEN_VERSION}\\.[0-9a-f]{64}$`));
  });

  // The five dimensions the token is claimed to bind. If any of these stopped
  // changing the token, P2's guarantee would be false.
  it('changes when the set of source files changes', () => {
    expect(computePlanToken(fp({ sourceHashes: ['aaa', 'ccc'] }))).not.toBe(computePlanToken(fp()));
  });

  it('changes when the file order changes', () => {
    expect(computePlanToken(fp({ sourceHashes: ['bbb', 'aaa'] }))).not.toBe(computePlanToken(fp()));
  });

  it('changes when the target changes', () => {
    expect(computePlanToken(withScope({ number: 43 }))).not.toBe(computePlanToken(fp()));
    expect(computePlanToken(withScope({ repo: 'other' }))).not.toBe(computePlanToken(fp()));
    expect(computePlanToken(withScope({ kind: 'issue' }))).not.toBe(computePlanToken(fp()));
  });

  it('changes when --key changes', () => {
    expect(computePlanToken(withScope({ key: 'other' }))).not.toBe(computePlanToken(fp()));
  });

  it('changes when the conversion policy changes', () => {
    expect(computePlanToken(withScope({ convertPolicy: 'none' }))).not.toBe(computePlanToken(fp()));
  });

  it('separates fields so no rearrangement of them collides', () => {
    const a = computePlanToken(withScope({ owner: 'ab', repo: 'c' }));
    const b = computePlanToken(withScope({ owner: 'a', repo: 'bc' }));
    expect(a).not.toBe(b);
  });

  it('length-prefixes every field in the canonical payload', () => {
    const payload = canonicalPayload(fp());
    expect(payload.readUInt32BE(0)).toBe(Buffer.byteLength('easy-cast/plan/v1'));
  });

  it('distinguishes an upload scope from an attach scope on the same repo', () => {
    const upload = fp({
      scope: { command: 'upload', owner: 'akholod', repo: 'easy-cast', convertPolicy: 'auto' },
    });
    expect(computePlanToken(upload)).not.toBe(computePlanToken(fp()));
  });
});

describe('duplicate handling', () => {
  it('keeps the first occurrence and drops later ones', () => {
    expect(dedupeByFirstOccurrence(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('verification', () => {
  it('accepts the token computed for the same fingerprint', () => {
    expect(verifyPlanToken(computePlanToken(fp()), fp())).toEqual({ ok: true });
  });

  it('rejects a missing token and still offers the one that would work', () => {
    const result = verifyPlanToken(undefined, fp());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.planContext.expected).toBe(computePlanToken(fp()));
  });

  it('quarantines a token from an unknown format version instead of interpreting it', () => {
    const result = verifyPlanToken('v999.' + 'f'.repeat(64), fp());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.planContext.changed).toEqual(['token-version']);
  });

  it('names which dimension moved when the previous fingerprint is known', () => {
    const previous = fp();
    const actual = withScope({ convertPolicy: 'none' });
    const result = verifyPlanToken(computePlanToken(previous), actual, previous);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.planContext.changed).toEqual(['convert-policy']);
  });

  it('reports a reordering as order, not as a change of files', () => {
    const previous = fp();
    const actual = fp({ sourceHashes: ['bbb', 'aaa'] });
    const result = verifyPlanToken(computePlanToken(previous), actual, previous);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.planContext.changed).toEqual(['order']);
  });

  it('admits it does not know what changed when the previous plan is unavailable', () => {
    const result = verifyPlanToken(`${PLAN_TOKEN_VERSION}.${'0'.repeat(64)}`, fp());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.planContext.changed).toEqual(['unknown']);
  });
});
