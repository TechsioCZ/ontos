import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  bootstrapInternalC14CatalogPricingReadiness,
  InternalC14CatalogPricingReadinessUnavailable,
} from '../support/c14-pricing-readiness-native.ts';
import type { InternalC14CatalogPricingReadinessRequest } from '../support/c14-pricing-readiness-native.ts';

const fixturePurpose = 'implementation-1096-registered-workload-gateway';
const tenantId = '11111111-1111-4111-8111-111111111111';
const inputFor = (ownedDatabase: OwnedNativeDatabaseFixture): InternalC14CatalogPricingReadinessRequest => ({
  expectedProductRevision: 1,
  expectedUnitRule: {
    revision: 1,
    rounding: 'UP',
    step: '1',
    unit: {
      moduleId: 'commerce.catalog',
      resourceId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  expectedVariantRevision: 1,
  fixtureFacts: {
    categoryName: 'Unreachable invalid ownership fixture',
    divisible: false,
    locale: 'en',
    localizedName: 'Unreachable invalid ownership fixture',
    structuredAttributesRequired: false,
    variantAxesRequired: false,
  },
  operatorPrincipalId: '33333333-3333-4333-8333-333333333333',
  operatorProviderUserId: 'unreachable-ownership-negative-control',
  originalCreateInvocationId: '44444444-4444-4444-8444-444444444444',
  ownedDatabase,
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  purpose: fixturePurpose,
  runtimeConnectionString: Redacted.make(ownedDatabase.connections.runtime.connectionString),
  tenantId,
  validation: {
    authorization: Redacted.make('unreachable-ownership-negative-control'),
    baseUrl: 'http://127.0.0.1:1/catalog-api',
    compositionRevision: 'ownership-negative-control',
    requestCorrelation: 'ownership-negative-control',
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const expectOwnershipRefusal = Effect.fn('CatalogReadinessTest.expectOwnershipRefusal')(
  function* expectOwnershipRefusal(input: InternalC14CatalogPricingReadinessRequest) {
    const failure = yield* bootstrapInternalC14CatalogPricingReadiness(input).pipe(Effect.flip);
    expect(Schema.is(InternalC14CatalogPricingReadinessUnavailable)(failure)).toBe(true);
    expect(failure.stage).toBe('owned-database');
  },
);
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live(
  'refuses copied live capabilities, mismatched database URLs, wrong fixture purposes, and closed leases before owner setup',
  () =>
    Effect.gen(function* catalogReadinessOwnershipBoundary() {
      const expired = yield* Effect.scoped(
        Effect.gen(function* liveOwnedReadinessFixture() {
          const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['catalog']);
          const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
            compositionSnapshot,
            mode: 'schema-only',
            purpose: fixturePurpose,
          });
          const input = inputFor(ownedDatabase);
          const copied = Object.defineProperties({ ...ownedDatabase }, Object.getOwnPropertyDescriptors(ownedDatabase));
          yield* expectOwnershipRefusal({ ...input, ownedDatabase: copied });
          const wrongPurpose = yield* makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'implementation-1118-symmy-job-admission',
          });
          yield* expectOwnershipRefusal({
            ...input,
            runtimeConnectionString: Redacted.make(wrongPurpose.connections.runtime.connectionString),
          });
          yield* expectOwnershipRefusal({
            ...input,
            ownedDatabase: wrongPurpose,
            runtimeConnectionString: Redacted.make(wrongPurpose.connections.runtime.connectionString),
          });
          const wrongCallerPurpose = yield* bootstrapInternalC14CatalogPricingReadiness({
            ...input,
            // @ts-expect-error An untyped caller must not select another test purpose.
            purpose: 'implementation-1118-symmy-job-admission',
          }).pipe(Effect.flip);
          expect(wrongCallerPurpose.stage).toBe('owned-database-purpose');
          return input;
        }),
      );
      yield* expectOwnershipRefusal(expired);
    }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, nativeServices))),
  120_000,
);
