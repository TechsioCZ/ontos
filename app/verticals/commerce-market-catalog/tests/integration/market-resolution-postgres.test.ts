import type { OperationalScope } from '@app/core-runtime';
import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { EligibleMarketTuplesRequestSchema } from '../../shared/apis/eligible-market-tuples.ts';
import {
  commerceMarketCatalogRelations,
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
  markets,
  storefrontAssociationRevisions,
  storefrontAssociations,
} from '../../src/database/schema.ts';
import { marketResolutionPersistenceForScope } from '../../src/persistence/market-resolution-persistence.ts';

const tenantId = randomUUID();
const unrelatedTenantId = randomUUID();
const sellerId = randomUUID();
const unrelatedSellerId = randomUUID();
const principalId = randomUUID();
const marketId = randomUUID();
const unrelatedMarketId = randomUUID();
const definitionRevisionId = randomUUID();
const unrelatedDefinitionRevisionId = randomUUID();
const lifecyclePeriodId = randomUUID();
const unrelatedLifecyclePeriodId = randomUUID();
const associationId = randomUUID();
const unrelatedAssociationId = randomUUID();
const associationRevisionId = randomUUID();
const futureAssociationRevisionId = randomUUID();
const unrelatedAssociationRevisionId = randomUUID();
const initialActionInvocationId = randomUUID();
const associationActionInvocationId = randomUUID();
const futureAssociationActionInvocationId = randomUUID();
const unrelatedInitialActionInvocationId = randomUUID();
const unrelatedAssociationActionInvocationId = randomUUID();
const storefrontAppId = 'market-resolution-postgres';
const marketStartsAt = new Date('2035-01-01T00:00:00.000Z');
const associationStartsAt = new Date('2035-06-01T00:00:00.000Z');
const futureAssociationStartsAt = new Date('2036-01-01T00:00:00.000Z');

const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:market-resolution-postgres:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'market-resolution-postgres',
};

const requestAt = (effectiveAt: string) =>
  Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
    channel: 'B2C',
    effectiveAt,
    sellingLegalEntityRestriction: {
      moduleId: 'core.identity',
      resourceId: sellerId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    storefrontRef: { appId: storefrontAppId, tenantId },
  });

type MarketCatalogTestDatabase = TestDatabaseFromPool<typeof commerceMarketCatalogRelations>;

const readSnapshot = (runtime: MarketCatalogTestDatabase, effectiveAt: string) =>
  runtime.transaction((transaction) =>
    Effect.gen(function* readEligibilitySnapshot() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', '', true)`,
        'objects',
      );
      const routineInvoker = scopedRoutineInvokerFromTransaction(
        (statement) => transaction.execute<Record<string, never>>(statement, 'objects'),
        scope,
      );
      const persistence = yield* marketResolutionPersistenceForScope(
        // @ts-expect-error The live fixture supplies the public routine invoker but cannot carry Core's private scope brand.
        routineInvoker,
        scope,
      );
      return yield* persistence.load(requestAt(effectiveAt));
    }),
  );

const formatBoundary = (boundary: DateTime.Utc | undefined) =>
  boundary === undefined ? undefined : DateTime.formatIso(boundary);

