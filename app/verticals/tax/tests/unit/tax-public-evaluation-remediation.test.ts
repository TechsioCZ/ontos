import { ReadHandlerNotFound } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Effect, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { ApplicableTaxRuleSetResponseSchema } from '../../shared/apis/applicable-tax-rule-set.ts';
import { TaxEvaluationRequestSchema, TaxEvaluationResponseSchema } from '../../shared/apis/tax-evaluation.ts';
import type { TaxEvaluationResponse } from '../../shared/apis/tax-evaluation.ts';
import { SellerVatRegimeAtInstantResponseContractSchema } from '../../shared/domain/seller-vat-regime-contracts.ts';
import {
  CustomerSafeSellerNotVatPayerSchema,
  CustomerSafeTaxAmountSchema,
  CustomerSafeTaxNotDeterminedSchema,
} from '../../shared/domain/tax-kernel/customer-safe-tax-projection.ts';
import { TaxOutcomeSuccessSchema } from '../../shared/domain/tax-kernel/tax-outcome.ts';
import { SellerNotVatPayerTreatmentSchema } from '../../shared/domain/tax-kernel/tax-treatment.ts';
import { readTaxEvaluation, taxEvaluationRead } from '../../src/api/tax-evaluation.read.ts';
import type { TaxOutcome } from '../../src/domain/tax-outcome.ts';
import { taxEvaluationFromReads } from '../../src/services/tax-evaluation.service.ts';
import type { TaxEvaluationReads } from '../../src/services/tax-evaluation.service.ts';
import { STANDARD_CODE, catalogEntry, evaluationRequestInput, pricingLine } from './tax-evaluation-fixtures.ts';

type RequestInput = ReturnType<typeof evaluationRequestInput>;
type PublicTaxEvaluationWireInput = Readonly<{
  pricing: RequestInput['pricing'];
  purchase: Omit<RequestInput['purchase'], 'purchaseDemandOccurrences'> &
    Readonly<{
      purchaseDemandOccurrences: readonly RequestInput['purchase']['purchaseDemandOccurrences'][number][];
    }>;
}>;

const isEvaluated = Schema.is(TaxEvaluationResponseSchema.members[0]);
const isRejected = Schema.is(TaxEvaluationResponseSchema.members[1]);
const isDetermined = Schema.is(TaxOutcomeSuccessSchema);

const evaluatedResponse = (response: TaxEvaluationResponse) => {
  if (!isEvaluated(response)) {
    throw new Error('Expected an evaluated public response');
  }
  return response;
};

const rejectedResponse = (response: TaxEvaluationResponse) => {
  if (!isRejected(response)) {
    throw new Error('Expected a public request rejection');
  }
  return response;
};

const determinedOutcome = (outcome: TaxOutcome) => {
  if (!isDetermined(outcome)) {
    throw new Error('Expected a determined TAX outcome');
  }
  return outcome;
};

/** Provisional owner-handoff double. Its declared source does not prove a real producer or production authority. */
const currentEligibility = (wire: RequestInput) => ({
  _tag: 'CURRENT' as const,
  authorityContractRef: 'tax-remediation-test:eligibility-assembly',
  contract: 'TAX_LAUNCH_ELIGIBILITY_V1' as const,
  evidencePurpose: 'TAX' as const,
  materialEvidenceCompleteness: {
    _tag: 'OWNER_QUALIFIED_COMPLETE' as const,
    ownerEvidenceRef: 'catalog-eligibility-complete:1',
  },
  ownerEvidenceRef: 'catalog-eligibility:1',
  ownerEvidenceRevisionRef: 'revision:1',
  purchase: wire.purchase,
  requiredTaxRegimes: ['ORDINARY_DOMESTIC'] as const,
  requiredTaxTreatments: ['TAXABLE'] as const,
  sourceOwner: 'commerce.order' as const,
  taxRelevantTime: wire.taxRelevantTime,
});

const supportedWire = (overrides: Parameters<typeof evaluationRequestInput>[0] = {}) => {
  const wire = evaluationRequestInput(overrides, ['o1']);
  return { ...wire, eligibility: currentEligibility(wire) };
};

