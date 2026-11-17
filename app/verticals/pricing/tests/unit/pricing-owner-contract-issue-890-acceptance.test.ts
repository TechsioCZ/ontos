import { PricingCommercialTotalReadySchema } from '@app/pricing-contracts/domain/commercial-total';
import { PricingWholePurchaseContractualEligibleBasisSchema } from '@app/pricing-contracts/domain/discount';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeIssue788CommercialTotal } from './support/issue-788-confirmation.fixture.ts';

const decodeCommercialTotal = Schema.decodeUnknownSync(PricingCommercialTotalReadySchema, {
  onExcessProperty: 'error',
});
const decodeWholePurchaseBasis = Schema.decodeUnknownSync(PricingWholePurchaseContractualEligibleBasisSchema, {
  onExcessProperty: 'error',
});

describe('issue #890 Pricing owner contract acceptance', () => {
  it.effect('rejects an extra split output line and preserves one result for each original occurrence', () =>
    Effect.gen(function* rejectsSplitOutputLine() {
      const ready = yield* makeIssue788CommercialTotal();
      expect(decodeCommercialTotal(ready)).toEqual(ready);

      const [publishedLine] = ready.publishedLines;
      if (publishedLine === undefined) {
        throw new Error('Issue #890 requires one published Pricing line');
      }

      expect(() =>
        decodeCommercialTotal({
          ...ready,
          publishedLines: [
            publishedLine,
            {
              ...publishedLine,
              occurrenceId: `${publishedLine.occurrenceId}-split`,
            },
          ],
        }),
      ).toThrow();
    }),
  );

  it('excludes negative, zero, and Shipping lines from the whole-purchase merchandise basis', () => {
    const validBasis = {
      currencyCode: 'CZK',
      eligibleAmount: '10',
      recipients: [
        {
          intermediateValue: { amount: '10', currencyCode: 'CZK' },
          occurrenceId: 'line-positive',
          recipientKind: 'MERCHANDISE',
        },
      ],
    } as const;
    expect(decodeWholePurchaseBasis(validBasis)).toEqual(validBasis);

    for (const excludedRecipient of [
      {
        intermediateValue: { amount: '-1', currencyCode: 'CZK' },
        occurrenceId: 'line-negative',
        recipientKind: 'MERCHANDISE',
      },
      {
        intermediateValue: { amount: '0', currencyCode: 'CZK' },
        occurrenceId: 'line-zero',
        recipientKind: 'MERCHANDISE',
      },
      {
        intermediateValue: { amount: '10', currencyCode: 'CZK' },
        occurrenceId: 'line-shipping',
        recipientKind: 'SHIPPING',
      },
    ] as const) {
      expect(() =>
        decodeWholePurchaseBasis({
          currencyCode: 'CZK',
          eligibleAmount: excludedRecipient.intermediateValue.amount,
          recipients: [excludedRecipient],
        }),
      ).toThrow();
    }
  });
});
