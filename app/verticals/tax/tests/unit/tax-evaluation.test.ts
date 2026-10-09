import { ReadHandlerUnavailable } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { SellingLegalEntityVatRegistrationState } from '../../shared/domain/tax-kernel/selling-legal-entity-vat-registration.ts';
import { readTaxEvaluation } from '../../src/api/tax-evaluation.read.ts';
import { taxEvaluationRequestRejections } from '../../src/domain/tax-evaluation-request.ts';
import { requiredTaxClassificationCodes, taxDecisionIdFor } from '../../src/domain/tax-evaluation.ts';
import {
  TaxCaseUnsupportedSchema,
  TaxDependencyUnavailableSchema,
  TaxInputStaleSchema,
  TaxPrerequisiteNotMetSchema,
  TaxRuleConflictSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
} from '../../src/domain/tax-non-success-outcome.ts';
import type { TaxNonSuccessOutcome } from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from '../../src/domain/tax-outcome.ts';
import { TaxEvaluationTimeSchema } from '../../shared/domain/tax-kernel/tax-time.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { unavailable } from '../../src/services/tax-governance-persistence.ts';
import { exactDecimal, occurrenceInput, purchaseBindingInput } from './tax-domain-fixtures.ts';
import {
  PRICING_RESULT_REF,
  REDUCED_CODE,
  STANDARD_CODE,
  catalogEntry,
  evaluate,
  evaluationRequest,
  evaluationRequestInput,
  ownState,
  pricingLine,
  selected,
} from './tax-evaluation-fixtures.ts';
import type { TaxEvaluationRequestInput } from './tax-evaluation-fixtures.ts';

const isSuccess = Schema.is(TaxOutcomeSuccessSchema);

const success = (outcome: TaxOutcome): TaxOutcomeSuccess => {
  if (!isSuccess(outcome)) {
    throw new Error('Expected a successful Tax Outcome');
  }
  return outcome;
};

const publishedByUnit = (outcome: TaxOutcome) =>
  new Map(
    success(outcome).result.units.map(({ publishedTaxAmount, taxableSupplyUnitId }) => [
      taxableSupplyUnitId,
      publishedTaxAmount.amount,
    ]),
  );

const indeterminate = TaxStateIndeterminateSchema.make({});
const shippingSourceRef = { revision: 1, shippingAmountId: 'shipping-1' } as const;

type ShippingInput = NonNullable<TaxEvaluationRequestInput['shipping']>;

const shippingInput = (overrides: Partial<ShippingInput> = {}): ShippingInput => ({
  affectedOccurrenceIds: ['o1', 'o2'],
  source: { _tag: 'CURRENT', amount: { amount: exactDecimal('100.00'), currency: 'CZK' }, shippingSourceRef },
  ...overrides,
});

const withShipping = (overrides: Partial<ShippingInput> = {}) =>
  evaluationRequest({
    purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
    shipping: shippingInput(overrides),
  });

const setSelection = {
  productRef: 'product-1',
  setCompositionRevisionRef: { revision: 1, setCompositionId: 'set-1' },
  variantRef: 'variant-1',
};

/** One Set occurrence `o1` with the given declared supply meanings. */
const setRequestInput = (
  setSupplyMeanings: TaxEvaluationRequestInput['setSupplyMeanings'] = [],
): TaxEvaluationRequestInput =>
  evaluationRequestInput(
    {
      catalog: [catalogEntry('o1', STANDARD_CODE, { catalogSelection: setSelection })],
      purchase: purchaseBindingInput(['o1'], {
        purchaseDemandOccurrences: [{ ...occurrenceInput('o1'), catalogSelection: setSelection }],
      }),
      setSupplyMeanings,
    },
    ['o1'],
  );

const forSeller = (sellerVatRegistration: SellingLegalEntityVatRegistrationState) =>
  evaluate(evaluationRequest(), ownState({ sellerVatRegistration }));