const scope: OperationalScope = {
  authContextRef: 'better-auth-session:tax-remediation-test',
  authMethod: 'session',
  correlationId: 'tax-remediation-test',
  legalEntityId: 'selling-legal-entity-1',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
};

/** Scripted TAX read observations exercise the production service, without claiming persistence or authorization. */
const observedReads = (regime: 'VAT_PAYER' | 'NON_PAYER' | 'NOT_DECLARED' = 'VAT_PAYER') => {
  const ruleCalls: string[] = [];
  const reads: TaxEvaluationReads = {
    declarations: {
      atInstant: ({ instant }) =>
        Schema.decodeEffect(SellerVatRegimeAtInstantResponseContractSchema)({
          completeness: { rowCount: regime === 'NOT_DECLARED' ? 0 : 1, setFingerprint: '1'.repeat(64) },
          headRevision: regime === 'NOT_DECLARED' ? 0 : 1,
          instant: DateTime.formatIso(instant),
          selection:
            regime === 'NOT_DECLARED'
              ? { _tag: 'NOT_DECLARED' }
              : {
                  _tag: 'DECLARED',
                  declarationRevisionRef: { revision: 1 },
                  effectiveFrom: '2026-01-01T00:00:00.000Z',
                  effectiveFromOrigin: 'DECLARED',
                  provenance: 'MERCHANT_DECLARED',
                  regime,
                },
        }).pipe(Effect.orDie, Effect.asSome),
    },
    governed: {
      applicableTaxRuleSet: ({ taxClassificationCode, taxRelevantTime }) => {
        ruleCalls.push(taxClassificationCode);
        return Schema.decodeEffect(ApplicableTaxRuleSetResponseSchema)({
          applicable: [
            {
              compositionKind: 'EXCLUSIVE',
              effectiveFrom: '2026-01-01T00:00:00.000Z',
              effectiveTo: null,
              endedEffectiveTo: null,
              ratePercent: '21',
              revisionNumber: 1,
              semanticFingerprint: '2'.repeat(64),
              taxRuleRef: {
                moduleId: 'commerce.tax',
                resourceId: 'f3206d38-7aae-4336-925c-e4c096f8acd3',
                resourceType: 'commerce.tax.tax-rule',
                tenantId: '659d106a-38dc-4552-a82d-2054d53151c6',
              },
              taxRuleRevisionRef: {
                moduleId: 'commerce.tax',
                resourceId: 'f89c5342-e6b2-46c3-8744-bc5048c7f9d9',
                resourceType: 'commerce.tax.tax-rule-revision',
                tenantId: '659d106a-38dc-4552-a82d-2054d53151c6',
              },
              treatmentCategory: 'TAXABLE',
            },
          ],
          completeness: {
            predicate: { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode },
            predicateFingerprint: '3'.repeat(64),
            rowCount: 1,
            setFingerprint: '4'.repeat(64),
          },
          excludedByCorrection: [],
          outcome: 'SELECTED',
          taxRelevantTime: DateTime.formatIso(taxRelevantTime),
        }).pipe(Effect.orDie);
      },
    },
  };
  return { reads, ruleCalls };
};

