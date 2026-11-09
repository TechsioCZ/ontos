import {
  makeIsolatedNativeDatabaseFixture,
  requireOwnedNativeDatabaseFixture,
} from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  bootstrapInternalC14PricingSourceAuthority,
  InternalC14PricingSourceBootstrapUnavailable,
} from '../support/c14-source-authority-bootstrap.fixture.ts';
import type { InternalC14PricingSourceBootstrapRequest } from '../support/c14-source-authority-bootstrap.fixture.ts';
import { ExternalPriceSourceAuthorityGrantSchema } from '../support/c14-source-authority.fixture.ts';

const fixturePurpose = 'implementation-1096-registered-workload-gateway';
const tenantId = 'e1400000-0000-4000-8000-000000000001';
const legalEntityId = 'e1400000-0000-4000-8000-000000000002';
const inputFor = (ownedDatabase: OwnedNativeDatabaseFixture): InternalC14PricingSourceBootstrapRequest => ({
  grant: Schema.decodeSync(ExternalPriceSourceAuthorityGrantSchema)({
    authority: { sourceAuthorityRef: 'unreachable-ownership-control', sourceAuthorityVersion: '1' },
    effectivePeriod: { effectiveFrom: '2026-11-07T10:00:00.000Z' },
    exactIdentityKey: {
      catalogSelection: {
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e1400000-0000-4000-8000-000000000003',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e1400000-0000-4000-8000-000000000004',
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
      commercialScope: {
        channelId: 'B2C',
        marketId: 'unreachable-ownership-control',
        sellingLegalEntityId: legalEntityId,
      },
      currencyCode: 'CZK',
      priceGroupSelector: { kind: 'NO_GROUP' },
      unitBasis: {
        quantity: '1',
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e1400000-0000-4000-8000-000000000005',
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        },
      },
    },
    family: 'PRICE',
    mapping: { mappingContractRef: 'unreachable-ownership-control', mappingContractVersion: '1' },
    ownerModuleId: 'commerce.pricing',
    schemaVersion: '1',
    verificationRef: 'unreachable-ownership-control',
    verifiedAt: '2026-11-07T10:00:00.000Z',
  }),
  legalEntityId,
  operatorPrincipalId: 'e1400000-0000-4000-8000-000000000006',
  operatorProviderUserId: 'unreachable-ownership-control',
  ownedDatabase,
  purpose: fixturePurpose,
  runtimeConnectionString: Redacted.make(ownedDatabase.connections.runtime.connectionString),
  tenantId,
});
const expectOwnershipRefusal = Effect.fn('PricingSourceBootstrapTest.expectOwnershipRefusal')(
  function* expectOwnershipRefusal(input: InternalC14PricingSourceBootstrapRequest) {
    const failure = yield* bootstrapInternalC14PricingSourceAuthority(input).pipe(Effect.flip);
    expect(Schema.is(InternalC14PricingSourceBootstrapUnavailable)(failure)).toBe(true);
    expect(failure.stage).toBe('owned-database');
  },
);
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(Layer.merge(NodeCrypto.layer, nativeServices), { excludeTestServices: true })((suite) =>
  suite.effect(
    'requires the exact live owned database capability, purpose, runtime URL and lifetime before configuring authority',
    () =>
      Effect.gen(function* ownedSourceAuthorityBoundary() {
        const expired = yield* Effect.scoped(
          Effect.gen(function* liveOwnedSourceAuthority() {
            const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['pricing']);
            const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
              compositionSnapshot,
              mode: 'schema-only',
              purpose: fixturePurpose,
            });
            const input = inputFor(ownedDatabase);
            yield* requireOwnedNativeDatabaseFixture(ownedDatabase, {
              adminConnectionString: Redacted.make(ownedDatabase.connections.admin.connectionString),
              purpose: fixturePurpose,
              runtimeConnectionString: input.runtimeConnectionString,
            });
            const copied = Object.defineProperties(
              { ...ownedDatabase },
              Object.getOwnPropertyDescriptors(ownedDatabase),
            );
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
            const wrongCallerPurpose = yield* bootstrapInternalC14PricingSourceAuthority({
              ...input,
              // @ts-expect-error The public helper refuses another purpose even from an untyped caller.
              purpose: 'implementation-1118-symmy-job-admission',
            }).pipe(Effect.flip);
            expect(wrongCallerPurpose.stage).toBe('owned-database-purpose');
            // A real live capability passes ownership, but cannot manufacture an actual human/Tenant/SLE.
            const missingHuman = yield* bootstrapInternalC14PricingSourceAuthority(input).pipe(Effect.flip);
            expect(missingHuman.stage).toBe('bootstrap');
            return input;
          }),
        );
        yield* expectOwnershipRefusal(expired);
      }),
    120_000,
  ),
);
