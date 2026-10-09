import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  QuantityTierDefinitionSchema,
  QuantityTierIdentityKeySchema,
  QuantityTierResultingUnitPriceSchema,
  QuantityTierScheduleAcknowledgementSchema,
  QuantityTierScheduleReadResultSchema,
  QuantityTierScheduleSnapshotSchema,
} from '../../src/domain/quantity-tier.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const otherPriceRef = {
  ...priceRef,
  resourceId: '33333333-3333-4333-8333-333333333333',
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const quantityBasis = {
  catalogQuantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 5,
  },
  priceUnitBasis: { quantity: '1', unitRef },
};
const identityKey = {
  priceRef,
  quantityBasis,
  thresholdQuantity: '10',
};

const scheduledRevision = ({
  amount,
  effectiveFrom,
  effectiveTo,
  kind,
  revision,
  revisionId,
}: {
  readonly amount: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: null | string;
  readonly kind: 'INITIAL' | 'SCHEDULED' | 'VALUE_ONLY_CURRENT';
  readonly revision: number;
  readonly revisionId: string;
}) => ({
  definition: {
    identityKey,
    revision: {
      effectiveFrom,
      monetaryBoundary: 'PRE_TAX' as const,
      resultingUnitPrice: { amount, currencyCode: 'CZK' },
      revision,
      revisionId,
    },
  },
  effectivePeriod: { effectiveFrom, effectiveTo },
  lineage: {
    correctedRevisionId: null,
    kind,
    previousRevisionId: revision === 1 ? null : '66666666-6666-4666-8666-666666666666',
  },
});

const current = scheduledRevision({
  amount: '90',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-09-28T00:00:00.000Z',
  kind: 'INITIAL',
  revision: 1,
  revisionId: '66666666-6666-4666-8666-666666666666',
});
const future = scheduledRevision({
  amount: '80',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  kind: 'SCHEDULED',
  revision: 2,
  revisionId: '77777777-7777-4777-8777-777777777777',
});

const decodeIdentity = Schema.decodeUnknownSync(QuantityTierIdentityKeySchema, {
  onExcessProperty: 'error',
});
const decodeDefinition = Schema.decodeUnknownSync(QuantityTierDefinitionSchema, {
  onExcessProperty: 'error',
});