/** Public wire decoder, governed Read Runtime decoder, actual read handler and actual owner evaluation service. */
const readPublic = <Wire extends PublicTaxEvaluationWireInput>(
  wire: Wire,
  reads: TaxEvaluationReads,
  trustedScope = scope,
) =>
  Schema.decodeUnknownEffect(TaxEvaluationRequestSchema)(wire).pipe(
    Effect.tap(() => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-13T12:00:00.000Z')))),
    Effect.flatMap(Schema.decodeUnknownEffect(taxEvaluationRead.descriptor.inputSchema)),
    Effect.flatMap((request) =>
      readTaxEvaluation(request, {
        readKey: taxEvaluationRead.descriptor.readKey,
        scope: trustedScope,
        services: { evaluations: taxEvaluationFromReads(reads, trustedScope) },
      }),
    ),
    Effect.flatMap(({ result }) => Schema.encodeEffect(TaxEvaluationResponseSchema)(result)),
    Effect.flatMap(Schema.decodeUnknownEffect(TaxEvaluationResponseSchema)),
  );

const expectNonSuccess = (response: TaxEvaluationResponse, tag: string) => {
  const evaluated = evaluatedResponse(response);
  expect(Schema.is(Schema.TaggedStruct(tag, {}))(evaluated.outcome)).toBe(true);
  expect(Schema.is(CustomerSafeTaxNotDeterminedSchema)(evaluated.customerSafe)).toBe(true);
  expect(evaluated.outcome).not.toHaveProperty('result');
  expect(evaluated.customerSafe).not.toHaveProperty('purchaseTaxTotal');
};

describe('TAX #907 public receiving-contract regressions', () => {
  it.effect('a domestic rate category without material eligibility never defaults to ordinary TAX', () =>
    Effect.gen(function* missingEligibility() {
      const wire = evaluationRequestInput({}, ['o1']);
      Reflect.deleteProperty(wire, 'eligibility');
      const response = yield* readPublic(wire, observedReads().reads);
      expectNonSuccess(response, 'TAX_STATE_INDETERMINATE');
    }),
  );

  it('the public and governed-read decoders accept a purchase without rate-classification entries', () => {
    const wire = evaluationRequestInput({ catalog: [] }, ['o1']);
    for (const schema of [TaxEvaluationRequestSchema, taxEvaluationRead.descriptor.inputSchema]) {
      expect(Result.isSuccess(Schema.decodeResult(schema)(wire))).toBe(true);
    }
  });

  it.effect('ordinary supported purchase survives both decoders, the handler, service and response serialization', () =>
    Effect.gen(function* ordinaryPurchase() {
      const wire = supportedWire();
      const decoded = yield* Schema.decodeEffect(TaxEvaluationRequestSchema)(wire);
      expect(decoded).toHaveProperty('eligibility');
      const response = evaluatedResponse(yield* readPublic(wire, observedReads().reads));
      const outcome = determinedOutcome(response.outcome);
      expect(Schema.is(CustomerSafeTaxAmountSchema)(response.customerSafe)).toBe(true);
      expect(outcome.result.purchaseTaxTotal).toEqual({ amount: '210.00', currency: 'CZK' });
      expect(response.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
    }),
  );

  for (const regime of ['REVERSE_CHARGE', 'OSS', 'EXPORT', 'INTRA_EU_SPECIAL_REGIME', 'FOREIGN_VAT_REGIME'] as const) {
    it.effect(`established ${regime} is unsupported for both TAX-owned seller regimes`, () =>
      Effect.gen(function* unsupportedRegime() {
        const wire = supportedWire();
        const eligibility = { ...wire.eligibility, requiredTaxRegimes: [regime] };
        for (const sellerRegime of ['VAT_PAYER', 'NON_PAYER'] as const) {
          const response = yield* readPublic({ ...wire, eligibility }, observedReads(sellerRegime).reads);
          expectNonSuccess(response, 'TAX_CASE_UNSUPPORTED');
          expect(response).toMatchObject({ outcome: { unsupportedRequirement: regime } });
        }
      }),
    );
  }

  for (const [treatment, unsupportedRequirement] of [
    ['ZERO_RATE', 'ZERO_RATE_TREATMENT'],
    ['EXEMPTION', 'EXEMPTION_TREATMENT'],
    ['NOT_APPLICABLE', 'NOT_APPLICABLE_TREATMENT'],
  ] as const) {
    it.effect(`established ${treatment} cannot become ordinary taxable treatment`, () =>
      Effect.gen(function* unsupportedTreatment() {
        const wire = supportedWire();
        const response = yield* readPublic(
          { ...wire, eligibility: { ...wire.eligibility, requiredTaxTreatments: [treatment] } },
          observedReads().reads,
        );
        expectNonSuccess(response, 'TAX_CASE_UNSUPPORTED');
        expect(response).toMatchObject({ outcome: { unsupportedRequirement } });
      }),
    );
  }

  for (const [state, outcome] of [
    ['STALE', 'TAX_INPUT_STALE'],
    ['UNAVAILABLE', 'TAX_DEPENDENCY_UNAVAILABLE'],
    ['CONFLICTING', 'TAX_STATE_INDETERMINATE'],
    ['UNVERIFIABLE', 'TAX_STATE_INDETERMINATE'],
  ] as const) {
    it.effect(`${state} material eligibility cannot become ordinary TAX or non-payer zero`, () =>
      Effect.gen(function* unusableEligibility() {
        const wire = supportedWire();
        const eligibility = {
          _tag: 'NOT_USABLE',
          authorityContractRef: wire.eligibility.authorityContractRef,
          contract: wire.eligibility.contract,
          evidencePurpose: wire.eligibility.evidencePurpose,
          ownerEvidenceRef: wire.eligibility.ownerEvidenceRef,
          ownerEvidenceRevisionRef: wire.eligibility.ownerEvidenceRevisionRef,
          purchase: wire.purchase,
          sourceOwner: wire.eligibility.sourceOwner,
          state,
          taxRelevantTime: wire.taxRelevantTime,
        };
        for (const sellerRegime of ['VAT_PAYER', 'NON_PAYER'] as const) {
          expectNonSuccess(yield* readPublic({ ...wire, eligibility }, observedReads(sellerRegime).reads), outcome);
        }
      }),
    );
  }

  it.effect('incomplete eligibility is indeterminate even with ordinary requirements and a declared non-payer', () =>
    Effect.gen(function* incompleteEligibility() {
      const wire = supportedWire();
      const eligibility = { ...wire.eligibility, materialEvidenceCompleteness: { _tag: 'NOT_ESTABLISHED' } };
      expectNonSuccess(
        yield* readPublic({ ...wire, eligibility }, observedReads('NON_PAYER').reads),
        'TAX_STATE_INDETERMINATE',
      );
    }),
  );

  it.effect(
    'known positive unsupported requirements remain unsupported when ordinary-case completeness is absent',
    () =>
      Effect.gen(function* incompleteUnsupportedRequirements() {
        const wire = supportedWire();
        const incomplete = { ...wire.eligibility, materialEvidenceCompleteness: { _tag: 'NOT_ESTABLISHED' } };
        for (const { eligibility, requirement } of [
          { eligibility: { ...incomplete, requiredTaxRegimes: ['REVERSE_CHARGE'] }, requirement: 'REVERSE_CHARGE' },
          { eligibility: { ...incomplete, requiredTaxTreatments: ['EXEMPTION'] }, requirement: 'EXEMPTION_TREATMENT' },
        ]) {
          for (const regime of ['VAT_PAYER', 'NON_PAYER'] as const) {
            const response = yield* readPublic({ ...wire, eligibility }, observedReads(regime).reads);
            expectNonSuccess(response, 'TAX_CASE_UNSUPPORTED');
            expect(response).toMatchObject({ outcome: { unsupportedRequirement: requirement } });
          }
        }
      }),
  );

  it.effect('a non-payer purchase needs no catalog key or fabricated classification and makes no Tax Rule reads', () =>
    Effect.gen(function* nonPayerMinimalInput() {
      for (const omitCatalog of [false, true]) {
        const wire = supportedWire({ catalog: [] });
        if (omitCatalog) {
          Reflect.deleteProperty(wire, 'catalog');
        }
        const { reads, ruleCalls } = observedReads('NON_PAYER');
        const response = evaluatedResponse(yield* readPublic(wire, reads));
        const outcome = determinedOutcome(response.outcome);
        expect(outcome.decision.sellerVatRegime).toBe('NON_PAYER');
        expect(outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
        expect(ruleCalls).toEqual([]);
        expect(response.customerSafe).toEqual(CustomerSafeSellerNotVatPayerSchema.make({ contractVersion: 2 }));
        for (const unit of outcome.decision.units) {
          expect(Schema.is(SellerNotVatPayerTreatmentSchema)(unit.treatment)).toBe(true);
          expect(unit).not.toHaveProperty('taxClassification');
          expect(unit).not.toHaveProperty('governingTaxRuleRevisionRef');
        }
      }
    }),
  );

  it.effect('a missing TAX-owned seller declaration never produces zero', () =>
    Effect.gen(function* missingSellerDeclaration() {
      const { reads, ruleCalls } = observedReads('NOT_DECLARED');
      expectNonSuccess(yield* readPublic(supportedWire({ catalog: [] }), reads), 'TAX_STATE_INDETERMINATE');
      expect(ruleCalls).toEqual([]);
    }),
  );

  it.effect('a caller seller-regime flag cannot make a TAX-owned payer succeed without classification', () =>
    Effect.gen(function* untrustedSellerFlag() {
      const wire = { ...supportedWire({ catalog: [] }), isSupported: true, sellerVatRegime: 'NON_PAYER' };
      expectNonSuccess(yield* readPublic(wire, observedReads('VAT_PAYER').reads), 'TAX_STATE_INDETERMINATE');
    }),
  );

  it.effect(
    'eligibility binds tenant, seller, purchase, exact selection, quantity, unit, sources and relevant time',
    () =>
      Effect.gen(function* exactEligibilityBinding() {
        const wire = supportedWire({ catalog: [] });
        const [occurrence] = wire.purchase.purchaseDemandOccurrences;
        const bindings = [
          { ...wire.purchase, tenantId: 'other-tenant' },
          { ...wire.purchase, sellingLegalEntityRef: 'other-seller' },
          { ...wire.purchase, purchaseCandidateRef: 'other-purchase' },
          { ...wire.purchase, purchasingSubject: { _tag: 'RETAIL_CUSTOMER', purchasingSubjectRef: 'other-customer' } },
          { ...wire.purchase, pricingResultRef: { ...wire.purchase.pricingResultRef, revision: 2 } },
          {
            ...wire.purchase,
            purchaseDemandOccurrences: [
              { ...occurrence, catalogSelection: { ...occurrence.catalogSelection, variantRef: 'other-variant' } },
            ],
          },
          {
            ...wire.purchase,
            purchaseDemandOccurrences: [{ ...occurrence, quantity: { ...occurrence.quantity, amount: '2' } }],
          },
          {
            ...wire.purchase,
            purchaseDemandOccurrences: [{ ...occurrence, quantity: { ...occurrence.quantity, unitRef: 'kilogram' } }],
          },
          { ...wire.purchase, shippingSourceRef: { revision: 1, shippingAmountId: 'other-shipping' } },
        ];
        const observations = [
          ...bindings.map((purchase) => ({ ...wire.eligibility, purchase })),
          { ...wire.eligibility, taxRelevantTime: '2026-10-08T09:59:59.000Z' },
        ];
        for (const eligibility of observations) {
          const response = yield* readPublic({ ...wire, eligibility }, observedReads('NON_PAYER').reads);
          expect(rejectedResponse(response).reasons).toEqual(['STRUCTURAL_BINDING_INVALID']);
        }
      }),
  );

  it('eligibility purpose, declared source, authority contract and complete meaning remain structural requirements', () => {
    const wire = supportedWire();
    const eligibilityInputs = [
      { ...wire.eligibility, evidencePurpose: 'PRICING' },
      { ...wire.eligibility, sourceOwner: '' },
      { ...wire.eligibility, authorityContractRef: '' },
      { ...wire.eligibility, contract: 'UNSUPPORTED_CONTRACT' },
      { ...wire.eligibility, requiredTaxRegimes: [] },
      { ...wire.eligibility, requiredTaxTreatments: [] },
    ];
    for (const eligibility of eligibilityInputs) {
      expect(Result.isFailure(Schema.decodeUnknownResult(TaxEvaluationRequestSchema)({ ...wire, eligibility }))).toBe(
        true,
      );
    }
  });

  it.effect(
    'omitting non-payer classification preserves Pricing source, occurrence and supplied Catalog binding checks',
    () =>
      Effect.gen(function* nonPayerIntegrity() {
        const wire = supportedWire({ catalog: [] });
        const published = pricingLine('o1', '1000.00');
        const entry = catalogEntry('o1', STANDARD_CODE);
        const invalidRequests = [
          {
            ...wire,
            pricing: { ...wire.pricing, pricingResultRef: { ...wire.pricing.pricingResultRef, revision: 2 } },
          },
          {
            ...wire,
            pricing: { ...wire.pricing, publishedLines: [{ ...published, occurrenceId: 'unbound-occurrence' }] },
          },
          {
            ...wire,
            catalog: [
              {
                ...entry,
                classificationInput: {
                  ...entry.classificationInput,
                  catalogSelection: { ...entry.classificationInput.catalogSelection, variantRef: 'other-variant' },
                },
              },
            ],
          },
        ];
        for (const input of invalidRequests) {
          expect(rejectedResponse(yield* readPublic(input, observedReads('NON_PAYER').reads)).reasons).toEqual([
            'STRUCTURAL_BINDING_INVALID',
          ]);
        }
      }),
  );

  it.effect('non-payer zero still requires unambiguous published commercial values in purchase currency', () =>
    Effect.gen(function* nonPayerMonetaryIntegrity() {
      for (const { outcome, publishedLines } of [
        { outcome: 'TAX_STATE_INDETERMINATE', publishedLines: [] },
        { outcome: 'TAX_CASE_UNSUPPORTED', publishedLines: [pricingLine('o1', '1000.00', { currency: 'EUR' })] },
        {
          outcome: 'TAX_STATE_INDETERMINATE',
          publishedLines: [
            pricingLine('o1', '1000.00'),
            { ...pricingLine('o1', '1000.00'), pricingLineRef: 'other-pricing-line' },
          ],
        },
      ]) {
        const wire = supportedWire({
          catalog: [],
          pricing: { pricingResultRef: { pricingResultId: 'pricing-result-1', revision: 1 }, publishedLines },
        });
        expectNonSuccess(yield* readPublic(wire, observedReads('NON_PAYER').reads), outcome);
      }
    }),
  );

  it('omitting classification preserves mandatory positive quantities, unit identity and exact selection', () => {
    const wire = supportedWire({ catalog: [] });
    const [occurrence] = wire.purchase.purchaseDemandOccurrences;
    for (const invalid of [
      { ...occurrence, quantity: { amount: '0', unitRef: 'piece' } },
      { ...occurrence, quantity: { amount: '1', unitRef: '' } },
      { ...occurrence, catalogSelection: { productRef: 'product-1', variantRef: '' } },
    ]) {
      const input = { ...wire, purchase: { ...wire.purchase, purchaseDemandOccurrences: [invalid] } };
      expect(Result.isFailure(Schema.decodeUnknownResult(TaxEvaluationRequestSchema)(input))).toBe(true);
    }
  });

  it.effect('a payer still requires complete Current material classification', () =>
    Effect.gen(function* payerClassificationStrictness() {
      const entry = catalogEntry('o1', STANDARD_CODE);
      const classifications = [
        {
          ...entry,
          classificationInput: {
            ...entry.classificationInput,
            materialEvidenceCompleteness: { _tag: 'NOT_ESTABLISHED' },
          },
        },
        {
          ...entry,
          classificationInput: {
            ...entry.classificationInput,
            materialCatalogEvidence: [{ _tag: 'NOT_USABLE', catalogFactRef: 'o1:tax-category', state: 'UNVERIFIABLE' }],
          },
        },
      ];
      for (const catalog of [[], ...classifications.map((classification) => [classification])]) {
        expectNonSuccess(
          yield* readPublic({ ...supportedWire(), catalog }, observedReads('VAT_PAYER').reads),
          'TAX_STATE_INDETERMINATE',
        );
      }
    }),
  );

  it.effect('a complete empty payer rule set remains TAX_RULE_MISSING without a zero fallback', () =>
    Effect.gen(function* payerRulesStrictness() {
      const { reads } = observedReads();
      const noRules: TaxEvaluationReads = {
        ...reads,
        governed: {
          applicableTaxRuleSet: (input) =>
            reads.governed.applicableTaxRuleSet(input).pipe(
              Effect.map((response) => ({
                ...response,
                applicable: [],
                completeness: { ...response.completeness, rowCount: 0 },
                outcome: 'TAX_RULE_MISSING' as const,
              })),
            ),
        },
      };
      expectNonSuccess(yield* readPublic(supportedWire(), noRules), 'TAX_RULE_MISSING');
    }),
  );

  it.effect('eligibility and evaluation are deterministic under reordered purchase, Catalog and Pricing inputs', () =>
    Effect.gen(function* deterministicEvaluation() {
      const input = evaluationRequestInput();
      const wire = { ...input, eligibility: currentEligibility(input) };
      const reversed = {
        ...wire,
        catalog: [...(wire.catalog ?? [])].toReversed(),
        eligibility: {
          ...wire.eligibility,
          purchase: {
            ...wire.purchase,
            purchaseDemandOccurrences: [...wire.purchase.purchaseDemandOccurrences].toReversed(),
          },
        },
        pricing: { ...wire.pricing, publishedLines: [...wire.pricing.publishedLines].toReversed() },
        purchase: {
          ...wire.purchase,
          purchaseDemandOccurrences: [...wire.purchase.purchaseDemandOccurrences].toReversed(),
        },
      };
      for (const regime of ['VAT_PAYER', 'NON_PAYER'] as const) {
        const before = evaluatedResponse(yield* readPublic(wire, observedReads(regime).reads));
        const after = evaluatedResponse(yield* readPublic(reversed, observedReads(regime).reads));
        const beforeOutcome = determinedOutcome(before.outcome);
        const afterOutcome = determinedOutcome(after.outcome);
        expect(afterOutcome.result).toEqual(beforeOutcome.result);
        expect(afterOutcome.decision.decisionId).toEqual(beforeOutcome.decision.decisionId);
        expect(after.customerSafe).toEqual(before.customerSafe);
      }
    }),
  );

  it.effect('missing eligibility never masks independently established unsupported currency, place or Set scope', () =>
    Effect.gen(function* unsupportedScopePrecedence() {
      const wire = supportedWire({ catalog: [] });
      Reflect.deleteProperty(wire, 'eligibility');
      const [occurrence] = wire.purchase.purchaseDemandOccurrences;
      const unsupportedCases = [
        {
          input: {
            ...wire,
            pricing: { ...wire.pricing, publishedLines: [pricingLine('o1', '1000.00', { currency: 'EUR' })] },
          },
          requirement: 'NON_CZK_CURRENCY',
        },
        {
          input: {
            ...wire,
            places: {
              ...wire.places,
              deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'DE', ownerEvidenceRef: 'delivery:de' },
            },
          },
          requirement: 'NON_CZECH_DOMESTIC_TAX_PLACE',
        },
        {
          input: {
            ...wire,
            purchase: {
              ...wire.purchase,
              purchaseDemandOccurrences: [
                {
                  ...occurrence,
                  catalogSelection: {
                    ...occurrence.catalogSelection,
                    setCompositionRevisionRef: { revision: 1, setCompositionId: 'set-1' },
                  },
                },
              ],
            },
            setSupplyMeanings: [{ meaning: 'MULTI_SUPPLY_SET', occurrenceId: 'o1' }],
          },
          requirement: 'SET_MULTI_SUPPLY_DECOMPOSITION',
        },
      ];
      for (const { input, requirement } of unsupportedCases) {
        for (const regime of ['VAT_PAYER', 'NON_PAYER'] as const) {
          const response = yield* readPublic(input, observedReads(regime).reads);
          expectNonSuccess(response, 'TAX_CASE_UNSUPPORTED');
          expect(response).toMatchObject({ outcome: { unsupportedRequirement: requirement } });
        }
      }
    }),
  );

  it.effect('trusted tenant and seller visibility rejects foreign purchases before TAX state reads', () =>
    Effect.gen(function* foreignScope() {
      for (const trustedScope of [
        { ...scope, tenantId: 'other-tenant' },
        { ...scope, legalEntityId: 'other-seller' },
      ]) {
        const { reads, ruleCalls } = observedReads('NON_PAYER');
        const failure = yield* Effect.flip(readPublic(supportedWire({ catalog: [] }), reads, trustedScope));
        expect(failure).toBeInstanceOf(ReadHandlerNotFound);
        expect(ruleCalls).toEqual([]);
      }
    }),
  );
});
