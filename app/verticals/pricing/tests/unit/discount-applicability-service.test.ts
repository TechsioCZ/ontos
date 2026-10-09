import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountApplicabilityRejected,
  assessWholePurchaseDiscountThreshold,
  interpretEffectivePricingDiscountRevisions,
  resolveCurrentPricingDiscountRevisions,
} from '../../src/services/discount-applicability.service.ts';

const revision = (revisionId: string, effectiveFrom: string, effectiveTo: string | null) => ({
  effectivePeriod: { effectiveFrom, effectiveTo },
  revision: { revisionId },
});

describe('Pricing Discount applicability service', () => {
  it('interprets zero, one, and multiple effective Revisions without choosing a winner', () => {
    const current = revision('current', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const overlapping = revision('overlapping', '2026-09-15T00:00:00.000Z', null);

    expect(interpretEffectivePricingDiscountRevisions([], '2026-09-27T10:00:00.000Z')).toEqual({
      outcome: 'DISCOUNT_REVISION_ABSENT',
    });
    expect(interpretEffectivePricingDiscountRevisions([current], '2026-09-27T10:00:00.000Z')).toEqual({
      outcome: 'DISCOUNT_REVISION_CURRENT',
      revision: current,
    });
    expect(interpretEffectivePricingDiscountRevisions([current, overlapping], '2026-09-27T10:00:00.000Z')).toEqual({
      conflictingRevisions: [current, overlapping],
      outcome: 'DISCOUNT_REVISION_CONFLICT',
    });
  });

  it('uses exact half-open effectivity at both boundaries', () => {
    const candidate = revision('bounded', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

    expect(interpretEffectivePricingDiscountRevisions([candidate], '2026-09-01T00:00:00.000Z').outcome).toBe(
      'DISCOUNT_REVISION_CURRENT',
    );
    expect(interpretEffectivePricingDiscountRevisions([candidate], '2026-10-01T00:00:00.000Z').outcome).toBe(
      'DISCOUNT_REVISION_ABSENT',
    );
  });

  it.effect('maps duplicate Revision identity to an explicit invariant outcome before overlap selection', () =>
    Effect.gen(function* rejectsDuplicateRevisionIdentity() {
      const tenantId = '11111111-1111-4111-8111-111111111111';
      const identityKey = {
        audience: {
          counterpartyRef: {
            moduleId: 'party.registry' as const,
            resourceId: '22222222-2222-4222-8222-222222222222',
            resourceType: 'party.registry.counterparty' as const,
            tenantId,
          },
          kind: 'COUNTERPARTY' as const,
        },
        basis: { kind: 'WHOLE_PURCHASE' as const },
        commercialScope: {
          channelId: 'B2B' as const,
          marketId: 'cz-launch',
          sellingLegalEntityId: '33333333-3333-4333-8333-333333333333',
        },
        currencyCode: 'CZK',
        effectKind: 'FIXED_MONETARY_AMOUNT' as const,
        family: 'CONTRACTUAL_DISCOUNT' as const,
        monetaryBoundary: 'PRE_TAX' as const,
        scope: 'WHOLE_PURCHASE' as const,
      };
      const scheduled = (revisionId: string, revisionNumber: number) => ({
        definition: {
          discountId: '44444444-4444-4444-8444-444444444444',
          identityKey,
          revision: {
            configuredEffect: {
              kind: 'FIXED_MONETARY_AMOUNT' as const,
              level: { amount: '10', currencyCode: 'CZK' },
            },
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            revision: revisionNumber,
            revisionId,
          },
        },
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
      });

      const duplicateId = yield* resolveCurrentPricingDiscountRevisions(
        identityKey,
        [scheduled('55555555-5555-4555-8555-555555555555', 1), scheduled('55555555-5555-4555-8555-555555555555', 2)],
        '2026-09-27T10:00:00.000Z',
      );
      const duplicateNumber = yield* resolveCurrentPricingDiscountRevisions(
        identityKey,
        [scheduled('66666666-6666-4666-8666-666666666666', 3), scheduled('77777777-7777-4777-8777-777777777777', 3)],
        '2026-09-27T10:00:00.000Z',
      );

      expect(duplicateId).toMatchObject({
        outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
        reason: 'DUPLICATE_REVISION_ID',
      });
      expect(duplicateNumber).toMatchObject({
        outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
        reason: 'DUPLICATE_REVISION_NUMBER',
      });
    }),
  );

  it.effect('applies a fixed whole-purchase Discount exactly once only when B is strictly greater than D', () =>
    Effect.gen(function* appliesStrictThreshold() {
      const baseInput = {
        configuredAmount: { amount: '100', currencyCode: 'CZK' },
        decisionCurrencyCode: 'CZK',
      } as const;

      const below = yield* assessWholePurchaseDiscountThreshold({
        ...baseInput,
        intermediates: [
          {
            amount: { amount: '99.99', currencyCode: 'CZK' },
            occurrenceId: 'below',
            recipientKind: 'MERCHANDISE',
          },
        ],
      });
      const equal = yield* assessWholePurchaseDiscountThreshold({
        ...baseInput,
        intermediates: [
          {
            amount: { amount: '100', currencyCode: 'CZK' },
            occurrenceId: 'equal',
            recipientKind: 'MERCHANDISE',
          },
        ],
      });
      const above = yield* assessWholePurchaseDiscountThreshold({
        ...baseInput,
        intermediates: [
          { amount: { amount: '60', currencyCode: 'CZK' }, occurrenceId: 'above-1', recipientKind: 'MERCHANDISE' },
          {
            amount: { amount: '40.01', currencyCode: 'CZK' },
            occurrenceId: 'above-2',
            recipientKind: 'MERCHANDISE',
          },
        ],
      });

      expect(below).toMatchObject({
        basis: { currencyCode: 'CZK', eligibleAmount: '99.99' },
        outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE',
        reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
      });
      expect(equal).toMatchObject({
        basis: { currencyCode: 'CZK', eligibleAmount: '100' },
        outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE',
        reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
      });
      expect(above).toMatchObject({
        applicationCount: 'ONCE_PER_PRICING_DECISION',
        basis: { currencyCode: 'CZK', eligibleAmount: '100.01' },
        contribution: { amount: '-100', currencyCode: 'CZK' },
        outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
      });
    }),
  );

  it.effect('sums only positive merchandise intermediates and never allocates the contribution', () =>
    Effect.gen(function* excludesIneligibleRecipients() {
      const result = yield* assessWholePurchaseDiscountThreshold({
        configuredAmount: { amount: '0.01', currencyCode: 'CZK' },
        decisionCurrencyCode: 'CZK',
        intermediates: [
          { amount: { amount: '0', currencyCode: 'CZK' }, occurrenceId: 'zero', recipientKind: 'MERCHANDISE' },
          {
            amount: { amount: '-5', currencyCode: 'CZK' },
            occurrenceId: 'negative',
            recipientKind: 'MERCHANDISE',
          },
          { amount: { amount: '999', currencyCode: 'CZK' }, occurrenceId: 'shipping', recipientKind: 'SHIPPING' },
          { amount: { amount: '999', currencyCode: 'CZK' }, occurrenceId: 'delivery', recipientKind: 'DELIVERY' },
          {
            amount: { amount: '0.02', currencyCode: 'CZK' },
            occurrenceId: 'positive',
            recipientKind: 'MERCHANDISE',
          },
        ],
      });

      expect(result).toMatchObject({
        applicationCount: 'ONCE_PER_PRICING_DECISION',
        basis: {
          currencyCode: 'CZK',
          eligibleAmount: '0.02',
          recipients: [
            {
              intermediateValue: { amount: '0.02', currencyCode: 'CZK' },
              occurrenceId: 'positive',
              recipientKind: 'MERCHANDISE',
            },
          ],
        },
        contribution: { amount: '-0.01', currencyCode: 'CZK' },
        outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
      });
      expect(result).not.toHaveProperty('allocations');
    }),
  );

  it.effect('compares and sums exact decimals beyond binary and safe-integer precision', () =>
    Effect.gen(function* usesExactDecimals() {
      const result = yield* assessWholePurchaseDiscountThreshold({
        configuredAmount: { amount: '9007199254740993.02', currencyCode: 'CZK' },
        decisionCurrencyCode: 'CZK',
        intermediates: [
          {
            amount: { amount: '9007199254740993', currencyCode: 'CZK' },
            occurrenceId: 'large',
            recipientKind: 'MERCHANDISE',
          },
          { amount: { amount: '0.01', currencyCode: 'CZK' }, occurrenceId: 'cent', recipientKind: 'MERCHANDISE' },
          {
            amount: { amount: '0.02', currencyCode: 'CZK' },
            occurrenceId: 'two-cents',
            recipientKind: 'MERCHANDISE',
          },
        ],
      });

      expect(result).toMatchObject({
        basis: { currencyCode: 'CZK', eligibleAmount: '9007199254740993.03' },
        outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
      });
    }),
  );

  it.effect('fails closed on currency mismatch instead of converting or relabeling money', () =>
    Effect.gen(function* rejectsCurrencyMismatch() {
      const rejection = yield* Effect.flip(
        assessWholePurchaseDiscountThreshold({
          configuredAmount: { amount: '1', currencyCode: 'EUR' },
          decisionCurrencyCode: 'CZK',
          intermediates: [
            {
              amount: { amount: '10', currencyCode: 'CZK' },
              occurrenceId: 'line',
              recipientKind: 'MERCHANDISE',
            },
          ],
        }),
      );

      expect(rejection).toBeInstanceOf(PricingDiscountApplicabilityRejected);
      expect(rejection).toMatchObject({ code: 'CURRENCY_MISMATCH' });
    }),
  );
});
