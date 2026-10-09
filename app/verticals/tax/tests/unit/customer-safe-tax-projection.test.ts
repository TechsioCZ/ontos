import { Array as Arr, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CUSTOMER_SAFE_TAX_PROJECTION_VERSION,
  CustomerSafeSellerNotVatPayerSchema,
  CustomerSafeTaxNotDeterminedSchema,
  CustomerSafeTaxProjectionSchema,
  projectCustomerSafeTax,
} from '../../src/domain/customer-safe-tax-projection.ts';
import type { CustomerSafeTaxProjection } from '../../src/domain/customer-safe-tax-projection.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcomeSuccess } from '../../src/domain/tax-outcome.ts';
import {
  composeResult,
  decisionUnitInput,
  decodeTaxDecision,
  nonPayerDecisionUnitInput,
  taxDecisionInput,
  nonPayerTaxDecisionInput,
} from './tax-domain-fixtures.ts';

/** 50.00 CZK at 21 % and 87.50 CZK at 12 % both publish 10.50 CZK; zero values publish 0.00 CZK. */
const successfulOutcome = (taxed: boolean): TaxOutcomeSuccess => {
  const decision = decodeTaxDecision(
    taxDecisionInput(['o-1', 'o-2'], {
      units: [
        decisionUnitInput('o-1', taxed ? '50.00' : '0.00'),
        decisionUnitInput('o-2', taxed ? '87.50' : '0.00', '12'),
      ],
    }),
  );
  return { _tag: 'TAX_DETERMINED', decision, result: composeResult(decision) };
};

/** Fields of a TAX_AMOUNT projection; none when no Tax amount is projected. */
const projectedAmount = (projection: CustomerSafeTaxProjection) =>
  Match.value(projection).pipe(
    Match.tag('TAX_AMOUNT', ({ components = [], contractVersion, purchaseTaxTotal }) =>
      Option.some({ components, contractVersion, purchaseTaxTotal }),
    ),
    Match.tag('TAX_NOT_DETERMINED', () => Option.none()),
    Match.tag('SELLER_NOT_VAT_PAYER', () => Option.none()),
    Match.exhaustive,
  );

/** A successful NON_PAYER outcome: units with a published line but no rate. */
const nonPayerOutcome = (): TaxOutcomeSuccess => {
  const decision = decodeTaxDecision(
    nonPayerTaxDecisionInput(['o-1', 'o-2'], {
      units: [nonPayerDecisionUnitInput('o-1', '50.00'), nonPayerDecisionUnitInput('o-2', '87.50')],
    }),
  );
  return { _tag: 'TAX_DETERMINED', decision, result: composeResult(decision) };
};

