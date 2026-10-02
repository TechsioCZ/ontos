import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceEffectivePeriodSchema,
  PriceRevisionLineageSchema,
  PriceScheduleSnapshotSchema,
} from '../../src/domain/price-schedule.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const revision = (revisionNumber: number, revisionId: string, effectiveFrom: string, effectiveTo: null | string) => ({
  definition: {
    identityKey: {
      catalogSelection: {
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: '44444444-4444-4444-8444-444444444444',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: '55555555-5555-4555-8555-555555555555',
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
      commercialScope: {
        channelId: 'B2C',
        marketId: 'cz',
        sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      currencyCode: 'CZK',
      priceGroupSelector: { kind: 'NO_GROUP' },
      unitBasis: {
        quantity: '1',
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: '66666666-6666-4666-8666-666666666666',
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        },
      },
    },
    priceRef,
    revision: {
      effectiveFrom,
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      revision: revisionNumber,
      revisionId,
    },
  },
  effectivePeriod: { effectiveFrom, effectiveTo },
  lineage: {
    correctedRevisionId: null,
    kind: revisionNumber === 1 ? 'INITIAL' : 'SCHEDULED',
    previousRevisionId: revisionNumber === 1 ? null : '77777777-7777-4777-8777-777777777777',
  },
});

describe('Pricing Revision Schedule contract', () => {
  it('enforces non-empty half-open periods', () => {
    const decode = Schema.decodeUnknownSync(PriceEffectivePeriodSchema);
    expect(
      decode({ effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: '2026-10-01T00:00:00.000Z' }),
    ).toBeDefined();
    expect(() =>
      decode({ effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: '2026-10-01T00:00:00.000Z' }),
    ).toThrow();
  });

  it('validates Current evidence immediately before, exactly at, and after a half-open boundary', () => {
    const first = revision(
      1,
      '77777777-7777-4777-8777-777777777777',
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    );
    const second = revision(2, '88888888-8888-4888-8888-888888888888', '2026-10-01T00:00:00.000Z', null);
    const decode = Schema.decodeUnknownSync(PriceScheduleSnapshotSchema);
    const snapshot = (observedAt: string, current: typeof first, future: readonly (typeof first)[]) => ({
      current,
      future,
      observedAt,
      priceRef,
      revisions: [first, second],
      scheduleRevision: 2,
    });

    expect(decode(snapshot('2026-09-30T23:59:59.999Z', first, [second]))).toBeDefined();
    expect(decode(snapshot('2026-10-01T00:00:00.000Z', second, []))).toBeDefined();
    expect(decode(snapshot('2026-10-01T00:00:00.001Z', second, []))).toBeDefined();
    expect(() => decode(snapshot('2026-10-01T00:00:00.000Z', first, []))).toThrow();
  });

  it('retains legitimate gaps and exposes future changes without fabricating an edit acknowledgement', () => {
    const first = revision(
      1,
      '77777777-7777-4777-8777-777777777777',
      '2026-09-01T00:00:00.000Z',
      '2026-09-28T00:00:00.000Z',
    );
    const future = revision(2, '88888888-8888-4888-8888-888888888888', '2026-10-01T00:00:00.000Z', null);
    const schedule = {
      future: [future],
      observedAt: '2026-09-29T00:00:00.000Z',
      priceRef,
      revisions: [first, future],
      scheduleRevision: 2,
    };
    expect(Schema.decodeUnknownSync(PriceScheduleSnapshotSchema)(schedule)).toBeDefined();
  });

  it('rejects overlaps and incomplete correction lineage', () => {
    const first = revision(
      1,
      '77777777-7777-4777-8777-777777777777',
      '2026-09-01T00:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
    );
    const future = revision(2, '88888888-8888-4888-8888-888888888888', '2026-10-01T00:00:00.000Z', null);
    expect(() =>
      Schema.decodeUnknownSync(PriceScheduleSnapshotSchema)({
        current: first,
        future: [future],
        observedAt: '2026-09-26T00:00:00.000Z',
        priceRef,
        revisions: [first, future],
        scheduleRevision: 2,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceRevisionLineageSchema)({
        correctedRevisionId: null,
        kind: 'CORRECTION',
        previousRevisionId: first.definition.revision.revisionId,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceRevisionLineageSchema)({
        correctedRevisionId: future.definition.revision.revisionId,
        kind: 'SCHEDULED',
        previousRevisionId: first.definition.revision.revisionId,
      }),
    ).toThrow();
  });

  it('requires the complete ordered future schedule evidence', () => {
    const first = revision(
      1,
      '77777777-7777-4777-8777-777777777777',
      '2026-09-01T00:00:00.000Z',
      '2026-09-28T00:00:00.000Z',
    );
    const future = revision(2, '88888888-8888-4888-8888-888888888888', '2026-10-01T00:00:00.000Z', null);
    expect(() =>
      Schema.decodeUnknownSync(PriceScheduleSnapshotSchema)({
        current: first,
        future: [],
        observedAt: '2026-09-27T00:00:00.000Z',
        priceRef,
        revisions: [first, future],
        scheduleRevision: 2,
      }),
    ).toThrow();
  });
});
