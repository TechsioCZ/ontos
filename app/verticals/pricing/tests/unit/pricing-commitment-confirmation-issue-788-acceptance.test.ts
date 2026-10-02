import {
  PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationExpiredSchema,
  PricingCommitmentConfirmationIssuedSchema,
  PricingCommitmentConfirmationIssuedOutcomeSchema,
  PricingCommitmentConfirmationNotYetValidSchema,
  PricingCommitmentConfirmationRenewedOutcomeSchema,
  PricingCommitmentConfirmationReplacementBundleRequiredSchema,
  PricingCommitmentConfirmationSourceInvalidSchema,
  PricingCommitmentConfirmationSourceUnverifiableSchema,
  PricingCommitmentConfirmationVerifiedSchema,
  PricingCurrentBackedConfirmationSourceSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { PricingQuotationGuestBindingSchema } from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePricingCurrentBackedConfirmationIssuanceService,
  PricingCurrentBackedConfirmationUnavailable,
} from '../../src/services/current-backed-confirmation-issuance.service.ts';
import { projectPricingCommercialTotal } from '../../src/services/commercial-total-projection.service.ts';
import { makePricingCommitmentConfirmationRenewalService } from '../../src/services/commitment-confirmation-renewal.service.ts';
import {
  makePricingCommitmentConfirmationVerificationService,
  PricingCommitmentConfirmationOwnerVerifier,
  PricingCommitmentConfirmationOwnerVerifierUnavailable,
} from '../../src/services/commitment-confirmation-verification.service.ts';
import {
  makePricingQuotationBackedConfirmationIssuanceService,
  PricingCommitmentConfirmationProofIssuanceUnavailable,
  PricingQuotationBackedConfirmationBindingRejected,
} from '../../src/services/quotation-backed-confirmation-issuance.service.ts';
import { makePricingQuotationRevalidationService } from '../../src/services/quotation-revalidation.service.ts';
import {
  issue788ConfirmationAuthenticity,
  issue788ExpiresAt,
  issue788IssuedAt,
  makeIssue788Binding,
  makeIssue788CommercialTotal,
  makeIssue788CurrentSource,
  makeIssue788CurrentConfirmation,
  makeIssue788IssuedConfirmation,
  makeIssue788Quotation,
  makeIssue788QuotationAuthenticity,
  makeIssue788QuotationSource,
} from './support/issue-788-confirmation.fixture.ts';

const confirmationVerificationEvidence = (confirmationRef: string, verifiedAt: string) => ({
  authenticityRef: `pricing-confirmation-authenticity:${confirmationRef}`,
  confirmationRef,
  issuerRef: issue788ConfirmationAuthenticity.issuerRef,
  keyRef: issue788ConfirmationAuthenticity.keyRef,
  keyStatus: 'ACTIVE' as const,
  keyVersion: issue788ConfirmationAuthenticity.keyVersion,
  lineageRef: issue788ConfirmationAuthenticity.lineageRef,
  payloadDigest: issue788ConfirmationAuthenticity.payloadDigest,
  proofRef: issue788ConfirmationAuthenticity.proofRef,
  proofVersion: issue788ConfirmationAuthenticity.proofVersion,
  verifiedAt,
});

