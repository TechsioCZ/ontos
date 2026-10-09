import {
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationIssuedOutcomeSchema,
  PricingCommitmentConfirmationSourceInvalidSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePricingCurrentBackedConfirmationIssuanceService,
  PricingCurrentBackedConfirmationBindingRejected,
} from '../../src/services/current-backed-confirmation-issuance.service.ts';
import { projectPricingCommercialTotal } from '../../src/services/commercial-total-projection.service.ts';
import {
  issue788ConfirmationAuthenticity,
  issue788IssuedAt,
  makeIssue788Binding,
  makeIssue788CommercialTotal,
  makeIssue788CurrentSource,
} from './support/issue-788-confirmation.fixture.ts';

describe('Current-backed Pricing Commitment Confirmation issuance', () => {
  it.effect('supports owner-internal binding-only issuance by resolving a new complete Current source', () =>
    Effect.gen(function* issuesFromBindingOnly() {
      const commercialTotal = yield* makeIssue788CommercialTotal('950');
      const binding = makeIssue788Binding(commercialTotal);
      const source = makeIssue788CurrentSource(commercialTotal);
      const publication = yield* projectPricingCommercialTotal(commercialTotal);
      let sourceResolutions = 0;
      const service = makePricingCurrentBackedConfirmationIssuanceService({
        bindingAuthority: { verifyUnchangedBinding: () => Effect.void },
        currentEvaluation: {
          evaluate: Effect.succeed({
            acceptedAttempt: source.currentness.attempt,
            attempts: 1,
            currentness: source.currentness,
            outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED' as const,
            publication,
          }),
        },
        proofIssuer: {
          issueProof: () =>
            Effect.succeed({
              authenticity: issue788ConfirmationAuthenticity,
              confirmationRef: 'pricing-confirmation:788:binding-only',
            }),
        },
        sourceAuthority: {
          resolveCurrentSource: () => {
            sourceResolutions += 1;
            return Effect.succeed(source);
          },
        },
        trustedTime: { readIssuedAt: Effect.succeed(issue788IssuedAt) },
        validityPolicy: { selectDurationMilliseconds: () => Effect.succeed(10_000) },
      });

      const outcome = yield* service.issue({ binding });

      expect(Schema.is(PricingCommitmentConfirmationIssuedOutcomeSchema)(outcome)).toBe(true);
      if (Schema.is(PricingCommitmentConfirmationIssuedOutcomeSchema)(outcome)) {
        expect(outcome.confirmation).toMatchObject({
          confirmationRef: 'pricing-confirmation:788:binding-only',
          expiresAt: '2026-09-28T12:00:10.000Z',
          source: { kind: 'CURRENT_BACKED' },
        });
      }
      expect(sourceResolutions).toBe(1);
    }),
  );

  it.effect('rejects an owner-observed changed Bundle before proof minting', () =>
    Effect.gen(function* rejectsChangedBundle() {
      const commercialTotal = yield* makeIssue788CommercialTotal('950');
      const binding = makeIssue788Binding(commercialTotal);
      const source = makeIssue788CurrentSource(commercialTotal);
      const publication = yield* projectPricingCommercialTotal(commercialTotal);
      let proofCalls = 0;
      const service = makePricingCurrentBackedConfirmationIssuanceService({
        bindingAuthority: {
          verifyUnchangedBinding: () =>
            Effect.fail(new PricingCurrentBackedConfirmationBindingRejected({ reason: 'BUNDLE_CHANGED' })),
        },
        currentEvaluation: {
          evaluate: Effect.succeed({
            acceptedAttempt: source.currentness.attempt,
            attempts: 1,
            currentness: source.currentness,
            outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED' as const,
            publication,
          }),
        },
        proofIssuer: {
          issueProof: () => {
            proofCalls += 1;
            return Effect.die('Changed Bundle must fail before proof minting');
          },
        },
        sourceAuthority: { resolveCurrentSource: () => Effect.succeed(source) },
        trustedTime: { readIssuedAt: Effect.succeed(issue788IssuedAt) },
        validityPolicy: { selectDurationMilliseconds: () => Effect.succeed(30_000) },
      });

      const outcome = yield* service.issue({ binding });

      expect(Schema.is(PricingCommitmentConfirmationBindingMismatchSchema)(outcome)).toBe(true);
      if (Schema.is(PricingCommitmentConfirmationBindingMismatchSchema)(outcome)) {
        expect(outcome.reason).toBe('BUNDLE_CHANGED');
        expect(outcome.retryable).toBe(false);
      }
      expect(proofCalls).toBe(0);
    }),
  );

  it.effect('rejects an owner policy interval over 30 seconds before proof minting', () =>
    Effect.gen(function* rejectsLongInterval() {
      const commercialTotal = yield* makeIssue788CommercialTotal('950');
      const binding = makeIssue788Binding(commercialTotal);
      const source = makeIssue788CurrentSource(commercialTotal);
      const publication = yield* projectPricingCommercialTotal(commercialTotal);
      let proofCalls = 0;
      const service = makePricingCurrentBackedConfirmationIssuanceService({
        bindingAuthority: { verifyUnchangedBinding: () => Effect.void },
        currentEvaluation: {
          evaluate: Effect.succeed({
            acceptedAttempt: source.currentness.attempt,
            attempts: 1,
            currentness: source.currentness,
            outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED' as const,
            publication,
          }),
        },
        proofIssuer: {
          issueProof: () => {
            proofCalls += 1;
            return Effect.die('Invalid validity policy must fail before proof minting');
          },
        },
        sourceAuthority: { resolveCurrentSource: () => Effect.succeed(source) },
        trustedTime: { readIssuedAt: Effect.succeed(issue788IssuedAt) },
        validityPolicy: { selectDurationMilliseconds: () => Effect.succeed(30_001) },
      });

      const outcome = yield* service.issue({ binding });

      expect(Schema.is(PricingCommitmentConfirmationSourceInvalidSchema)(outcome)).toBe(true);
      if (Schema.is(PricingCommitmentConfirmationSourceInvalidSchema)(outcome)) {
        expect(outcome.reason).toBe('The owner validity policy must select a positive interval of at most 30 seconds');
        expect(outcome.retryable).toBe(false);
      }
      expect(proofCalls).toBe(0);
    }),
  );
});