const withReducedOutcome = (outcome: 'TAX_RULE_MISSING' | 'TAX_RULE_OVERLAP' | 'TAX_RULE_CONFLICT') =>
  evaluate(
    evaluationRequest(),
    ownState({
      ruleSets: new Map([
        [STANDARD_CODE, selected('21', 'rule-standard')],
        [REDUCED_CODE, { applicable: [], outcome }],
      ]),
    }),
  );

const eurLineOnO2 = () =>
  evaluationRequest({
    pricing: {
      pricingResultRef: PRICING_RESULT_REF,
      publishedLines: [pricingLine('o1', '1000.00'), pricingLine('o2', '10', 'EUR')],
    },
  });

describe('Prospective Launch Tax evaluation', () => {
  it('#936 #935 #942 mixed rates: one Decision with one Result per Taxable Supply Unit, rounded once per unit', () => {
    const outcome = success(evaluate());

    expect(publishedByUnit(outcome)).toEqual(
      new Map([
        ['taxable-supply-unit:o1', '210.00'],
        ['taxable-supply-unit:o2', '60.00'],
      ]),
    );
    expect(outcome.result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
    expect(outcome.decision.units.map(({ governingTaxRuleRevisionRef }) => governingTaxRuleRevisionRef)).toEqual([
      { revision: 1, taxRuleId: 'rule-standard' },
      { revision: 1, taxRuleId: 'rule-reduced' },
    ]);
    expect(outcome.decision.units.map(({ taxClassification }) => taxClassification.classificationCode)).toEqual([
      STANDARD_CODE,
      REDUCED_CODE,
    ]);
  });

  it('#941 F1 #937 F33-F35 Tax-Relevant Time and Tax Evaluation Time are kept as distinct meanings', () => {
    const { decision } = success(evaluate());

    expect(DateTime.formatIso(decision.taxRelevantTime)).toBe('2026-10-08T10:00:00.000Z');
    expect(DateTime.formatIso(decision.taxEvaluationTime)).toBe('2026-10-08T10:00:02.000Z');
  });

  it('#935 F21-F22 a unit is published ROUND_HALF_UP at 0.01 CZK from its exact contribution', () => {
    const request = evaluationRequest(
      { pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', '33.33')] } },
      ['o1'],
    );

    expect(publishedByUnit(evaluate(request))).toEqual(new Map([['taxable-supply-unit:o1', '7.00']]));
  });

  describe('#942 F23 deterministic Decision identity', () => {
    it('the same input and state give the same decisionId', () => {
      expect(success(evaluate()).decision.decisionId).toBe(success(evaluate()).decision.decisionId);
    });

    it('input order, Tax Evaluation Time and traceability context never change it', () => {
      const shuffled = evaluationRequest({
        catalog: [catalogEntry('o2', REDUCED_CODE), catalogEntry('o1', STANDARD_CODE)],
        pricing: {
          pricingResultRef: PRICING_RESULT_REF,
          publishedLines: [pricingLine('o2', '500.00'), pricingLine('o1', '1000.00')],
        },
        purchase: purchaseBindingInput(['o2', 'o1'], { traceabilityContext: { channel: 'B2B', locale: 'cs-CZ' } }),
      });
      const later = TaxEvaluationTimeSchema.make(DateTime.makeUnsafe('2026-10-08T11:00:00.000Z'));
      const expected = success(evaluate()).decision.decisionId;

      expect(success(evaluate(shuffled)).decision.decisionId).toBe(expected);
      expect(success(evaluate(evaluationRequest(), ownState(), later)).decision.decisionId).toBe(expected);
    });

    it('#937 F33 a different Tax-Relevant Time is a different Decision binding', () => {
      const atOtherTime = evaluationRequest({ taxRelevantTime: '2026-10-08T09:00:00.000Z' });

      expect(success(evaluate(atOtherTime)).decision.decisionId).not.toBe(success(evaluate()).decision.decisionId);
    });

    it('the decisionId is recomputable from the Decision itself', () => {
      const { decision } = success(evaluate());

      expect(taxDecisionIdFor(decision, taxMeaningFingerprint)).toBe(decision.decisionId);
    });
  });

  describe('#938 typed non-success, never a guessed Decision', () => {
    it('#942 F4-F5 each seller state keeps its own meaning', () => {
      expect(forSeller('KNOWN_ENDED_OR_NON_REGISTERED')).toEqual(
        TaxPrerequisiteNotMetSchema.make({ unmetPrerequisite: 'SELLING_LEGAL_ENTITY_CURRENT_CZ_VAT_REGISTRATION' }),
      );
      expect(forSeller('STALE')).toEqual(TaxInputStaleSchema.make({}));
      expect(forSeller('UNAVAILABLE')).toEqual(TaxDependencyUnavailableSchema.make({}));
      expect(forSeller('UNKNOWN')).toEqual(indeterminate);
      expect(forSeller('UNRESOLVED')).toEqual(indeterminate);
    });

    it('#942 F12-F15 a complete rule set outcome is reported as is', () => {
      const expectations: readonly (readonly [Parameters<typeof withReducedOutcome>[0], TaxNonSuccessOutcome])[] = [
        ['TAX_RULE_MISSING', TaxRuleMissingSchema.make({})],
        ['TAX_RULE_OVERLAP', TaxRuleOverlapSchema.make({})],
        ['TAX_RULE_CONFLICT', TaxRuleConflictSchema.make({})],
      ];

      for (const [outcome, expected] of expectations) {
        expect(withReducedOutcome(outcome)).toEqual(expected);
      }
    });

    it('#942 F12 a rule set that was not read is not authoritative absence', () => {
      const state = ownState({ ruleSets: new Map([[STANDARD_CODE, selected('21', 'rule-standard')]]) });

      expect(evaluate(evaluationRequest(), state)).toEqual(indeterminate);
    });

    it('#938 F7 a known non-Czech place is out of scope before a known-negative seller', () => {
      const request = evaluationRequest({
        places: {
          ...evaluationRequestInput().places,
          deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'DE', ownerEvidenceRef: 'delivery-de' },
        },
      });

      expect(evaluate(request, ownState({ sellerVatRegistration: 'KNOWN_ENDED_OR_NON_REGISTERED' }))).toEqual(
        TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NON_CZECH_DOMESTIC_TAX_PLACE' }),
      );
    });

    it('#927 F19 an unavailable material place is TAX_DEPENDENCY_UNAVAILABLE, never a CZ fallback', () => {
      const request = evaluationRequest({
        places: {
          ...evaluationRequestInput().places,
          deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
        },
      });

      expect(evaluate(request)).toEqual(TaxDependencyUnavailableSchema.make({}));
    });

    it('#926 F12-F13 D9 without exactly one TAX_CATEGORY fact the classification is indeterminate', () => {
      const request = evaluationRequest(
        { catalog: [catalogEntry('o1', STANDARD_CODE, { factKind: 'CATEGORY_ANCESTRY' })] },
        ['o1'],
      );

      expect(evaluate(request)).toEqual(indeterminate);
    });

    it('#931 F14 a missing published line is never estimated', () => {
      const request = evaluationRequest({
        pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', '1000.00')] },
      });

      expect(evaluate(request)).toEqual(indeterminate);
    });

    it('#931 F15-F16 a non-CZK published line is never relabelled', () => {
      const request = evaluationRequest(
        { pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', '10', 'EUR')] } },
        ['o1'],
      );

      expect(evaluate(request)).toEqual(TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NON_CZK_CURRENCY' }));
    });

    it('#920 F29-F30 a multi-supply Set is unsupported, never split', () => {
      const request = evaluationRequest(setRequestInput([{ meaning: 'MULTI_SUPPLY_SET', occurrenceId: 'o1' }]), ['o1']);

      expect(evaluate(request)).toEqual(
        TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'SET_MULTI_SUPPLY_DECOMPOSITION' }),
      );
    });
  });

  describe('#938 F3 F7 F16 unsupported scope is reported before prerequisites and configuration', () => {
    const nonCzk = TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NON_CZK_CURRENCY' });

    it("one unit's missing rule never masks another unit's unsupported currency", () => {
      const state = ownState({
        ruleSets: new Map([
          [STANDARD_CODE, { applicable: [], outcome: 'TAX_RULE_MISSING' }],
          [REDUCED_CODE, selected('12', 'rule-reduced')],
        ]),
      });

      expect(evaluate(eurLineOnO2(), state)).toEqual(nonCzk);
    });

    it('a known-negative seller never masks an unsupported unit', () => {
      expect(evaluate(eurLineOnO2(), ownState({ sellerVatRegistration: 'KNOWN_ENDED_OR_NON_REGISTERED' }))).toEqual(
        nonCzk,
      );
    });

    it('#938 F7 a known-negative seller is not reported while a material place is not established', () => {
      const request = evaluationRequest({
        places: {
          ...evaluationRequestInput().places,
          deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
        },
      });

      expect(evaluate(request, ownState({ sellerVatRegistration: 'KNOWN_ENDED_OR_NON_REGISTERED' }))).toEqual(
        TaxDependencyUnavailableSchema.make({}),
      );
    });

    it('#931 F14 a purchase without any published line is indeterminate, not rejected', () => {
      const request = evaluationRequest({ pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [] } }, [
        'o1',
      ]);

      expect(taxEvaluationRequestRejections(request)).toEqual([]);
      expect(evaluate(request)).toEqual(indeterminate);
    });
  });

  describe('#933 Shipping allocation (PO decision D3 default)', () => {
    it('owner-approved weights keyed by occurrence are applied exactly to TAX unit identities', () => {
      const outcome = success(
        evaluate(
          withShipping({
            allocationWeights: {
              approvalEvidenceRef: 'weights-approval-1',
              weights: [
                { occurrenceId: 'o1', weight: exactDecimal('3') },
                { occurrenceId: 'o2', weight: exactDecimal('1') },
              ],
            },
          }),
        ),
      );

      // o1: (1000 + 75) * 21 % = 225.75; o2: (500 + 25) * 12 % = 63.00
      expect(publishedByUnit(outcome)).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '225.75'],
          ['taxable-supply-unit:o2', '63.00'],
        ]),
      );
      expect(
        outcome.decision.shippingAllocation?.unitAllocations.map(({ taxableSupplyUnitId }) => taxableSupplyUnitId),
      ).toEqual(['taxable-supply-unit:o1', 'taxable-supply-unit:o2']);
    });

    it('several affected units without owner-approved weights get no guessed split', () => {
      expect(evaluate(withShipping())).toEqual(indeterminate);
    });

    it('one affected unit takes the whole Shipping amount', () => {
      expect(publishedByUnit(evaluate(withShipping({ affectedOccurrenceIds: ['o2'] })))).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '210.00'],
          ['taxable-supply-unit:o2', '72.00'],
        ]),
      );
    });

    it('stale Shipping is not zero Shipping', () => {
      expect(evaluate(withShipping({ source: { _tag: 'NOT_ESTABLISHED', state: 'STALE' } }))).toEqual(
        TaxInputStaleSchema.make({}),
      );
    });
  });

  it('classification codes needed for rule reads are distinct and in canonical order', () => {
    expect(requiredTaxClassificationCodes(evaluationRequest())).toEqual([REDUCED_CODE, STANDARD_CODE]);
  });
});

