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
import { exactDecimal } from './tax-domain-fixtures.ts';

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

  it('#946 F8-F9 #947 F5 the record is either the final B2C Order Snapshot or the accepted Billing Document', () => {
    const billing = decodeAcceptedTaxTerms({
      ...input(),
      authoritativeRecord: { _tag: 'BILLING_DOCUMENT', billingDocumentRef: 'invoice-1' },
    });

    expect(Schema.is(AuthoritativeOriginalAcceptedRecordSchema.members[1])(billing.authoritativeRecord)).toBe(true);
    expect(() => decodeAcceptedTaxTerms({ ...input(), authoritativeRecord: { _tag: 'CURRENT_CATALOG' } })).toThrow();
  });

  it('#948 F2-F5 F8 read the unit baseline only from the record: quantity, basis split, rate and published Tax', () => {
    const terms = decodeAcceptedTaxTerms(input());

    expect(Option.getOrThrow(originalUnitBaseline(terms, unitIdOf('o-1')))).toEqual({
      originalBasis: exactDecimal('1009.9'),
      originalLineBasis: exactDecimal('999.9'),
      originalPublishedTax: { amount: '212.08', currency: 'CZK' },
      originalQuantity: exactDecimal('10'),
      rate: exactDecimal('0.21'),
      taxRoundingPolicy: terms.finalTax.result.taxRoundingPolicy,
    });
    expect(Option.getOrThrow(originalUnitBaseline(terms, unitIdOf('o-2'))).originalPublishedTax.amount).toBe('6.00');
    expect(Option.isNone(originalUnitBaseline(terms, unitIdOf('o-3')))).toBe(true);
  });
});
