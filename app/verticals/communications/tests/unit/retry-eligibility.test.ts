import { describe, expect, it } from 'effect-rstest';

import { recoveryPolicyOf, resendPolicyOf } from '../../src/domain/catalog/message-type.ts';
import { assessAttemptHistory, confirmContinuation } from '../../src/domain/recovery/retry-eligibility.ts';
import type { CurrentGates } from '../../src/domain/recovery/retry-eligibility.ts';
import { rejectionClassOf } from '../../src/domain/recovery/vocabulary.ts';
import { fixtureRecovery, fixtureType } from './support/catalog-fixtures.ts';
import { ATTEMPT_1, ATTEMPT_2, attempt, conflict, factsOf, minute, observation } from './support/history-fixtures.ts';

/**
 * [#1403 R-01 R-04 R-05 R-06 AC-01 AC-02 AC-07] Retry eligibility is decided over the append-only history and the approved
 * recovery rule of the type: only a PROVEN non-acceptance (nothing submitted, a provider refusal, a reconciled non-acceptance)
 * can lead to another attempt of the same intent; a timeout, an unavailable provider and an indeterminate answer never can.
 */
const approved = { kind: 'RETRY_ON_PROVEN_NON_ACCEPTANCE', maxAttempts: 3 } as const;
const none = { kind: 'NONE' } as const;
const temporary = { reason: 'rate_limited' } as const;
const cleared: CurrentGates = { kind: 'CLEARED' };

