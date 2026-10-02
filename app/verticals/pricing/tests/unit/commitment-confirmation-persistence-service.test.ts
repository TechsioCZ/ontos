import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  decodeCommitmentConfirmationRecoveryOutcome,
  decodeCommitmentConfirmationStoreOutcome,
  persistPricingCommitmentConfirmationRoutine,
  readPricingCommitmentConfirmationRoutine,
} from '../../src/services/commitment-confirmation-persistence.service.ts';
import {
  makeIssue788CommercialTotal,
  makeIssue788IssuedConfirmation,
} from './support/issue-788-confirmation.fixture.ts';

const row = <Payload>(payload: Payload): readonly [{ readonly payload: Payload }] => [{ payload }];

const recoveryEnvelope = (confirmation: ReturnType<typeof makeIssue788IssuedConfirmation>) => ({
  attemptRef: confirmation.binding.attemptRef,
  confirmation,
  confirmationRef: confirmation.confirmationRef,
  decisionBundleHash: confirmation.binding.decisionBundleHash,
  decisionBundleRef: confirmation.binding.decisionBundleRef,
  decisionBundleVersion: confirmation.binding.decisionBundleVersion,
  expiresAt: confirmation.expiresAt,
  issuedAt: confirmation.issuedAt,
  outcome: 'FOUND',
  payloadDigest: confirmation.authenticity.payloadDigest,
  proofRef: confirmation.authenticity.proofRef,
  quotationRef:
    confirmation.source.kind === 'QUOTATION_BACKED'
      ? confirmation.source.quotationRevalidation.quotation.quotationRef
      : null,
  sourceKind: confirmation.source.kind,
});

describe('Pricing Commitment Confirmation durable persistence (#788)', () => {
  it('binds the production provider to owner-scoped insert and recovery routines', () => {
    expect(persistPricingCommitmentConfirmationRoutine).toMatchObject({
      name: 'persist_pricing_commitment_confirmation_v1',
      ownerModuleKey: 'commerce.pricing',
      routineKey: 'pricing.persist-pricing-commitment-confirmation-v1',
      schema: 'pricing',
    });
    expect(readPricingCommitmentConfirmationRoutine).toMatchObject({
      name: 'read_pricing_commitment_confirmation_v1',
      ownerModuleKey: 'commerce.pricing',
      routineKey: 'pricing.read-pricing-commitment-confirmation-v1',
      schema: 'pricing',
    });
  });

  it.effect('recovers the complete immutable issued payload and exact source lineage', () =>
    Effect.gen(function* recoversImmutablePayload() {
      const total = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788IssuedConfirmation(total);
      const recovered = decodeCommitmentConfirmationRecoveryOutcome(
        confirmation.confirmationRef,
        row(recoveryEnvelope(confirmation)),
      );

      expect(recovered).toEqual({ confirmation, outcome: 'FOUND' });
      if (recovered.outcome === 'FOUND') {
        expect(recovered.confirmation.source.kind).toBe('QUOTATION_BACKED');
        expect(recovered.confirmation.terms.pricingNetCommercialTotal.amount).toBe('900');
        expect(recovered.confirmation.authenticity.payloadDigest).toBe(confirmation.authenticity.payloadDigest);
      }
    }),
  );

  it.effect('distinguishes absent, invalid payload, and normalized-envelope corruption', () =>
    Effect.gen(function* distinguishesRecoveryFailures() {
      const total = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788IssuedConfirmation(total);

      expect(
        decodeCommitmentConfirmationRecoveryOutcome(
          confirmation.confirmationRef,
          row({ confirmationRef: confirmation.confirmationRef, outcome: 'ABSENT' }),
        ),
      ).toEqual({ confirmationRef: confirmation.confirmationRef, outcome: 'ABSENT' });
      expect(
        decodeCommitmentConfirmationRecoveryOutcome(
          confirmation.confirmationRef,
          row({ ...recoveryEnvelope(confirmation), confirmation: { forbidden: 'raw evidence' } }),
        ),
      ).toEqual({
        confirmationRef: confirmation.confirmationRef,
        outcome: 'CORRUPT',
        reason: 'PAYLOAD_INVALID',
      });
      expect(
        decodeCommitmentConfirmationRecoveryOutcome(
          confirmation.confirmationRef,
          row({ ...recoveryEnvelope(confirmation), decisionBundleHash: 'sha256:changed' }),
        ),
      ).toEqual({
        confirmationRef: confirmation.confirmationRef,
        outcome: 'CORRUPT',
        reason: 'NORMALIZED_BINDING_MISMATCH',
      });
    }),
  );

  it.effect('preserves insert-only idempotency while surfacing proof-identity conflicts', () =>
    Effect.gen(function* decodesStoreOutcomes() {
      const total = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788IssuedConfirmation(total);

      expect(yield* decodeCommitmentConfirmationStoreOutcome(row({ confirmation, outcome: 'STORED' }))).toEqual({
        confirmation,
        outcome: 'STORED',
      });
      expect(yield* decodeCommitmentConfirmationStoreOutcome(row({ confirmation, outcome: 'REUSED' }))).toEqual({
        confirmation,
        outcome: 'REUSED',
      });
      expect(
        yield* decodeCommitmentConfirmationStoreOutcome(
          row({
            confirmationRef: confirmation.confirmationRef,
            outcome: 'IDENTITY_CONFLICT',
            reason: 'CONFIRMATION_OR_PROOF_IDENTITY_ALREADY_BOUND',
          }),
        ),
      ).toEqual({
        confirmationRef: confirmation.confirmationRef,
        outcome: 'IDENTITY_CONFLICT',
        reason: 'CONFIRMATION_OR_PROOF_IDENTITY_ALREADY_BOUND',
      });
    }),
  );
});