it.live('returns complete exact-predicate Market eligibility snapshots from PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* marketResolutionPostgres() {
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, commerceMarketCatalogRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, commerceMarketCatalogRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanMarketResolutionFixtures() {
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
                sql.raw(
                  `delete from commerce_market_catalog.${table} where tenant_id in ('${tenantId}'::uuid, '${unrelatedTenantId}'::uuid)`,
                ),
              );
            }
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedMarketResolutionFixtures() {
          yield* transaction.insert(markets).values([
            {
              aggregateRevision: 1,
              businessCode: 'RESOLUTION_MAIN',
              createdAt: marketStartsAt,
              createdByActionInvocationId: initialActionInvocationId,
              createdByPrincipalId: principalId,
              currentDefinitionRevision: 1,
              currentDefinitionRevisionId: definitionRevisionId,
              marketId,
              sellingLegalEntityId: sellerId,
              tenantId,
            },
            {
              aggregateRevision: 1,
              businessCode: 'RESOLUTION_OTHER',
              createdAt: marketStartsAt,
              createdByActionInvocationId: unrelatedInitialActionInvocationId,
              createdByPrincipalId: principalId,
              currentDefinitionRevision: 1,
              currentDefinitionRevisionId: unrelatedDefinitionRevisionId,
              marketId: unrelatedMarketId,
              sellingLegalEntityId: unrelatedSellerId,
              tenantId: unrelatedTenantId,
            },
          ]);
          yield* transaction.insert(marketDefinitionRevisions).values([
            {
              actingPrincipalId: principalId,
              actionInvocationId: initialActionInvocationId,
              changeReason: 'Create the PostgreSQL Market resolution fixture.',
              channels: ['B2C'],
              effectiveFrom: marketStartsAt,
              jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
              marketDefinitionRevisionId: definitionRevisionId,
              marketId,
              purpose: 'Prove authoritative Market resolution.',
              recordedAt: marketStartsAt,
              revisionNumber: 1,
              sellingLegalEntityId: sellerId,
              supportedLocales: ['cs-CZ'],
              tenantId,
            },
            {
              actingPrincipalId: principalId,
              actionInvocationId: unrelatedInitialActionInvocationId,
              changeReason: 'Create an unrelated Tenant fixture.',
              channels: ['B2C'],
              effectiveFrom: marketStartsAt,
              jurisdictions: [{ code: 'SK', kind: 'COUNTRY' }],
              marketDefinitionRevisionId: unrelatedDefinitionRevisionId,
              marketId: unrelatedMarketId,
              purpose: 'Prove Tenant-isolated Market revision evidence.',
              recordedAt: marketStartsAt,
              revisionNumber: 1,
              sellingLegalEntityId: unrelatedSellerId,
              supportedLocales: ['sk-SK'],
              tenantId: unrelatedTenantId,
            },
          ]);
          yield* transaction.insert(marketLifecyclePeriods).values([
            {
              actingPrincipalId: principalId,
              actionInvocationId: initialActionInvocationId,
              effectiveFrom: marketStartsAt,
              lifecycle: 'ACTIVE',
              marketId,
              marketLifecyclePeriodId: lifecyclePeriodId,
              reason: 'Activate the PostgreSQL Market resolution fixture.',
              recordedAt: marketStartsAt,
              revisionNumber: 1,
              sellingLegalEntityId: sellerId,
              tenantId,
            },
            {
              actingPrincipalId: principalId,
              actionInvocationId: unrelatedInitialActionInvocationId,
              effectiveFrom: marketStartsAt,
              lifecycle: 'ACTIVE',
              marketId: unrelatedMarketId,
              marketLifecyclePeriodId: unrelatedLifecyclePeriodId,
              reason: 'Activate the unrelated Tenant fixture.',
              recordedAt: marketStartsAt,
              revisionNumber: 1,
              sellingLegalEntityId: unrelatedSellerId,
              tenantId: unrelatedTenantId,
            },
          ]);
          yield* transaction.insert(storefrontAssociations).values([
            {
              createdAt: marketStartsAt,
              createdByActionInvocationId: associationActionInvocationId,
              createdByPrincipalId: principalId,
              currentRevision: 1,
              sellingLegalEntityId: sellerId,
              storefrontAssociationId: associationId,
              tenantId,
            },
            {
              createdAt: marketStartsAt,
              createdByActionInvocationId: unrelatedAssociationActionInvocationId,
              createdByPrincipalId: principalId,
              currentRevision: 1,
              sellingLegalEntityId: unrelatedSellerId,
              storefrontAssociationId: unrelatedAssociationId,
              tenantId: unrelatedTenantId,
            },
          ]);
          yield* transaction.insert(storefrontAssociationRevisions).values({
            actingPrincipalId: principalId,
            actionInvocationId: associationActionInvocationId,
            channel: 'B2C',
            effectiveFrom: associationStartsAt,
            effectiveTo: futureAssociationStartsAt,
            marketDefinitionRevisionId: definitionRevisionId,
            marketId,
            provenanceKind: 'MANUAL',
            provenanceReference: 'market-resolution-postgres',
            reason: 'Schedule the Storefront association.',
            recordedAt: marketStartsAt,
            revisionNumber: 1,
            sellingLegalEntityId: sellerId,
            storefrontAppId,
            storefrontAssociationId: associationId,
            storefrontAssociationRevisionId: associationRevisionId,
            tenantId,
          });
          yield* transaction.insert(marketCatalogCompletenessGenerations).values({
            generation: 1,
            lastActionInvocationId: associationActionInvocationId,
            tenantId,
            updatedAt: marketStartsAt,
          });
        }),
      );

      const beforeApplicability = yield* readSnapshot(runtime, '2035-05-01T00:00:00.000Z');
      expect(beforeApplicability.facts).toEqual([]);
      expect(beforeApplicability.generation).toBe(1);
      expect(beforeApplicability.completenessEvidence.scope.kind).toBe('EXACT_PREDICATE');
      expect(formatBoundary(beforeApplicability.nextApplicabilityBoundary)).toBe('2035-06-01T00:00:00.000Z');

      const afterApplicability = yield* readSnapshot(runtime, '2035-07-01T00:00:00.000Z');
      expect(afterApplicability.facts).toHaveLength(1);
      expect(afterApplicability.facts[0]).toMatchObject({
        lifecycle: 'ACTIVE',
        tuple: {
          associationRef: { resourceId: associationId, tenantId },
          associationRevision: 1,
          marketDefinitionRevisionRef: { resourceId: definitionRevisionId, tenantId },
          marketRef: { resourceId: marketId, tenantId },
          sellingLegalEntityRef: { resourceId: sellerId, tenantId },
        },
      });
      expect(formatBoundary(afterApplicability.nextApplicabilityBoundary)).toBe('2036-01-01T00:00:00.000Z');

      yield* admin.transaction((transaction) =>
        Effect.gen(function* insertMaterialAssociationRevision() {
          yield* transaction.insert(storefrontAssociationRevisions).values({
            actingPrincipalId: principalId,
            actionInvocationId: futureAssociationActionInvocationId,
            channel: 'B2C',
            effectiveFrom: futureAssociationStartsAt,
            marketDefinitionRevisionId: definitionRevisionId,
            marketId,
            provenanceKind: 'MANUAL',
            provenanceReference: 'market-resolution-postgres-future-revision',
            reason: 'Append the next material association revision.',
            recordedAt: marketStartsAt,
            revisionNumber: 2,
            sellingLegalEntityId: sellerId,
            storefrontAppId,
            storefrontAssociationId: associationId,
            storefrontAssociationRevisionId: futureAssociationRevisionId,
            tenantId,
          });
          yield* transaction
            .update(storefrontAssociations)
            .set({ currentRevision: 2 })
            .where(sql`${storefrontAssociations.storefrontAssociationId} = ${associationId}::uuid`);
        }),
      );

      const afterMaterialInsert = yield* readSnapshot(runtime, '2035-07-01T00:00:00.000Z');
      expect(afterMaterialInsert.facts).toEqual(afterApplicability.facts);
      expect(afterMaterialInsert.generation).toBe(afterApplicability.generation);
      expect(afterMaterialInsert.completenessEvidence.ownerRevision).not.toBe(
        afterApplicability.completenessEvidence.ownerRevision,
      );

      yield* admin.insert(storefrontAssociationRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: unrelatedAssociationActionInvocationId,
        channel: 'B2C',
        effectiveFrom: associationStartsAt,
        marketDefinitionRevisionId: unrelatedDefinitionRevisionId,
        marketId: unrelatedMarketId,
        provenanceKind: 'MANUAL',
        provenanceReference: 'unrelated-tenant-market-resolution-postgres',
        reason: 'Insert an unrelated Tenant association.',
        recordedAt: marketStartsAt,
        revisionNumber: 1,
        sellingLegalEntityId: unrelatedSellerId,
        storefrontAppId,
        storefrontAssociationId: unrelatedAssociationId,
        storefrontAssociationRevisionId: unrelatedAssociationRevisionId,
        tenantId: unrelatedTenantId,
      });

      const afterUnrelatedTenantInsert = yield* readSnapshot(runtime, '2035-07-01T00:00:00.000Z');
      expect(afterUnrelatedTenantInsert.facts).toEqual(afterMaterialInsert.facts);
      expect(afterUnrelatedTenantInsert.completenessEvidence.scope).toEqual(
        afterMaterialInsert.completenessEvidence.scope,
      );
      expect(afterUnrelatedTenantInsert.completenessEvidence.ownerRevision).toBe(
        afterMaterialInsert.completenessEvidence.ownerRevision,
      );
    }),
  ),
);
