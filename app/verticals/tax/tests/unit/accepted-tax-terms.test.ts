import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AuthoritativeOriginalAcceptedRecordSchema,
  originalUnitBaseline,
} from '../../src/domain/accepted-tax-terms.ts';
import {
  acceptedTaxTermsInput,
  decodeAcceptedTaxTerms,
  encodeAcceptedTaxTerms,
  unitIdOf,
} from './tax-correction-fixtures.ts';
import {
  composeResult,
  decodeTaxDecision,
  encodeTaxDecision,
  exactDecimal,
  nonPayerTaxDecisionInput,
} from './tax-domain-fixtures.ts';
import { TaxResultSchema } from '../../src/domain/tax-result.ts';
import { SellerNotVatPayerTreatmentSchema } from '../../src/domain/tax-treatment.ts';

const encodeTaxResult = Schema.encodeSync(TaxResultSchema);

const input = () =>
  acceptedTaxTermsInput([
    { lineValue: '999.90', occurrenceId: 'o-1', quantity: '10', shipping: '10.00' },
    { lineValue: '50.00', occurrenceId: 'o-2', quantity: '1', ratePercent: '12' },
  ]);

describe('Accepted Tax Terms', () => {
  it('#945 F2 #946 F2-F3 retain exactly the final Decision/Result and its original Order Commitment Time', () => {
    const terms = decodeAcceptedTaxTerms(input());

    expect(encodeAcceptedTaxTerms(terms)).toEqual(input());
    expect(() => decodeAcceptedTaxTerms({ ...input(), orderCommitmentTime: '2026-10-08T10:00:02.000Z' })).toThrow(
      /original Order Commitment Time/u,
    );
  });

  it('#945 F3 #907 F172 never accept a Result that does not follow from its Decision, e.g. an older preview', () => {
    const terms = input();
    const [first, ...rest] = terms.finalTax.result.units;
    expect(first).toBeDefined();
    expect(() =>
      decodeAcceptedTaxTerms({
        ...terms,
        finalTax: {
          ...terms.finalTax,
          result: {
            ...terms.finalTax.result,
            purchaseTaxTotal: { amount: '0.01', currency: 'CZK' },
            units: [{ ...first, publishedTaxAmount: { amount: '0.01', currency: 'CZK' } }, ...rest],
          },
        },
      }),
    ).toThrow();
  });

  it('#945-#948 H10: the record is the accepted Billing Document, the Order Snapshot only before any document', () => {
    const billing = decodeAcceptedTaxTerms({
      ...input(),
      authoritativeRecord: { _tag: 'BILLING_DOCUMENT', billingDocumentRef: 'invoice-1' },
    });
    const orderSnapshot = decodeAcceptedTaxTerms({ ...input(), authoritativeRecord: { _tag: 'ORDER_SNAPSHOT' } });

    // Both AcceptedTaxTerms tags still decode as Terms; H10 narrows which one a correction may use, not the type.
    expect(Schema.is(AuthoritativeOriginalAcceptedRecordSchema.members[1])(billing.authoritativeRecord)).toBe(true);
    expect(Schema.is(AuthoritativeOriginalAcceptedRecordSchema.members[0])(orderSnapshot.authoritativeRecord)).toBe(
      true,
    );
    expect(() => decodeAcceptedTaxTerms({ ...input(), authoritativeRecord: { _tag: 'CURRENT_CATALOG' } })).toThrow();
  });

  it('#948 F2-F5 F8 read the unit baseline only from the record: quantity, basis split, rate and published Tax', () => {
    const terms = decodeAcceptedTaxTerms(input());

    // PO decision D3 on #907: the Shipping share is always GROSS, so its VAT is carved out under § 37 písm. b).
    expect(Option.getOrThrow(originalUnitBaseline(terms, unitIdOf('o-1')))).toEqual({
      lineAmountBasis: 'NET',
      originalLineBasis: exactDecimal('999.9'),
      originalPublishedTax: { amount: '211.71', currency: 'CZK' },
      originalQuantity: exactDecimal('10'),
      originalShippingBasis: exactDecimal('10'),
      taxRoundingPolicy: terms.finalTax.result.taxRoundingPolicy,
      treatment: { _tag: 'TAXABLE', ratePercent: '21' },
    });
    expect(Option.getOrThrow(originalUnitBaseline(terms, unitIdOf('o-2'))).originalPublishedTax.amount).toBe('6.00');
    expect(Option.isNone(originalUnitBaseline(terms, unitIdOf('o-3')))).toBe(true);
  });

  it('B-3 a seller-is-non-payer unit has a treatment-aware baseline with no rate field (Unit 12 B3)', () => {
    const decision = decodeTaxDecision(nonPayerTaxDecisionInput(['o-1']));
    const encodedDecision = encodeTaxDecision(decision);
    const terms = decodeAcceptedTaxTerms({
      authoritativeRecord: { _tag: 'ORDER_SNAPSHOT' },
      finalTax: {
        _tag: 'TAX_DETERMINED',
        decision: encodedDecision,
        result: encodeTaxResult(composeResult(decision)),
      },
      orderCommitmentTime: encodedDecision.taxRelevantTime,
      orderLineage: { bundleRef: 'bundle-1', orderRef: 'order-1' },
    });

    const baseline = Option.getOrThrow(originalUnitBaseline(terms, unitIdOf('o-1')));
    expect(Schema.is(SellerNotVatPayerTreatmentSchema)(baseline.treatment)).toBe(true);
    expect('rate' in baseline).toBe(false);
    expect(baseline.lineAmountBasis).toBe('NET');
  });
});