describe('Pricing Quantity Tier definition acceptance', () => {
  it('owns every Tier by one exact Price and rejects Product-only or Storefront-shaped targets', () => {
    expect(decodeIdentity(identityKey)).toEqual(identityKey);
    expect(() =>
      decodeIdentity({
        ...identityKey,
        priceRef: {
          ...priceRef,
          resourceType: 'commerce.catalog.product',
        },
      }),
    ).toThrow();
    expect(() => decodeIdentity({ ...identityKey, storefrontId: 'storefront-prague' })).toThrow();
  });

  it('treats Price, threshold, and quantity basis changes as distinct identities even at the same amount', () => {
    const baseline = decodeIdentity(identityKey);
    const changedPrice = decodeIdentity({ ...identityKey, priceRef: otherPriceRef });
    const changedThreshold = decodeIdentity({ ...identityKey, thresholdQuantity: '12' });
    const changedBasis = decodeIdentity({
      ...identityKey,
      quantityBasis: {
        ...quantityBasis,
        catalogQuantityBasis: {
          ...quantityBasis.catalogQuantityBasis,
          targetDivisibilityRevision: 4,
        },
      },
    });

    for (const distinctIdentity of [changedPrice, changedThreshold, changedBasis]) {
      expect(distinctIdentity).not.toEqual(baseline);
      expect(
        decodeDefinition({
          identityKey: distinctIdentity,
          revision: {
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            monetaryBoundary: 'PRE_TAX',
            resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
            revision: 1,
            revisionId: '88888888-8888-4888-8888-888888888888',
          },
        }).revision.resultingUnitPrice.amount,
      ).toBe('90');
    }
  });

  it('requires a positive threshold but accepts an explicit zero Unit Price', () => {
    expect(() => decodeIdentity({ ...identityKey, thresholdQuantity: '0' })).toThrow();
    expect(() => decodeIdentity({ ...identityKey, thresholdQuantity: '-1' })).toThrow();
    expect(() => decodeIdentity({ ...identityKey, thresholdOperator: 'GREATER_THAN' })).toThrow();

    expect(() =>
      decodeIdentity({
        ...identityKey,
        quantityBasis: {
          ...quantityBasis,
          priceUnitBasis: {
            ...quantityBasis.priceUnitBasis,
            unitRef: { ...unitRef, resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          },
        },
      }),
    ).toThrow();

    const decodeUnitPrice = Schema.decodeUnknownSync(QuantityTierResultingUnitPriceSchema);
    expect(decodeUnitPrice({ amount: '0', currencyCode: 'CZK' })).toEqual({
      amount: '0',
      currencyCode: 'CZK',
    });
    expect(() => decodeUnitPrice({ amount: '-0.01', currencyCode: 'CZK' })).toThrow();
  });

  it('keeps currency contracts generalized without placing activation or FX fields on a Tier', () => {
    const decodeUnitPrice = Schema.decodeUnknownSync(QuantityTierResultingUnitPriceSchema, {
      onExcessProperty: 'error',
    });
    expect(decodeUnitPrice({ amount: '85', currencyCode: 'EUR' }).currencyCode).toBe('EUR');
    expect(() => decodeUnitPrice({ amount: '85', currencyCode: 'EUR', exchangeRate: '25' })).toThrow();
    expect(() => decodeIdentity({ ...identityKey, supportedCurrencies: ['CZK', 'EUR'] })).toThrow();
  });

  it('preserves a finite Current end, its gap, and every future revision in a value-only schedule state', () => {
    const revisedCurrent = scheduledRevision({
      amount: '85',
      effectiveFrom: current.effectivePeriod.effectiveFrom,
      effectiveTo: current.effectivePeriod.effectiveTo,
      kind: 'VALUE_ONLY_CURRENT',
      revision: 3,
      revisionId: '99999999-9999-4999-8999-999999999999',
    });
    const decoded = Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
      current: revisedCurrent,
      future: [future],
      identityKey,
      observedAt: '2026-09-27T00:00:00.000Z',
      revisions: [revisedCurrent, future],
      scheduleRevision: 3,
    });

    expect(decoded.current?.effectivePeriod).toEqual(current.effectivePeriod);
    expect(decoded.current?.definition.identityKey).toEqual(identityKey);
    expect(decoded.future).toEqual([future]);
    expect(decoded.current?.effectivePeriod.effectiveTo).not.toBe(future.effectivePeriod.effectiveFrom);
  });

  it('preserves an open Current end when no future Revision exists', () => {
    const openCurrent = scheduledRevision({
      amount: '85',
      effectiveFrom: current.effectivePeriod.effectiveFrom,
      effectiveTo: null,
      kind: 'VALUE_ONLY_CURRENT',
      revision: 2,
      revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const decoded = Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
      current: openCurrent,
      future: [],
      identityKey,
      observedAt: '2026-09-27T00:00:00.000Z',
      revisions: [openCurrent],
      scheduleRevision: 2,
    });

    expect(decoded.current?.effectivePeriod).toEqual({
      effectiveFrom: current.effectivePeriod.effectiveFrom,
      effectiveTo: null,
    });
    expect(decoded.future).toEqual([]);
  });

  it('binds blocking acknowledgement to the presented head, exact target interval, and unchanged future state', () => {
    const acknowledgement = {
      actingPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fingerprint: 'b'.repeat(64),
      identityKey,
      intendedEffectivePeriod: current.effectivePeriod,
      intendedResultingUnitPrice: { amount: '85', currencyCode: 'CZK' },
      intent: 'VALUE_ONLY_CURRENT' as const,
      presentedFuture: [future],
      scheduleRevision: 2,
      targetEffectivePeriod: current.effectivePeriod,
      targetRevisionId: current.definition.revision.revisionId,
    };
    const decode = Schema.decodeUnknownSync(QuantityTierScheduleAcknowledgementSchema, {
      onExcessProperty: 'error',
    });

    const decoded = decode(acknowledgement);
    expect(decoded.scheduleRevision).toBe(2);
    expect(decoded.presentedFuture).toEqual([future]);
    expect(() =>
      decode({
        ...acknowledgement,
        targetEffectivePeriod: {
          ...current.effectivePeriod,
          effectiveTo: '2026-09-29T00:00:00.000Z',
        },
      }),
    ).toThrow();
  });

  it('represents gap, absence, and conflict explicitly instead of inventing a fallback Tier', () => {
    const decode = Schema.decodeUnknownSync(QuantityTierScheduleReadResultSchema, {
      onExcessProperty: 'error',
    });
    expect(
      decode({
        outcome: 'QUANTITY_TIER_SCHEDULE_GAP',
        schedule: {
          future: [future],
          identityKey,
          observedAt: '2026-09-29T00:00:00.000Z',
          revisions: [current, future],
          scheduleRevision: 2,
        },
      }).outcome,
    ).toBe('QUANTITY_TIER_SCHEDULE_GAP');
    expect(decode({ identityKey, outcome: 'QUANTITY_TIER_SCHEDULE_ABSENT' }).outcome).toBe(
      'QUANTITY_TIER_SCHEDULE_ABSENT',
    );
    expect(
      decode({
        candidateRevisionIds: [current.definition.revision.revisionId, future.definition.revision.revisionId],
        identityKey,
        outcome: 'QUANTITY_TIER_SCHEDULE_CONFLICT',
      }).outcome,
    ).toBe('QUANTITY_TIER_SCHEDULE_CONFLICT');
  });
});