const decodeIssued = Schema.decodeUnknownSync(PricingCommitmentConfirmationIssuedOutcomeSchema);
const decodeSourceInvalid = Schema.decodeUnknownSync(PricingCommitmentConfirmationSourceInvalidSchema);
const decodeSourceUnverifiable = Schema.decodeUnknownSync(PricingCommitmentConfirmationSourceUnverifiableSchema);
const decodeVerified = Schema.decodeUnknownSync(PricingCommitmentConfirmationVerifiedSchema);
const decodeExpired = Schema.decodeUnknownSync(PricingCommitmentConfirmationExpiredSchema);
const decodeNotYetValid = Schema.decodeUnknownSync(PricingCommitmentConfirmationNotYetValidSchema);
const decodeBindingMismatch = Schema.decodeUnknownSync(PricingCommitmentConfirmationBindingMismatchSchema);
const decodeAuthenticityUnverifiable = Schema.decodeUnknownSync(
  PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
);
const decodeRenewed = Schema.decodeUnknownSync(PricingCommitmentConfirmationRenewedOutcomeSchema);
const decodeReplacementRequired = Schema.decodeUnknownSync(
  PricingCommitmentConfirmationReplacementBundleRequiredSchema,
);
const decodeStrictIssuedConfirmation = Schema.decodeUnknownSync(PricingCommitmentConfirmationIssuedSchema, {
  onExcessProperty: 'error',
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const requireDefined = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const makeIssue788VerificationService = (options?: { readonly unavailable?: boolean }) =>
  makePricingCommitmentConfirmationVerificationService.pipe(
    Effect.provideService(PricingCommitmentConfirmationOwnerVerifier, {
      verifyImmutableConfirmation: ({ confirmation, verifiedAt }) =>
        options?.unavailable === true
          ? Effect.fail(
              new PricingCommitmentConfirmationOwnerVerifierUnavailable({
                reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE',
              }),
            )
          : Effect.succeed({
              _tag: 'VERIFIED' as const,
              authenticityEvidence: confirmationVerificationEvidence(confirmation.confirmationRef, verifiedAt),
            }),
    }),
  );

const exactQuotationRevalidation = (quotation: ReturnType<typeof makeIssue788Quotation>) =>
  makePricingQuotationRevalidationService({
    authenticity: {
      verify: () =>
        Effect.succeed({
          evidence: makeIssue788QuotationAuthenticity(quotation),
          kind: 'QUOTATION_AUTHENTIC' as const,
        }),
    },
    binding: {
      assess: () => Effect.succeed({ kind: 'EXACT_MATCH' as const, quotationRef: quotation.quotationRef }),
    },
    validity: {
      verify: () =>
        Effect.succeed({
          _tag: 'VALID' as const,
          evaluatedAt: issue788IssuedAt,
          quotationRef: quotation.quotationRef,
          validity: quotation.validity,
        }),
    },
  });

const unchangedQuotationBindingAuthority = {
  verifyUnchangedBinding: () => Effect.void,
};

describe('issue #788 Pricing Commitment Confirmation acceptance', () => {
  it.effect('issues Current-backed terms only from one fresh complete owner-authorized evaluation', () =>
    Effect.gen(function* issuesCurrentBackedTerms() {
      const currentTotal = yield* makeIssue788CommercialTotal('950');
      const binding = makeIssue788Binding(currentTotal);
      const source = makeIssue788CurrentSource(currentTotal);
      const publication = yield* projectPricingCommercialTotal(currentTotal);
      let bindingChecks = 0;
      const service = makePricingCurrentBackedConfirmationIssuanceService({
        bindingAuthority: {
          verifyUnchangedBinding: ({ binding: checkedBinding }) => {
            bindingChecks += 1;
            expect(checkedBinding).toEqual(binding);
            return Effect.void;
          },
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
          issueProof: () =>
            Effect.succeed({
              authenticity: issue788ConfirmationAuthenticity,
              confirmationRef: 'pricing-confirmation:788:current:a',
            }),
        },
        sourceAuthority: { resolveCurrentSource: () => Effect.succeed(source) },
        trustedTime: { readIssuedAt: Effect.succeed(issue788IssuedAt) },
        validityPolicy: { selectDurationMilliseconds: () => Effect.succeed(30_000) },
      });

      const outcome = yield* service.issue({
        binding,
        kind: 'ISSUE_CURRENT_BACKED_PRICING_CONFIRMATION',
        source,
      });

      const issued = decodeIssued(outcome);
      expect(issued.confirmation).toMatchObject({
        binding,
        expiresAt: issue788ExpiresAt,
        issuedAt: issue788IssuedAt,
        source: { kind: 'CURRENT_BACKED' },
        terms: { pricingNetCommercialTotal: { amount: '950', currencyCode: 'CZK' } },
      });
      expect(bindingChecks).toBe(1);
      expect(
        Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source.materialEvidence.sourceEvidence.currencySupport),
      ).toBe(true);
      expect(
        Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(
          source.materialEvidence.sourceEvidence.lines[0]?.pricePath.usedPrice,
        ),
      ).toBe(true);
      expect(source.materialEvidence.externalOwnerEvidence.catalogSelections).toHaveLength(1);
      expect(
        Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source.materialEvidence.externalOwnerEvidence.market),
      ).toBe(true);
    }),
  );

  it.effect('fails Current issuance when a required owner-backed source prerequisite is unavailable', () =>
    Effect.gen(function* failsUnavailableCurrentPrerequisite() {
      const currentTotal = yield* makeIssue788CommercialTotal('950');
      const binding = makeIssue788Binding(currentTotal);
      const source = makeIssue788CurrentSource(currentTotal);
      const publication = yield* projectPricingCommercialTotal(currentTotal);
      let proofCalls = 0;
      const outcome = yield* makePricingCurrentBackedConfirmationIssuanceService({
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
            return Effect.die('Unavailable Current source must fail before proof issuance');
          },
        },
        sourceAuthority: {
          resolveCurrentSource: () =>
            Effect.fail(
              new PricingCurrentBackedConfirmationUnavailable({
                reason: 'CURRENT_OWNER_SET_UNAVAILABLE',
                retryable: true,
              }),
            ),
        },
        trustedTime: { readIssuedAt: Effect.succeed(issue788IssuedAt) },
        validityPolicy: { selectDurationMilliseconds: () => Effect.succeed(30_000) },
      }).issue({ binding, kind: 'ISSUE_CURRENT_BACKED_PRICING_CONFIRMATION', source });

      expect(decodeSourceUnverifiable(outcome)).toMatchObject({
        reason: 'CURRENT_OWNER_SET_UNAVAILABLE',
        retryable: true,
      });
      expect(proofCalls).toBe(0);
    }),
  );

  it.effect('rejects same-candidate Current snapshots spliced with another decision or owner proof', () =>
    Effect.gen(function* rejectsSplicedCurrentSnapshots() {
      const currentTotal = yield* makeIssue788CommercialTotal('950');
      const source = makeIssue788CurrentSource(currentTotal);
      const changedDecision = {
        ...source,
        currentness: {
          ...source.currentness,
          attempt: {
            ...source.currentness.attempt,
            snapshot: {
              ...source.currentness.attempt.snapshot,
              decision: {
                ...source.currentness.attempt.snapshot.decision,
                commercialScope: {
                  ...source.currentness.attempt.snapshot.decision.commercialScope,
                  marketId: 'market:spliced',
                },
              },
            },
          },
        },
      };
      const binding = requireDefined(
        source.currentness.attempt.snapshot.materialBindings.find(({ kind }) => kind === 'EXACT_PRICE_SET'),
        'Issue #788 fixture requires the exact Price material binding',
      );
      const sourceEvidence = yield* Schema.decodeUnknownEffect(PricingSourceEvidenceVerifiedPresentSchema)(
        binding.sourceEvidence,
      );
      const changedEvidence = {
        ...source,
        currentness: {
          ...source.currentness,
          attempt: {
            ...source.currentness.attempt,
            snapshot: {
              ...source.currentness.attempt.snapshot,
              materialBindings: [
                {
                  ...binding,
                  sourceEvidence: {
                    ...sourceEvidence,
                    currentFacts: sourceEvidence.currentFacts.map((fact) => ({
                      ...fact,
                      factRef: `${fact.factRef}:spliced`,
                      factRevisionRef: `${fact.factRevisionRef}:spliced`,
                    })),
                  },
                },
              ],
            },
          },
        },
      };

      expect(Schema.is(PricingCurrentBackedConfirmationSourceSchema)(changedDecision)).toBe(false);
      expect(Schema.is(PricingCurrentBackedConfirmationSourceSchema)(changedEvidence)).toBe(false);
    }),
  );

  it.effect('issues exact quotation-backed 900 CZK terms while ordinary Current is 950 without repricing', () =>
    Effect.gen(function* issuesQuotedTermsWithoutCurrentRepricing() {
      const quotedTotal = yield* makeIssue788CommercialTotal('900');
      const currentTotal = yield* makeIssue788CommercialTotal('950');
      const quotation = makeIssue788Quotation(quotedTotal);
      const binding = makeIssue788Binding(quotedTotal);
      let bindingAuthorityCalls = 0;
      let ordinaryCurrentReads = 0;
      const ordinaryCurrent = {
        read: () => {
          ordinaryCurrentReads += 1;
          return Effect.die('Quotation-backed issuance must not read ordinary Current pricing');
        },
      };
      let proofInputs: readonly unknown[] = [];
      const service = makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: {
          verifyUnchangedBinding: ({ binding: verifiedBinding, source }) => {
            bindingAuthorityCalls += 1;
            expect(verifiedBinding).toEqual(binding);
            expect(source.quotationRevalidation.quotation.quotedResult.pricingNetCommercialTotal.amount).toBe('900');
            return Effect.void;
          },
        },
        proofIssuer: {
          issueProof: (input) => {
            proofInputs = [...proofInputs, input];
            return Effect.succeed({
              authenticity: issue788ConfirmationAuthenticity,
              confirmationRef: 'pricing-confirmation:788:quote:a',
            });
          },
        },
        revalidation: exactQuotationRevalidation(quotation),
      });

      const outcome = yield* service.issue({
        binding,
        materialEvidence: makeIssue788QuotationSource(quotation).materialEvidence,
        quotation,
        requestedBinding: binding.purchase,
      });

      const issued = decodeIssued(outcome);
      expect(issued.confirmation.terms.pricingNetCommercialTotal).toEqual({
        amount: '900',
        currencyCode: 'CZK',
      });
      expect(currentTotal.pricingNetCommercialTotal).toEqual({ amount: '950', currencyCode: 'CZK' });
      expect(issued.confirmation.source).toMatchObject({
        kind: 'QUOTATION_BACKED',
        quotationRevalidation: {
          kind: 'EXACT_REUSE',
          quotation: { quotationRef: quotation.quotationRef },
          termsAuthority: 'ORIGINAL_QUOTATION',
        },
      });
      expect(issued.confirmation.binding).toEqual(binding);
      expect(issued.confirmation.binding.purchase.subject).toMatchObject({
        guestSessionRef: 'guest-session:788:a',
        kind: 'GUEST',
      });
      expect(issued.confirmation.binding.purchase.commercialScope).toEqual(quotedTotal.decision.commercialScope);
      expect(issued.confirmation.binding.purchase.lines[0]?.selection.variantRef).toEqual(
        quotedTotal.decision.lines[0]?.catalog.selection.variantRef,
      );
      expect(proofInputs).toHaveLength(1);
      expect(bindingAuthorityCalls).toBe(1);
      expect(ordinaryCurrentReads).toBe(0);
      expect(ordinaryCurrent.read).toBeDefined();
      const encodedConfirmation = yield* encodeJson(issued.confirmation);
      expect(encodedConfirmation).not.toContain('950');
      expect(encodedConfirmation).not.toContain('EUR');
      expect(encodedConfirmation).not.toContain('exchangeRate');
    }),
  );

  it.effect('fails before proof issuance when the Attempt is absent or its exact Bundle binding changed', () =>
    Effect.gen(function* rejectsMissingOrChangedAttemptBinding() {
      const quotedTotal = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quotedTotal);
      const binding = makeIssue788Binding(quotedTotal);
      const line = requireDefined(binding.purchase.lines[0], 'Issue #788 fixture requires one quoted line');
      let proofCalls = 0;
      const proofIssuer = {
        issueProof: () => {
          proofCalls += 1;
          return Effect.die('Rejected Attempt or Bundle must fail before proof issuance');
        },
      };
      const missing = yield* makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: {
          verifyUnchangedBinding: () =>
            Effect.fail(new PricingQuotationBackedConfirmationBindingRejected({ reason: 'ATTEMPT_NOT_FOUND' })),
        },
        proofIssuer,
        revalidation: exactQuotationRevalidation(quotation),
      }).issue({
        binding,
        materialEvidence: makeIssue788QuotationSource(quotation).materialEvidence,
        quotation,
        requestedBinding: binding.purchase,
      });
      expect(decodeBindingMismatch(missing)).toMatchObject({
        reason: 'ATTEMPT_NOT_FOUND',
        retryable: false,
      });

      const changedBindings = [
        {
          expectedReason: 'BUNDLE_CHANGED',
          value: { ...binding, decisionBundleRef: 'order-decision-bundle:788:other' },
        },
        { expectedReason: 'BUNDLE_CHANGED', value: { ...binding, decisionBundleHash: 'sha256:bundle-788-other' } },
        { expectedReason: 'BUNDLE_CHANGED', value: { ...binding, decisionBundleVersion: '2' } },
        {
          expectedReason: 'PURCHASE_CHANGED',
          value: {
            ...binding,
            purchase: {
              ...binding.purchase,
              lines: [
                {
                  ...line,
                  selection: {
                    ...line.selection,
                    variantRef: {
                      ...line.selection.variantRef,
                      resourceId: '56565656-5656-4656-8656-565656565656',
                    },
                  },
                },
              ],
            },
          },
        },
      ] as const;

      for (const { expectedReason, value: changedBinding } of changedBindings) {
        const changed = yield* makePricingQuotationBackedConfirmationIssuanceService({
          bindingAuthority: {
            verifyUnchangedBinding: ({ binding: verifiedBinding }) => {
              expect(verifiedBinding).toEqual(changedBinding);
              return Effect.fail(
                new PricingQuotationBackedConfirmationBindingRejected({
                  reason: expectedReason,
                }),
              );
            },
          },
          proofIssuer,
          revalidation: exactQuotationRevalidation(quotation),
        }).issue({
          binding: changedBinding,
          materialEvidence: makeIssue788QuotationSource(quotation).materialEvidence,
          quotation,
          requestedBinding: changedBinding.purchase,
        });
        expect(decodeBindingMismatch(changed)).toMatchObject({
          reason: expectedReason,
          retryable: false,
        });
      }
      expect(proofCalls).toBe(0);
    }),
  );

  it.effect('caps quotation-backed validity at the earlier quotation expiry and rejects a zero interval', () =>
    Effect.gen(function* enforcesQuoteExpiryCap() {
      const quotedTotal = yield* makeIssue788CommercialTotal('900');
      const cappedQuotation = makeIssue788Quotation(
        quotedTotal,
        'pricing-quotation:788:capped',
        '2026-09-28T12:00:12.000Z',
      );
      const binding = makeIssue788Binding(quotedTotal);
      const service = makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: unchangedQuotationBindingAuthority,
        proofIssuer: {
          issueProof: () =>
            Effect.succeed({
              authenticity: issue788ConfirmationAuthenticity,
              confirmationRef: 'pricing-confirmation:788:quote:capped',
            }),
        },
        revalidation: exactQuotationRevalidation(cappedQuotation),
      });

      const capped = yield* service.issue({
        binding,
        materialEvidence: makeIssue788QuotationSource(cappedQuotation).materialEvidence,
        quotation: cappedQuotation,
        requestedBinding: binding.purchase,
      });
      expect(decodeIssued(capped).confirmation).toMatchObject({
        expiresAt: '2026-09-28T12:00:12.000Z',
        issuedAt: issue788IssuedAt,
      });

      const exhaustedQuotation = makeIssue788Quotation(
        quotedTotal,
        'pricing-quotation:788:exhausted',
        issue788IssuedAt,
      );
      const exhausted = yield* makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: unchangedQuotationBindingAuthority,
        proofIssuer: {
          issueProof: () => Effect.die('A zero quote interval must fail before proof issuance'),
        },
        revalidation: exactQuotationRevalidation(exhaustedQuotation),
      }).issue({
        binding,
        materialEvidence: makeIssue788QuotationSource(exhaustedQuotation).materialEvidence,
        quotation: exhaustedQuotation,
        requestedBinding: binding.purchase,
      });
      expect(decodeSourceInvalid(exhausted)).toMatchObject({
        reason: 'QUOTATION_HAS_NO_POSITIVE_CONFIRMATION_INTERVAL',
        retryable: false,
      });
    }),
  );

  it.effect('rejects stale and future Quotation revalidation as Confirmation authority', () =>
    Effect.gen(function* rejectsTemporallyDetachedQuotationRevalidation() {
      const quotedTotal = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quotedTotal);
      const binding = makeIssue788Binding(quotedTotal);
      const source = makeIssue788QuotationSource(quotation);
      const confirmation = {
        authenticity: issue788ConfirmationAuthenticity,
        binding,
        confirmationRef: 'pricing-confirmation:788:detached',
        expiresAt: issue788ExpiresAt,
        issuedAt: issue788IssuedAt,
        kind: 'PRICING_COMMITMENT_CONFIRMATION',
        terms: quotation.quotedResult,
      } as const;
      const sourceAt = (evaluatedAt: string) => ({
        ...source,
        quotationRevalidation: {
          ...source.quotationRevalidation,
          authenticityEvidence: {
            ...source.quotationRevalidation.authenticityEvidence,
            verifiedAt: evaluatedAt,
          },
          evaluatedAt,
        },
      });

      expect(() =>
        decodeStrictIssuedConfirmation({ ...confirmation, source: sourceAt('2026-09-28T11:59:29.999Z') }),
      ).toThrow();
      expect(() =>
        decodeStrictIssuedConfirmation({ ...confirmation, source: sourceAt('2026-09-28T12:00:00.001Z') }),
      ).toThrow();
    }),
  );

  it.effect('distinguishes quotation prerequisite outage from owner proof issuance outage', () =>
    Effect.gen(function* distinguishesPrerequisiteOutages() {
      const quotedTotal = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quotedTotal);
      const binding = makeIssue788Binding(quotedTotal);
      const quoteUnavailable = yield* makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: unchangedQuotationBindingAuthority,
        proofIssuer: {
          issueProof: () => Effect.die('Unverifiable Quotation must fail before proof issuance'),
        },
        revalidation: {
          revalidate: () =>
            Effect.succeed({
              kind: 'AUTHENTICITY_UNVERIFIABLE' as const,
              quotationRef: quotation.quotationRef,
              reason: 'DEPENDENCY_UNAVAILABLE' as const,
              retryable: true as const,
            }),
        },
      }).issue({
        binding,
        materialEvidence: makeIssue788QuotationSource(quotation).materialEvidence,
        quotation,
        requestedBinding: binding.purchase,
      });
      expect(decodeSourceUnverifiable(quoteUnavailable)).toMatchObject({
        reason: 'QUOTATION_DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });

      const proofUnavailable = yield* makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: unchangedQuotationBindingAuthority,
        proofIssuer: {
          issueProof: () =>
            Effect.fail(
              new PricingCommitmentConfirmationProofIssuanceUnavailable({
                reason: 'ISSUER_UNAVAILABLE',
                retryable: true,
              }),
            ),
        },
        revalidation: exactQuotationRevalidation(quotation),
      }).issue({
        binding,
        materialEvidence: makeIssue788QuotationSource(quotation).materialEvidence,
        quotation,
        requestedBinding: binding.purchase,
      });
      expect(decodeSourceUnverifiable(proofUnavailable)).toMatchObject({
        reason: 'CONFIRMATION_PROOF_ISSUANCE_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect('verifies the strict half-open interval before, at, and after both boundaries', () =>
    Effect.gen(function* verifiesStrictInterval() {
      const total = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788IssuedConfirmation(total);
      const service = yield* makeIssue788VerificationService();
      const verifyAt = (attemptedAt: string) =>
        service.verify({
          attemptedAt,
          confirmation,
          kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
          requestedBinding: confirmation.binding,
        });

      expect(decodeNotYetValid(yield* verifyAt('2026-09-28T11:59:59.999Z'))).toMatchObject({
        evaluatedAt: '2026-09-28T11:59:59.999Z',
      });
      expect(decodeVerified(yield* verifyAt(issue788IssuedAt))).toMatchObject({
        verifiedAt: issue788IssuedAt,
      });
      expect(decodeVerified(yield* verifyAt('2026-09-28T12:00:29.999Z'))).toMatchObject({
        verifiedAt: '2026-09-28T12:00:29.999Z',
      });
      expect(decodeExpired(yield* verifyAt(issue788ExpiresAt))).toMatchObject({
        evaluatedAt: issue788ExpiresAt,
      });
      expect(decodeExpired(yield* verifyAt('2026-09-28T12:00:30.001Z'))).toMatchObject({
        evaluatedAt: '2026-09-28T12:00:30.001Z',
      });
    }),
  );

  it.effect('requires exact Attempt, Bundle, Variant, Market, Guest, quantity, currency, and basis binding', () =>
    Effect.gen(function* rejectsEveryMaterialBindingMismatch() {
      const total = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788IssuedConfirmation(total);
      const service = yield* makeIssue788VerificationService();
      const line = requireDefined(confirmation.binding.purchase.lines[0], 'Issue #788 fixture requires one line');
      const guest = yield* Schema.decodeUnknownEffect(PricingQuotationGuestBindingSchema)(
        confirmation.binding.purchase.subject,
      );
      const bindings = [
        { expected: 'ATTEMPT_CHANGED', value: { ...confirmation.binding, attemptRef: 'attempt:other' } },
        {
          expected: 'BUNDLE_CHANGED',
          value: { ...confirmation.binding, decisionBundleHash: 'sha256:bundle-other' },
        },
        {
          expected: 'SELECTION_CHANGED',
          value: {
            ...confirmation.binding,
            purchase: {
              ...confirmation.binding.purchase,
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
            },
          },
        },
        {
          expected: 'COMMERCIAL_SCOPE_CHANGED',
          value: {
            ...confirmation.binding,
            purchase: {
              ...confirmation.binding.purchase,
              commercialScope: { ...confirmation.binding.purchase.commercialScope, marketId: 'market:other' },
            },
          },
        },
        {
          expected: 'AUTHORITY_CONTEXT_CHANGED',
          value: {
            ...confirmation.binding,
            purchase: {
              ...confirmation.binding.purchase,
              subject: { ...guest, guestSessionRef: `${guest.guestSessionRef}:other` },
            },
          },
        },
        {
          expected: 'QUANTITY_OR_UNIT_CHANGED',
          value: {
            ...confirmation.binding,
            purchase: {
              ...confirmation.binding.purchase,
              lines: [{ ...line, quantity: { ...line.quantity, amount: '2' } }],
            },
          },
        },
        {
          expected: 'CURRENCY_OR_BASIS_CHANGED',
          value: {
            ...confirmation.binding,
            purchase: { ...confirmation.binding.purchase, currencyCode: 'EUR' },
          },
        },
      ] as const;

      for (const { expected, value } of bindings) {
        const outcome = yield* service.verify({
          attemptedAt: issue788IssuedAt,
          confirmation,
          kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
          requestedBinding: value,
        });
        expect(decodeBindingMismatch(outcome)).toMatchObject({ reason: expected, retryable: false });
      }
    }),
  );

  it.effect('keeps issued proof usable through ordinary-source outage but fails when proof is unverifiable', () =>
    Effect.gen(function* distinguishesPostIssuanceOutages() {
      const total = yield* makeIssue788CommercialTotal('900');
      const confirmation = makeIssue788IssuedConfirmation(total);
      let ordinarySourceReads = 0;
      const ordinarySource = {
        load: () => {
          ordinarySourceReads += 1;
          return Effect.die('Verification must not reread ordinary Current Price');
        },
      };
      const healthy = yield* makeIssue788VerificationService();
      expect(
        decodeVerified(
          yield* healthy.verify({
            attemptedAt: issue788IssuedAt,
            confirmation,
            kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
            requestedBinding: confirmation.binding,
          }),
        ),
      ).toMatchObject({ confirmation: { confirmationRef: confirmation.confirmationRef } });
      expect(ordinarySourceReads).toBe(0);
      expect(ordinarySource.load).toBeDefined();

      const unavailable = yield* makeIssue788VerificationService({ unavailable: true });
      expect(
        decodeAuthenticityUnverifiable(
          yield* unavailable.verify({
            attemptedAt: issue788IssuedAt,
            confirmation,
            kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
            requestedBinding: confirmation.binding,
          }),
        ),
      ).toMatchObject({
        confirmationRef: confirmation.confirmationRef,
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect('renews both paths as new overlapping instances without mutating either previous proof', () =>
    Effect.gen(function* renewsBothPathsAsNewInstances() {
      const total = yield* makeIssue788CommercialTotal('900');
      const previousCurrent = makeIssue788CurrentConfirmation(total);
      const previousQuotation = makeIssue788IssuedConfirmation(total);
      const currentSnapshot = yield* encodeJson(previousCurrent);
      const quotationSnapshot = yield* encodeJson(previousQuotation);
      const renewedCurrent = {
        ...previousCurrent,
        authenticity: {
          ...previousCurrent.authenticity,
          payloadDigest: 'sha256:pricing-confirmation:788:current:b',
          proofRef: 'pricing-confirmation-proof:788:current:b',
        },
        confirmationRef: 'pricing-confirmation:788:current:b',
        expiresAt: '2026-09-28T12:00:40.000Z',
        issuedAt: '2026-09-28T12:00:10.000Z',
      };
      const renewedQuotation = {
        ...previousQuotation,
        authenticity: {
          ...previousQuotation.authenticity,
          payloadDigest: 'sha256:pricing-confirmation:788:quote:b',
          proofRef: 'pricing-confirmation-proof:788:quote:b',
        },
        confirmationRef: 'pricing-confirmation:788:quote:b',
        expiresAt: '2026-09-28T12:00:40.000Z',
        issuedAt: '2026-09-28T12:00:10.000Z',
      };
      let currentCalls = 0;
      let quotationCalls = 0;
      const renewal = makePricingCommitmentConfirmationRenewalService({
        currentIssuance: {
          issue: () => {
            currentCalls += 1;
            return Effect.succeed({ _tag: 'ISSUED' as const, confirmation: renewedCurrent });
          },
        },
        quotationIssuance: {
          issue: () => {
            quotationCalls += 1;
            return Effect.succeed({ _tag: 'ISSUED' as const, confirmation: renewedQuotation });
          },
        },
      });

      const currentOutcome = yield* renewal.renew({
        binding: previousCurrent.binding,
        kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
        previousConfirmation: previousCurrent,
      });
      const quotationOutcome = yield* renewal.renew({
        binding: previousQuotation.binding,
        kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
        previousConfirmation: previousQuotation,
      });

      expect(decodeRenewed(currentOutcome)).toMatchObject({
        confirmation: { confirmationRef: renewedCurrent.confirmationRef },
        previousConfirmationRef: previousCurrent.confirmationRef,
      });
      expect(decodeRenewed(quotationOutcome)).toMatchObject({
        confirmation: { confirmationRef: renewedQuotation.confirmationRef },
        previousConfirmationRef: previousQuotation.confirmationRef,
      });
      expect(currentCalls).toBe(1);
      expect(quotationCalls).toBe(1);
      expect(renewedCurrent.issuedAt < previousCurrent.expiresAt).toBe(true);
      expect(renewedQuotation.issuedAt < previousQuotation.expiresAt).toBe(true);
      expect(yield* encodeJson(previousCurrent)).toBe(currentSnapshot);
      expect(yield* encodeJson(previousQuotation)).toBe(quotationSnapshot);
    }),
  );

  it.effect('routes a changed Bundle to replacement without mutating the Attempt or calling either issuer', () =>
    Effect.gen(function* rejectsChangedBundleRenewal() {
      const total = yield* makeIssue788CommercialTotal('900');
      const previous = makeIssue788IssuedConfirmation(total);
      const previousSnapshot = yield* encodeJson(previous);
      let issuerCalls = 0;
      const renewal = makePricingCommitmentConfirmationRenewalService({
        currentIssuance: {
          issue: () => {
            issuerCalls += 1;
            return Effect.die('Changed Bundle must not issue a Current-backed proof');
          },
        },
        quotationIssuance: {
          issue: () => {
            issuerCalls += 1;
            return Effect.die('Changed Bundle must not issue a Quotation-backed proof');
          },
        },
      });

      const outcome = yield* renewal.renew({
        binding: { ...previous.binding, decisionBundleHash: 'sha256:bundle-788-replacement' },
        kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
        previousConfirmation: previous,
      });

      expect(decodeReplacementRequired(outcome)).toMatchObject({
        reason: 'BUNDLE_CHANGED',
        retryable: false,
      });
      expect(issuerCalls).toBe(0);
      expect(yield* encodeJson(previous)).toBe(previousSnapshot);
    }),
  );

  it('keeps Confirmation outside the Bundle hash and rejects EUR, FX, and independent-gate fields', () => {
    const decodeBinding = Schema.decodeUnknownSync(PricingCommitmentConfirmationBindingSchema, {
      onExcessProperty: 'error',
    });
    const decodeConfirmation = Schema.decodeUnknownSync(PricingCommitmentConfirmationIssuedSchema, {
      onExcessProperty: 'error',
    });
    expect(() =>
      decodeBinding({
        attemptRef: 'attempt:788',
        confirmation: { confirmationRef: 'pricing-confirmation:inside-bundle' },
        decisionBundleHash: 'sha256:bundle',
        decisionBundleRef: 'bundle:788',
        decisionBundleVersion: '1',
        purchase: {},
      }),
    ).toThrow();
    expect(() =>
      decodeConfirmation({
        authenticity: issue788ConfirmationAuthenticity,
        binding: {},
        confirmationRef: 'pricing-confirmation:788:forged',
        expiresAt: issue788ExpiresAt,
        fx: { from: 'EUR', rate: '25', to: 'CZK' },
        issuedAt: issue788IssuedAt,
        kind: 'PRICING_COMMITMENT_CONFIRMATION',
        permissionPassed: true,
        source: {},
        terms: { pricingNetCommercialTotal: { amount: '36', currencyCode: 'EUR' } },
      }),
    ).toThrow();
  });
});
