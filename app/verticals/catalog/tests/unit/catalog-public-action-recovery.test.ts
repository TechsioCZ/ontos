import { ActionRuntime, ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  CreateVariantRecoveryRequestSchema,
  CreateVariantRecoveryResponseSchema,
} from '../../shared/apis/create-variant-recovery.ts';
import {
  UpdateProductRecoveryRequestSchema,
  UpdateProductRecoveryResponseSchema,
} from '../../shared/apis/update-product-recovery.ts';
import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { recoverCreateVariant } from '../../src/api/create-variant-recovery.read.ts';
import { recoverUpdateProduct } from '../../src/api/update-product-recovery.read.ts';
import type { VariantPersistence } from '../../src/persistence/variant-persistence.ts';
import type { CatalogPersistence } from '../../src/persistence/catalog-persistence.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';
const scope = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:test',
  authMethod: 'session' as const,
  correlationId: 'test',
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const unusedRuntime = {
  resolveActionCommit: () => Effect.die('Mocked recovery must not resolve an Action commit'),
  runAction: () => Effect.die('Mocked recovery must not run an Action'),
};

describe('typed public Catalog Action recovery', () => {
  it('publishes distinct governed permissions and refuses generic result bodies', () => {
    expect(catalogPublicOperationContracts['commerce.catalog.api.create-variant-recovery']).toMatchObject({
      permission: 'commerce.catalog.read.create-variant-recovery',
      scope: 'tenant',
    });
    expect(catalogPublicOperationContracts['commerce.catalog.api.update-product-recovery']).toMatchObject({
      permission: 'commerce.catalog.read.update-product-recovery',
      scope: 'tenant',
    });
    expect(catalogAuthorityBundles.CATALOG_READER).toContain('commerce.catalog.read.create-variant-recovery');
    expect(catalogAuthorityBundles.CATALOG_READER).toContain('commerce.catalog.read.update-product-recovery');
    expect(Schema.is(CreateVariantRecoveryRequestSchema)({ invocationId })).toBe(true);
    expect(Schema.is(UpdateProductRecoveryRequestSchema)({ invocationId })).toBe(true);
    expect(Schema.is(CreateVariantRecoveryResponseSchema)({ ok: true })).toBe(false);
    expect(Schema.is(UpdateProductRecoveryResponseSchema)({ ok: true })).toBe(false);
  });

  for (const status of ['absent', 'rejected', 'open', 'indeterminate', 'unavailable'] as const) {
    it.effect(`maps create Variant ${status} without inventing a result`, () =>
      Effect.gen(function* recoverVariant() {
        const services: VariantPersistence = {
          change: () => Effect.die('unused'),
          confirm: () => Effect.die('unused'),
          create: () => Effect.die('unused'),
          reactivate: () => Effect.die('unused'),
          recoverCreateVariant: () => Effect.succeed({ status }),
          retire: () => Effect.die('unused'),
        };
        const failedAsExpected = yield* recoverCreateVariant(
          { invocationId },
          { readKey: 'commerce.catalog.api.create-variant-recovery', scope, services },
        ).pipe(
          Effect.provideService(ActionRuntime, unusedRuntime),
          Effect.match({
            onFailure: (failure) =>
              Schema.is(status === 'absent' ? ReadHandlerNotFound : ReadHandlerUnavailable)(failure),
            onSuccess: () => false,
          }),
        );
        expect(failedAsExpected).toBe(true);
      }),
    );
    it.effect(`maps update Product ${status} without inventing a result`, () =>
      Effect.gen(function* recoverProduct() {
        const services: CatalogPersistence = {
          correct: () => Effect.die('unused'),
          create: () => Effect.die('unused'),
          getCreatedByInvocation: () => Effect.die('unused'),
          getCurrent: () => Effect.die('unused'),
          getHistory: () => Effect.die('unused'),
          reactivate: () => Effect.die('unused'),
          recoverCreateProduct: () => Effect.die('unused'),
          recoverUpdateProduct: () => Effect.succeed({ status }),
          retire: () => Effect.die('unused'),
          update: () => Effect.die('unused'),
        };
        const failedAsExpected = yield* recoverUpdateProduct(
          { invocationId },
          { readKey: 'commerce.catalog.api.update-product-recovery', scope, services },
        ).pipe(
          Effect.provideService(ActionRuntime, unusedRuntime),
          Effect.match({
            onFailure: (failure) =>
              Schema.is(status === 'absent' ? ReadHandlerNotFound : ReadHandlerUnavailable)(failure),
            onSuccess: () => false,
          }),
        );
        expect(failedAsExpected).toBe(true);
      }),
    );
  }
});
