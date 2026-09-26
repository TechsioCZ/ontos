import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { CurrentStorefrontApplicationResponseSchema } from '@app/storefront-registry-contracts';
import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CZECH_LAUNCH_COMMERCE_FIXTURE } from '../../../../scripts/czech-launch-commerce-fixture.mts';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler, getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  AssociateStorefrontPayloadSchema,
  associateStorefrontAction,
} from '../../src/actions/associate-storefront.action.ts';
import { CreateMarketPayloadSchema, createMarketAction } from '../../src/actions/create-market.action.ts';
import { makeCurrentStorefrontApplicationAuthority } from '../../src/integrations/current-storefront-application.ts';
import { marketCatalogReadPersistenceForScope } from '../../src/persistence/market-catalog-read-persistence.ts';
import { CurrentMarketCatalogRequestSchema } from '../../shared/apis/current-market-catalog.ts';

const tenantId = 'e346f000-0000-4000-8000-000000000001';
const principalId = 'e346f000-0000-4000-8000-000000000002';
const createActionInvocationId = 'e346f000-0000-4000-8000-000000000003';
const associateActionInvocationId = 'e346f000-0000-4000-8000-000000000004';
const fixtureScope = CZECH_LAUNCH_COMMERCE_FIXTURE.scope;
const fixtureMarket = CZECH_LAUNCH_COMMERCE_FIXTURE.market;
const [fixtureAssociation] = CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.marketCatalog.associations;

if (fixtureAssociation === undefined) {
  throw new Error('The Czech Launch fixture must declare its Storefront association');
}

const sellingLegalEntityRef = {
  ...fixtureMarket.sellingLegalEntityRef,
  tenantId,
};
const marketRef = {
  ...fixtureAssociation.marketRef,
  tenantId,
};
const storefrontRef = {
  ...fixtureAssociation.storefrontRef,
  tenantId,
};
const associationId = fixtureAssociation.associationRef.resourceId;
const effectiveAt = fixtureMarket.effectivePeriod.startsAt;

const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'czech-launch-market-fixture-postgres',
  legalEntityId: fixtureScope.sellingLegalEntityId,
  principalId,
  tenantId,
};

const createPayload = Schema.decodeUnknownSync(CreateMarketPayloadSchema)({
  ...fixtureMarket,
  sellingLegalEntityRef,
});

const currentInput = Schema.decodeUnknownSync(CurrentMarketCatalogRequestSchema)({ at: effectiveAt });

const storefrontOwnerResponse = Schema.decodeUnknownSync(CurrentStorefrontApplicationResponseSchema)({
  allowedChannels: [fixtureAssociation.channel],
  effectiveAt,
  effectiveInterval: { effectiveFrom: '2026-09-01T00:00:00.000Z' },
  lifecycle: 'ACTIVE',
  observedAt: '2026-09-30T23:59:59.000Z',
  outcome: 'CURRENT',
  ownerRevision: 'commerce.storefront-registry.current:czech-launch-b2c:v1',
  requestedChannel: fixtureAssociation.channel,
  storefrontAppId: fixtureScope.storefrontId,
  tenantId,
});

const storefrontAuthority = makeCurrentStorefrontApplicationAuthority(() => Effect.succeed(storefrontOwnerResponse));

type MarketCatalogTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
const scoped = <Value, Failure>(
  database: MarketCatalogTestDatabase,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedOperation() {
      const scopedTransaction = yield* installOperationalScope(transaction, scope);
      return yield* operation(scopedTransaction);
    }),
  );

