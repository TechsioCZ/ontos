import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { CurrentMarketCatalogRequestSchema } from '../../shared/apis/current-market-catalog.ts';
import { marketCatalogReadPersistenceForScope } from '../../src/persistence/market-catalog-read-persistence.ts';

const tenantId = 'e3470000-0000-4000-8000-000000000001';
const sellerId = 'e3470000-0000-4000-8000-000000000003';
const principalId = 'e3470000-0000-4000-8000-000000000004';
const marketId = 'e3471000-0000-4000-8000-000000000001';
const associationId = 'e3472000-0000-4000-8000-000000000001';

type MarketCatalogTestDatabase = TestDatabaseFromPool<typeof coreRelations>;
type MarketCatalogTransaction = Parameters<Parameters<MarketCatalogTestDatabase['transaction']>[0]>[0];

const OutcomeRowSchema = Schema.Struct({ payload: Schema.Record(Schema.String, Schema.Unknown) });
const oneOutcome = (rows: readonly unknown[]) => Schema.decodeUnknownSync(OutcomeRowSchema)(rows[0]).payload;

const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e3470000-0000-4000-8000-000000000005',
    authContextRef: 'session:market-catalog-owner-reads-postgres',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId,
    tenantId,
  }),
  correlationId: 'market-catalog-owner-reads-postgres',
};

