import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  ExternalPriceSourceAuthorityGrantConflict,
  ExternalPriceSourceAuthorityGrantRejected,
  GrantExternalPriceSourceAuthorityPayloadSchema,
  grantExternalPriceSourceAuthorityAction,
  handleGrantExternalPriceSourceAuthority,
} from '../../src/actions/grant-external-price-source-authority.action.ts';
import type { GrantExternalPriceSourceAuthorityPayload } from '../../src/actions/grant-external-price-source-authority.action.ts';
import { externalPriceSourceAuthorityForScope } from '../../src/persistence/external-price-source-authority-persistence.ts';
import { makeExternalPriceInputBoundary } from '../../src/services/external-price-input-boundary.service.ts';

const tenantId = 'e8060000-0000-4000-8000-000000000001';
const legalEntityId = 'e8060000-0000-4000-8000-000000000002';
const otherLegalEntityId = 'e8060000-0000-4000-8000-000000000003';
const principalId = 'e8060000-0000-4000-8000-000000000004';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];

const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: principalId,
    authContextRef: 'session:grant-external-price-source-authority',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'grant-external-price-source-authority-postgres',
};

const unitBasis = {
  quantity: '1',
  unitRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: 'e8060000-0000-4000-8000-000000000013',
    resourceType: 'commerce.catalog.product-unit' as const,
    tenantId,
  },
};
const exactIdentityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: 'e8060000-0000-4000-8000-000000000011',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: 'e8060000-0000-4000-8000-000000000012',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2B' as const, marketId: 'cz-market', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: {
    kind: 'PRICE_GROUP' as const,
    priceGroupRef: {
      moduleId: 'pricing.price-group-catalog' as const,
      resourceId: 'e8060000-0000-4000-8000-000000000021',
      resourceType: 'pricing.price-group-catalog.price-group' as const,
      tenantId,
    },
  },
  unitBasis,
};
const authority = { sourceAuthorityRef: 'erp-price-owner', sourceAuthorityVersion: '1' };
const mapping = { mappingContractRef: 'erp-price-list-exact-key', mappingContractVersion: '1' };
const payload = Schema.decodeSync(GrantExternalPriceSourceAuthorityPayloadSchema)({
  authority,
  effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z' },
  exactIdentityKey,
  mapping,
  reason: 'The ERP is the verified owner of this exact group Price.',
  verificationRef: 'operator-verification-1096',
});

const foreignPayload = Schema.decodeSync(GrantExternalPriceSourceAuthorityPayloadSchema)({
  ...payload,
  exactIdentityKey: {
    ...exactIdentityKey,
    commercialScope: { ...exactIdentityKey.commercialScope, sellingLegalEntityId: otherLegalEntityId },
  },
});

/** Runs the Action handler with the registration's own scoped services, as the runtime role under RLS. */
const runGrant = (runtime: PricingTestDatabase, selectedPayload: GrantExternalPriceSourceAuthorityPayload) =>
  runtime.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* registeredGrant() {
      const owner = yield* installOperationalScope(transaction, scope);
      const services = yield* getActionServiceFactory(grantExternalPriceSourceAuthorityAction)(
        owner,
        scope,
        'a'.repeat(64),
      );
      return yield* handleGrantExternalPriceSourceAuthority(selectedPayload, {
        actionInvocationId: 'e8060000-0000-4000-8000-000000000031',
        addDomainEvent: () => Effect.die('unused'),
        addOutboxMessage: () => Effect.die('unused'),
        compositionRevision: 'a'.repeat(64),
        recordAuditEvidence: () => Effect.void,
        recordDataAccess: () => Effect.void,
        scope,
        services,
      });
    }),
  );

const sourceAssertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
  lineage: { kind: 'INITIAL' },
  mapping,
  originalAssertion: {
    monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    unitBasis,
  },
  sourceAssertionId: 'e8060000-0000-4000-8000-000000000041',
  sourceAuthority: authority,
  sourceRecord: {
    sourceChangeCorrelation: 'erp-change-1096',
    sourceRecordRef: 'erp-price-row-1096',
    sourceRecordVersion: '1',
    sourceSystem: { ownerModuleId: 'external.erp', sourceSystemRef: 'erp' },
  },
  timing: {
    importedAt: '2026-11-02T09:00:00.000Z',
    ownerBusinessEffectiveAt: '2026-11-02T08:00:00.000Z',
    sourceEffectiveAt: '2026-11-02T08:00:00.000Z',
  },
});

/** The same boundary Define Price, Revise Price and the bulk Price Action build from this persistence. */
const assessDefinition = (runtime: PricingTestDatabase, trustedOperationAt: Date) =>
  runtime.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* boundaryAssessment() {
      const owner = yield* installOperationalScope(transaction, scope);
      const persistence = yield* externalPriceSourceAuthorityForScope(owner, scope);
      return yield* makeExternalPriceInputBoundary(persistence).assess({
        actingPrincipalId: principalId,
        effectiveFrom: sourceAssertion.timing.ownerBusinessEffectiveAt,
        identityKey: payload.exactIdentityKey,
        monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
        sourceAssertion,
        tenantId,
        trustedOperationAt,
      });
    }),
  );

const cleanup = (admin: PricingTestDatabase) =>
  admin.execute(sql`delete from pricing.external_price_source_authority_grants where tenant_id = ${tenantId}::uuid`);

it.live('an operator grant through the Action lets the external Price boundary accept exactly that key', () =>
  Effect.scoped(
    Effect.gen(function* grantThroughAction() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      // Without a grant the source assertion is held, and nothing is written.
      const beforeGrant = yield* assessDefinition(runtime, DateTime.toDateUtc(yield* DateTime.now));
      expect(beforeGrant).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'SOURCE_AUTHORITY_UNRESOLVED',
      });

      const granted = yield* runGrant(runtime, payload);
      expect(granted.outcome).toBe('STORED');

      const afterGrant = yield* assessDefinition(runtime, DateTime.toDateUtc(yield* DateTime.now));
      expect(afterGrant.outcome).toBe('READY_FOR_CANONICAL_WRITE');

      // A later grant of the same key, authority, mapping and start never replaces the verified one.
      const repeated = yield* runGrant(runtime, payload).pipe(Effect.flip);
      expect(repeated).toBeInstanceOf(ExternalPriceSourceAuthorityGrantConflict);

      // A key of another Selling Legal Entity is refused before anything is stored.
      const foreign = yield* runGrant(runtime, foreignPayload).pipe(Effect.flip);
      expect(foreign).toBeInstanceOf(ExternalPriceSourceAuthorityGrantRejected);

      const rows = yield* admin.execute<{ readonly count: number }>(
        sql`select count(*)::integer as count from pricing.external_price_source_authority_grants
          where tenant_id = ${tenantId}::uuid`,
        'objects',
      );
      expect(rows).toEqual([{ count: 1 }]);
    }),
  ),
);