it.live('persists and reads the Czech Launch Market fixture through owner Action factories', () =>
  Effect.scoped(
    Effect.gen(function* czechLaunchMarketFixturePostgres() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanCzechLaunchMarketFixture() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            for (const table of [
              'storefront_association_revisions',
              'storefront_associations',
              'market_lifecycle_periods',
              'market_definition_revisions',
              'markets',
              'market_catalog_completeness_generations',
            ] as const) {
              yield* transaction.execute(
                sql.raw(`delete from commerce_market_catalog.${table} where tenant_id = '${tenantId}'::uuid`),
              );
            }
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const create = () =>
        scoped(runtime, (transaction) =>
          Effect.gen(function* executeCreateMarketAction() {
            const collector = createActionCollector(
              createMarketAction.descriptor.domainEvents,
              createMarketAction.descriptor.owningModuleKey,
              createMarketAction.descriptor.accessEvidencePolicy,
              createMarketAction.descriptor.auditEvidenceSchema,
            );
            const services = yield* getActionServiceFactory(createMarketAction)(transaction, scope);
            const result = yield* getActionHandler(createMarketAction)(createPayload, {
              actionInvocationId: createActionInvocationId,
              addDomainEvent: collector.addDomainEvent,
              addOutboxMessage: collector.addOutboxMessage,
              recordAuditEvidence: collector.recordAuditEvidence,
              recordDataAccess: collector.recordDataAccess,
              scope,
              services,
            });
            return yield* Schema.decodeUnknownEffect(createMarketAction.descriptor.resultSchema)(result);
          }),
        );

      const created = yield* create();
      expect(created).toMatchObject({
        created: true,
        marketRef: { resourceId: fixtureScope.marketId, tenantId },
        revision: 1,
      });
      const { definitionRevisionRef } = created;

      const createReplay = yield* create();
      expect(createReplay).toEqual({
        created: false,
        definitionRevisionRef,
        marketRef: created.marketRef,
        revision: created.revision,
      });

      const associatePayload = Schema.decodeUnknownSync(AssociateStorefrontPayloadSchema)({
        associationId,
        channel: fixtureAssociation.channel,
        effectivePeriod: fixtureAssociation.effectivePeriod,
        expectedMarketDefinitionRevisionRef: definitionRevisionRef,
        marketRef,
        provenance: fixtureAssociation.provenance,
        reason: fixtureMarket.reason,
        sellingLegalEntityRef,
        storefrontRef,
      });

      const associate = () =>
        scoped(runtime, (transaction) =>
          Effect.gen(function* executeAssociateStorefrontAction() {
            const collector = createActionCollector(
              associateStorefrontAction.descriptor.domainEvents,
              associateStorefrontAction.descriptor.owningModuleKey,
              associateStorefrontAction.descriptor.accessEvidencePolicy,
              associateStorefrontAction.descriptor.auditEvidenceSchema,
            );
            const productionServices = yield* getActionServiceFactory(associateStorefrontAction)(transaction, scope);
            const services = { ...productionServices, ...storefrontAuthority };
            const result = yield* getActionHandler(associateStorefrontAction)(associatePayload, {
              actionInvocationId: associateActionInvocationId,
              addDomainEvent: collector.addDomainEvent,
              addOutboxMessage: collector.addOutboxMessage,
              recordAuditEvidence: collector.recordAuditEvidence,
              recordDataAccess: collector.recordDataAccess,
              scope,
              services,
            });
            return yield* Schema.decodeUnknownEffect(associateStorefrontAction.descriptor.resultSchema)(result);
          }),
        );

      const associated = yield* associate();
      expect(associated).toMatchObject({
        associationRef: { resourceId: associationId, tenantId },
        changed: true,
        marketRef: { resourceId: fixtureScope.marketId, tenantId },
        revision: 1,
      });

      const associationReplay = yield* associate();
      expect(associationReplay).toEqual({
        associationRef: associated.associationRef,
        changed: false,
        marketRef: associated.marketRef,
        revision: associated.revision,
      });

      const current = yield* scoped(runtime, (transaction) =>
        Effect.gen(function* readCurrentMarketCatalog() {
          const persistence = yield* marketCatalogReadPersistenceForScope(transaction, scope);
          return yield* persistence.current(currentInput);
        }),
      );

      expect(current.markets).toHaveLength(1);
      expect(current.markets[0]).toMatchObject({
        definitionRevisionRef,
        marketCode: fixtureMarket.marketCode,
        marketRef,
        revision: 1,
        sellingLegalEntityRef,
      });
      expect(current.associations).toHaveLength(1);
      expect(current.associations[0]).toMatchObject({
        associationRef: { resourceId: associationId, tenantId },
        marketDefinitionRevisionRef: definitionRevisionRef,
        marketRef,
        revision: 1,
        storefrontRef,
      });
      expect(current.completenessEvidence).toEqual({
        observedAt: current.observedAt,
        ownerRevision: 'commerce.market-catalog.current:v1:generation:2',
        scope: {
          kind: 'EXACT_PREDICATE',
          predicateRef: `commerce.market-catalog.current:v1:${tenantId}:${fixtureScope.sellingLegalEntityId}:${effectiveAt}`,
        },
      });
    }),
  ),
);
