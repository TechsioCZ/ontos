import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import type { PriceSourceAssertionInput } from '@app/pricing-contracts/domain/price-source-provenance';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { externalPriceSourceAuthorityForScope } from '../../src/persistence/external-price-source-authority-persistence.ts';
import type { ExternalPriceSourceAuthorityPersistence } from '../../src/persistence/external-price-source-authority-persistence.ts';
import type { ExternalPriceSourceAuthorityGrant } from '../../src/services/external-price-input-boundary.service.ts';

const tenantId = 'e8030000-0000-4000-8000-000000000001';
const legalEntityId = 'e8030000-0000-4000-8000-000000000002';
const otherTenantId = 'e8030000-0000-4000-8000-000000000003';
const otherLegalEntityId = 'e8030000-0000-4000-8000-000000000004';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];

const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));

const scopeFor = (selectedTenantId: string, selectedLegalEntityId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: selectedTenantId,
    authContextRef: `session:external-price-source-authority:${selectedTenantId}`,
    authMethod: 'session',
    legalEntityId: selectedLegalEntityId,
    principalId: selectedLegalEntityId,
    tenantId: selectedTenantId,
  }),
  correlationId: `external-price-source-authority:${selectedTenantId}`,
});

const scope = scopeFor(tenantId, legalEntityId);
const otherScope = scopeFor(otherTenantId, otherLegalEntityId);

const identityFor = (selectedTenantId: string, selectedLegalEntityId: string): PriceIdentityKey => ({
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e8030000-0000-4000-8000-000000000011',
      resourceType: 'commerce.catalog.product',
      tenantId: selectedTenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e8030000-0000-4000-8000-000000000012',
      resourceType: 'commerce.catalog.variant',
      tenantId: selectedTenantId,
    },
  },
  commercialScope: {
    channelId: 'B2B',
    marketId: 'cz-market',
    sellingLegalEntityId: selectedLegalEntityId,
  },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' },
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e8030000-0000-4000-8000-000000000013',
      resourceType: 'commerce.catalog.product-unit',
      tenantId: selectedTenantId,
    },
  },
});

const grantFor = (selectedTenantId: string, selectedLegalEntityId: string): ExternalPriceSourceAuthorityGrant => ({
  authority: {
    sourceAuthorityRef: 'pricing-governed-erp-feed',
    sourceAuthorityVersion: '9',
  },
  effectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-10-01T00:00:00.000Z',
  },
  exactIdentityKey: identityFor(selectedTenantId, selectedLegalEntityId),
  family: 'PRICE',
  mapping: { mappingContractRef: 'erp-price-exact-key', mappingContractVersion: '4' },
  ownerModuleId: 'commerce.pricing',
  schemaVersion: '1',
  verificationRef: 'pricing-source-authority-proof-803',
  verifiedAt: '2026-08-31T10:00:00.000Z',
});

