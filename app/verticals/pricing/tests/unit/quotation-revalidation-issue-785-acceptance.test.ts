import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingCommitmentConfirmationReferenceSchema,
  PricingQuotationBindingSchema,
  PricingQuotationIssuedSchema,
  PricingQuotationRevalidationRequestSchema,
  PricingQuotationValiditySchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationAuthenticityVerificationEvidence,
  PricingQuotationBinding,
  PricingQuotationIssued,
  PricingQuotationOwnerTransitionEvidence,
} from '@app/pricing-contracts/domain/quotation';
import { Effect, Exit, Schema } from 'effect';
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
  makePricingQuotationAuthenticityService,
  PricingQuotationAuthenticityProviderUnavailable,
  PricingQuotationAuthenticityVerifier,
} from '../../src/services/quotation-authenticity.service.ts';
import type { PricingQuotationOwnerAuthenticityOutcome } from '../../src/services/quotation-authenticity.service.ts';
import {
  makePricingQuotationBindingRevalidationService,
  PricingAuthenticatedQuotationAuthority,
  PricingQuotationOwnerTransitionFailure,
  PricingQuotationOwnerTransitionVerifier,
} from '../../src/services/quotation-binding-revalidation.service.ts';
import type { PricingAuthenticatedQuotationAuthorityService } from '../../src/services/quotation-binding-revalidation.service.ts';
import { makePricingQuotationRevalidationService } from '../../src/services/quotation-revalidation.service.ts';
import { candidateRef, makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const validFrom = '2026-09-28T12:00:00.000Z';
const validUntil = '2026-09-29T12:00:00.000Z';
const evaluatedAt = '2026-09-28T12:00:00.000Z';

const requireDefined = <Value>(value: Value | undefined, message: string) =>
  value === undefined ? Effect.die(message) : Effect.succeed(value);

const validity = Schema.decodeSync(PricingQuotationValiditySchema, { onExcessProperty: 'error' })({
  policyEvidence: {
    maximumValidityDurationMilliseconds: 86_400_000,
    policyRef: 'pricing-quotation-validity:launch',
    policyVersion: '2026-09-28',
  },
  validFrom,
  validUntil,
});

const decodeBinding = Schema.decodeUnknownSync(PricingQuotationBindingSchema, { onExcessProperty: 'error' });

const quotationFixture = Effect.fn('test.issue785QuotationFixture')(function* issue785QuotationFixture(options?: {
  readonly priceAmount?: string;
  readonly quotationRef?: string;
  readonly subject?: PricingQuotationBinding['subject'];
}) {
  const { preRound } = yield* makeIssue779PreRoundScenario({
    discounts: ['0', '0', '0'],
    priceAmount: options?.priceAmount ?? '900',
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
    subject:
      options?.subject ??
      ({
        guestEvidenceRef: 'guest-evidence:785:a',
        guestSessionRef: 'guest-session:785:a',
        kind: 'GUEST',
        purchaseContext: {
          contextRef: commercialTotal.decision.purchasingContext.contextRef,
          contextRevision: commercialTotal.decision.purchasingContext.contextRevision,
        },
      } as const),
    tenantId: commercialTotal.decision.tenantId,
  });
  const quotation = yield* Schema.decodeEffect(PricingQuotationIssuedSchema, { onExcessProperty: 'error' })({
    binding,
    issuedAt: validFrom,
    kind: 'PRICING_QUOTATION',
    materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
    quotationRef: options?.quotationRef ?? 'pricing-quotation:785:900',
    quotedResult: commercialTotal,
    validity,
  });
  return { binding, quotation };
});

const authenticityEvidence = (
  quotationRef: string,
  keyStatus: 'ACTIVE' | 'HISTORICAL' = 'ACTIVE',
): PricingQuotationAuthenticityVerificationEvidence => ({
  authenticityRef: `quotation-authenticity:${quotationRef}`,
  authority: 'EVIDENCE_ONLY',
  issuerRef: 'pricing-quotation-owner:launch',
  keyRef: 'pricing-signing-key:launch',
  keyStatus,
  keyVersion: keyStatus === 'ACTIVE' ? '3' : '2',
  lineageRef: 'pricing-signing-key-lineage:launch',
  payloadDigest: `sha256:${quotationRef}`,
  proofVersion: '1',
  quotationRef,
  verifiedAt: evaluatedAt,
});

const ownerTransitionEvidence = (
  quotation: PricingQuotationIssued,
  originalEvidenceRef = 'catalog-selection-evidence:785:original',
  proposedEvidenceRef = 'catalog-selection-evidence:785:reissued',
): PricingQuotationOwnerTransitionEvidence => ({
  candidateRef: quotation.binding.candidateRef,
  materiality: 'NON_MATERIAL',
  originalEvidenceRef,
  ownerModuleId: 'commerce.catalog',
  ownerRef: 'catalog-transition-verifier:785',
  proposedEvidenceRef,
  quotationRef: quotation.quotationRef,
  source: 'OWNING_DOMAIN_ATTESTATION',
  status: 'CONFIRMED',
  tenantId: quotation.binding.tenantId,
  transitionEvidenceRef: 'catalog-transition-evidence:785',
  transitionEvidenceVersion: '1',
  verifiedAt: evaluatedAt,
});

const verifiedGuestAuthority = {
  verify: ({ quotationRef, quotedBinding }) =>
    Effect.succeed({
      binding: quotedBinding,
      kind: 'PRICING_GUEST_QUOTATION_AUTHORITY_VERIFIED' as const,
      quotationRef,
    }),
} satisfies PricingGuestQuotationAuthorityService;

const verifiedAuthenticatedAuthority = {
  verify: ({ quotationRef, quotedBinding }) =>
    Effect.succeed({
      binding: quotedBinding,
      kind: 'PRICING_AUTHENTICATED_QUOTATION_AUTHORITY_VERIFIED' as const,
      quotationRef,
    }),
} satisfies PricingAuthenticatedQuotationAuthorityService;

describe('issue #785 Pricing Quotation revalidation acceptance', () => {
  it.effect('distinguishes tampering, unsupported or retired keys, dependency outage, and valid key rotation', () =>
    Effect.gen(function* verifiesOwnerAuthenticity() {
      const { quotation } = yield* quotationFixture();
      const verify = (ownerOutcome: PricingQuotationOwnerAuthenticityOutcome) =>
        Effect.flatMap(
          makePricingQuotationAuthenticityService.pipe(
            Effect.provideService(PricingQuotationAuthenticityVerifier, {
              verifyImmutableQuotation: () => Effect.succeed(ownerOutcome),
            }),
          ),
          (service) => service.verify({ quotation }),
        );

      expect(yield* verify({ _tag: 'VERIFIED', evidence: authenticityEvidence(quotation.quotationRef) })).toMatchObject(
        {
          kind: 'QUOTATION_AUTHENTIC',
        },
      );
      expect(
        yield* verify({
          _tag: 'VERIFIED',
          evidence: authenticityEvidence(quotation.quotationRef, 'HISTORICAL'),
        }),
      ).toMatchObject({
        evidence: { keyStatus: 'HISTORICAL', keyVersion: '2' },
        kind: 'QUOTATION_AUTHENTIC',
      });
      expect(
        yield* verify({ _tag: 'INVALID', quotationRef: quotation.quotationRef, reason: 'PAYLOAD_TAMPERED' }),
      ).toEqual({
        kind: 'QUOTATION_AUTHENTICITY_INVALID',
        quotationRef: quotation.quotationRef,
        reason: 'PAYLOAD_TAMPERED',
      });

      for (const reason of [
        'UNKNOWN_KEY',
        'UNSUPPORTED_KEY_VERSION',
        'RETIRED_KEY_WITHOUT_LINEAGE',
        'LINEAGE_UNVERIFIABLE',
      ] as const) {
        expect(
          yield* verify({ _tag: 'UNVERIFIABLE', quotationRef: quotation.quotationRef, reason, retryable: false }),
        ).toEqual({
          kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE',
          quotationRef: quotation.quotationRef,
          reason,
          retryable: false,
        });
      }

      const outage = yield* Effect.flatMap(
        makePricingQuotationAuthenticityService.pipe(
          Effect.provideService(PricingQuotationAuthenticityVerifier, {
            verifyImmutableQuotation: () =>
              Effect.fail(
                new PricingQuotationAuthenticityProviderUnavailable({
                  reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE',
                }),
              ),
          }),
        ),
        (service) => service.verify({ quotation }),
      );
      expect(outage).toEqual({
        kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect(
    'keeps revalidation input closed to Current pricing, caller proof, Storefront, Tax, FX, and Confirmation',
    () =>
      Effect.gen(function* keepsInputClosed() {
        const { binding, quotation } = yield* quotationFixture();
        const decode = Schema.decodeUnknownEffect(PricingQuotationRevalidationRequestSchema, {
          onExcessProperty: 'error',
        });
        const forbiddenInput = yield* Effect.exit(
          decode({
            authenticityEvidence: authenticityEvidence(quotation.quotationRef),
            bearer: 'caller-controlled',
            confirmation: {
              confirmationRef: 'pricing-confirmation:785',
              expiresAt: '2099-01-01T00:00:00.000Z',
              kind: 'PRICING_COMMITMENT_CONFIRMATION_REFERENCE',
            },
            currentPrice: { amount: '950', currencyCode: 'CZK' },
            fx: { from: 'EUR', rate: '25', to: 'CZK' },
            kind: 'REVALIDATE_PRICING_QUOTATION',
            quotation,
            requestedBinding: { ...binding, storefrontId: 'storefront:other', tax: { amount: '999' } },
            trustedTime: evaluatedAt,
          }),
        );
        expect(Exit.isFailure(forbiddenInput)).toBe(true);

        const decoded = yield* decode({
          kind: 'REVALIDATE_PRICING_QUOTATION',
          quotation,
          requestedBinding: binding,
        });
        expect(decoded.quotation.quotedResult.pricingNetCommercialTotal).toEqual({
          amount: '900',
          currencyCode: 'CZK',
        });
        expect(Object.keys(decoded)).toEqual(['kind', 'quotation', 'requestedBinding']);
        expect(decoded.requestedBinding).not.toHaveProperty('storefrontId');
        expect(decoded.requestedBinding).not.toHaveProperty('tax');
        const mismatchedCurrency = yield* Effect.exit(
          decode({
            kind: 'REVALIDATE_PRICING_QUOTATION',
            quotation: { ...quotation, binding: { ...binding, currencyCode: 'EUR' } },
            requestedBinding: binding,
          }),
        );
        expect(Exit.isFailure(mismatchedCurrency)).toBe(true);

        const decodeConfirmation = Schema.decodeUnknownEffect(PricingCommitmentConfirmationReferenceSchema, {
          onExcessProperty: 'error',
        });
        const untrustedConfirmation = yield* Effect.exit(
          decodeConfirmation({
            confirmationRef: 'pricing-confirmation:785',
            expiresAt: '2099-01-01T00:00:00.000Z',
            kind: 'PRICING_COMMITMENT_CONFIRMATION_REFERENCE',
          }),
        );
        expect(Exit.isFailure(untrustedConfirmation)).toBe(true);
      }),
  );

  it.effect(
    'requires owner confirmation for a proposed non-material transition and never infers it from equality',
    () =>
      Effect.gen(function* requiresOwnerConfirmation() {
        const { binding, quotation } = yield* quotationFixture();
        const proposedEvidence = {
          originalEvidenceRef: 'catalog-selection-evidence:785:original',
          ownerModuleId: 'commerce.catalog',
          proposedEvidenceRef: 'catalog-selection-evidence:785:reissued',
        } as const;
        let ownerCalls = 0;
        const exactService = yield* makePricingQuotationBindingRevalidationService.pipe(
          Effect.provideService(PricingQuotationOwnerTransitionVerifier, {
            verifyTransition: () => {
              ownerCalls += 1;
              return Effect.succeed(ownerTransitionEvidence(quotation));
            },
          }),
          Effect.provideService(PricingGuestQuotationAuthority, verifiedGuestAuthority),
          Effect.provideService(PricingAuthenticatedQuotationAuthority, verifiedAuthenticatedAuthority),
        );

        const bindingWithPresentationOnlyFields = {
          ...binding,
          storefrontId: 'storefront:other',
          tax: { amount: '999' },
        };
        const direct = yield* exactService.assess({
          kind: 'REVALIDATE_PRICING_QUOTATION',
          quotation,
          requestedBinding: bindingWithPresentationOnlyFields,
        });
        expect(direct).toEqual({ kind: 'EXACT_MATCH', quotationRef: quotation.quotationRef });
        expect(ownerCalls).toBe(0);

        const ownerAccepted = yield* exactService.assess({
          kind: 'REVALIDATE_PRICING_QUOTATION',
          proposedEvidence,
          quotation,
          requestedBinding: binding,
        });
        expect(ownerCalls).toBe(1);
        expect(ownerAccepted).toMatchObject({
          kind: 'OWNER_REVALIDATION_ACCEPTED',
          transitionEvidence: {
            materiality: 'NON_MATERIAL',
            quotationRef: quotation.quotationRef,
            source: 'OWNING_DOMAIN_ATTESTATION',
          },
        });

        const unavailableService = yield* makePricingQuotationBindingRevalidationService.pipe(
          Effect.provideService(PricingQuotationOwnerTransitionVerifier, {
            verifyTransition: () =>
              Effect.fail(
                new PricingQuotationOwnerTransitionFailure({
                  reason: 'OWNER_EVIDENCE_UNVERIFIABLE',
                  retryable: true,
                }),
              ),
          }),
          Effect.provideService(PricingGuestQuotationAuthority, verifiedGuestAuthority),
          Effect.provideService(PricingAuthenticatedQuotationAuthority, verifiedAuthenticatedAuthority),
        );
        expect(
          yield* unavailableService.assess({
            kind: 'REVALIDATE_PRICING_QUOTATION',
            proposedEvidence,
            quotation,
            requestedBinding: binding,
          }),
        ).toEqual({
          kind: 'BINDING_UNVERIFIABLE',
          quotationRef: quotation.quotationRef,
          reason: 'OWNER_REVALIDATION_UNAVAILABLE',
          retryable: true,
        });
      }),
  );

  it.effect(
    'rejects exact scope changes and Guest A/B or Guest-to-authenticated transitions without owner rebinding',
    () =>
      Effect.gen(function* rejectsMaterialChanges() {
        const { binding, quotation } = yield* quotationFixture();
        const line = yield* requireDefined(binding.lines[0], 'Issue #785 fixture requires one quotation line');
        let ownerCalls = 0;
        const service = yield* makePricingQuotationBindingRevalidationService.pipe(
          Effect.provideService(PricingQuotationOwnerTransitionVerifier, {
            verifyTransition: () => {
              ownerCalls += 1;
              return Effect.succeed(ownerTransitionEvidence(quotation));
            },
          }),
          Effect.provideService(PricingGuestQuotationAuthority, verifiedGuestAuthority),
          Effect.provideService(PricingAuthenticatedQuotationAuthority, verifiedAuthenticatedAuthority),
        );
        const changedBindings = [
          decodeBinding({
            ...binding,
            subject: { ...binding.subject, guestSessionRef: 'guest-session:785:b' },
          }),
          decodeBinding({
            ...binding,
            subject: {
              kind: 'AUTHENTICATED',
              purchaseContext: binding.subject.purchaseContext,
              subjectEvidenceRef: 'subject-evidence:785',
              subjectRef: {
                moduleId: 'party.registry',
                resourceId: '12121212-1212-4212-8212-121212121212',
                resourceType: 'party.registry.engagement-profile',
                tenantId: binding.tenantId,
              },
            },
          }),
          decodeBinding({
            ...binding,
            commercialScope: { ...binding.commercialScope, marketId: 'sk-launch' },
          }),
          decodeBinding({
            ...binding,
            lines: [{ ...line, quantity: { ...line.quantity, amount: '101' } }],
          }),
          decodeBinding({
            ...binding,
            lines: [
              {
                ...line,
                selection: {
                  ...line.selection,
                  variantRef: {
                    ...line.selection.variantRef,
                    resourceId: '45454545-4545-4454-8454-454545454545',
                  },
                },
              },
            ],
          }),
        ];

        for (const requestedBinding of changedBindings) {
          const outcome = yield* service.assess({
            kind: 'REVALIDATE_PRICING_QUOTATION',
            proposedEvidence: {
              originalEvidenceRef: 'catalog-selection-evidence:785:original',
              ownerModuleId: 'commerce.catalog',
              proposedEvidenceRef: 'catalog-selection-evidence:785:reissued',
            },
            quotation,
            requestedBinding,
          });
          expect(outcome.kind).toBe('MISMATCH');
        }
        expect(ownerCalls).toBe(0);
      }),
  );

  it.effect('distinguishes Guest owner denial from unavailable Guest evidence', () =>
    Effect.gen(function* distinguishesGuestAuthorityFailures() {
      const { binding, quotation } = yield* quotationFixture();
      const ownerTransitionVerifier = {
        verifyTransition: () => Effect.succeed(ownerTransitionEvidence(quotation)),
      };
      const deniedService = yield* makePricingQuotationBindingRevalidationService.pipe(
        Effect.provideService(PricingQuotationOwnerTransitionVerifier, ownerTransitionVerifier),
        Effect.provideService(PricingGuestQuotationAuthority, {
          verify: () => Effect.fail(new PricingGuestQuotationAuthorityRejected({ reason: 'OWNER_REJECTED' })),
        }),
        Effect.provideService(PricingAuthenticatedQuotationAuthority, verifiedAuthenticatedAuthority),
      );
      expect(
        yield* deniedService.assess({
          kind: 'REVALIDATE_PRICING_QUOTATION',
          quotation,
          requestedBinding: binding,
        }),
      ).toEqual({
        kind: 'MISMATCH',
        quotationRef: quotation.quotationRef,
        reason: 'AUTHORITY_CONTEXT_CHANGED',
      });

      const unavailableService = yield* makePricingQuotationBindingRevalidationService.pipe(
        Effect.provideService(PricingQuotationOwnerTransitionVerifier, ownerTransitionVerifier),
        Effect.provideService(PricingGuestQuotationAuthority, {
          verify: () =>
            Effect.fail(
              new PricingGuestQuotationAuthorityUnavailable({
                reason: 'OWNER_VERIFICATION_UNAVAILABLE',
                retryable: true,
              }),
            ),
        }),
        Effect.provideService(PricingAuthenticatedQuotationAuthority, verifiedAuthenticatedAuthority),
      );
      expect(
        yield* unavailableService.assess({
          kind: 'REVALIDATE_PRICING_QUOTATION',
          quotation,
          requestedBinding: binding,
        }),
      ).toEqual({
        kind: 'BINDING_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'BINDING_DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect('authentically reuses immutable 900 CZK terms while ordinary Current is 950 without reading Current', () =>
    Effect.gen(function* reusesOriginalTerms() {
      const original = yield* quotationFixture({ priceAmount: '900' });
      const laterCurrent = yield* quotationFixture({
        priceAmount: '950',
        quotationRef: 'pricing-quotation:785:unrelated-current',
      });
      const originalSnapshot = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(original.quotation);
      let ownerTransitionCalls = 0;
      let ordinaryCurrentReads = 0;
      const ordinaryCurrentSource = {
        read: () => {
          ordinaryCurrentReads += 1;
          return Effect.die('Ordinary Current pricing is not a quotation-revalidation dependency');
        },
      };
      const binding = yield* makePricingQuotationBindingRevalidationService.pipe(
        Effect.provideService(PricingQuotationOwnerTransitionVerifier, {
          verifyTransition: () => {
            ownerTransitionCalls += 1;
            return Effect.die('Exact binding must not invoke an owner transition verifier');
          },
        }),
        Effect.provideService(PricingGuestQuotationAuthority, verifiedGuestAuthority),
        Effect.provideService(PricingAuthenticatedQuotationAuthority, verifiedAuthenticatedAuthority),
      );
      const service = makePricingQuotationRevalidationService({
        authenticity: {
          verify: () =>
            Effect.succeed({
              evidence: authenticityEvidence(original.quotation.quotationRef),
              kind: 'QUOTATION_AUTHENTIC' as const,
            }),
        },
        binding,
        validity: {
          verify: () =>
            Effect.succeed({
              _tag: 'VALID' as const,
              evaluatedAt,
              quotationRef: original.quotation.quotationRef,
              validity,
            }),
        },
      });

      const bindingWithPresentationOnlyFields = {
        ...original.binding,
        storefrontId: 'storefront:other',
        tax: { amount: '999', revisionRef: 'tax-revision:other' },
      };
      const outcome = yield* service.revalidate({
        kind: 'REVALIDATE_PRICING_QUOTATION',
        quotation: original.quotation,
        requestedBinding: bindingWithPresentationOnlyFields,
      });

      expect(outcome.kind).toBe('EXACT_REUSE');
      const exactReuse = yield* outcome.kind === 'EXACT_REUSE'
        ? Effect.succeed(outcome)
        : Effect.die(`Expected exact quotation reuse, received ${outcome.kind}`);
      expect(exactReuse.bindingProof).toEqual({ kind: 'DIRECT_EXACT_MATCH' });
      expect(exactReuse.termsAuthority).toBe('ORIGINAL_QUOTATION');
      expect(exactReuse.quotation).toBe(original.quotation);
      expect(exactReuse.quotation.quotedResult.pricingNetCommercialTotal).toEqual({
        amount: '900',
        currencyCode: 'CZK',
      });
      expect(laterCurrent.quotation.quotedResult.pricingNetCommercialTotal).toEqual({
        amount: '950',
        currencyCode: 'CZK',
      });
      expect(ordinaryCurrentReads).toBe(0);
      expect(ownerTransitionCalls).toBe(0);
      expect(ordinaryCurrentSource.read).toBeDefined();
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(original.quotation)).toBe(
        originalSnapshot,
      );
      expect(exactReuse).not.toHaveProperty('confirmation');
    }),
  );

  it.effect('returns owner-confirmed reuse only with bound attestation and preserves original terms and evidence', () =>
    Effect.gen(function* returnsOwnerConfirmedReuse() {
      const { binding: requestedBinding, quotation } = yield* quotationFixture();
      const transitionEvidence = ownerTransitionEvidence(quotation);
      const binding = yield* makePricingQuotationBindingRevalidationService.pipe(
        Effect.provideService(PricingQuotationOwnerTransitionVerifier, {
          verifyTransition: () => Effect.succeed(transitionEvidence),
        }),
        Effect.provideService(PricingGuestQuotationAuthority, verifiedGuestAuthority),
        Effect.provideService(PricingAuthenticatedQuotationAuthority, verifiedAuthenticatedAuthority),
      );
      const service = makePricingQuotationRevalidationService({
        authenticity: {
          verify: () =>
            Effect.succeed({
              evidence: authenticityEvidence(quotation.quotationRef),
              kind: 'QUOTATION_AUTHENTIC' as const,
            }),
        },
        binding,
        validity: {
          verify: () =>
            Effect.succeed({ _tag: 'VALID' as const, evaluatedAt, quotationRef: quotation.quotationRef, validity }),
        },
      });
      const outcome = yield* service.revalidate({
        kind: 'REVALIDATE_PRICING_QUOTATION',
        proposedEvidence: {
          originalEvidenceRef: transitionEvidence.originalEvidenceRef,
          ownerModuleId: transitionEvidence.ownerModuleId,
          proposedEvidenceRef: transitionEvidence.proposedEvidenceRef,
        },
        quotation,
        requestedBinding,
      });

      expect(outcome).toMatchObject({
        bindingProof: {
          kind: 'OWNER_CONFIRMED_NON_MATERIAL_TRANSITION',
          transitionEvidence,
        },
        kind: 'EXACT_REUSE',
        quotation,
        termsAuthority: 'ORIGINAL_QUOTATION',
      });
      expect(quotation.quotedResult.pricingNetCommercialTotal.amount).toBe('900');
    }),
  );

  it.effect('keeps mismatch, expiry, validity outage, authenticity failure, and binding outage distinct', () =>
    Effect.gen(function* distinguishesSafeFailures() {
      const { binding, quotation } = yield* quotationFixture();
      const authentic = {
        verify: () =>
          Effect.succeed({
            evidence: authenticityEvidence(quotation.quotationRef),
            kind: 'QUOTATION_AUTHENTIC' as const,
          }),
      };
      const exactBinding = {
        assess: () => Effect.succeed({ kind: 'EXACT_MATCH' as const, quotationRef: quotation.quotationRef }),
      };
      const valid = {
        verify: () =>
          Effect.succeed({ _tag: 'VALID' as const, evaluatedAt, quotationRef: quotation.quotationRef, validity }),
      };
      const request = { kind: 'REVALIDATE_PRICING_QUOTATION' as const, quotation, requestedBinding: binding };

      const expired = yield* makePricingQuotationRevalidationService({
        authenticity: authentic,
        binding: exactBinding,
        validity: {
          verify: () =>
            Effect.succeed({
              _tag: 'EXPIRED' as const,
              evaluatedAt: validUntil,
              quotationRef: quotation.quotationRef,
              validity,
            }),
        },
      }).revalidate(request);
      expect(expired).toMatchObject({ kind: 'EXPIRED', quotationRef: quotation.quotationRef });
      expect(expired).not.toHaveProperty('confirmation');

      const notYetValid = yield* makePricingQuotationRevalidationService({
        authenticity: authentic,
        binding: exactBinding,
        validity: {
          verify: () =>
            Effect.succeed({
              _tag: 'INVALID' as const,
              evaluatedAt: '2026-09-28T11:59:59.999Z',
              quotationRef: quotation.quotationRef,
              reason: 'NOT_YET_VALID' as const,
              validity,
            }),
        },
      }).revalidate(request);
      expect(notYetValid).toMatchObject({ kind: 'NOT_YET_VALID', quotationRef: quotation.quotationRef });

      const validityUnavailable = yield* makePricingQuotationRevalidationService({
        authenticity: authentic,
        binding: exactBinding,
        validity: {
          verify: () =>
            Effect.succeed({
              _tag: 'UNVERIFIABLE' as const,
              quotationRef: quotation.quotationRef,
              reason: 'TRUSTED_TIME_UNAVAILABLE' as const,
              retryable: true as const,
              validity,
            }),
        },
      }).revalidate(request);
      expect(validityUnavailable).toEqual({
        kind: 'VALIDITY_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'TRUSTED_TIME_UNAVAILABLE',
        retryable: true,
      });

      const tampered = yield* makePricingQuotationRevalidationService({
        authenticity: {
          verify: () =>
            Effect.succeed({
              kind: 'QUOTATION_AUTHENTICITY_INVALID' as const,
              quotationRef: quotation.quotationRef,
              reason: 'PAYLOAD_TAMPERED' as const,
            }),
        },
        binding: exactBinding,
        validity: valid,
      }).revalidate(request);
      expect(tampered).toEqual({
        kind: 'AUTHENTICITY_INVALID',
        quotationRef: quotation.quotationRef,
        reason: 'PAYLOAD_TAMPERED',
        retryable: false,
      });

      const sourceUnavailable = yield* makePricingQuotationRevalidationService({
        authenticity: {
          verify: () =>
            Effect.succeed({
              kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE' as const,
              quotationRef: quotation.quotationRef,
              reason: 'DEPENDENCY_UNAVAILABLE' as const,
              retryable: true,
            }),
        },
        binding: exactBinding,
        validity: valid,
      }).revalidate(request);
      expect(sourceUnavailable).toEqual({
        kind: 'AUTHENTICITY_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });

      const changedMarket = decodeBinding({
        ...binding,
        commercialScope: { ...binding.commercialScope, marketId: 'sk-launch' },
      });
      const newQuotation = yield* makePricingQuotationRevalidationService({
        authenticity: authentic,
        binding: {
          assess: () =>
            Effect.succeed({
              kind: 'MISMATCH' as const,
              quotationRef: quotation.quotationRef,
              reason: 'COMMERCIAL_SCOPE_CHANGED' as const,
            }),
        },
        validity: valid,
      }).revalidate({ ...request, requestedBinding: changedMarket });
      expect(newQuotation).toEqual({
        kind: 'NEW_QUOTATION_REQUIRED',
        mismatchReason: 'COMMERCIAL_SCOPE_CHANGED',
        quotationRef: quotation.quotationRef,
        retryable: false,
      });

      const bindingUnavailable = yield* makePricingQuotationRevalidationService({
        authenticity: authentic,
        binding: {
          assess: () =>
            Effect.succeed({
              kind: 'BINDING_UNVERIFIABLE' as const,
              quotationRef: quotation.quotationRef,
              reason: 'OWNER_REVALIDATION_UNAVAILABLE' as const,
              retryable: true as const,
            }),
        },
        validity: valid,
      }).revalidate(request);
      expect(bindingUnavailable).toEqual({
        kind: 'BINDING_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'OWNER_REVALIDATION_UNAVAILABLE',
        retryable: true,
      });
    }),
  );
});