describe('Structural binding of the evaluation request (#937 F11-F30)', () => {
  it('a structurally bound request has no rejection', () => {
    expect(taxEvaluationRequestRejections(evaluationRequest())).toEqual([]);
  });

  it('Catalog evidence must cover every occurrence', () => {
    expect(taxEvaluationRequestRejections(evaluationRequest({ catalog: [catalogEntry('o1', STANDARD_CODE)] }))).toEqual(
      ['STRUCTURAL_BINDING_INVALID'],
    );
  });

  it('Catalog evidence must be issued for the exact Catalog Selection', () => {
    const request = evaluationRequest(
      {
        catalog: [
          catalogEntry('o1', STANDARD_CODE, { catalogSelection: { productRef: 'product-1', variantRef: 'variant-2' } }),
        ],
      },
      ['o1'],
    );

    expect(taxEvaluationRequestRejections(request)).toEqual(['STRUCTURAL_BINDING_INVALID']);
  });

  it('a published line of an unbound occurrence is rejected', () => {
    const request = evaluationRequest(
      {
        pricing: {
          pricingResultRef: PRICING_RESULT_REF,
          publishedLines: [pricingLine('o1', '1000.00'), pricingLine('o9', '1.00')],
        },
      },
      ['o1'],
    );

    expect(taxEvaluationRequestRejections(request)).toEqual(['STRUCTURAL_BINDING_INVALID']);
  });

  it('#937 F26-F28 published lines must come from the exact Pricing Result the binding names', () => {
    const otherResult = evaluationRequest({
      pricing: {
        pricingResultRef: { pricingResultId: 'pricing-result-2', revision: 1 },
        publishedLines: [pricingLine('o1', '1000.00'), pricingLine('o2', '500.00')],
      },
    });

    expect(taxEvaluationRequestRejections(otherResult)).toEqual(['STRUCTURAL_BINDING_INVALID']);
  });

  it('#937 F27 one Pricing Line never stands for two occurrences', () => {
    const shared = evaluationRequest({
      pricing: {
        pricingResultRef: PRICING_RESULT_REF,
        publishedLines: [
          pricingLine('o1', '1000.00'),
          { ...pricingLine('o2', '500.00'), pricingLineRef: 'pricing-line-o1' },
        ],
      },
    });

    expect(taxEvaluationRequestRejections(shared)).toEqual(['STRUCTURAL_BINDING_INVALID']);
  });

  it('#937 F29-F30 Shipping evidence must be the exact source revision the binding names', () => {
    const mismatched = withShipping({
      source: {
        _tag: 'CURRENT',
        amount: { amount: exactDecimal('100.00'), currency: 'CZK' },
        shippingSourceRef: { revision: 2, shippingAmountId: 'shipping-1' },
      },
    });
    const unbound = evaluationRequest({ shipping: shippingInput() });

    expect(taxEvaluationRequestRejections(mismatched)).toEqual(['STRUCTURAL_BINDING_INVALID']);
    expect(taxEvaluationRequestRejections(unbound)).toEqual(['STRUCTURAL_BINDING_INVALID']);
  });

  it('#934 a Set occurrence without a declared supply meaning is rejected, never guessed ordinary', () => {
    expect(taxEvaluationRequestRejections(evaluationRequest(setRequestInput(), ['o1']))).toEqual([
      'SET_MEANING_UNDECLARED',
    ]);
  });
});

describe('Tax evaluation read handler', () => {
  it.effect('a failed TAX own read is a retryable unavailable read, never a guessed Tax Outcome', () =>
    Effect.gen(function* unavailableOwnState() {
      const failure = yield* Effect.flip(
        readTaxEvaluation(evaluationRequest(), {
          readKey: 'commerce.tax.api.tax-evaluation',
          scope: {
            authContextRef: 'better-auth-session:test',
            authMethod: 'session',
            correlationId: 'correlation-1',
            legalEntityId: 'selling-legal-entity-1',
            principalId: 'principal-1',
            tenantId: 'tenant-1',
          },
          services: { evaluations: { evaluate: () => Effect.fail(unavailable()) } },
        }),
      );

      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
    }),
  );
});