const scoped = <Value, Failure>(
  database: MarketCatalogTestDatabase,
  operation: (transaction: MarketCatalogTransaction) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedOperation() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${sellerId}, true)`,
        'objects',
      );
      return yield* operation(transaction);
    }),
  );

const command = (actionInvocationId: string) => ({
  actionInvocationId,
  principalId,
  recordedAt: '2035-01-01T00:00:00.000Z',
});

const reference = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.market-catalog',
  resourceId,
  resourceType,
  tenantId,
});

const marketRef = reference(marketId, 'commerce.market-catalog.market');
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
};
const storefrontRef = { appId: 'czech-storefront', tenantId };

const currentAt = (database: MarketCatalogTestDatabase, at: string) =>
  scoped(database, (transaction) =>
    Effect.gen(function* readCurrentCatalog() {
      const ownerTransaction = yield* installOperationalScope(transaction, scope);
      const persistence = yield* marketCatalogReadPersistenceForScope(ownerTransaction, scope);
      const input = Schema.decodeUnknownSync(CurrentMarketCatalogRequestSchema)({ at });
      return yield* persistence.current(input);
    }),
  );

it.live('reads scheduled Current state and immutable retained history through runtime PostgreSQL RLS', () =>
  Effect.scoped(
    Effect.gen(function* ownerReadAcceptance() {
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, coreRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, coreRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanOwnerReadFixtures() {
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

      const created = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.create_market(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3473000-0000-4000-8000-000000000001'),
                channels: ['B2C'],
                effectivePeriod: { startsAt: '2035-02-01T00:00:00.000Z' },
                jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
                lifecycle: 'ACTIVE',
                marketCode: 'CZ_SCHEDULED',
                marketId,
                purpose: 'Scheduled Czech commerce.',
                reason: 'Create a scheduled Market for owner-read acceptance.',
                sellingLegalEntityRef: sellerRef,
                supportedLocales: ['cs-CZ'],
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expect(Predicate.isTagged(created, 'created')).toBe(true);
      expect(created).toMatchObject({ generation: 1, revision: 1 });
      const definitionRevisionOneId = Schema.decodeUnknownSync(Schema.String)(created.definitionRevisionId);

      const associated = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.associate_storefront(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3473000-0000-4000-8000-000000000002'),
                associationId,
                channel: 'B2C',
                effectivePeriod: { startsAt: '2035-02-01T00:00:00.000Z' },
                expectedMarketDefinitionRevisionRef: reference(
                  definitionRevisionOneId,
                  'commerce.market-catalog.market-definition-revision',
                ),
                marketRef,
                provenance: { kind: 'CONFIGURATION_ACTION', reference: 'acceptance:scheduled:v1' },
                reason: 'Associate the scheduled Czech Storefront.',
                sellingLegalEntityRef: sellerRef,
                storefrontRef,
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expect(Predicate.isTagged(associated, 'associated')).toBe(true);
      expect(associated).toMatchObject({ generation: 2, revision: 1 });

      const revisedDefinition = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.revise_market_definition(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3473000-0000-4000-8000-000000000003'),
                channels: ['B2C', 'B2B'],
                effectivePeriod: { startsAt: '2035-03-01T00:00:00.000Z' },
                expectedCurrentDefinitionRevisionRef: reference(
                  definitionRevisionOneId,
                  'commerce.market-catalog.market-definition-revision',
                ),
                expectedRevision: 1,
                jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
                marketRef,
                purpose: 'Scheduled Czech retail and business commerce.',
                reason: 'Add the approved B2B channel.',
                supportedLocales: ['cs-CZ', 'en-CZ'],
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expect(Predicate.isTagged(revisedDefinition, 'revised')).toBe(true);
      expect(revisedDefinition).toMatchObject({ generation: 3, revision: 2 });
      const definitionRevisionTwoId = Schema.decodeUnknownSync(Schema.String)(revisedDefinition.definitionRevisionId);

      const revisedAssociation = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.revise_storefront_association(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3473000-0000-4000-8000-000000000004'),
                associationRef: reference(associationId, 'commerce.market-catalog.storefront-association'),
                channel: 'B2B',
                effectivePeriod: { startsAt: '2035-03-01T00:00:00.000Z' },
                expectedRevision: 1,
                marketRef,
                provenance: { kind: 'CONFIGURATION_ACTION', reference: 'acceptance:scheduled:v2' },
                reason: 'Use the revised Market definition and channel.',
                storefrontRef,
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expect(Predicate.isTagged(revisedAssociation, 'revised')).toBe(true);
      expect(revisedAssociation).toMatchObject({
        generation: 4,
        previousRevision: 1,
        revision: 2,
      });

      const beforeBoundary = yield* currentAt(runtime, '2035-01-31T23:59:59.999Z');
      expect(beforeBoundary.markets).toEqual([]);
      expect(beforeBoundary.associations).toEqual([]);

      const afterBoundary = yield* currentAt(runtime, '2035-04-01T00:00:00.000Z');
      expect(afterBoundary.markets).toHaveLength(1);
      expect(afterBoundary.markets[0]).toMatchObject({
        definitionRevisionRef: { resourceId: definitionRevisionTwoId },
        lifecycle: 'ACTIVE',
        previousDefinitionRevisionRef: { resourceId: definitionRevisionOneId },
        revision: 2,
      });
      expect(afterBoundary.associations).toHaveLength(1);
      expect(afterBoundary.associations[0]).toMatchObject({
        channel: 'B2B',
        marketDefinitionRevisionRef: { resourceId: definitionRevisionTwoId },
        previousAssociationRevision: 1,
        revision: 2,
      });
      expect(afterBoundary.completenessEvidence).toMatchObject({
        ownerRevision: 'commerce.market-catalog.current:v1:generation:4',
        scope: { kind: 'EXACT_PREDICATE' },
      });
      expect(afterBoundary.completenessEvidence.scope.predicateRef).toBe(
        `commerce.market-catalog.current:v1:${tenantId}:${sellerId}:2035-04-01T00:00:00.000Z`,
      );

      const historyBeforeRetirement = yield* scoped(runtime, (transaction) =>
        Effect.gen(function* readHistory() {
          const ownerTransaction = yield* installOperationalScope(transaction, scope);
          const persistence = yield* marketCatalogReadPersistenceForScope(ownerTransaction, scope);
          return yield* persistence.history(marketId);
        }),
      );
      expect(Option.isSome(historyBeforeRetirement)).toBe(true);
      if (Option.isNone(historyBeforeRetirement)) {
        return;
      }
      expect(historyBeforeRetirement.value.definitions.map(({ revision }) => revision)).toEqual([1, 2]);
      expect(historyBeforeRetirement.value.associations.map(({ revision }) => revision)).toEqual([1, 2]);

      const retired = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.transition_market_lifecycle(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3473000-0000-4000-8000-000000000005'),
                effectiveAt: '2035-05-01T00:00:00.000Z',
                expectedCurrentDefinitionRevisionId: definitionRevisionTwoId,
                expectedRevision: 2,
                lifecycle: 'RETIRED',
                marketId,
                reason: 'Retire after the scheduled acceptance window.',
                retirementImpactAssessment: {
                  assessedMarketRef: marketRef,
                  assessedMarketRevision: 2,
                  assessmentDigest: 'a'.repeat(64),
                  effectiveAt: '2035-05-01T00:00:00.000Z',
                  providers: [
                    {
                      completenessEvidenceReference: 'acceptance:completeness:1',
                      currentnessEvidenceReference: 'acceptance:currentness:1',
                      effectiveAt: '2035-05-01T00:00:00.000Z',
                      liveBlockingReferences: { count: 0, evidenceReference: 'acceptance:live:0' },
                      observedAt: '2035-04-30T23:59:59.000Z',
                      ownerModuleKey: 'commerce.customer-context',
                      ownerRevision: 'acceptance:customer-context:1',
                      retainedHistoryEvidence: { count: 2, evidenceReference: 'acceptance:history:2' },
                      versionToken: 'acceptance:customer-context:version:1',
                    },
                  ],
                  requiredProviderModuleKeys: ['commerce.customer-context'],
                  reservation: {
                    token: 'e3474000-0000-4000-8000-000000000001',
                    version: 1,
                  },
                },
                tenantId,
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expect(Predicate.isTagged(retired, 'transitioned')).toBe(true);
      expect(retired).toMatchObject({ generation: 5, lifecycle: 'RETIRED', revision: 3 });

      const afterRetirement = yield* currentAt(runtime, '2035-06-01T00:00:00.000Z');
      expect(afterRetirement.markets[0]).toMatchObject({ lifecycle: 'RETIRED', revision: 2 });
      expect(afterRetirement.completenessEvidence.ownerRevision).toBe(
        'commerce.market-catalog.current:v1:generation:5',
      );

      yield* Effect.flip(
        admin.execute(sql`update commerce_market_catalog.market_definition_revisions
                          set purpose = 'Mutated history' where tenant_id = ${tenantId}::uuid`),
      );
      yield* Effect.flip(
        admin.execute(sql`update commerce_market_catalog.storefront_association_revisions
                          set reason = 'Mutated history' where tenant_id = ${tenantId}::uuid`),
      );

      const retainedHistory = yield* scoped(runtime, (transaction) =>
        Effect.gen(function* readRetainedHistory() {
          const ownerTransaction = yield* installOperationalScope(transaction, scope);
          const persistence = yield* marketCatalogReadPersistenceForScope(ownerTransaction, scope);
          return yield* persistence.history(marketId);
        }),
      );
      expect(Option.isSome(retainedHistory)).toBe(true);
      if (Option.isSome(retainedHistory)) {
        expect(retainedHistory.value.definitions.map(({ revision }) => revision)).toEqual([1, 2]);
        expect(retainedHistory.value.associations.map(({ revision }) => revision)).toEqual([1, 2]);
        expect(retainedHistory.value.definitions[1]).toMatchObject({
          lifecycle: 'ACTIVE',
          previousDefinitionRevisionRef: { resourceId: definitionRevisionOneId },
        });
      }
    }),
  ),
);
