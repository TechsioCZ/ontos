import type {
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationEvidence,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingCurrentBackedConfirmationSourceSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingAcceptedLegacyCurrencySupportReferenceSchema } from '@app/pricing-contracts/domain/accepted-order-handoff';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  deserializePricingAcceptedOrderHandoff,
  serializePricingAcceptedOrderHandoff,
} from '../../src/services/accepted-order-handoff-serializer.service.ts';
import type { PricingCommitmentConfirmationVerificationService } from '../../src/services/commitment-confirmation-verification.service.ts';
import { projectPricingCommercialTotal } from '../../src/services/commercial-total-projection.service.ts';
import { makePricingCurrentBackedAcceptedHandoffService } from '../../src/services/current-backed-accepted-handoff.service.ts';
import {
  issue788IssuedAt,
  makeIssue788CommercialTotal,
  makeIssue788CurrentConfirmation,
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

const verifierFor = (
  confirmation: PricingCommitmentConfirmationIssued,
): PricingCommitmentConfirmationVerificationService => ({
  verify: () =>
    Effect.succeed({
      _tag: 'VERIFIED',
      authenticityEvidence: verificationEvidenceFor(confirmation),
      confirmation,
      verifiedAt: issue788IssuedAt,
    }),
});

const legacyReferencesFor = (tenantId: string) => {
  const originalLegacySupport = {
    correctiveMigrationLineage: {
      auditRef: 'opaque:migration-audit/legacy-support-a',
      migratedAt: '2026-09-28T10:00:00.000Z',
      migrationRef: 'opaque:migration/correct-legacy-support-v2',
      successorOwnerScope: {
        ownerModuleId: 'commerce.pricing',
        ownerRootRef: 'opaque:currency-support/tenant-a',
        predicateRef: 'opaque:currency-support/current/tenant-a',
        tenantId,
      },
      successorSupportRevisionRef: 'opaque:currency-support/revision-42',
    },
    effectivePeriod: {
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveTo: '2025-07-01T00:00:00.000Z',
    },
    generation: 1,
    ownerScope: {
      ownerModuleId: 'legacy.pricing.currency-support',
      ownerRootRef: 'opaque:legacy-support/partition-a/tenant-a',
      predicateRef: 'pricing-currency-support:1',
      tenantId,
    },
    supportedCurrencies: ['EUR'],
    supportRevisionRef: 'pricing-currency-support:1',
    verificationRef: 'opaque:legacy-proof/shared-label',
  } as const;
  return [
    originalLegacySupport,
    {
      effectivePeriod: originalLegacySupport.effectivePeriod,
      generation: originalLegacySupport.generation,
      ownerScope: {
        ...originalLegacySupport.ownerScope,
        ownerRootRef: 'opaque:legacy-support/partition-b/tenant-a',
      },
      supportedCurrencies: originalLegacySupport.supportedCurrencies,
      supportRevisionRef: originalLegacySupport.supportRevisionRef,
      verificationRef: originalLegacySupport.verificationRef,
    },
  ] as const;
};

describe('Pricing Accepted handoff qualified legacy serialization', () => {
  it.effect('preserves original partitioned evidence and exact accepted terms without Current reinterpretation', () =>
    Effect.gen(function* preservesQualifiedLegacyHistory() {
      const acceptedTotal = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788CurrentConfirmation(acceptedTotal);
      const currentSource = yield* Schema.decodeEffect(PricingCurrentBackedConfirmationSourceSchema)(
        confirmation.source,
      );
      const qualifiedLegacyReferences = yield* Schema.decodeEffect(
        Schema.Array(PricingAcceptedLegacyCurrencySupportReferenceSchema),
        { onExcessProperty: 'error' },
      )(legacyReferencesFor(acceptedTotal.decision.tenantId));
      const publication = yield* projectPricingCommercialTotal(acceptedTotal);
      const outcome = yield* makePricingCurrentBackedAcceptedHandoffService(verifierFor(confirmation)).build({
        acceptedAt: issue788IssuedAt,
        confirmation,
        currentPublication: {
          acceptedAttempt: currentSource.currentness.attempt,
          attempts: 1,
          currentness: currentSource.currentness,
          outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED',
          publication,
        },
        handoffRef: 'pricing-accepted-handoff:789:legacy-history',
        materialEvidence: currentSource.materialEvidence,
        qualifiedLegacyCurrencySupportReferences: qualifiedLegacyReferences,
        requestedBinding: confirmation.binding,
        scopeRef: 'pricing-tenant:tenant-a',
      });
      const handoff = yield* Match.value(outcome).pipe(
        Match.tag('HANDOFF_BUILT', ({ handoff: builtHandoff }) => Effect.succeed(builtHandoff)),
        Match.tag('HANDOFF_INVALID', ({ reason }) => Effect.die(`Unexpected handoff outcome: ${reason}`)),
        Match.exhaustive,
      );

      const wire = yield* serializePricingAcceptedOrderHandoff(handoff);
      const roundTripped = yield* deserializePricingAcceptedOrderHandoff(wire);
      const laterCurrentTotal = yield* makeIssue788CommercialTotal('950');

      expect(roundTripped).toEqual(handoff);
      expect(roundTripped.qualifiedLegacyCurrencySupportReferences).toEqual(qualifiedLegacyReferences);
      expect(roundTripped.qualifiedLegacyCurrencySupportReferences).toHaveLength(2);
      expect(
        roundTripped.qualifiedLegacyCurrencySupportReferences.map(({ ownerScope }) => ownerScope.ownerRootRef),
      ).toEqual(['opaque:legacy-support/partition-a/tenant-a', 'opaque:legacy-support/partition-b/tenant-a']);
      expect(roundTripped.terms.pricingNetCommercialTotal.amount).toBe('900');
      expect(roundTripped.terms.decision.currencyCode).toBe('CZK');
      expect(laterCurrentTotal.pricingNetCommercialTotal.amount).toBe('950');
      expect(roundTripped.qualifiedLegacyCurrencySupportReferences[0]?.supportedCurrencies).toEqual(['EUR']);
      expect(roundTripped.qualifiedLegacyCurrencySupportReferences[0]).not.toHaveProperty('evaluationMode');
      expect(roundTripped.qualifiedLegacyCurrencySupportReferences[0]).not.toHaveProperty('ownerRevision');
    }),
  );
});
