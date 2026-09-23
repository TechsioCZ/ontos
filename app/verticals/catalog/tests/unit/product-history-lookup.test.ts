import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';

import { ProductHistorySchema } from '../../shared/domain/product.ts';
import { ProductRevisionReferenceSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { ReadHandlerNotFound } from '@app/core-runtime';
import { readProductHistory } from '../../src/api/product-history.read.ts';
import { ProductHistoricalLocalizedRevisionSchema } from '../../shared/apis/product-history.ts';
import type { CatalogPersistence } from '../../src/persistence/catalog-persistence.ts';
import type { LocalizedFactsReads } from '../../src/persistence/localized-facts-reads.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const revisionId = '33333333-3333-4333-8333-333333333333';
const actionInvocationId = '44444444-4444-4444-8444-444444444444';
const recordedAt = '2026-09-16T12:00:00.000Z';
const history = Schema.decodeUnknownSync(ProductHistorySchema)({
  historical: true,
  lifecycle: [],
  productRef,
  revisions: [
    {
      actionInvocationId,
      changeKind: 'CREATED',
      description: 'Original description',
      evidenceRefs: ['evidence:original'],
      lifecycle: 'DRAFT',
      name: 'Original name',
      productRef,
      reason: 'Created',
      recordedAt,
      revision: 1,
      revisionReference: { resourceRef: productRef, revision: 1, revisionId },
    },
    {
      actionInvocationId: '55555555-5555-4555-8555-555555555555',
      changeKind: 'UPDATED',
      description: 'Current description',
      evidenceRefs: ['evidence:rename'],
      lifecycle: 'ACTIVE',
      name: 'Current name',
      productRef,
      reason: 'Renamed',
      recordedAt: '2026-09-17T12:00:00.000Z',
      revision: 2,
      revisionReference: {
        resourceRef: productRef,
        revision: 2,
        revisionId: '66666666-6666-4666-8666-666666666666',
      },
    },
  ],
});
const services: CatalogPersistence = {
  correct: () => Effect.die('unused'),
  create: () => Effect.die('unused'),
  getCreatedByInvocation: () => Effect.die('unused'),
  getCurrent: () => Effect.die('unused'),
  getHistory: () => Effect.succeed(Option.some(history)),
  reactivate: () => Effect.die('unused'),
  recoverCreateProduct: () => Effect.die('unused'),
  recoverUpdateProduct: () => Effect.die('unused'),
  retire: () => Effect.die('unused'),
  update: () => Effect.die('unused'),
};
const historyServices: CatalogPersistence & Pick<LocalizedFactsReads, 'productHistory'> = {
  ...services,
  productHistory: (_ref, locale) =>
    Effect.succeed(
      Schema.decodeUnknownSync(Schema.Array(ProductHistoricalLocalizedRevisionSchema))([
        {
          evidenceRefs: [],
          historical: true as const,
          kind: 'SET' as const,
          locale,
          name: 'Starý název',
          reason: 'Original copy',
          recordedAt,
          revision: 1,
        },
        {
          evidenceRefs: [],
          historical: true as const,
          kind: 'SET' as const,
          locale,
          name: 'Nový název',
          reason: 'Rename',
          recordedAt: '2026-09-17T12:00:00.000Z',
          revision: 2,
        },
      ]),
    ),
};
const firstReference = Schema.decodeUnknownSync(ProductRevisionReferenceSchema)({
  resourceRef: productRef,
  revision: 1,
  revisionId,
});

describe('governed Product historical lookup', () => {
  it.effect('returns the exact retained revision, not a Current replacement', () =>
    Effect.gen(function* foundRevision() {
      const response = yield* readProductHistory(
        {
          productRef,
          revisionReference: firstReference,
        },
        tenantId,
        historyServices,
      );
      expect(response.lookup?.kind).toBe('FOUND');
      if (response.lookup?.kind === 'FOUND') {
        expect(response.lookup.evidence.retained).toMatchObject({
          description: 'Original description',
          historical: true,
          kind: 'PRODUCT',
          lifecycle: 'DRAFT',
          name: 'Original name',
        });
        expect(response.lookup.evidence.reference).toEqual(firstReference);
        expect(response.lookup.evidence.evidenceRefs).toEqual(['evidence:original']);
        expect(response.lookup.evidence.retained).not.toHaveProperty('catalogReady');
      }
    }),
  );

  it.effect('returns MISSING for an absent exact revision and rejects a foreign Tenant', () =>
    Effect.gen(function* missingRevision() {
      const response = yield* readProductHistory(
        {
          productRef,
          revisionReference: Schema.decodeUnknownSync(ProductRevisionReferenceSchema)({
            resourceRef: productRef,
            revision: 2,
            revisionId: '55555555-5555-4555-8555-555555555555',
          }),
        },
        tenantId,
        historyServices,
      );
      expect(response.lookup?.kind).toBe('MISSING');
      const foreign = yield* readProductHistory(
        {
          productRef: { ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' },
        },
        tenantId,
        historyServices,
      ).pipe(Effect.catchTag('ReadHandlerNotFound', (error) => Effect.succeed(error)));
      expect(Schema.is(ReadHandlerNotFound)(foreign)).toBe(true);
    }),
  );

  it.effect('returns exact locale-qualified rename revisions without substituting Current text', () =>
    Effect.gen(function* localizedRename() {
      const response = yield* readProductHistory(
        { locale: 'cs-CZ', productRef, revisionReference: firstReference },
        tenantId,
        historyServices,
      );
      expect(response.history.revisions.map(({ description, name }) => ({ description, name }))).toEqual([
        { description: 'Original description', name: 'Original name' },
        { description: 'Current description', name: 'Current name' },
      ]);
      expect(response.localizedRevisions?.map(({ name, revision }) => ({ name, revision }))).toEqual([
        { name: 'Starý název', revision: 1 },
        { name: 'Nový název', revision: 2 },
      ]);
      expect(response.lookup?.kind).toBe('FOUND');
      if (response.lookup?.kind === 'FOUND') {
        expect(response.lookup.evidence.retained).toMatchObject({
          description: 'Original description',
          name: 'Original name',
        });
      }
    }),
  );

  it.effect('keeps the old Product reference historical after retirement', () =>
    Effect.gen(function* retiredProduct() {
      const retiredHistory = Schema.decodeUnknownSync(ProductHistorySchema)({
        ...history,
        lifecycle: [
          {
            actionInvocationId,
            effectiveAt: '2026-09-18T12:00:00.000Z',
            event: 'RETIRED',
            productRef,
            reason: 'Discontinued',
            recordedAt: '2026-09-18T12:00:00.000Z',
          },
        ],
      });
      const response = yield* readProductHistory(
        { locale: 'cs-CZ', productRef, revisionReference: firstReference },
        tenantId,
        { ...historyServices, getHistory: () => Effect.succeed(Option.some(retiredHistory)) },
      );
      expect(response.history.lifecycle[0]?.event).toBe('RETIRED');
      expect(response.lookup?.kind).toBe('FOUND');
      if (response.lookup?.kind === 'FOUND') {
        expect(response.lookup.evidence.retained.lifecycle).toBe('DRAFT');
      }
    }),
  );
});
