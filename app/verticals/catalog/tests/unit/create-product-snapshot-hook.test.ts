import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import { recordCreateProductResultSnapshot } from '../../src/actions/create-product.action.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '44444444-4444-4444-8444-444444444444';
const variantId = '55555555-5555-4555-8555-555555555555';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const result = Schema.decodeUnknownSync(CreateProductResultSchema)({
  product: {
    catalogReady: false,
    createdAt: '2026-09-17T10:00:00.000Z',
    lifecycle: 'DRAFT',
    name: 'Original',
    productRef,
    revision: 1,
    updatedAt: '2026-09-17T10:00:00.000Z',
    variants: [
      {
        lifecycle: 'WORK_IN_PROGRESS',
        productRef,
        variantId,
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: variantId,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
    ],
  },
  variantId,
});

describe('create Product decoded-success snapshot hook', () => {
  it.effect('passes the decoded result and invocation to transaction-local capture', () =>
    Effect.gen(function* insertDecodedResult() {
      const observed: unknown[] = [];
      yield* recordCreateProductResultSnapshot({
        actionInvocationId,
        result,
        services: {
          captureResult: (id, value) => {
            observed.push({ id, value });
            return Effect.void;
          },
        },
      });
      expect(observed).toEqual([
        {
          id: actionInvocationId,
          value: result,
        },
      ]);
    }),
  );

  it.effect('preserves a typed snapshot persistence failure', () =>
    Effect.gen(function* failClosedSnapshot() {
      const unavailable = new CatalogPersistenceUnavailable({
        code: 'catalog_persistence_unavailable',
        reason: 'Snapshot unavailable',
      });
      const failure = yield* Effect.flip(
        recordCreateProductResultSnapshot({
          actionInvocationId,
          result,
          services: {
            captureResult: () => Effect.fail(unavailable),
          },
        }),
      );
      expect(failure).toBe(unavailable);
    }),
  );
});
