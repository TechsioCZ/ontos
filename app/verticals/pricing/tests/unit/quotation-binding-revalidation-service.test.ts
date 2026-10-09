import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingQuotationBindingSchema,
  PricingQuotationIssuedSchema,
  PricingQuotationOwnerTransitionEvidenceSchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationBinding,
  PricingQuotationOwnerTransitionEvidence,
  PricingQuotationRevalidationRequest,
} from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import {
  PricingGuestQuotationAuthority,
  PricingGuestQuotationAuthorityRejected,
  PricingGuestQuotationAuthorityUnavailable,
} from '../../src/services/guest-quotation-authority.service.ts';
import type { PricingGuestQuotationAuthorityService } from '../../src/services/guest-quotation-authority.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import {
  makePricingQuotationBindingRevalidationService,
  PricingAuthenticatedQuotationAuthority,
  PricingQuotationOwnerTransitionFailure,
  PricingQuotationOwnerTransitionVerifier,
} from '../../src/services/quotation-binding-revalidation.service.ts';
import type {
  PricingAuthenticatedQuotationAuthorityService,
  PricingQuotationOwnerTransitionVerifierService,
} from '../../src/services/quotation-binding-revalidation.service.ts';
import { candidateRef, makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const decodeBinding = Schema.decodeUnknownSync(PricingQuotationBindingSchema, { onExcessProperty: 'error' });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const transition = {
  originalEvidenceRef: 'catalog-selection-evidence:original',
  ownerModuleId: 'commerce.catalog',
  proposedEvidenceRef: 'catalog-selection-evidence:proposed',
} as const;

const quotationFixture = Effect.fn('test.issue785BindingQuotationFixture')(function* issue785BindingQuotationFixture() {
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
    return yield* Effect.die(`Issue #785 fixture expected a commercial total: ${commercialTotal.failure.code}`);
  }
  const binding = decodeBinding({
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
  const quotation = yield* Schema.decodeEffect(PricingQuotationIssuedSchema, { onExcessProperty: 'error' })({
    binding,
    issuedAt: commercialTotal.decision.operationTime,
    kind: 'PRICING_QUOTATION',
    materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
    quotationRef: 'pricing-quotation:785:transition',
    quotedResult: commercialTotal,
    validity: {
      policyEvidence: {
        maximumValidityDurationMilliseconds: 86_400_000,
        policyRef: 'pricing-quotation-validity:launch',
        policyVersion: '1',
      },
      validFrom: commercialTotal.decision.operationTime,
      validUntil: '2026-09-29T12:00:00.000Z',
    },
  });
  return { binding, quotation };
});

const ownerEvidence = (
  request: PricingQuotationRevalidationRequest & {
    readonly proposedEvidence: NonNullable<PricingQuotationRevalidationRequest['proposedEvidence']>;
  },
): PricingQuotationOwnerTransitionEvidence =>
  Schema.decodeSync(PricingQuotationOwnerTransitionEvidenceSchema, { onExcessProperty: 'error' })({
    candidateRef: request.quotation.binding.candidateRef,
    materiality: 'NON_MATERIAL',
    originalEvidenceRef: request.proposedEvidence.originalEvidenceRef,
    ownerModuleId: request.proposedEvidence.ownerModuleId,
    ownerRef: 'commerce.catalog:selection-revalidation',
    proposedEvidenceRef: request.proposedEvidence.proposedEvidenceRef,
    quotationRef: request.quotation.quotationRef,
    source: 'OWNING_DOMAIN_ATTESTATION',
    status: 'CONFIRMED',
    tenantId: request.quotation.binding.tenantId,
    transitionEvidenceRef: 'catalog-transition:785',
    transitionEvidenceVersion: '1',
    verifiedAt: '2026-09-28T12:00:00.500Z',
  });

const requestFor = (
  quotation: PricingQuotationRevalidationRequest['quotation'],
  requestedBinding: PricingQuotationBinding,
  withTransition = false,
): PricingQuotationRevalidationRequest =>
  withTransition
    ? {
        kind: 'REVALIDATE_PRICING_QUOTATION',
        proposedEvidence: transition,
        quotation,
        requestedBinding,
      }
    : {
        kind: 'REVALIDATE_PRICING_QUOTATION',
        quotation,
        requestedBinding,
      };

const successfulGuestAuthority: PricingGuestQuotationAuthorityService = {
  verify: ({ quotationRef, quotedBinding }) =>
    Effect.succeed({
      binding: quotedBinding,
      kind: 'PRICING_GUEST_QUOTATION_AUTHORITY_VERIFIED',
      quotationRef,
    }),
};

const successfulAuthenticatedAuthority: PricingAuthenticatedQuotationAuthorityService = {
  verify: ({ quotationRef, quotedBinding }) =>
    Effect.succeed({
      binding: quotedBinding,
      kind: 'PRICING_AUTHENTICATED_QUOTATION_AUTHORITY_VERIFIED',
      quotationRef,
    }),
};

const assessWith = (
  request: PricingQuotationRevalidationRequest,
  verifyTransition: PricingQuotationOwnerTransitionVerifierService['verifyTransition'],
  guestAuthority: PricingGuestQuotationAuthorityService = successfulGuestAuthority,
  authenticatedAuthority: PricingAuthenticatedQuotationAuthorityService = successfulAuthenticatedAuthority,
) =>
  Effect.flatMap(
    makePricingQuotationBindingRevalidationService.pipe(
      Effect.provideService(PricingQuotationOwnerTransitionVerifier, { verifyTransition }),
      Effect.provideService(PricingGuestQuotationAuthority, guestAuthority),
      Effect.provideService(PricingAuthenticatedQuotationAuthority, authenticatedAuthority),
    ),
    (service) => service.assess(request),
  );

describe('Pricing Quotation owner-confirmed evidence transition #785', () => {
  it.effect('accepts a changed evidence reference only through the owning domain and preserves the quote', () =>
    Effect.gen(function* acceptsOwnerTransition() {
      const { binding, quotation } = yield* quotationFixture();
      const before = yield* encodeJson(quotation);
      const request = requestFor(quotation, binding, true);
      let ownerCalls = 0;
      const result = yield* assessWith(request, (input) => {
        ownerCalls += 1;
        expect(input.quotation).toEqual(quotation);
        expect(input.requestedBinding).toEqual(binding);
        expect(input.proposedEvidence).toEqual(transition);
        return Effect.succeed(ownerEvidence({ ...request, proposedEvidence: transition }));
      });

      expect(result).toMatchObject({
        kind: 'OWNER_REVALIDATION_ACCEPTED',
        transitionEvidence: {
          originalEvidenceRef: transition.originalEvidenceRef,
          ownerModuleId: transition.ownerModuleId,
          proposedEvidenceRef: transition.proposedEvidenceRef,
          quotationRef: quotation.quotationRef,
        },
      });
      expect(ownerCalls).toBe(1);
      expect(yield* encodeJson(quotation)).toBe(before);
      expect(quotation.quotedResult.pricingNetCommercialTotal).toEqual({ amount: '900', currencyCode: 'CZK' });
      expect(quotation.quotedResult.sourceEvidence).toBeDefined();
    }),
  );

  it.effect('uses direct exact match without an owner read and rejects consumer-declared equal evidence refs', () =>
    Effect.gen(function* keepsExactAndTransitionSeparate() {
      const { binding, quotation } = yield* quotationFixture();
      let ownerCalls = 0;
      const verifier = () => {
        ownerCalls += 1;
        return Effect.die('Exact binding or equal consumer references must not call the evidence owner');
      };

      expect(yield* assessWith(requestFor(quotation, binding), verifier)).toEqual({
        kind: 'EXACT_MATCH',
        quotationRef: quotation.quotationRef,
      });
      expect(
        yield* assessWith(
          {
            ...requestFor(quotation, binding),
            proposedEvidence: {
              ...transition,
              proposedEvidenceRef: transition.originalEvidenceRef,
            },
          },
          verifier,
        ),
      ).toEqual({
        kind: 'MISMATCH',
        quotationRef: quotation.quotationRef,
        reason: 'MATERIAL_EVIDENCE_CHANGED',
      });
      expect(ownerCalls).toBe(0);
    }),
  );

  it.effect('rejects changed purchase identity before owner attestation', () =>
    Effect.gen(function* rejectsCriticalBindingChanges() {
      const { binding, quotation } = yield* quotationFixture();
      const [line] = binding.lines;
      if (line === undefined) {
        throw new Error('Issue #785 fixture requires one line');
      }
      const differentVariant = {
        ...line.selection.variantRef,
        resourceId: '45454545-4545-4454-8454-454545454545',
      };
      const changed: readonly [PricingQuotationBinding, string][] = [
        [
          decodeBinding({
            ...binding,
            lines: [{ ...line, selection: { ...line.selection, variantRef: differentVariant } }],
          }),
          'SELECTION_CHANGED',
        ],
        [
          decodeBinding({ ...binding, lines: [{ ...line, quantity: { ...line.quantity, amount: '901' } }] }),
          'QUANTITY_CHANGED',
        ],
        [
          decodeBinding({ ...binding, lines: [{ ...line, occurrenceId: 'purchase-occurrence:changed' }] }),
          'OCCURRENCE_STRUCTURE_CHANGED',
        ],
        [
          decodeBinding({
            ...binding,
            commercialScope: {
              ...binding.commercialScope,
              sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
            },
          }),
          'COMMERCIAL_SCOPE_CHANGED',
        ],
        [
          decodeBinding({ ...binding, commercialScope: { ...binding.commercialScope, channelId: 'B2B' } }),
          'COMMERCIAL_SCOPE_CHANGED',
        ],
        [
          decodeBinding({ ...binding, commercialScope: { ...binding.commercialScope, marketId: 'sk-launch' } }),
          'COMMERCIAL_SCOPE_CHANGED',
        ],
        [decodeBinding({ ...binding, currencyCode: 'EUR' }), 'CURRENCY_CHANGED'],
        [
          decodeBinding({ ...binding, subject: { ...binding.subject, guestSessionRef: 'guest-session:other' } }),
          'AUTHORITY_CONTEXT_CHANGED',
        ],
        [
          decodeBinding({ ...binding, subject: { ...binding.subject, guestEvidenceRef: 'guest-evidence:other' } }),
          'AUTHORITY_CONTEXT_CHANGED',
        ],
      ];
      let ownerCalls = 0;
      const mustNotCallOwner: PricingQuotationOwnerTransitionVerifierService['verifyTransition'] = () => {
        ownerCalls += 1;
        return Effect.die('Material binding changes must not reach the evidence owner');
      };
      for (const [requestedBinding, reason] of changed) {
        const result = yield* assessWith(requestFor(quotation, requestedBinding, true), mustNotCallOwner);
        expect(result).toEqual({ kind: 'MISMATCH', quotationRef: quotation.quotationRef, reason });
      }
      expect(ownerCalls).toBe(0);
    }),
  );

  it.effect('fails closed for owner rejection, outage, and unbound or malformed attestations', () =>
    Effect.gen(function* failsClosed() {
      const { binding, quotation } = yield* quotationFixture();
      const request = requestFor(quotation, binding, true);

      expect(
        yield* assessWith(request, () =>
          Effect.fail(new PricingQuotationOwnerTransitionFailure({ reason: 'MATERIAL_CHANGE', retryable: false })),
        ),
      ).toEqual({
        kind: 'MISMATCH',
        quotationRef: quotation.quotationRef,
        reason: 'MATERIAL_EVIDENCE_CHANGED',
      });
      expect(
        yield* assessWith(request, () =>
          Effect.fail(new PricingQuotationOwnerTransitionFailure({ reason: 'OWNER_UNAVAILABLE', retryable: true })),
        ),
      ).toEqual({
        kind: 'BINDING_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'OWNER_REVALIDATION_UNAVAILABLE',
        retryable: true,
      });
      expect(
        yield* assessWith(request, () =>
          Effect.succeed({
            ...ownerEvidence({ ...request, proposedEvidence: transition }),
            quotationRef: 'pricing-quotation:other',
          }),
        ),
      ).toEqual({
        kind: 'BINDING_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'OWNER_EVIDENCE_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect('requires live Guest owner authority before exact or transition acceptance', () =>
    Effect.gen(function* requiresLiveGuestAuthority() {
      const { binding, quotation } = yield* quotationFixture();
      let transitionCalls = 0;
      const transitionVerifier: PricingQuotationOwnerTransitionVerifierService['verifyTransition'] = () => {
        transitionCalls += 1;
        return Effect.die('Guest authority must pass before evidence transition verification');
      };

      const rejected = yield* assessWith(requestFor(quotation, binding, true), transitionVerifier, {
        verify: () => Effect.fail(new PricingGuestQuotationAuthorityRejected({ reason: 'OWNER_REJECTED' })),
      });
      expect(rejected).toEqual({
        kind: 'MISMATCH',
        quotationRef: quotation.quotationRef,
        reason: 'AUTHORITY_CONTEXT_CHANGED',
      });

      const unavailable = yield* assessWith(requestFor(quotation, binding), transitionVerifier, {
        verify: () =>
          Effect.fail(
            new PricingGuestQuotationAuthorityUnavailable({
              reason: 'OWNER_VERIFICATION_UNAVAILABLE',
              retryable: true,
            }),
          ),
      });
      expect(unavailable).toEqual({
        kind: 'BINDING_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'BINDING_DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
      expect(transitionCalls).toBe(0);
    }),
  );

  it.effect('requires live authenticated subject and Actor authority before exact or transition acceptance', () =>
    Effect.gen(function* requiresLiveAuthenticatedAuthority() {
      const { binding, quotation } = yield* quotationFixture();
      const authenticatedBinding = decodeBinding({
        ...binding,
        subject: {
          kind: 'AUTHENTICATED',
          purchaseContext: binding.subject.purchaseContext,
          subjectEvidenceRef: 'subject-evidence:785',
          subjectRef: {
            moduleId: 'commerce-customer-context',
            resourceId: 'profile:785',
            resourceType: 'commerce.customer-context.retail-customer-profile',
            tenantId: binding.tenantId,
          },
        },
      });
      const authenticatedQuotation = yield* Schema.decodeEffect(PricingQuotationIssuedSchema, {
        onExcessProperty: 'error',
      })({ ...quotation, binding: authenticatedBinding });
      const request = requestFor(authenticatedQuotation, authenticatedBinding, true);
      let authorityCalls = 0;
      let transitionCalls = 0;
      const transitionVerifier: PricingQuotationOwnerTransitionVerifierService['verifyTransition'] = (input) => {
        transitionCalls += 1;
        return Effect.succeed(ownerEvidence({ ...request, proposedEvidence: input.proposedEvidence }));
      };

      const accepted = yield* assessWith(request, transitionVerifier, successfulGuestAuthority, {
        verify: ({ quotationRef, quotedBinding, requestedBinding }) => {
          authorityCalls += 1;
          expect(quotedBinding).toEqual(authenticatedBinding);
          expect(requestedBinding).toEqual(authenticatedBinding);
          return Effect.succeed({
            binding: requestedBinding,
            kind: 'PRICING_AUTHENTICATED_QUOTATION_AUTHORITY_VERIFIED',
            quotationRef,
          });
        },
      });
      expect(accepted.kind).toBe('OWNER_REVALIDATION_ACCEPTED');
      expect(authorityCalls).toBe(1);
      expect(transitionCalls).toBe(1);

      const denied = yield* assessWith(request, transitionVerifier, successfulGuestAuthority, {
        verify: () =>
          Effect.fail({
            _tag: 'PricingAuthenticatedQuotationAuthorityDenied' as const,
            reason: 'SUBJECT_OR_ACTOR_NOT_AUTHORIZED' as const,
            retryable: false as const,
          }),
      });
      expect(denied).toEqual({
        kind: 'MISMATCH',
        quotationRef: quotation.quotationRef,
        reason: 'AUTHORITY_CONTEXT_CHANGED',
      });

      const unavailable = yield* assessWith(request, transitionVerifier, successfulGuestAuthority, {
        verify: () =>
          Effect.fail({
            _tag: 'PricingAuthenticatedQuotationAuthorityUnavailable' as const,
            reason: 'OWNER_VERIFICATION_UNAVAILABLE' as const,
            retryable: true as const,
          }),
      });
      expect(unavailable).toEqual({
        kind: 'BINDING_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'BINDING_DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
      expect(transitionCalls).toBe(1);
    }),
  );
});
