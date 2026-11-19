import { describe, expect, it } from 'effect-rstest';

import { submissionFactOfAttempt } from '../../src/domain/history/delivery-result.ts';
import type { AttemptState } from '../../src/domain/history/vocabulary.ts';

/**
 * [#1402 H-04 H-06 AC-03 AC-04 AC-10] How a stored submission answer reads in the history vocabulary. There is ONE path
 * (`submissionFactOfAttempt`, the one production uses). These are the rules of ADR-0022: an accepted submission is never
 * delivery, an unknown acceptance is never a sure failure, an unusable configuration made no request, and each technical
 * answer keeps its own evidence.
 */
describe('A stored submission answer in the history vocabulary (#1402)', () => {
  it('maps ACCEPTED (`accepted: true`) to PROVIDER_ACCEPTED and never to DELIVERED', () => {
    const fact = submissionFactOfAttempt('ACCEPTED');
    expect(fact).toEqual({ effect: 'PRESENT', status: 'PROVIDER_ACCEPTED', technical: 'PROVIDER_ACCEPTED' });
    expect(fact.status).not.toBe('DELIVERED');
  });

  it('maps an indeterminate acceptance to INDETERMINATE with an unknown effect, never to a sure failure', () => {
    for (const reason of ['response_invalid', 'timeout', 'transport'] as const) {
      const fact = submissionFactOfAttempt('INDETERMINATE', reason);
      expect(fact).toEqual({
        effect: 'UNKNOWN',
        reason,
        status: 'INDETERMINATE',
        technical: 'ACCEPTANCE_INDETERMINATE',
      });
      expect(fact.status).not.toBe('FAILED');
    }
  });

  it('keeps Rejected, Unavailable and an unconfigured deployment as DISTINCT technical evidence', () => {
    const rejected = submissionFactOfAttempt('REJECTED', 'provider_rejected');
    const unavailable = submissionFactOfAttempt('UNAVAILABLE', 'provider_unavailable');
    const unconfigured = submissionFactOfAttempt('UNAVAILABLE', 'configuration');
    expect([rejected.technical, unavailable.technical, unconfigured.technical]).toEqual([
      'PROVIDER_REJECTED',
      'PROVIDER_UNAVAILABLE',
      'NOT_ATTEMPTED',
    ]);
    // a refusal PROVES that nothing was accepted; an unavailable provider proves nothing of the kind
    expect([rejected.effect, unavailable.effect]).toEqual(['ABSENT', 'UNKNOWN']);
    expect([rejected.status, unavailable.status]).toEqual(['FAILED', 'INDETERMINATE']);
  });

  it('reads `configuration` (no request was made) exactly like NOT_ATTEMPTED, and every other unavailable reason as unknown', () => {
    const unconfigured = submissionFactOfAttempt('UNAVAILABLE', 'configuration');
    expect(unconfigured).toEqual({
      effect: 'ABSENT',
      reason: 'configuration',
      status: 'PREPARED',
      technical: 'NOT_ATTEMPTED',
    });
    expect(unconfigured.status).not.toBe('INDETERMINATE');
    // a 5xx, a transport failure and an unknown reason say nothing about whether the provider took the message
    for (const reason of ['provider_unavailable', undefined, 'unexpected']) {
      expect(submissionFactOfAttempt('UNAVAILABLE', reason)).toMatchObject({
        effect: 'UNKNOWN',
        status: 'INDETERMINATE',
        technical: 'PROVIDER_UNAVAILABLE',
      });
    }
    expect(submissionFactOfAttempt('INDETERMINATE', 'transport').effect).toBe('UNKNOWN');
  });

  it('keeps an invalid message expressible as a PROVEN failure with its own evidence (no stored attempt state carries it yet)', () => {
    expect(submissionFactOfAttempt('MESSAGE_INVALID', 'empty')).toEqual({
      effect: 'ABSENT',
      reason: 'empty',
      status: 'FAILED',
      technical: 'MESSAGE_INVALID',
    });
  });

  it('carries only the closed reason literal of the answer, never a status text or a payload', () => {
    expect(submissionFactOfAttempt('REJECTED', 'provider_rejected').reason).toBe('provider_rejected');
    expect(Object.keys(submissionFactOfAttempt('REJECTED', 'provider_rejected')).toSorted()).toEqual([
      'effect',
      'reason',
      'status',
      'technical',
    ]);
  });

  it('treats NOT_ATTEMPTED as "provably nothing was submitted": still only prepared, never accepted or failed', () => {
    expect(submissionFactOfAttempt('NOT_ATTEMPTED', 'NO_ADAPTER_CONFIGURED')).toEqual({
      effect: 'ABSENT',
      reason: 'NO_ADAPTER_CONFIGURED',
      status: 'PREPARED',
      technical: 'NOT_ATTEMPTED',
    });
  });

  it('reads an attempt that began without an answer as SUBMITTED with an unknown effect, neither accepted nor failed', () => {
    expect(submissionFactOfAttempt('PREPARED')).toEqual({
      effect: 'UNKNOWN',
      status: 'PROVIDER_SUBMITTED',
      technical: 'SUBMISSION_STARTED',
    });
  });

  it('answers every stored attempt state: no state is left to another reading', () => {
    const states: readonly AttemptState[] = [
      'ACCEPTED',
      'INDETERMINATE',
      'NOT_ATTEMPTED',
      'PREPARED',
      'REJECTED',
      'UNAVAILABLE',
    ];
    expect(states.map((state) => submissionFactOfAttempt(state).technical)).toEqual([
      'PROVIDER_ACCEPTED',
      'ACCEPTANCE_INDETERMINATE',
      'NOT_ATTEMPTED',
      'SUBMISSION_STARTED',
      'PROVIDER_REJECTED',
      'PROVIDER_UNAVAILABLE',
    ]);
  });
});
