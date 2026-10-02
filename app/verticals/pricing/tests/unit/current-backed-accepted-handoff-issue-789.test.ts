import type {
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationEvidence,
  PricingCommitmentConfirmationVerificationOutcome,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import {
  PricingCommitmentConfirmationExpiredSchema,
  PricingCurrentBackedConfirmationSourceSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PricingCommitmentConfirmationVerificationService } from '../../src/services/commitment-confirmation-verification.service.ts';
import { projectPricingCommercialTotal } from '../../src/services/commercial-total-projection.service.ts';
import {
  makePricingCurrentBackedAcceptedHandoffService,
  PricingCurrentBackedAcceptedHandoffBuiltSchema,
  PricingCurrentBackedAcceptedHandoffInvalidSchema,
} from '../../src/services/current-backed-accepted-handoff.service.ts';
import {
  issue788IssuedAt,
  makeIssue788CommercialTotal,
  makeIssue788CurrentConfirmation,
  makeIssue788CurrentSource,
} from './support/issue-788-confirmation.fixture.ts';

const verificationEvidenceFor = (
  confirmation: PricingCommitmentConfirmationIssued,
): PricingCommitmentConfirmationVerificationEvidence => ({
  authenticityRef: `pricing-confirmation-authenticity:${confirmation.confirmationRef}`,
  confirmationRef: confirmation.confirmationRef,
  issuerRef: confirmation.authenticity.issuerRef,
  keyRef: confirmation.authenticity.keyRef,
  keyStatus: 'ACTIVE',
  keyVersion: confirmation.authenticity.keyVersion,
  lineageRef: confirmation.authenticity.lineageRef,
  payloadDigest: confirmation.authenticity.payloadDigest,
  proofRef: confirmation.authenticity.proofRef,
  proofVersion: confirmation.authenticity.proofVersion,
  verifiedAt: issue788IssuedAt,
});

const verifying = (
  confirmation: PricingCommitmentConfirmationIssued,
  outcome?: PricingCommitmentConfirmationVerificationOutcome,
): PricingCommitmentConfirmationVerificationService => ({
  verify: (request) => {
    expect(request).toEqual({
      attemptedAt: issue788IssuedAt,
      confirmation,
      kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
      requestedBinding: confirmation.binding,
    });
    return Effect.succeed(
      outcome ?? {
        _tag: 'VERIFIED',
        authenticityEvidence: verificationEvidenceFor(confirmation),
        confirmation,
        verifiedAt: issue788IssuedAt,
      },
    );
  },
});

describe('Current-backed Pricing Accepted handoff', () => {
  it.effect(
    'copies the exact verified Current terms, material evidence, Attempt, and Bundle without recalculation',
    () =>
      Effect.gen(function* buildsAcceptedHandoff() {
        const total = yield* makeIssue788CommercialTotal('900');
        const confirmation = makeIssue788CurrentConfirmation(total);
        const source = yield* Schema.decodeEffect(PricingCurrentBackedConfirmationSourceSchema)(
          confirmation.source,
        ).pipe(Effect.orDie);
        const publication = yield* projectPricingCommercialTotal(total);
        const service = makePricingCurrentBackedAcceptedHandoffService(verifying(confirmation));

        const outcome = yield* service.build({
          acceptedAt: issue788IssuedAt,
          confirmation,
          currentPublication: {
            acceptedAttempt: source.currentness.attempt,
            attempts: 1,
            currentness: source.currentness,
            outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED',
            publication,
          },
          handoffRef: 'pricing-accepted-handoff:789:current:a',
          materialEvidence: source.materialEvidence,
          qualifiedLegacyCurrencySupportReferences: [],
          requestedBinding: confirmation.binding,
          scopeRef: 'pricing-tenant:tenant-a',
        });

        const built = yield* Schema.decodeUnknownEffect(PricingCurrentBackedAcceptedHandoffBuiltSchema)(outcome).pipe(
          Effect.orDie,
        );
        expect(built.handoff).toMatchObject({
          acceptedAt: issue788IssuedAt,
          handoffRef: 'pricing-accepted-handoff:789:current:a',
          kind: 'PRICING_ACCEPTED_ORDER_HANDOFF',
          lineage: {
            attemptRef: confirmation.binding.attemptRef,
            confirmationRef: confirmation.confirmationRef,
            decisionBundleHash: confirmation.binding.decisionBundleHash,
            decisionBundleRef: confirmation.binding.decisionBundleRef,
            decisionBundleVersion: confirmation.binding.decisionBundleVersion,
            kind: 'CURRENT_TO_CONFIRMATION',
            materialEvidenceValidatedAt: source.materialEvidence.validatedAt,
          },
          owner: { moduleId: 'commerce.pricing', scopeRef: 'pricing-tenant:tenant-a' },
        });
        expect(built.handoff.commitmentVerification.confirmation).toEqual(confirmation);
        expect(built.handoff.materialEvidence).toEqual(source.materialEvidence);
        expect(built.handoff.terms).toEqual(total);

        const laterCurrentTotal = yield* makeIssue788CommercialTotal('950');
        expect(laterCurrentTotal.pricingNetCommercialTotal.amount).toBe('950');
        expect(built.handoff.terms.pricingNetCommercialTotal.amount).toBe('900');
      }),
  );

  it.effect('rejects substituted original material evidence', () =>
    Effect.gen(function* rejectsSubstitutedMaterialEvidence() {
      const acceptedTotal = yield* makeIssue788CommercialTotal('900');
      const laterTotal = yield* makeIssue788CommercialTotal('950');
      const confirmation = makeIssue788CurrentConfirmation(acceptedTotal);
      const source = yield* Schema.decodeEffect(PricingCurrentBackedConfirmationSourceSchema)(confirmation.source).pipe(
        Effect.orDie,
      );
      const publication = yield* projectPricingCommercialTotal(acceptedTotal);
      const outcome = yield* makePricingCurrentBackedAcceptedHandoffService(verifying(confirmation)).build({
        acceptedAt: issue788IssuedAt,
        confirmation,
        currentPublication: {
          acceptedAttempt: source.currentness.attempt,
          attempts: 1,
          currentness: source.currentness,
          outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED',
          publication,
        },
        handoffRef: 'pricing-accepted-handoff:789:current:changed-evidence',
        materialEvidence: makeIssue788CurrentSource(laterTotal).materialEvidence,
        qualifiedLegacyCurrencySupportReferences: [],
        requestedBinding: confirmation.binding,
        scopeRef: 'pricing-tenant:tenant-a',
      });

      const invalid = yield* Schema.decodeUnknownEffect(PricingCurrentBackedAcceptedHandoffInvalidSchema)(outcome).pipe(
        Effect.orDie,
      );
      expect(invalid.reason).toBe('MATERIAL_EVIDENCE_CHANGED');
      expect(invalid.retryable).toBe(false);
    }),
  );

  it.effect('rejects a publication from a different Current evaluation', () =>
    Effect.gen(function* rejectsDifferentPublication() {
      const acceptedTotal = yield* makeIssue788CommercialTotal('900');
      const laterTotal = yield* makeIssue788CommercialTotal('950');
      const confirmation = makeIssue788CurrentConfirmation(acceptedTotal);
      const source = yield* Schema.decodeEffect(PricingCurrentBackedConfirmationSourceSchema)(confirmation.source).pipe(
        Effect.orDie,
      );
      const laterSource = makeIssue788CurrentSource(laterTotal);
      const laterPublication = yield* projectPricingCommercialTotal(laterTotal);
      const outcome = yield* makePricingCurrentBackedAcceptedHandoffService(verifying(confirmation)).build({
        acceptedAt: issue788IssuedAt,
        confirmation,
        currentPublication: {
          acceptedAttempt: laterSource.currentness.attempt,
          attempts: 1,
          currentness: laterSource.currentness,
          outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED',
          publication: laterPublication,
        },
        handoffRef: 'pricing-accepted-handoff:789:current:changed-publication',
        materialEvidence: source.materialEvidence,
        qualifiedLegacyCurrencySupportReferences: [],
        requestedBinding: confirmation.binding,
        scopeRef: 'pricing-tenant:tenant-a',
      });

      const invalid = yield* Schema.decodeUnknownEffect(PricingCurrentBackedAcceptedHandoffInvalidSchema)(outcome).pipe(
        Effect.orDie,
      );
      expect(invalid.reason).toBe('CURRENT_PUBLICATION_CHANGED');
      expect(invalid.retryable).toBe(false);
    }),
  );

  it.effect('rejects a Confirmation that was not usable at the commitment instant', () =>
    Effect.gen(function* rejectsExpiredConfirmation() {
      const total = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788CurrentConfirmation(total);
      const source = yield* Schema.decodeEffect(PricingCurrentBackedConfirmationSourceSchema)(confirmation.source).pipe(
        Effect.orDie,
      );
      const publication = yield* projectPricingCommercialTotal(total);
      const verificationOutcome = {
        _tag: 'EXPIRED' as const,
        confirmationRef: confirmation.confirmationRef,
        evaluatedAt: confirmation.expiresAt,
        expiresAt: confirmation.expiresAt,
      };
      const outcome = yield* makePricingCurrentBackedAcceptedHandoffService(
        verifying(confirmation, verificationOutcome),
      ).build({
        acceptedAt: issue788IssuedAt,
        confirmation,
        currentPublication: {
          acceptedAttempt: source.currentness.attempt,
          attempts: 1,
          currentness: source.currentness,
          outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED',
          publication,
        },
        handoffRef: 'pricing-accepted-handoff:789:current:expired',
        materialEvidence: source.materialEvidence,
        qualifiedLegacyCurrencySupportReferences: [],
        requestedBinding: confirmation.binding,
        scopeRef: 'pricing-tenant:tenant-a',
      });

      const invalid = yield* Schema.decodeUnknownEffect(PricingCurrentBackedAcceptedHandoffInvalidSchema)(outcome).pipe(
        Effect.orDie,
      );
      expect(invalid.reason).toBe('COMMITMENT_CONFIRMATION_NOT_VERIFIED');
      expect(invalid.retryable).toBe(false);
      const expired = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationExpiredSchema)(
        invalid.verificationOutcome,
      ).pipe(Effect.orDie);
      expect(expired.confirmationRef).toBe(verificationOutcome.confirmationRef);
      expect(expired.evaluatedAt).toBe(verificationOutcome.evaluatedAt);
      expect(expired.expiresAt).toBe(verificationOutcome.expiresAt);
    }),
  );
});