const sourceAssertion: PriceSourceAssertionInput = {
  lineage: { kind: 'INITIAL' },
  mapping: { mappingContractRef: 'erp-price-exact-key', mappingContractVersion: '4' },
  originalAssertion: {
    monetaryAmount: { amount: '100.000000000', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    unitBasis: {
      quantity: '1',
      unitRef: identityFor(tenantId, legalEntityId).unitBasis.unitRef,
    },
  },
  sourceAssertionId: 'e8030000-0000-4000-8000-000000000014',
  sourceAuthority: {
    sourceAuthorityRef: 'pricing-governed-erp-feed',
    sourceAuthorityVersion: '9',
  },
  sourceRecord: {
    sourceChangeCorrelation: 'erp-change-803',
    sourceRecordRef: 'erp-price-row-803',
    sourceRecordVersion: '1',
    sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
  },
  timing: {
    importedAt: '2026-09-15T10:01:00.000Z',
    ownerBusinessEffectiveAt: '2026-09-15T10:00:00.000Z',
    sourceEffectiveAt: '2026-09-15T09:55:00.000Z',
  },
};

const withAuthority = <Value, Failure>(
  database: PricingTestDatabase,
  selectedScope: OperationalScope,
  operation: (authority: ExternalPriceSourceAuthorityPersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedAuthority() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${selectedScope.tenantId}, true),
                   set_config('ontos.legal_entity_id', ${selectedScope.legalEntityId ?? ''}, true)`,
        'objects',
      );
      const ownerTransaction = yield* installOperationalScope(transaction, selectedScope);
      const authority = yield* externalPriceSourceAuthorityForScope(ownerTransaction, selectedScope);
      return yield* operation(authority);
    }),
  );

const cleanup = (admin: PricingTestDatabase) =>
  admin.execute(sql`delete from pricing.external_price_source_authority_grants
    where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`);

it.live('stores, resolves, and isolates exact external Price Source Authority grants in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* externalPriceSourceAuthorityPostgres() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const grant = grantFor(tenantId, legalEntityId);
      expect(yield* withAuthority(runtime, scope, (authority) => authority.store(grant))).toEqual({
        outcome: 'STORED',
      });
      expect(yield* withAuthority(runtime, scope, (authority) => authority.store(grant))).toEqual({
        outcome: 'REUSED',
      });
      expect(
        yield* withAuthority(runtime, scope, (authority) =>
          authority.store({ ...grant, verificationRef: 'pricing-source-authority-conflict-803' }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'GRANT_IDENTITY_ALREADY_BOUND' });

      const assess = (
        selectedSourceAssertion: PriceSourceAssertionInput = sourceAssertion,
        trustedOperationAt = instant('2026-09-20T10:00:00.000Z'),
      ) =>
        withAuthority(runtime, scope, (authority) =>
          authority.assess({
            exactIdentityKey: grant.exactIdentityKey,
            sourceAssertion: selectedSourceAssertion,
            tenantId,
            trustedOperationAt,
          }),
        );
      expect(yield* assess()).toEqual({ grant, outcome: 'AUTHORITY_GRANTED' });
      expect(
        yield* assess({
          ...sourceAssertion,
          sourceAuthority: { ...sourceAssertion.sourceAuthority, sourceAuthorityVersion: 'missing' },
        }),
      ).toEqual({ outcome: 'AUTHORITY_UNRESOLVED', reason: 'AUTHORITY' });
      expect(yield* assess(sourceAssertion, instant('2026-08-30T10:00:00.000Z'))).toEqual({
        outcome: 'AUTHORITY_UNRESOLVED',
        reason: 'AUTHORITY',
      });

      const overlappingGrant: ExternalPriceSourceAuthorityGrant = {
        ...grant,
        effectivePeriod: {
          effectiveFrom: '2026-09-10T00:00:00.000Z',
          effectiveTo: '2026-09-30T00:00:00.000Z',
        },
        verificationRef: 'pricing-source-authority-overlap-803',
      };
      expect(yield* withAuthority(runtime, scope, (authority) => authority.store(overlappingGrant))).toEqual({
        outcome: 'STORED',
      });
      expect(yield* assess()).toEqual({ outcome: 'AUTHORITY_UNRESOLVED', reason: 'AUTHORITY' });

      const otherGrant = grantFor(otherTenantId, otherLegalEntityId);
      expect(yield* withAuthority(runtime, otherScope, (authority) => authority.store(otherGrant))).toEqual({
        outcome: 'STORED',
      });
      const scopedCounts = yield* Effect.forEach([scope, otherScope], (selectedScope) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedCount() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${selectedScope.tenantId}, true),
                             set_config('ontos.legal_entity_id', ${selectedScope.legalEntityId ?? ''}, true)`,
            );
            return yield* transaction.execute<{ readonly count: number }>(
              sql`select count(*)::integer as count
                        from pricing.external_price_source_authority_grants`,
              'objects',
            );
          }),
        ),
      );
      expect(scopedCounts).toEqual([[{ count: 2 }], [{ count: 1 }]]);
    }),
  ),
);
