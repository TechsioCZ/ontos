import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  QuantityTierDefinitionSchema,
  QuantityTierIdentityKeySchema,
  QuantityTierRevisionLineageSchema,
  QuantityTierScheduleAcknowledgementSchema,
  QuantityTierScheduleSnapshotSchema,
  quantityTierIdentityKeysEqual,
} from '../../src/domain/quantity-tier.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const identityKey = {
  priceRef,
  quantityBasis: {
    catalogQuantityBasis: {
      targetDivisibilityRevision: 7,
      targetRef: {
        moduleId: 'commerce.catalog' as const,
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.catalog.variant' as const,
        tenantId,
      },
      unitRef,
      unitRuleRevision: 9,
    },
    priceUnitBasis: { quantity: '1', unitRef },
  },
  thresholdQuantity: '10',
};

const scheduledRevision = (
  revision: number,
  revisionId: string,
  amount: string,
  effectiveFrom: string,
  effectiveTo: null | string,
) => ({
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
    kind: revision === 1 ? ('INITIAL' as const) : ('SCHEDULED' as const),
    previousRevisionId: revision === 1 ? null : '77777777-7777-4777-8777-777777777777',
  },
});

describe('Pricing Quantity Tier contract', () => {
  it('binds stable identity to one exact Price, positive threshold, and owner-issued compatible basis', () => {
    const decode = Schema.decodeUnknownSync(QuantityTierIdentityKeySchema);
    expect(decode(identityKey)).toBeDefined();
    expect(
      quantityTierIdentityKeysEqual(decode(identityKey), decode({ ...identityKey, thresholdQuantity: '10.0' })),
    ).toBe(true);
    expect(() => decode({ ...identityKey, thresholdQuantity: '0' })).toThrow();
    expect(() =>
      decode({
        ...identityKey,
        quantityBasis: {
          ...identityKey.quantityBasis,
          catalogQuantityBasis: {
            ...identityKey.quantityBasis.catalogQuantityBasis,
            unitRef: { ...unitRef, resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          },
        },
      }),
    ).toThrow();
  });

  it('accepts zero as a pre-Tax resulting Unit Price while retaining generalized exact currency', () => {
    const decode = Schema.decodeUnknownSync(QuantityTierDefinitionSchema);
    expect(
      decode({
        identityKey,
        revision: {
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          monetaryBoundary: 'PRE_TAX',
          resultingUnitPrice: { amount: '0', currencyCode: 'CZK' },
          revision: 1,
          revisionId: '77777777-7777-4777-8777-777777777777',
        },
      }).revision.resultingUnitPrice,
    ).toEqual({ amount: '0', currencyCode: 'CZK' });
    expect(
      decode({
        identityKey,
        revision: {
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          monetaryBoundary: 'PRE_TAX',
          resultingUnitPrice: { amount: '85', currencyCode: 'EUR' },
          revision: 2,
          revisionId: '88888888-8888-4888-8888-888888888888',
        },
      }).revision.resultingUnitPrice.currencyCode,
    ).toBe('EUR');
    expect(() =>
      decode({
        identityKey,
        revision: {
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          monetaryBoundary: 'PRE_TAX',
          resultingUnitPrice: { amount: '-1', currencyCode: 'CZK' },
          revision: 1,
          revisionId: '77777777-7777-4777-8777-777777777777',
        },
      }),
    ).toThrow();
  });

  it('distinguishes correction lineage from scheduled and retirement successor lineage', () => {
    const decode = Schema.decodeUnknownSync(QuantityTierRevisionLineageSchema);
    const targetRevisionId = '77777777-7777-4777-8777-777777777777';

    expect(
      decode({
        correctedRevisionId: targetRevisionId,
        kind: 'CORRECTION',
        previousRevisionId: targetRevisionId,
      }),
    ).toBeDefined();
    expect(() =>
      decode({
        correctedRevisionId: targetRevisionId,
        kind: 'CORRECTION',
        previousRevisionId: '88888888-8888-4888-8888-888888888888',
      }),
    ).toThrow();
    expect(() =>
      decode({
        correctedRevisionId: null,
        kind: 'CORRECTION',
        previousRevisionId: null,
      }),
    ).toThrow();
    for (const kind of ['SCHEDULED', 'RETIREMENT'] as const) {
      expect(
        decode({
          correctedRevisionId: null,
          kind,
          previousRevisionId: targetRevisionId,
        }),
      ).toBeDefined();
      expect(() =>
        decode({
          correctedRevisionId: targetRevisionId,
          kind,
          previousRevisionId: targetRevisionId,
        }),
      ).toThrow();
    }
  });

  it('uses exact half-open Current selection, retains gaps, and requires the complete future schedule', () => {
    const first = scheduledRevision(
      1,
      '77777777-7777-4777-8777-777777777777',
      '90',
      '2026-09-01T00:00:00.000Z',
      '2026-09-28T00:00:00.000Z',
    );
    const future = scheduledRevision(2, '88888888-8888-4888-8888-888888888888', '85', '2026-10-01T00:00:00.000Z', null);
    const decode = Schema.decodeUnknownSync(QuantityTierScheduleSnapshotSchema);

    expect(
      decode({
        future: [future],
        identityKey,
        observedAt: '2026-09-29T00:00:00.000Z',
        revisions: [first, future],
        scheduleRevision: 2,
      }),
    ).toBeDefined();
    expect(
      decode({
        current: future,
        future: [],
        identityKey,
        observedAt: '2026-10-01T00:00:00.000Z',
        revisions: [first, future],
        scheduleRevision: 2,
      }),
    ).toBeDefined();
    expect(() =>
      decode({
        current: first,
        future: [],
        identityKey,
        observedAt: '2026-09-27T00:00:00.000Z',
        revisions: [first, future],
        scheduleRevision: 2,
      }),
    ).toThrow();
  });

  it('binds value-only acknowledgement to the exact Tier target, interval, and presented future state', () => {
    const first = scheduledRevision(
      1,
      '77777777-7777-4777-8777-777777777777',
      '90',
      '2026-09-01T00:00:00.000Z',
      '2026-09-28T00:00:00.000Z',
    );
    const future = scheduledRevision(2, '88888888-8888-4888-8888-888888888888', '80', '2026-10-01T00:00:00.000Z', null);
    const acknowledgement = {
      actingPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fingerprint: 'a'.repeat(64),
      identityKey,
      intendedEffectivePeriod: {
        effectiveFrom: '2026-09-26T00:00:00.000Z',
        effectiveTo: first.effectivePeriod.effectiveTo,
      },
      intendedResultingUnitPrice: { amount: '85', currencyCode: 'CZK' },
      intent: 'VALUE_ONLY_CURRENT',
      presentedFuture: [future],
      scheduleRevision: 2,
      targetEffectivePeriod: first.effectivePeriod,
      targetRevisionId: first.definition.revision.revisionId,
    };
    const decode = Schema.decodeUnknownSync(QuantityTierScheduleAcknowledgementSchema);

    expect(decode(acknowledgement)).toBeDefined();
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: { ...first.effectivePeriod, effectiveTo: '2026-09-30T00:00:00.000Z' },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: {
          effectiveFrom: '2026-08-31T23:59:59.999Z',
          effectiveTo: first.effectivePeriod.effectiveTo,
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        presentedFuture: [
          {
            ...future,
            definition: {
              ...future.definition,
              identityKey: { ...identityKey, thresholdQuantity: '20' },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('binds retirement acknowledgement to a strict shortening of the exact Tier target interval', () => {
    type SupportsRetirement =
      Extract<
        typeof QuantityTierScheduleAcknowledgementSchema.Type,
        { readonly intent: 'RETIRE_CURRENT' }
      > extends never
        ? false
        : true;
    const supportsRetirement: SupportsRetirement = true;
    const first = scheduledRevision(
      1,
      '77777777-7777-4777-8777-777777777777',
      '90',
      '2026-09-01T00:00:00.000Z',
      '2026-09-28T00:00:00.000Z',
    );
    const future = scheduledRevision(2, '88888888-8888-4888-8888-888888888888', '80', '2026-10-01T00:00:00.000Z', null);
    const acknowledgement = {
      actingPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fingerprint: 'a'.repeat(64),
      identityKey,
      intendedEffectivePeriod: {
        effectiveFrom: first.effectivePeriod.effectiveFrom,
        effectiveTo: '2026-09-26T00:00:00.000Z',
      },
      intendedResultingUnitPrice: first.definition.revision.resultingUnitPrice,
      intent: 'RETIRE_CURRENT',
      presentedFuture: [future],
      scheduleRevision: 2,
      targetEffectivePeriod: first.effectivePeriod,
      targetRevisionId: first.definition.revision.revisionId,
    };
    const decode = Schema.decodeUnknownSync(QuantityTierScheduleAcknowledgementSchema);

    expect(supportsRetirement).toBe(true);
    expect(decode(acknowledgement)).toBeDefined();
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: {
          effectiveFrom: '2026-09-02T00:00:00.000Z',
          effectiveTo: '2026-09-26T00:00:00.000Z',
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: {
          effectiveFrom: first.effectivePeriod.effectiveFrom,
          effectiveTo: first.effectivePeriod.effectiveFrom,
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: first.effectivePeriod,
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: {
          effectiveFrom: first.effectivePeriod.effectiveFrom,
          effectiveTo: null,
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        presentedFuture: [
          future,
          scheduledRevision(3, '99999999-9999-4999-8999-999999999999', '75', '2026-09-30T00:00:00.000Z', null),
        ],
      }),
    ).toThrow();
  });
});
