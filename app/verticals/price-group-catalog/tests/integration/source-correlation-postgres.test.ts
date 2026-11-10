import { randomUUID } from 'node:crypto';
import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { PriceGroupIdempotencyReuseConflict, PriceGroupNotFound } from '../../shared/domain/price-group-errors.ts';
import { priceGroupCatalogRelations } from '../../src/database/schema.ts';
import { priceGroupCatalogPersistenceFromRoutineInvoker } from '../../src/persistence/price-group-catalog-persistence.ts';
import { priceGroupSourcePersistenceForScope } from '../../src/persistence/price-group-source-persistence.ts';

/** INTERNAL fixture. These identities and meanings are not a verified external producer contract. */
it.live('atomically correlates source groups, isolates issuers, pages and recovers the original native operation', () =>
  Effect.scoped(
    Effect.gen(function* sourceCorrelationConformance() {
      const tenantId = randomUUID();
      const otherTenantId = randomUUID();
      const principalId = randomUUID();
      const actionInvocationId = randomUUID();
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, priceGroupCatalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, priceGroupCatalogRelations);
      const scope = {
        authMethod: 'system' as const,
        correlationId: 'internal-c14-group-conformance',
        principalId,
        tenantId,
      };
      const sourceCorrelation = {
        issuer: 'internal-fixture-issuer-a',
        mappingVersion: '1',
        namespace: 'group-priced-lists',
        recordKey: 'opaque/list/a',
        routeId: 'internal-c14-price-groups-v1',
      };
      const request = {
        issuer: sourceCorrelation.issuer,
        limit: 1,
        namespace: sourceCorrelation.namespace,
        offset: 0,
        routeId: sourceCorrelation.routeId,
      };
      const input = {
        actingPrincipalId: principalId,
        actionInvocationId,
        businessCode: 'INTERNAL_C14_A',
        classificationPurpose: 'Internal C14 contract fixture for dealer price classification A.',
        compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
        description: 'Explicit internal fixture description; contains no identity encoding.',
        displayName: 'Internal C14 group A',
        effectiveFrom: new Date('2026-11-07T09:00:00.000Z'),
        expectedCatalogRevision: 0,
        reason: 'Internal C14 source correlation conformance.',
        sourceCorrelation: { ...sourceCorrelation, sourceOccurrenceId: 'internal-c14-create-occurrence' },
        trustedEffectiveAt: new Date('2026-11-07T09:00:00.000Z'),
      };
      const inScope = <A, E>(
        operation: (
          invoker: ReturnType<typeof scopedRoutineInvokerFromTransaction>,
          selectedScope: typeof scope,
        ) => Effect.Effect<A, E>,
        selectedScope = scope,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* ownerTransaction() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${selectedScope.tenantId}, true)`,
              'objects',
            );
            const invoker = scopedRoutineInvokerFromTransaction(
              // oxlint-disable-next-line sonarjs/no-nested-functions -- This test adapter retains its transaction-scoped executor; remove-when: Core exposes a bound native invoker.
              (statement) => transaction.execute(statement, 'objects'),
              selectedScope,
            );
            return yield* operation(invoker, selectedScope);
          }),
        );
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanupFixture() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_source_operation_receipts where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_source_correlations where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_containment_projection_intents where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_compatibility_support where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_definition_effective_intervals where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_definition_revisions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_groups where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_catalog_ledger where tenant_id = ${tenantId}::uuid`,
            );
          }),
        );
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      const [created, replayed] = yield* Effect.all(
        [
          inScope((invoker) => priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup(input)),
          inScope((invoker) => priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup(input)),
        ],
        { concurrency: 2 },
      );
      expect(replayed).toEqual(created);
      const groupRef = created.businessResult.identity.priceGroupRef;
      const original = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.recover({ actionInvocationId }),
        ),
      );
      expect(original).toMatchObject({
        outcome: 'PRICE_GROUP_OPERATION_FOUND',
        receipt: {
          actionInvocationId,
          catalogRevision: 1,
          operationKind: 'CREATE_PRICE_GROUP',
          priceGroupRef: groupRef,
        },
      });
      const originalWriterReceipt = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.recover({ actionInvocationId }, principalId),
        ),
      );
      expect(originalWriterReceipt).toEqual(original);
      const wrongWriterReceipt = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.recover({ actionInvocationId }, randomUUID()),
        ),
      );
      expect(wrongWriterReceipt).toEqual({ actionInvocationId, outcome: 'PRICE_GROUP_OPERATION_ABSENT' });
      const collision = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
            ...input,
            actionInvocationId: randomUUID(),
            businessCode: 'INTERNAL_C14_COLLISION',
            classificationPurpose: 'Distinct internal collision fixture meaning.',
            expectedCatalogRevision: 1,
            sourceCorrelation: {
              ...input.sourceCorrelation,
              sourceOccurrenceId: 'internal-c14-new-colliding-occurrence',
            },
          }),
        ),
      );
      expect(Schema.is(PriceGroupIdempotencyReuseConflict)(collision)).toBe(true);
      const second = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
          ...input,
          actionInvocationId: randomUUID(),
          businessCode: 'INTERNAL_C14_B',
          classificationPurpose: 'Internal C14 contract fixture for dealer price classification B.',
          expectedCatalogRevision: 1,
          sourceCorrelation: { ...sourceCorrelation, recordKey: 'opaque/list/b' },
        }),
      );
      expect(second.businessResult.initialDefinition.acceptedCatalogRevision).toBe(2);
      const otherIssuer = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
          ...input,
          actionInvocationId: randomUUID(),
          businessCode: 'INTERNAL_C14_ISSUER_B',
          classificationPurpose: 'Internal C14 contract fixture for separately asserted issuer B classification.',
          expectedCatalogRevision: 2,
          sourceCorrelation: { ...sourceCorrelation, issuer: 'internal-fixture-issuer-b' },
        }),
      );
      expect(otherIssuer.businessResult.identity.priceGroupRef).not.toEqual(groupRef);
      const firstPage = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) => service.list(request)),
      );
      const secondPage = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.list({ ...request, offset: 1 }),
        ),
      );
      const exact = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.list({ ...request, recordKey: sourceCorrelation.recordKey }),
        ),
      );
      const empty = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.list({ ...request, offset: 99 }),
        ),
      );
      expect(firstPage).toMatchObject({
        associations: [{ priceGroupRef: groupRef, sourceCorrelation }],
        count: 2,
        limit: 1,
        offset: 0,
      });
      expect(secondPage.associations[0]?.priceGroupRef).toEqual(second.businessResult.identity.priceGroupRef);
      expect(exact.count).toBe(1);
      expect(empty).toMatchObject({ associations: [], count: 2, offset: 99 });
      const otherTenant = yield* inScope(
        (invoker, selected) =>
          Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) => service.list(request)),
        { ...scope, tenantId: otherTenantId },
      );
      expect(otherTenant).toMatchObject({ associations: [], count: 0 });
      const absent = yield* inScope(
        (invoker, selected) =>
          Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
            service.recover({ actionInvocationId }),
          ),
        { ...scope, tenantId: otherTenantId },
      );
      expect(absent).toEqual({ actionInvocationId, outcome: 'PRICE_GROUP_OPERATION_ABSENT' });
      const definition = created.businessResult.initialDefinition;
      const revisionOccurrence = {
        ...sourceCorrelation,
        mappingVersion: '2',
        sourceOccurrenceId: 'internal-c14-definition-revision-occurrence',
      };
      const revisionInvocationId = randomUUID();
      const revisionInput = {
        ...input,
        actionInvocationId: revisionInvocationId,
        description: 'Revised internal fixture description.',
        effectiveFrom: new Date('2026-11-07T10:00:00.000Z'),
        expectedCurrent: {
          catalogRevision: 1,
          definitionRevisionId: definition.definitionRevisionId,
          definitionRevisionNumber: definition.revisionNumber,
          meaningFingerprint: definition.meaningFingerprint,
          priceGroupRef: groupRef,
        },
        semanticDecision: {
          comparedDefinitionRevisionId: definition.definitionRevisionId,
          decision: 'SAME_MEANING' as const,
        },
        sourceCorrelation: revisionOccurrence,
        trustedEffectiveAt: new Date('2026-11-07T10:00:00.000Z'),
      };
      const unrelatedSource = {
        ...revisionOccurrence,
        issuer: 'internal-fixture-issuer-b',
        recordKey: 'opaque/list/unbound',
      };
      const unboundRevisionInvocationId = randomUUID();
      const unboundRevisionDenied = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
          ...revisionInput,
          actionInvocationId: unboundRevisionInvocationId,
          sourceCorrelation: unrelatedSource,
        }),
      ).pipe(Effect.match({ onFailure: Schema.is(PriceGroupNotFound), onSuccess: () => false }));
      expect(unboundRevisionDenied).toBe(true);
      const mismatchedRevisionDenied = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
          ...revisionInput,
          actionInvocationId: randomUUID(),
          sourceCorrelation: { ...sourceCorrelation, issuer: unrelatedSource.issuer },
        }),
      ).pipe(Effect.match({ onFailure: Schema.is(PriceGroupNotFound), onSuccess: () => false }));
      expect(mismatchedRevisionDenied).toBe(true);
      const unrelatedAssociations = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.list({ ...request, issuer: unrelatedSource.issuer, recordKey: unrelatedSource.recordKey }),
        ),
      );
      expect(unrelatedAssociations.associations).toEqual([]);
      const unboundReceipt = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.recover({ actionInvocationId: unboundRevisionInvocationId }, principalId),
        ),
      );
      expect(unboundReceipt).toEqual({
        actionInvocationId: unboundRevisionInvocationId,
        outcome: 'PRICE_GROUP_OPERATION_ABSENT',
      });
      const revised = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision(revisionInput),
      );
      expect(revised.priceGroupRef).toEqual(groupRef);
      const replayedRevisionInvocationId = randomUUID();
      const replayedRevision = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
          ...revisionInput,
          actionInvocationId: replayedRevisionInvocationId,
          trustedEffectiveAt: new Date('2026-11-07T11:00:00.000Z'),
        }),
      );
      expect(replayedRevision.businessOriginalInvocationId).toBe(revisionInvocationId);
      expect(replayedRevision.definitionRevisionId).toBe(revised.definitionRevisionId);
      const replayedRevisionReceipt = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.recover({ actionInvocationId: replayedRevisionInvocationId }, principalId),
        ),
      );
      expect(replayedRevisionReceipt).toMatchObject({
        outcome: 'PRICE_GROUP_OPERATION_FOUND',
        receipt: {
          actionInvocationId: replayedRevisionInvocationId,
          businessOriginalInvocationId: revisionInvocationId,
          definitionRevisionId: revised.definitionRevisionId,
          operationKind: 'CREATE_DEFINITION_REVISION',
        },
      });

      const revisedAssociation = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.list({ ...request, recordKey: sourceCorrelation.recordKey }),
        ),
      );
      expect(revisedAssociation.associations[0]?.sourceCorrelation.mappingVersion).toBe('2');
      const replayedOriginal = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
          ...input,
          actionInvocationId: randomUUID(),
          trustedEffectiveAt: new Date('2026-11-07T12:00:00.000Z'),
        }),
      );
      expect(replayedOriginal.businessResult.businessOriginalInvocationId).toBe(actionInvocationId);
      const mappingAfterHistoricalReplay = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.list({ ...request, recordKey: sourceCorrelation.recordKey }),
        ),
      );
      expect(mappingAfterHistoricalReplay.associations[0]?.sourceCorrelation.mappingVersion).toBe('2');

      const recoveredAgain = yield* inScope((invoker, selected) =>
        Effect.flatMap(priceGroupSourcePersistenceForScope(invoker, selected), (service) =>
          service.recover({ actionInvocationId }),
        ),
      );
      expect(recoveredAgain).toEqual(original);
    }),
  ),
);
