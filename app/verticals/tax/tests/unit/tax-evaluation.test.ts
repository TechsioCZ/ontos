import { ReadHandlerUnavailable } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { readTaxEvaluation } from '../../src/api/tax-evaluation.read.ts';
import { taxEvaluationRequestRejections } from '../../src/domain/tax-evaluation-request.ts';
import { requiredTaxClassificationCodes, taxDecisionIdFor } from '../../src/domain/tax-evaluation.ts';
import { exactTaxContribution } from '../../src/domain/tax-rounding.ts';
import { SellerNotVatPayerTreatmentSchema, TaxableTreatmentSchema } from '../../src/domain/tax-treatment.ts';
import { subtractTaxExactRationals, sumTaxExactRationals } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import {
  TaxCaseUnsupportedSchema,
  TaxDependencyUnavailableSchema,
  TaxInputStaleSchema,
  TaxRuleConflictSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
} from '../../src/domain/tax-non-success-outcome.ts';
import type { TaxNonSuccessOutcome } from '../../src/domain/tax-non-success-outcome.ts';
import type { SellerVatRegimeSelection } from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from '../../src/domain/tax-outcome.ts';
import { TaxEvaluationTimeSchema } from '../../shared/domain/tax-kernel/tax-time.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { unavailable } from '../../src/services/tax-governance-persistence.ts';
import { exactDecimal, occurrenceInput, purchaseBindingInput } from './tax-domain-fixtures.ts';
import {
  DECLARED_NON_PAYER,
  NOT_DECLARED,
  PRICING_RESULT_REF,
  REDUCED_CODE,
  STANDARD_CODE,
  catalogEntry,
  decodeEvaluationRequest,
  evaluate,
  evaluationRequest,
  evaluationRequestInput,
  grossLine,
  ownState,
  pricingLine,
  selected,
  shippingCharge,
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
  source: shippingCharge('100.00'),
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

const forSeller = (sellerVatRegime: SellerVatRegimeSelection) =>
  evaluate(evaluationRequest(), ownState({ sellerVatRegime }));

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
      publishedLines: [pricingLine('o1', '1000.00'), pricingLine('o2', '10', { currency: 'EUR' })],
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
    const taxableUnits = outcome.decision.units.filter(
      (unit): unit is Extract<(typeof outcome.decision.units)[number], { readonly taxClassification: unknown }> =>
        'taxClassification' in unit,
    );
    expect(taxableUnits.map(({ governingTaxRuleRevisionRef }) => governingTaxRuleRevisionRef)).toEqual([
      { revision: 1, taxRuleId: 'rule-standard' },
      { revision: 1, taxRuleId: 'rule-reduced' },
    ]);
    expect(taxableUnits.map(({ taxClassification }) => taxClassification.classificationCode)).toEqual([
      STANDARD_CODE,
      REDUCED_CODE,
    ]);
  });

  it('Unit 10 A4 a NON_PAYER seller publishes 0.00 with no classification, rule or shipping read', () => {
    const outcome = success(evaluate(evaluationRequest(), ownState({ sellerVatRegime: DECLARED_NON_PAYER })));

    expect(publishedByUnit(outcome)).toEqual(
      new Map([
        ['taxable-supply-unit:o1', '0.00'],
        ['taxable-supply-unit:o2', '0.00'],
      ]),
    );
    expect(outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
    expect(outcome.decision.sellerVatRegime).toBe('NON_PAYER');
    for (const unit of outcome.decision.units) {
      expect('taxClassification' in unit).toBe(false);
      expect(Schema.is(SellerNotVatPayerTreatmentSchema)(unit.treatment)).toBe(true);
    }
  });

  it('#962 BDD zero a supported VAT_PAYER line of 0.00 CZK is a successful taxable 0.00, not zero-rate, exempt or non-payer', () => {
    const request = evaluationRequest(
      { pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', '0.00')] } },
      ['o1'],
    );
    const outcome = success(evaluate(request, ownState()));

    expect(publishedByUnit(outcome)).toEqual(new Map([['taxable-supply-unit:o1', '0.00']]));
    expect(outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
    expect(outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
    const [unit] = outcome.decision.units;
    expect(Schema.is(TaxableTreatmentSchema)(unit.treatment)).toBe(true);
    if (Schema.is(TaxableTreatmentSchema)(unit.treatment)) {
      expect(unit.treatment.ratePercent).toBe('21');
    }
    expect(Schema.is(SellerNotVatPayerTreatmentSchema)(unit.treatment)).toBe(false);
    expect('governingTaxRuleRevisionRef' in unit && unit.governingTaxRuleRevisionRef).toEqual({
      revision: 1,
      taxRuleId: 'rule-standard',
    });
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

    it('#937 F7 identifiers that collate equal in a locale still order by exact value', () => {
      // One composed and one decomposed é: distinct identifiers that locale collation ranks as equal.
      const ids = ['o-\u00E9', 'o-e\u0301'] as const;
      const base = evaluationRequestInput({}, ids);
      const reversed = evaluationRequest(
        {
          catalog: [catalogEntry(ids[1], REDUCED_CODE), catalogEntry(ids[0], STANDARD_CODE)],
          pricing: {
            pricingResultRef: PRICING_RESULT_REF,
            publishedLines: [pricingLine(ids[1], '500.00'), pricingLine(ids[0], '1000.00')],
          },
          purchase: purchaseBindingInput([ids[1], ids[0]]),
        },
        ids,
      );

      expect(success(evaluate(reversed)).decision.decisionId).toBe(
        success(evaluate(evaluationRequest(base, ids))).decision.decisionId,
      );
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
    it('Unit 10 A4 a not-declared seller is TAX_STATE_INDETERMINATE, with the reason apart from the outcome', () => {
      expect(forSeller(NOT_DECLARED)).toEqual(indeterminate);
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

      expect(evaluate(request, ownState({ sellerVatRegime: NOT_DECLARED }))).toEqual(
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
        {
          pricing: {
            pricingResultRef: PRICING_RESULT_REF,
            publishedLines: [pricingLine('o1', '10', { currency: 'EUR' })],
          },
        },
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

    it('Unit 10 A4 a NON_PAYER seller still leaves the non-Czech place, currency and multi-supply Set scope checks in place', () => {
      const nonPayer = ownState({ sellerVatRegime: DECLARED_NON_PAYER });
      const nonCzechPlace = evaluationRequest({
        places: {
          ...evaluationRequestInput().places,
          deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'DE', ownerEvidenceRef: 'delivery-de' },
        },
      });
      expect(evaluate(nonCzechPlace, nonPayer)).toEqual(
        TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NON_CZECH_DOMESTIC_TAX_PLACE' }),
      );

      const nonCzkCurrency = evaluationRequest(
        {
          pricing: {
            pricingResultRef: PRICING_RESULT_REF,
            publishedLines: [pricingLine('o1', '10', { currency: 'EUR' })],
          },
        },
        ['o1'],
      );
      expect(evaluate(nonCzkCurrency, nonPayer)).toEqual(
        TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NON_CZK_CURRENCY' }),
      );

      const multiSupplySet = evaluationRequest(setRequestInput([{ meaning: 'MULTI_SUPPLY_SET', occurrenceId: 'o1' }]), [
        'o1',
      ]);
      expect(evaluate(multiSupplySet, nonPayer)).toEqual(
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
      expect(evaluate(eurLineOnO2(), ownState({ sellerVatRegime: NOT_DECLARED }))).toEqual(nonCzk);
    });

    it('#938 F7 a known-negative seller is not reported while a material place is not established', () => {
      const request = evaluationRequest({
        places: {
          ...evaluationRequestInput().places,
          deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
        },
      });

      expect(evaluate(request, ownState({ sellerVatRegime: NOT_DECLARED }))).toEqual(
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

  describe('LEGAL §2 D3 gross shipping basis: TAX derives the weights (#907 unit 11)', () => {
    it('D3-1 worked example: GROSS lines, GROSS shipping, exact gross-weighted shares', () => {
      const outcome = success(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '121.00'), grossLine('o2', '112.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
        ),
      );
      expect(publishedByUnit(outcome)).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '29.92'],
          ['taxable-supply-unit:o2', '17.10'],
        ]),
      );
      expect(outcome.result.purchaseTaxTotal.amount).toBe('47.02');
      expect(outcome.decision.shippingAllocation?.unitAllocations[0]?.basisComponent).toMatchObject({
        allocationKey: { key: 'GROSS_LINE_VALUE', revision: 1 },
        amountBasis: 'GROSS',
      });
      // Weights 121/112, total 233: exact shares are 99 * 121/233 = 11979/233 and 99 * 112/233 = 11088/233.
      expect(
        outcome.decision.shippingAllocation?.unitAllocations.map(({ basisComponent, taxableSupplyUnitId }) => [
          taxableSupplyUnitId,
          basisComponent.amount,
        ]),
      ).toEqual([
        ['taxable-supply-unit:o1', { denominator: '233', numerator: '11979' }],
        ['taxable-supply-unit:o2', { denominator: '233', numerator: '11088' }],
      ]);
      // The exact per-unit Tax contribution minus the exact goods-only VAT (21 and 12) isolates the exact
      // Shipping VAT; the two shipping VAT contributions must sum to exactly 3267/233 (14.02 rounded).
      const [unit1, unit2] = outcome.decision.units;
      if (unit1 === undefined || unit2 === undefined) {
        throw new Error('Expected two Decision units');
      }
      const shippingVat1: TaxExactRational = subtractTaxExactRationals(
        exactTaxContribution(unit1.taxableBasisInterpretation, unit1.treatment),
        exactDecimal('21'),
      );
      const shippingVat2: TaxExactRational = subtractTaxExactRationals(
        exactTaxContribution(unit2.taxableBasisInterpretation, unit2.treatment),
        exactDecimal('12'),
      );
      expect(sumTaxExactRationals([shippingVat1, shippingVat2])).toEqual({
        denominator: '233',
        numerator: '3267',
      });
    });

    it('D3-1s allocation-level: the exact unitAllocations amounts are the exact fractions, not display shares', () => {
      const outcome = success(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '121.00'), grossLine('o2', '112.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
        ),
      );
      const [allocation1, allocation2] = outcome.decision.shippingAllocation?.unitAllocations ?? [];
      expect(allocation1?.basisComponent.amount).toEqual({ denominator: '233', numerator: '11979' });
      expect(allocation2?.basisComponent.amount).toEqual({ denominator: '233', numerator: '11088' });
      expect(
        sumTaxExactRationals([
          allocation1?.basisComponent.amount ?? exactDecimal('0'),
          allocation2?.basisComponent.amount ?? exactDecimal('0'),
        ]),
      ).toEqual(exactDecimal('99.00'));
    });

    it('D3-10 an affected subset of 2 out of 3 units at the same rate gets the exact gross-weighted shares; the unaffected unit has none', () => {
      const outcome = success(
        evaluate(
          evaluationRequest(
            {
              catalog: [
                catalogEntry('o1', STANDARD_CODE),
                catalogEntry('o2', STANDARD_CODE),
                catalogEntry('o3', REDUCED_CODE),
              ],
              pricing: {
                pricingResultRef: PRICING_RESULT_REF,
                publishedLines: [grossLine('o1', '121.00'), grossLine('o2', '242.00'), grossLine('o3', '500.00')],
              },
              purchase: purchaseBindingInput(['o1', 'o2', 'o3'], { shippingSourceRef }),
              shipping: shippingInput({ affectedOccurrenceIds: ['o1', 'o2'], source: shippingCharge('99.00') }),
            },
            ['o1', 'o2', 'o3'],
          ),
        ),
      );
      const allocations = outcome.decision.shippingAllocation?.unitAllocations ?? [];
      expect(
        allocations.map(({ basisComponent, taxableSupplyUnitId }) => [taxableSupplyUnitId, basisComponent.amount]),
      ).toEqual([
        ['taxable-supply-unit:o1', exactDecimal('33')],
        ['taxable-supply-unit:o2', exactDecimal('66')],
      ]);
      expect(allocations.some(({ taxableSupplyUnitId }) => taxableSupplyUnitId === 'taxable-supply-unit:o3')).toBe(
        false,
      );
      const published = [...publishedByUnit(outcome)];
      expect(published.find(([unitId]) => unitId === 'taxable-supply-unit:o1')?.[1]).toBe('26.73');
      expect(published.find(([unitId]) => unitId === 'taxable-supply-unit:o2')?.[1]).toBe('53.45');
    });

    it('D3-1n the same basket priced NET gives the identical shares and units', () => {
      const outcome = success(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [pricingLine('o1', '100.00'), pricingLine('o2', '100.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
        ),
      );
      expect(publishedByUnit(outcome)).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '29.92'],
          ['taxable-supply-unit:o2', '17.10'],
        ]),
      );
    });

    it('D3-3s quantity row: the weight is the whole line value, never a per-piece price', () => {
      const outcome = success(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '29.97'), grossLine('o2', '112.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], {
              purchaseDemandOccurrences: [occurrenceInput('o1', '3'), occurrenceInput('o2')],
              shippingSourceRef,
            }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
        ),
      );
      expect(publishedByUnit(outcome)).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '8.83'],
          ['taxable-supply-unit:o2', '20.37'],
        ]),
      );
    });

    it('D3-4a a zero total weight with a non-zero charge is indeterminate', () => {
      expect(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '0.00'), grossLine('o2', '0.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
        ),
      ).toEqual(indeterminate);
    });

    it('D3-4b one zero weight among positive ones gets an exact 0 share, never indeterminate', () => {
      const outcome = success(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '0.00'), grossLine('o2', '10.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
        ),
      );
      expect(
        outcome.decision.shippingAllocation?.unitAllocations.map(({ basisComponent, taxableSupplyUnitId }) => [
          taxableSupplyUnitId,
          basisComponent.amount,
        ]),
      ).toEqual([
        ['taxable-supply-unit:o1', exactDecimal('0')],
        ['taxable-supply-unit:o2', exactDecimal('99.00')],
      ]);
    });

    it('D3-4c an unusable rule never guesses a weight', () => {
      expect(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '10.00'), grossLine('o2', '10.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
          ownState({ ruleSets: new Map([[STANDARD_CODE, { applicable: [], outcome: 'TAX_RULE_MISSING' }]]) }),
        ),
      ).toEqual(TaxRuleMissingSchema.make({}));
    });

    it('D3-5 inconsistent lines bases (GROSS next to NET) are indeterminate', () => {
      expect(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '121.00'), pricingLine('o2', '500.00')],
            },
          }),
        ),
      ).toEqual(indeterminate);
    });

    it('D3-6 a NET-priced Shipping charge cannot supply the gross control total', () => {
      expect(evaluate(withShipping({ source: shippingCharge('100.00', 'NET') }))).toEqual(
        TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NET_SHIPPING_AMOUNT_BASIS' }),
      );
    });

    it('D3-6b a NET-priced Shipping charge beats a missing rule on another unit (#938 F3)', () => {
      expect(
        evaluate(
          withShipping({ source: shippingCharge('100.00', 'NET') }),
          ownState({
            ruleSets: new Map([
              [STANDARD_CODE, selected('21', 'rule-standard')],
              [REDUCED_CODE, { applicable: [], outcome: 'TAX_RULE_MISSING' }],
            ]),
          }),
        ),
      ).toEqual(TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NET_SHIPPING_AMOUNT_BASIS' }));
    });

    it('D3-7 display (largest-remainder) shares never feed back into the exact tax', () => {
      const outcome = success(
        evaluate(
          evaluationRequest({
            pricing: {
              pricingResultRef: PRICING_RESULT_REF,
              publishedLines: [grossLine('o1', '1.00'), grossLine('o2', '6.00')],
            },
            purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            shipping: shippingInput({ source: shippingCharge('99.00') }),
          }),
        ),
      );
      // B's exact share is 594/7; it publishes 9.73, not the 9.74 a rounded display share would give.
      expect([...publishedByUnit(outcome)].find(([unitId]) => unitId === 'taxable-supply-unit:o2')?.[1]).toBe('9.73');
    });

    it('D3-8 a non-payer carries no Shipping allocation and ignores its amount basis, GROSS or NET', () => {
      const outcome = success(
        evaluate(
          evaluationRequest(
            {
              pricing: {
                pricingResultRef: PRICING_RESULT_REF,
                publishedLines: [grossLine('o1', '121.00'), grossLine('o2', '112.00')],
              },
              purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
              shipping: shippingInput({ source: shippingCharge('99.00', 'NET') }),
            },
            ['o1', 'o2'],
          ),
          ownState({ ruleSets: new Map(), sellerVatRegime: DECLARED_NON_PAYER }),
        ),
      );
      expect(outcome.decision.shippingAllocation).toBeUndefined();
      expect(publishedByUnit(outcome)).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '0.00'],
          ['taxable-supply-unit:o2', '0.00'],
        ]),
      );
    });

    it('D3-9 a caller that still sends the old allocationWeights key is ignored, never applied', () => {
      // The whole request is decoded from an untyped literal so the obsolete `allocationWeights` key, an excess
      // property Effect `Struct` decoding drops, can be included without widening any typed fixture helper.
      const outcome = success(
        evaluate(
          decodeEvaluationRequest({
            ...evaluationRequestInput({
              pricing: {
                pricingResultRef: PRICING_RESULT_REF,
                publishedLines: [grossLine('o1', '121.00'), grossLine('o2', '112.00')],
              },
              purchase: purchaseBindingInput(['o1', 'o2'], { shippingSourceRef }),
            }),
            shipping: {
              ...shippingInput({ source: shippingCharge('99.00') }),
              allocationWeights: { o1: 3, o2: 1 },
            },
          }),
        ),
      );
      expect(publishedByUnit(outcome)).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '29.92'],
          ['taxable-supply-unit:o2', '17.10'],
        ]),
      );
    });

    it('one affected unit takes the whole Shipping amount', () => {
      // o2: NET 500 @ 12 % = 60; GROSS 100 shipping @ 12 % = 100 * 12/112 = 10.7142... -> 60 + 10.7142... = 70.71.
      expect(publishedByUnit(evaluate(withShipping({ affectedOccurrenceIds: ['o2'] })))).toEqual(
        new Map([
          ['taxable-supply-unit:o1', '210.00'],
          ['taxable-supply-unit:o2', '70.71'],
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
        amount: { amount: exactDecimal('100.00'), amountBasis: 'GROSS', currency: 'CZK' },
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