describe('assessAttemptHistory: what the history and the approved rule allow before any gate is asked', () => {
  it('[S02] an intent with no attempt yet is the first handoff: no recovery rule is involved', () => {
    expect(assessAttemptHistory(factsOf({}), none)).toEqual({ kind: 'FIRST_ATTEMPT' });
    expect(assessAttemptHistory(factsOf({}), approved)).toEqual({ kind: 'FIRST_ATTEMPT' });
  });

  it('an attempt that provably submitted nothing leaves the intent open, with no rule needed', () => {
    for (const submitted of [attempt('NOT_ATTEMPTED'), attempt('UNAVAILABLE', { reason: 'configuration' })]) {
      expect(assessAttemptHistory(factsOf({ attempts: [submitted] }), none)).toEqual({
        basis: { kind: 'PRIOR_NOT_ATTEMPTED' },
        kind: 'CONTINUE',
        previousAttemptId: ATTEMPT_1,
      });
    }
  });

  it('[S01 AC-01] a proven TEMPORARY refusal continues the SAME intent when, and only when, the type approved a recovery rule', () => {
    const facts = factsOf({ attempts: [attempt('REJECTED', temporary)] });
    expect(assessAttemptHistory(facts, approved)).toEqual({
      basis: { kind: 'PRIOR_REJECTED' },
      kind: 'CONTINUE',
      previousAttemptId: ATTEMPT_1,
    });
    // [S03 AC-07] without a rule automatic action halts and says why: it never invents one
    expect(assessAttemptHistory(facts, none)).toEqual({ attemptId: ATTEMPT_1, code: 'NO_RECOVERY_RULE', kind: 'HALT' });
  });

  it("[R-13 AC-07] the owner's own approved limit of submitted attempts halts further automatic action", () => {
    const twice = factsOf({
      attempts: [
        attempt('REJECTED', { ...temporary, id: ATTEMPT_1 }),
        attempt('REJECTED', { ...temporary, id: ATTEMPT_2, number: 2, prepared: 5 }),
      ],
    });
    expect(assessAttemptHistory(twice, { ...approved, maxAttempts: 3 })).toMatchObject({
      kind: 'CONTINUE',
      previousAttemptId: ATTEMPT_2,
    });
    expect(assessAttemptHistory(twice, { ...approved, maxAttempts: 2 })).toEqual({
      attemptId: ATTEMPT_2,
      code: 'RECOVERY_LIMIT_REACHED',
      kind: 'HALT',
    });
    // an attempt that submitted nothing is not counted against the owner's limit
    const withNothingSubmitted = factsOf({
      attempts: [
        attempt('NOT_ATTEMPTED'),
        attempt('REJECTED', { ...temporary, id: ATTEMPT_2, number: 2, prepared: 5 }),
      ],
    });
    expect(assessAttemptHistory(withNothingSubmitted, { ...approved, maxAttempts: 2 })).toMatchObject({
      kind: 'CONTINUE',
    });
  });

  it('[R-10 AC-03] a permanent refusal stops for good, whatever the rule says, and any unreadable refusal reason is permanent', () => {
    for (const reason of ['provider_rejected', 'something_new', undefined]) {
      const facts = factsOf({ attempts: [attempt('REJECTED', reason === undefined ? {} : { reason })] });
      for (const policy of [none, approved]) {
        expect(assessAttemptHistory(facts, policy)).toMatchObject({
          attemptId: ATTEMPT_1,
          kind: 'STOP',
          reasons: [{ category: 'PERMANENT_REJECTION', proven: true }],
        });
      }
    }
    expect(rejectionClassOf('rate_limited')).toBe('TEMPORARY');
    expect(rejectionClassOf('provider_rejected')).toBe('PERMANENT');
  });

  it('[S04 AC-02 R-05] an unknown effect never leads to another attempt, whatever the rule says: reconcile first', () => {
    for (const state of ['PREPARED', 'INDETERMINATE', 'UNAVAILABLE'] as const) {
      expect(assessAttemptHistory(factsOf({ attempts: [attempt(state)] }), approved)).toEqual({
        kind: 'SKIP',
        reason: 'RECONCILIATION_REQUIRED',
      });
    }
  });

  it('[S05] an acceptance is never repeated: not an answer, not a reconciliation, not a delivery', () => {
    expect(assessAttemptHistory(factsOf({ attempts: [attempt('ACCEPTED')] }), approved)).toEqual({
      kind: 'SKIP',
      reason: 'ALREADY_FINISHED',
    });
    expect(
      assessAttemptHistory(
        factsOf({
          attempts: [attempt('INDETERMINATE')],
          observations: [observation('ACCEPTANCE_PROVEN', { observed: 10 })],
        }),
        approved,
      ),
    ).toEqual({ kind: 'SKIP', reason: 'ALREADY_FINISHED' });
  });

  it('[S06] a reconciled NON-acceptance continues the same intent under the same rule; the unknown answer stays in the history', () => {
    const proof = observation('NON_ACCEPTANCE_PROVEN', { observed: 10 });
    const facts = factsOf({ attempts: [attempt('INDETERMINATE')], observations: [proof] });
    expect(assessAttemptHistory(facts, approved)).toEqual({
      basis: { kind: 'RECONCILED_NON_ACCEPTANCE', observationId: proof.observationId },
      kind: 'CONTINUE',
      previousAttemptId: ATTEMPT_1,
    });
    expect(assessAttemptHistory(facts, none)).toEqual({ attemptId: ATTEMPT_1, code: 'NO_RECOVERY_RULE', kind: 'HALT' });
    // a reconciled non-acceptance after a provider answer that was UNAVAILABLE (5xx) is the same proof
    expect(
      assessAttemptHistory(
        factsOf({ attempts: [attempt('UNAVAILABLE', { reason: 'provider_unavailable' })], observations: [proof] }),
        approved,
      ),
    ).toMatchObject({ kind: 'CONTINUE' });
  });

  it('[H-07] contradictory evidence and unresolved conflicts of provider evidence are reconciled, never resolved in favour of sending', () => {
    expect(
      assessAttemptHistory(
        factsOf({
          attempts: [attempt('INDETERMINATE')],
          observations: [
            observation('ACCEPTANCE_PROVEN', { observed: 10 }),
            observation('NON_ACCEPTANCE_PROVEN', { observed: 11 }),
          ],
        }),
        approved,
      ),
    ).toEqual({ kind: 'SKIP', reason: 'RECONCILIATION_REQUIRED' });
    const proof = observation('NON_ACCEPTANCE_PROVEN', { observed: 10 });
    const withConflict = (settled: ReturnType<typeof conflict>) =>
      factsOf({ attempts: [attempt('INDETERMINATE')], conflicts: [settled], observations: [proof] });
    const open = conflict('NON_ACCEPTANCE_PROVEN', { observationId: proof.observationId, observed: 11 });
    expect(assessAttemptHistory(withConflict(open), approved)).toEqual({
      kind: 'SKIP',
      reason: 'RECONCILIATION_REQUIRED',
    });
    // a resolution is an appended fact: the conflict stays in the facts and no longer blocks
    const resolved = conflict('NON_ACCEPTANCE_PROVEN', {
      observationId: proof.observationId,
      observed: 11,
      resolved: 12,
    });
    expect(assessAttemptHistory(withConflict(resolved), approved)).toMatchObject({ kind: 'CONTINUE' });
  });
});

