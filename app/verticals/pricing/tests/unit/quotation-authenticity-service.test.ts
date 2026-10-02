import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingQuotationBindingSchema,
  PricingQuotationIssuedSchema,
  PricingQuotationValiditySchema,
} from '@app/pricing-contracts/domain/quotation';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePricingQuotationAuthenticityService,
  PricingQuotationAuthenticityProviderUnavailable,
  PricingQuotationAuthenticityVerifier,
} from '../../src/services/quotation-authenticity.service.ts';
import type {
  PricingQuotationAuthenticityVerificationInput,
  PricingQuotationAuthenticityVerifierService,
} from '../../src/services/quotation-authenticity.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { candidateRef, makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const verifiedAt = '2026-09-28T12:00:00.000Z';

const quotationFixture = Effect.fn('test.issue785AuthenticityQuotationFixture')(
  function* issue785AuthenticityQuotationFixture() {
    const { preRound } = yield* makeIssue779PreRoundScenario({
      discounts: ['0', '0', '0'],
      priceAmount: '900',
    });
    const publication = yield* publishPricingLineValues({
      candidateRef,
      decision: preRound.decision,
      preRound,
      publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
    });
    if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
      return yield* Effect.die(`Issue #785 fixture expected publication: ${publication.failure.code}`);
    }
    const commercialTotal = yield* calculatePricingCommercialTotals({
      candidateRef,
      decision: preRound.decision,
      preRound,
      publishedLines: publication.publishedLines,
    });
    if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
      return yield* Effect.die(`Issue #785 fixture expected commercial total: ${commercialTotal.failure.code}`);
    }
    const binding = yield* Schema.decodeUnknownEffect(PricingQuotationBindingSchema, { onExcessProperty: 'error' })({
      candidateRef,
      commercialScope: commercialTotal.decision.commercialScope,
      currencyCode: commercialTotal.decision.currencyCode,
      lines: commercialTotal.decision.lines.map(({ catalog, occurrenceId }) => ({
        occurrenceId,
        quantity: { amount: catalog.quantity.resulting, unitRef: catalog.unitRef },
        selection: catalog.selection,
      })),
      monetaryBoundary: commercialTotal.decision.monetaryBoundary,
      subject: {
        guestEvidenceRef: 'guest-evidence:785',
        guestSessionRef: 'guest-session:785',
        kind: 'GUEST',
        purchaseContext: {
          contextRef: commercialTotal.decision.purchasingContext.contextRef,
          contextRevision: commercialTotal.decision.purchasingContext.contextRevision,
        },
      },
      tenantId: commercialTotal.decision.tenantId,
    });
    const validity = yield* Schema.decodeEffect(PricingQuotationValiditySchema, { onExcessProperty: 'error' })({
      policyEvidence: {
        maximumValidityDurationMilliseconds: 604_800_000,
        policyRef: 'pricing-quotation-validity:launch',
        policyVersion: '2026-09-18',
      },
      validFrom: commercialTotal.decision.operationTime,
      validUntil: '2026-09-28T16:00:00.000Z',
    });
    return yield* Schema.decodeEffect(PricingQuotationIssuedSchema, { onExcessProperty: 'error' })({
      binding,
      issuedAt: validity.validFrom,
      kind: 'PRICING_QUOTATION',
      materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
      quotationRef: 'pricing-quotation:785:original',
      quotedResult: commercialTotal,
      validity,
    });
  },
);

const evidenceFor = (quotation: PricingQuotationIssued, keyStatus: 'ACTIVE' | 'HISTORICAL') => ({
  authenticityRef: `quotation-authenticity:${keyStatus.toLowerCase()}`,
  authority: 'EVIDENCE_ONLY' as const,
  issuerRef: 'pricing:quotation-issuer',
  keyRef: 'pricing:quotation-signing-key',
  keyStatus,
  keyVersion: keyStatus === 'ACTIVE' ? 'key-v2' : 'key-v1',
  lineageRef: 'pricing:quotation-key-lineage:v1-to-v2',
  payloadDigest: 'sha256:canonical-immutable-quotation',
  proofVersion: 'quotation-proof-v1',
  quotationRef: quotation.quotationRef,
  verifiedAt,
});

const verifyWith = (quotation: PricingQuotationIssued, verifier: PricingQuotationAuthenticityVerifierService) =>
  makePricingQuotationAuthenticityService.pipe(
    Effect.provideService(PricingQuotationAuthenticityVerifier, verifier),
    Effect.flatMap((service) => service.verify({ quotation })),
  );