describe('Customer-Safe Tax Projection', () => {
  it('#940 F18-F21 F25-F30 projects only the allowlisted amount and currency', () => {
    const projection = projectCustomerSafeTax(successfulOutcome(true), 'NOT_NEEDED');

    expect(Object.keys(projection)).not.toContain('components');
    expect(Option.getOrThrow(projectedAmount(projection))).toEqual({
      components: [],
      contractVersion: CUSTOMER_SAFE_TAX_PROJECTION_VERSION,
      purchaseTaxTotal: { amount: '21.00', currency: 'CZK' },
    });
    const serialized = Schema.encodeSync(Schema.fromJsonString(CustomerSafeTaxProjectionSchema))(projection);
    expect(serialized).not.toContain('taxRuleId');
    expect(serialized).not.toContain('pricing');
    expect(serialized).not.toContain('selling-legal-entity');
    expect(serialized).not.toContain('tenant');
  });

  it('#940 F22-F24 exposes per-unit decomposition with safe treatment only when the view needs it', () => {
    const projection = projectCustomerSafeTax(successfulOutcome(true), 'PER_TAXABLE_SUPPLY_UNIT');

    expect(Option.getOrThrow(projectedAmount(projection))).toEqual({
      components: [
        {
          purchaseDemandOccurrenceIds: ['o-1'],
          taxAmount: { amount: '10.50', currency: 'CZK' },
          treatment: { category: 'TAXABLE', ratePercent: '21' },
        },
        {
          purchaseDemandOccurrenceIds: ['o-2'],
          taxAmount: { amount: '10.50', currency: 'CZK' },
          treatment: { category: 'TAXABLE', ratePercent: '12' },
        },
      ],
      contractVersion: CUSTOMER_SAFE_TAX_PROJECTION_VERSION,
      purchaseTaxTotal: { amount: '21.00', currency: 'CZK' },
    });
  });

  it('#940 F38 #939 F34 a non-success outcome is never projected as a Tax amount', () => {
    const projection = projectCustomerSafeTax(
      { _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'REVERSE_CHARGE' },
      'PER_TAXABLE_SUPPLY_UNIT',
    );

    expect(Schema.is(CustomerSafeTaxNotDeterminedSchema)(projection)).toBe(true);
    expect(Option.isNone(projectedAmount(projection))).toBe(true);
    expect(Object.keys(projection).toSorted()).toEqual(['_tag', 'contractVersion']);
  });

  it('#940 F39 #939 F34 a successful zero is shown only from the successful Result, with its taxable meaning', () => {
    const projection = projectCustomerSafeTax(successfulOutcome(false), 'PER_TAXABLE_SUPPLY_UNIT');

    const projected = Option.getOrThrow(projectedAmount(projection));
    expect(projected.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
    expect(projected.components.map(({ treatment }) => treatment.category)).toEqual(['TAXABLE', 'TAXABLE']);
    expect(Schema.is(CustomerSafeTaxProjectionSchema)(projection)).toBe(true);
  });

  it('#937 F7 #936 F28-F29 #940 F32 joins Result amounts to Decision units by identity, not array position', () => {
    const decision = decodeTaxDecision(
      taxDecisionInput(['o-1', 'o-2'], {
        units: [decisionUnitInput('o-1', '50.00'), decisionUnitInput('o-2', '100.00', '12')],
      }),
    );
    const result = composeResult(decision);
    const inOrder: TaxOutcomeSuccess = { _tag: 'TAX_DETERMINED', decision, result };
    const reversed: TaxOutcomeSuccess = { ...inOrder, result: { ...result, units: Arr.reverse(result.units) } };

    expect(Schema.is(TaxOutcomeSuccessSchema)(reversed)).toBe(true);
    expect(projectCustomerSafeTax(reversed, 'PER_TAXABLE_SUPPLY_UNIT')).toEqual(
      projectCustomerSafeTax(inOrder, 'PER_TAXABLE_SUPPLY_UNIT'),
    );
    expect(
      Option.getOrThrow(projectedAmount(projectCustomerSafeTax(reversed, 'PER_TAXABLE_SUPPLY_UNIT'))).components.map(
        ({ purchaseDemandOccurrenceIds, taxAmount }) => [purchaseDemandOccurrenceIds, taxAmount.amount],
      ),
    ).toEqual([
      [['o-1'], '10.50'],
      [['o-2'], '12.00'],
    ]);
  });

  it('Unit 10 A5 a NON_PAYER seller always projects to SELLER_NOT_VAT_PAYER, whatever the decomposition need', () => {
    for (const decompositionNeed of ['NOT_NEEDED', 'PER_TAXABLE_SUPPLY_UNIT'] as const) {
      const projection = projectCustomerSafeTax(nonPayerOutcome(), decompositionNeed);

      expect(Schema.is(CustomerSafeSellerNotVatPayerSchema)(projection)).toBe(true);
      const serialized = Schema.encodeSync(Schema.fromJsonString(CustomerSafeTaxProjectionSchema))(projection);
      expect(serialized).not.toContain('TAX_AMOUNT');
      expect(serialized).not.toContain('ratePercent');
      expect(serialized).not.toContain('"0"');
    }
  });

  it('#940 F44 the same outcome and contract version produce the same projection', () => {
    const outcome = successfulOutcome(true);

    expect(projectCustomerSafeTax(outcome, 'PER_TAXABLE_SUPPLY_UNIT')).toEqual(
      projectCustomerSafeTax(outcome, 'PER_TAXABLE_SUPPLY_UNIT'),
    );
  });
});
