import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryRejected,
  EmailDeliveryUnavailable,
} from '@app/email-delivery/server';
import { describe, expect, it } from 'effect-rstest';

import {
  submissionFactOfAttempt,
  submissionFactOfEmailDelivery,
  submissionFactOfEvidence,
} from '../../src/domain/history/delivery-result.ts';
import type { EmailDeliveryResult } from '../../src/domain/history/delivery-result.ts';
import type { ProviderEvidenceCase } from '../../src/domain/handoff/message-handoff.ts';

/**
 * [#1402 H-04 H-06 AC-03 AC-04 AC-10] How the answers of `EmailDeliveryService` and of the handoff port read in the history
 * vocabulary. These are the rules of ADR-0022: an accepted submission is never delivery, an unknown acceptance is never a
 * sure failure, and each technical answer keeps its own evidence.
 */
const answers = {
  accepted: { accepted: true, id: 'fixture-receipt-1' } satisfies EmailDeliveryResult,
  indeterminate: new EmailDeliveryAcceptanceIndeterminate({ reason: 'timeout' }),
  invalid: new EmailDeliveryInvalidMessage({ field: 'subject', reason: 'empty' }),
  rejected: new EmailDeliveryRejected({ reason: 'provider_rejected', status: 422 }),
  unavailable: new EmailDeliveryUnavailable({ reason: 'provider_unavailable', status: 503 }),
};

describe('EmailDeliveryService results in the history vocabulary (#1402)', () => {
  it('maps `accepted: true` to PROVIDER_ACCEPTED and never to DELIVERED', () => {
    const fact = submissionFactOfEmailDelivery(answers.accepted);
    expect(fact).toEqual({ effect: 'PRESENT', status: 'PROVIDER_ACCEPTED', technical: 'PROVIDER_ACCEPTED' });
    expect(fact.status).not.toBe('DELIVERED');
  });

  it('maps an indeterminate acceptance to INDETERMINATE with an unknown effect, never to a sure failure', () => {
    for (const reason of ['response_invalid', 'timeout', 'transport'] as const) {
      const fact = submissionFactOfEmailDelivery(new EmailDeliveryAcceptanceIndeterminate({ reason }));
      expect(fact).toEqual({
        effect: 'UNKNOWN',
        reason,
        status: 'INDETERMINATE',
        technical: 'ACCEPTANCE_INDETERMINATE',
      });
      expect(fact.status).not.toBe('FAILED');
    }
  });

  it('keeps Rejected, Unavailable and InvalidMessage as DISTINCT technical evidence', () => {
    const rejected = submissionFactOfEmailDelivery(answers.rejected);
    const unavailable = submissionFactOfEmailDelivery(answers.unavailable);
    const invalid = submissionFactOfEmailDelivery(answers.invalid);
    expect([rejected.technical, unavailable.technical, invalid.technical]).toEqual([
      'PROVIDER_REJECTED',
      'PROVIDER_UNAVAILABLE',
      'MESSAGE_INVALID',
    ]);
    // a refusal and an invalid message PROVE that nothing was accepted; an unavailable provider proves nothing of the kind
    expect([rejected.effect, invalid.effect, unavailable.effect]).toEqual(['ABSENT', 'ABSENT', 'UNKNOWN']);
    expect([rejected.status, invalid.status, unavailable.status]).toEqual(['FAILED', 'FAILED', 'INDETERMINATE']);
  });

  it('carries only the closed reason literal of the answer, never a status text or a payload', () => {
    expect(submissionFactOfEmailDelivery(answers.rejected).reason).toBe('provider_rejected');
    expect(submissionFactOfEmailDelivery(answers.invalid).reason).toBe('empty');
    expect(Object.keys(submissionFactOfEmailDelivery(answers.rejected)).toSorted()).toEqual([
      'effect',
      'reason',
      'status',
      'technical',
    ]);
  });

  it('reads the handoff vocabulary of the pre-handoff lane exactly like the EmailDeliveryService answers it comes from', () => {
    const cases: readonly [ProviderEvidenceCase, EmailDeliveryResult][] = [
      [{ kind: 'ACCEPTED', providerKey: 'fixture-provider', providerRef: 'fixture-receipt-1' }, answers.accepted],
      [{ kind: 'INDETERMINATE', reason: 'timeout' }, answers.indeterminate],
      [{ kind: 'REJECTED', reason: 'provider_rejected' }, answers.rejected],
      [{ kind: 'UNAVAILABLE', reason: 'provider_unavailable' }, answers.unavailable],
    ];
    for (const [evidence, result] of cases) {
      expect(submissionFactOfEvidence(evidence)).toEqual(submissionFactOfEmailDelivery(result));
    }
  });

  it('treats NOT_ATTEMPTED as "provably nothing was submitted": still only prepared, never accepted or failed', () => {
    expect(submissionFactOfEvidence({ kind: 'NOT_ATTEMPTED', reason: 'NO_ADAPTER_CONFIGURED' })).toEqual({
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
});