describe('Pricing Quotation authenticity verification', () => {
  it.effect(
    'passes the complete immutable identity, binding, terms, validity, and source evidence to the owner verifier',
    () =>
      Effect.gen(function* verifiesCompleteImmutablePayload() {
        const quotation = yield* quotationFixture();
        let received: PricingQuotationAuthenticityVerificationInput | undefined;
        const result = yield* verifyWith(quotation, {
          verifyImmutableQuotation: (input) => {
            received = input;
            return Effect.succeed({ _tag: 'VERIFIED', evidence: evidenceFor(quotation, 'ACTIVE') });
          },
        });

        expect(received).toEqual({
          immutablePayload: {
            binding: quotation.binding,
            materialEvidence: quotation.materialEvidence,
            quotedResult: quotation.quotedResult,
            validity: quotation.validity,
          },
          quotationIdentity: {
            issuedAt: quotation.issuedAt,
            kind: quotation.kind,
            quotationRef: quotation.quotationRef,
          },
        });
        expect(result).toEqual({ evidence: evidenceFor(quotation, 'ACTIVE'), kind: 'QUOTATION_AUTHENTIC' });
      }),
  );

  it.effect('keeps a historical key version verifiable when its retained lineage is proven', () =>
    Effect.gen(function* verifiesHistoricalKeyLineage() {
      const quotation = yield* quotationFixture();
      const result = yield* verifyWith(quotation, {
        verifyImmutableQuotation: () =>
          Effect.succeed({ _tag: 'VERIFIED', evidence: evidenceFor(quotation, 'HISTORICAL') }),
      });

      expect(result).toEqual({ evidence: evidenceFor(quotation, 'HISTORICAL'), kind: 'QUOTATION_AUTHENTIC' });
    }),
  );

  it.effect('keeps unknown and retired-without-lineage keys typed, terminal, and distinct from invalid proof', () =>
    Effect.gen(function* rejectsUnverifiableKeyHistory() {
      const quotation = yield* quotationFixture();
      for (const reason of ['UNKNOWN_KEY', 'RETIRED_KEY_WITHOUT_LINEAGE'] as const) {
        const result = yield* verifyWith(quotation, {
          verifyImmutableQuotation: () =>
            Effect.succeed({ _tag: 'UNVERIFIABLE', quotationRef: quotation.quotationRef, reason, retryable: false }),
        });
        expect(result).toEqual({
          kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE',
          quotationRef: quotation.quotationRef,
          reason,
          retryable: false,
        });
      }
    }),
  );

  it.effect('classifies tampered immutable payloads as invalid without repricing or ordinary revocation', () =>
    Effect.gen(function* rejectsTamperedPayload() {
      const quotation = yield* quotationFixture();
      const tampered = yield* Schema.decodeEffect(PricingQuotationIssuedSchema, { onExcessProperty: 'error' })({
        ...quotation,
        issuedAt: '2026-09-28T12:00:01.000Z',
      });
      const result = yield* verifyWith(tampered, {
        verifyImmutableQuotation: ({ quotationIdentity }) =>
          Effect.succeed(
            quotationIdentity.issuedAt === quotation.issuedAt
              ? { _tag: 'VERIFIED', evidence: evidenceFor(quotation, 'ACTIVE') }
              : {
                  _tag: 'INVALID',
                  quotationRef: quotationIdentity.quotationRef,
                  reason: 'PAYLOAD_TAMPERED',
                },
          ),
      });

      expect(result).toEqual({
        kind: 'QUOTATION_AUTHENTICITY_INVALID',
        quotationRef: quotation.quotationRef,
        reason: 'PAYLOAD_TAMPERED',
      });
    }),
  );

  it.effect('rejects substituted calculation versions before authenticity verification', () =>
    Effect.gen(function* rejectsSubstitutedMaterialEvidence() {
      const quotation = yield* quotationFixture();
      expect(() =>
        Schema.decodeSync(PricingQuotationIssuedSchema, {
          onExcessProperty: 'error',
        })({
          ...quotation,
          materialEvidence: {
            ...quotation.materialEvidence,
            calculationVersions: {
              ...quotation.materialEvidence.calculationVersions,
              arithmeticProfileVersions: ['pricing-exact-decimal:substituted'],
            },
          },
        }),
      ).toThrow('Material-evidence result must bind the exact candidate and final validation instant');
    }),
  );

  it.effect('rejects provider evidence for another quotation instead of trusting reference possession', () =>
    Effect.gen(function* rejectsMismatchedProviderEvidence() {
      const quotation = yield* quotationFixture();
      const result = yield* verifyWith(quotation, {
        verifyImmutableQuotation: () =>
          Effect.succeed({
            _tag: 'VERIFIED',
            evidence: { ...evidenceFor(quotation, 'ACTIVE'), quotationRef: 'pricing-quotation:785:other' },
          }),
      });

      expect(result).toEqual({
        kind: 'QUOTATION_AUTHENTICITY_INVALID',
        quotationRef: quotation.quotationRef,
        reason: 'INVALID_PROOF',
      });
    }),
  );

  it.effect('maps provider outage and malformed responses to retryable dependency unavailability', () =>
    Effect.gen(function* failsClosedOnVerifierOutage() {
      const quotation = yield* quotationFixture();
      const unavailable = yield* verifyWith(quotation, {
        verifyImmutableQuotation: () =>
          Effect.fail(
            new PricingQuotationAuthenticityProviderUnavailable({
              reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE',
            }),
          ),
      });
      const malformed = yield* verifyWith(quotation, {
        verifyImmutableQuotation: () => Effect.succeed({ kind: 'VERIFIED', quotationRef: quotation.quotationRef }),
      });

      const expected = {
        kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      } as const;
      expect(unavailable).toEqual(expected);
      expect(malformed).toEqual(expected);
    }),
  );
});