describe('confirmContinuation: the Current gates asked AGAIN, and the history guard has the last word', () => {
  const retry = assessAttemptHistory(factsOf({ attempts: [attempt('REJECTED', temporary)] }), approved);
  const facts = factsOf({ attempts: [attempt('REJECTED', temporary)] });

  it('begins the next attempt of the same intent only when every gate cleared, with the basis that was proven', () => {
    expect(retry.kind).toBe('CONTINUE');
    if (retry.kind !== 'CONTINUE') {
      return;
    }
    expect(confirmContinuation(facts, retry, cleared, minute(30))).toEqual({
      basis: { kind: 'PRIOR_REJECTED' },
      kind: 'BEGIN_RETRY',
      previousAttemptId: ATTEMPT_1,
    });
  });

  it('[R-06 AC-03] a gate that stops (Privacy NOT_ALLOWED or INDETERMINATE, an ended endpoint, a stale source) stops with its reasons', () => {
    const reasons = [{ category: 'PRIVACY_NOT_ALLOWED', cause: 'FIXTURE', proven: true }] as const;
    if (retry.kind !== 'CONTINUE') {
      return;
    }
    expect(confirmContinuation(facts, retry, { kind: 'STOPPED', reasons }, minute(30))).toEqual({
      kind: 'STOP',
      reasons,
    });
  });

  it('[R-06] an evaluation made BEFORE the latest reconciliation evidence is not Current: a stale ALLOWED never opens a send', () => {
    const proof = observation('NON_ACCEPTANCE_PROVEN', { observed: 10, recorded: 20 });
    const reconciled = factsOf({ attempts: [attempt('INDETERMINATE')], observations: [proof] });
    const assessment = assessAttemptHistory(reconciled, approved);
    if (assessment.kind !== 'CONTINUE') {
      expect(assessment.kind).toBe('CONTINUE');
      return;
    }
    expect(confirmContinuation(reconciled, assessment, cleared, minute(19))).toEqual({
      kind: 'SKIP',
      reason: 'RECONCILIATION_REQUIRED',
    });
    expect(confirmContinuation(reconciled, assessment, cleared, minute(21))).toMatchObject({ kind: 'BEGIN_RETRY' });
  });

  it('the first attempt of an intent begins with no basis and no previous attempt', () => {
    expect(confirmContinuation(factsOf({}), { kind: 'FIRST_ATTEMPT' }, cleared, minute(3))).toEqual({
      kind: 'BEGIN_FIRST',
    });
  });
});

describe('the approved recovery and resend attributes of a type (platform catalog, no tenant override)', () => {
  it('[AC-07 AC-10] default to NONE and NOT_ALLOWED: a type that declares nothing never recovers or resends on its own', () => {
    const plain = fixtureType();
    expect(recoveryPolicyOf(plain)).toEqual({ kind: 'NONE' });
    expect(resendPolicyOf(plain)).toBe('NOT_ALLOWED');
    const approvedType = fixtureType({ recovery: fixtureRecovery(2), resend: 'SOURCE_APPROVED' });
    expect(recoveryPolicyOf(approvedType)).toEqual({ kind: 'RETRY_ON_PROVEN_NON_ACCEPTANCE', maxAttempts: 2 });
    expect(resendPolicyOf(approvedType)).toBe('SOURCE_APPROVED');
  });

  it("[AC-07] has no way to express an approved rule without the owner's own limit, or a limit that is not positive", () => {
    expect(() => fixtureType({ recovery: { kind: 'RETRY_ON_PROVEN_NON_ACCEPTANCE' } })).toThrow();
    expect(() => fixtureType({ recovery: fixtureRecovery(0) })).toThrow();
    expect(() => fixtureType({ recovery: { kind: 'RETRY_FOREVER' } })).toThrow();
    expect(() => fixtureType({ resend: 'ANYONE' })).toThrow();
  });
});
