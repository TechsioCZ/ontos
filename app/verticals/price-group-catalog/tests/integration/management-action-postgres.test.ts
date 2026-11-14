import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import {
  ActionAlreadyCommitted,
  ActionRequestHashConflict,
  getActionAccessTargetResolver,
  scopedRoutineInvokerFromTransaction,
} from '@app/core-runtime';
import { Crypto, DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  accessScopeFences,
  actionInvocations,
  accessScopes,
  coreRelations,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import {
  prepareCreatePriceGroupOriginalRequestIdentity,
  prepareCreatePriceGroupDefinitionRevisionOriginalRequestIdentity,
} from '../../shared/source-request-identity.ts';
import { createPriceGroupDefinitionRevisionAction } from '../../src/actions/create-price-group-definition-revision.action.ts';
import { createPriceGroupAction } from '../../src/actions/create-price-group.action.ts';
import { priceGroupSourcePersistenceForScope } from '../../src/persistence/price-group-source-persistence.ts';
import { PriceGroupIdempotencyReuseConflict, PriceGroupCodeConflict } from '../../shared/domain/price-group-errors.ts';
import { retirePriceGroupAction } from '../../src/actions/retire-price-group.action.ts';
import { priceGroupCatalogRegistration } from '../../vertical.registration.ts';
import {
  priceGroupCatalogLedger,
  priceGroupCatalogRelations,
  priceGroupCompatibilitySupport,
  priceGroupContainmentProjectionIntents,
  priceGroupDefinitionEffectiveIntervals,
  priceGroupDefinitionRevisions,
  priceGroupRetirements,
  priceGroupSourceCorrelations,
  priceGroupSourceOperationReceipts,
  priceGroups,
} from '../../src/database/schema.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

const tenantId = randomUUID();
const accessScopeId = randomUUID();
const principalId = randomUUID();
const authBindingId = randomUUID();
const authenticationNamespaceId = 'test.price-group-management-action.v1';
const principal = {
  authBindingId,
  authContextRef: `better-auth-session:${authBindingId}`,
  authenticationNamespaceId,
  authMethod: 'session' as const,
  principalId,
  tenantId,
};

interface DatabaseClockRow extends Record<string, unknown> {
  readonly currentTime: Date;
}

type NativeTransaction = Parameters<Parameters<TestDatabaseFromClient<typeof coreRelations>['transaction']>[0]>[0];
const executeNativeRoutine = (transaction: NativeTransaction, statement: SQL) =>
  transaction.execute(statement, 'objects');

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const contextAccess: ContextAccessService = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  ownerPermissions: (input) =>
    Effect.succeed(
      input.targets.map((target) => ({
        decision: 'allowed' as const,
        key: target.target.key,
      })),
    ),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

it.live('commits a scheduled retirement with server-trusted acceptance chronology through the Action runtime', () =>
  Effect.scoped(
    Effect.gen(function* scheduledRetirementAction() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, priceGroupCatalogRelations);
      const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanupTenant() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            const messages = yield* transaction
              .select({ messageId: outboxMessages.outboxMessageId })
              .from(outboxMessages)
              .where(
                and(
                  eq(outboxMessages.tenantId, tenantId),
                  eq(outboxMessages.producerModuleKey, 'pricing.price-group-catalog'),
                ),
              );
            const messageIds: string[] = [];
            for (const { messageId } of messages) {
              messageIds.push(messageId);
            }
            const deliveries = yield* transaction
              .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
              .from(outboxDeliveries)
              .where(inArray(outboxDeliveries.outboxMessageId, messageIds));
            const deliveryIds: string[] = [];
            for (const { deliveryId } of deliveries) {
              deliveryIds.push(deliveryId);
            }
            yield* transaction.delete(outboxAttempts).where(inArray(outboxAttempts.outboxDeliveryId, deliveryIds));
            yield* transaction.delete(outboxDeliveries).where(inArray(outboxDeliveries.outboxMessageId, messageIds));
            yield* transaction
              .delete(outboxMessages)
              .where(
                and(
                  eq(outboxMessages.tenantId, tenantId),
                  eq(outboxMessages.producerModuleKey, 'pricing.price-group-catalog'),
                  inArray(outboxMessages.outboxMessageId, messageIds),
                ),
              );
            yield* transaction
              .delete(priceGroupSourceOperationReceipts)
              .where(eq(priceGroupSourceOperationReceipts.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupSourceCorrelations)
              .where(eq(priceGroupSourceCorrelations.tenantId, tenantId));
            yield* transaction.delete(priceGroupRetirements).where(eq(priceGroupRetirements.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupCompatibilitySupport)
              .where(eq(priceGroupCompatibilitySupport.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupContainmentProjectionIntents)
              .where(eq(priceGroupContainmentProjectionIntents.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupDefinitionEffectiveIntervals)
              .where(eq(priceGroupDefinitionEffectiveIntervals.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupDefinitionRevisions)
              .where(eq(priceGroupDefinitionRevisions.tenantId, tenantId));
            yield* transaction.delete(priceGroups).where(eq(priceGroups.tenantId, tenantId));
            yield* transaction.delete(priceGroupCatalogLedger).where(eq(priceGroupCatalogLedger.tenantId, tenantId));
            yield* transaction.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
            yield* transaction.delete(principals).where(eq(principals.tenantId, tenantId));
            yield* transaction.delete(accessScopeFences).where(eq(accessScopeFences.tenantId, tenantId));
            yield* transaction.delete(accessScopes).where(eq(accessScopes.tenantId, tenantId));
            yield* transaction.delete(tenants).where(eq(tenants.tenantId, tenantId));
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* admin.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Scheduled retirement Action integration',
        slug: `scheduled-retirement-${tenantId}`,
        status: 'active',
        tenantId,
      });
      // The runner re-decides the Action under the tenant context scope's shared fence, so seed the
      // scope with a Ready fence as Core bootstrap does.
      yield* admin.insert(accessScopes).values({ scopeId: accessScopeId, tenantContextId: tenantId, tenantId });
      yield* admin.insert(accessScopeFences).values({ revision: 1, scopeId: accessScopeId, state: 'Ready', tenantId });
      yield* admin.insert(principals).values({
        displayName: 'Scheduled retirement operator',
        kind: 'human',
        principalId,
        status: 'active',
        tenantId,
      });
      yield* admin.insert(principalAuthBindings).values({
        authenticationNamespaceId,
        principalAuthBindingId: authBindingId,
        principalId,
        provider: 'better_auth',
        providerSubjectId: `scheduled-retirement-${principalId}`,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });

      const runtime = makeActionRuntime(
        { executor: database },
        makeActionRepository(yield* Crypto.Crypto),
        allowedPermission,
        testOperationalScopeResolver,
        {
          ...openActionRuntimeOptions,
          accessDecision: makeScriptedBoundAccessGate('allowed').bound,
          contextAccess,
          databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,

          ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
          ownerRegistration: priceGroupCatalogRegistration,
        },
      );
      const [clock] = yield* admin.execute<DatabaseClockRow>(sql`select clock_timestamp() as "currentTime"`, 'objects');
      if (clock === undefined) {
        throw new Error('Expected the database clock');
      }
      const now = DateTime.fromDateUnsafe(clock.currentTime);
      const effectiveFrom = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
      const retirementEffectiveAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const createRequest = {
        payload: {
          businessCode: 'SCHEDULED_RETIREMENT',
          classificationPurpose: 'Proves scheduled Price Group retirement chronology.',
          compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
          description: 'Price Group created for the scheduled retirement Action regression.',
          displayName: 'Scheduled retirement',
          effectiveFrom,
          effectiveTo: null,
          expectedCatalogRevision: 0,
          reason: 'Create the Price Group used by the scheduled retirement proof.',
          sourceCorrelation: {
            issuer: 'internal-c14-core-recovery',
            mappingVersion: '1',
            namespace: 'group-priced-lists',
            recordKey: 'internal-scheduled-retirement',
            routeId: 'internal-c14-owner-recovery-v1',
            sourceOccurrenceId: 'internal-c14-explicit-create-occurrence',
          },
        },
        principal,
        registration: createPriceGroupAction,
        transport: {
          correlationId: 'scheduled-retirement-create',
          idempotencyKey: 'scheduled-retirement-create',
          targetModuleKey: 'pricing.price-group-catalog',
          targetResourceId: 'a1400000-0000-4000-8000-000000000099',
          targetResourceType: 'source-list-hint',
        },
      };
      // INTERNAL C14 response-loss proof: the first native result is deliberately unobserved by the
      // recovering caller. Its saved original request and key resolve the same immutable invocation.
      const created = yield* runtime.runAction(createRequest);
      const originalInvocationId = created.initialDefinition.created.actionInvocationId;
      const recoveries = yield* Effect.all(
        [runtime.runAction(createRequest).pipe(Effect.flip), runtime.runAction(createRequest).pipe(Effect.flip)],
        { concurrency: 2 },
      );
      for (const recovery of recoveries) {
        expect(Schema.is(ActionAlreadyCommitted)(recovery)).toBe(true);
        expect(recovery).toMatchObject({ invocationId: originalInvocationId });
      }
      const intentMismatch = yield* runtime
        .runAction({
          ...createRequest,
          payload: { ...createRequest.payload, description: 'Changed mapping intent must not replace the original.' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(ActionRequestHashConflict)(intentMismatch)).toBe(true);
      const originalInvocations = yield* admin
        .select()
        .from(actionInvocations)
        .where(
          and(
            eq(actionInvocations.tenantId, tenantId),
            eq(actionInvocations.actionKey, 'pricing.price-group-catalog.create-price-group'),
            eq(actionInvocations.idempotencyKey, createRequest.transport.idempotencyKey),
          ),
        );
      expect(originalInvocations).toHaveLength(1);
      expect(originalInvocations[0]?.actionInvocationId).toBe(originalInvocationId);
      const originalIdentity = yield* prepareCreatePriceGroupOriginalRequestIdentity(createRequest.payload, {
        principalId,
        tenantId,
      });
      expect(getActionAccessTargetResolver(createPriceGroupAction)).toBeUndefined();
      expect(originalIdentity.target).toEqual({});
      expect(originalIdentity.actionKey).toBe(createPriceGroupAction.descriptor.actionKey);
      expect(originalIdentity.schemaVersion).toBe(createPriceGroupAction.descriptor.schemaVersion);
      expect(originalIdentity.requestHash).toBe(originalInvocations[0]?.requestHash);
      expect(originalInvocations[0]?.targetResourceId).toBeNull();

      const ownerEffects = yield* admin
        .select()
        .from(priceGroupCatalogLedger)
        .where(
          and(
            eq(priceGroupCatalogLedger.tenantId, tenantId),
            eq(priceGroupCatalogLedger.actionInvocationId, originalInvocationId),
          ),
        );
      expect(ownerEffects).toHaveLength(1);
      // A fresh Core invocation is a distinct delivery of this explicit source occurrence.
      // Its immutable receipt links the earlier native business acceptance without a second effect.
      const duplicatePrincipalId = randomUUID();
      const duplicateAuthBindingId = randomUUID();
      yield* admin.insert(principals).values({
        displayName: 'Independent source delivery writer',
        kind: 'human',
        principalId: duplicatePrincipalId,
        status: 'active',
        tenantId,
      });
      yield* admin.insert(principalAuthBindings).values({
        authenticationNamespaceId,
        principalAuthBindingId: duplicateAuthBindingId,
        principalId: duplicatePrincipalId,
        provider: 'better_auth',
        providerSubjectId: `c14-source-writer-${duplicatePrincipalId}`,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });
      const duplicatePrincipal = {
        ...principal,
        authBindingId: duplicateAuthBindingId,
        authContextRef: `better-auth-session:${duplicateAuthBindingId}`,
        principalId: duplicatePrincipalId,
      };
      const duplicateRequest = {
        ...createRequest,
        principal: duplicatePrincipal,
        transport: { ...createRequest.transport, idempotencyKey: 'internal-c14-new-job-same-occurrence' },
      };
      const duplicate = yield* runtime.runAction(duplicateRequest);
      expect(duplicate.businessOriginalInvocationId).toBe(originalInvocationId);
      expect(duplicate.acceptance).toEqual(created.acceptance);
      const duplicateCore = yield* admin
        .select()
        .from(actionInvocations)
        .where(
          and(
            eq(actionInvocations.tenantId, tenantId),
            eq(actionInvocations.idempotencyKey, duplicateRequest.transport.idempotencyKey),
          ),
        );
      const [duplicateInvocation] = duplicateCore;
      expect(duplicateCore).toHaveLength(1);
      if (duplicateInvocation === undefined) {
        throw new Error('Expected actual second Core invocation');
      }
      expect(duplicateInvocation.actionInvocationId).not.toBe(originalInvocationId);
      expect(duplicateInvocation.status).toBe('succeeded');
      const lostAck = yield* runtime.runAction(duplicateRequest).pipe(Effect.flip);
      expect(lostAck).toMatchObject({ invocationId: duplicateInvocation.actionInvocationId });
      expect(Schema.is(ActionAlreadyCommitted)(lostAck)).toBe(true);
      const readDeliveryReceipt = (writer: string) =>
        database.transaction((transaction) =>
          Effect.gen(function* readImmutableDelivery() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`);
            const invoker = scopedRoutineInvokerFromTransaction(executeNativeRoutine.bind(undefined, transaction), {
              tenantId,
            });
            const persistence = yield* priceGroupSourcePersistenceForScope(invoker, {
              ...principal,
              correlationId: 'internal-c14-read-original-receipt',
            });
            return yield* persistence.recover({ actionInvocationId: duplicateInvocation.actionInvocationId }, writer);
          }),
        );
      const duplicateReceipt = yield* readDeliveryReceipt(duplicatePrincipalId);
      expect(duplicateReceipt).toMatchObject({
        outcome: 'PRICE_GROUP_OPERATION_FOUND',
        receipt: {
          actionInvocationId: duplicateInvocation.actionInvocationId,
          businessOriginalInvocationId: originalInvocationId,
          catalogRevision: 1,
        },
      });
      expect(yield* readDeliveryReceipt(principalId)).toMatchObject({ outcome: 'PRICE_GROUP_OPERATION_ABSENT' });
      const changedOccurrenceIntent = yield* runtime
        .runAction({
          ...duplicateRequest,
          payload: {
            ...duplicateRequest.payload,
            description: 'Changed intent under the same occurrence must conflict.',
          },
          transport: { ...duplicateRequest.transport, idempotencyKey: 'internal-c14-occurrence-intent-conflict' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(PriceGroupIdempotencyReuseConflict)(changedOccurrenceIntent)).toBe(true);
      const changedOccurrenceMapping = yield* runtime
        .runAction({
          ...duplicateRequest,
          payload: {
            ...duplicateRequest.payload,
            sourceCorrelation: { ...duplicateRequest.payload.sourceCorrelation, mappingVersion: '2' },
          },
          transport: { ...duplicateRequest.transport, idempotencyKey: 'internal-c14-occurrence-mapping-conflict' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(PriceGroupIdempotencyReuseConflict)(changedOccurrenceMapping)).toBe(true);
      const newOccurrence = yield* runtime
        .runAction({
          ...duplicateRequest,
          payload: {
            ...duplicateRequest.payload,
            sourceCorrelation: {
              ...duplicateRequest.payload.sourceCorrelation,
              sourceOccurrenceId: 'internal-c14-new-explicit-occurrence',
            },
          },
          transport: { ...duplicateRequest.transport, idempotencyKey: 'internal-c14-new-occurrence-native-create' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(PriceGroupCodeConflict)(newOccurrence)).toBe(true);
      const allOwnerEffects = yield* admin
        .select()
        .from(priceGroupCatalogLedger)
        .where(eq(priceGroupCatalogLedger.tenantId, tenantId));
      expect(allOwnerEffects).toHaveLength(1);
      const sourceDeliveryReceipts = yield* admin
        .select()
        .from(priceGroupSourceOperationReceipts)
        .where(eq(priceGroupSourceOperationReceipts.tenantId, tenantId));
      expect(sourceDeliveryReceipts).toHaveLength(2);
      const containmentEffects = yield* admin
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.tenantId, tenantId),
            eq(outboxMessages.producerModuleKey, 'pricing.price-group-catalog'),
          ),
        );
      expect(containmentEffects).toHaveLength(1);
      const expectedCurrent = {
        catalogRevision: created.acceptance.acceptedCatalogRevision,
        definitionRevisionId: created.acceptance.definitionRevisionId,
        definitionRevisionNumber: created.acceptance.definitionRevisionNumber,
        meaningFingerprint: created.acceptance.meaningFingerprint,
        priceGroupRef: created.acceptance.priceGroupRef,
      };

      // A real denied native Revision records the exact request identity without loading its owner
      // services. This is the recovery case where write authority has already been revoked.
      const revokedRuntime = makeActionRuntime(
        { executor: database },
        makeActionRepository(yield* Crypto.Crypto),
        allowedPermission,
        testOperationalScopeResolver,
        {
          ...openActionRuntimeOptions,
          accessDecision: makeScriptedBoundAccessGate('denied').bound,
          contextAccess,
          ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
          ownerRegistration: priceGroupCatalogRegistration,
        },
      );
      const revisionPayload = {
        classificationPurpose: createRequest.payload.classificationPurpose,
        compatibilityContracts: createRequest.payload.compatibilityContracts,
        description: 'Original source revision after write revocation.',
        displayName: createRequest.payload.displayName,
        effectiveFrom: DateTime.formatIso(DateTime.add(now, { minutes: 2 })),
        effectiveTo: null,
        expectedCurrent,
        reason: 'Prove the native revision request fingerprint without a new effect.',
        semanticDecision: {
          comparedDefinitionRevisionId: expectedCurrent.definitionRevisionId,
          decision: 'SAME_MEANING' as const,
        },
      };
      yield* revokedRuntime
        .runAction({
          payload: revisionPayload,
          principal,
          registration: createPriceGroupDefinitionRevisionAction,
          transport: {
            correlationId: 'internal-c14-revoked-revision',
            idempotencyKey: 'internal-c14-revoked-revision',
            targetModuleKey: 'pricing.price-group-catalog',
            targetResourceId: expectedCurrent.priceGroupRef.resourceId,
            targetResourceType: 'source-list-hint',
          },
        })
        .pipe(Effect.flip);
      const [revisionInvocation] = yield* admin
        .select()
        .from(actionInvocations)
        .where(
          and(
            eq(actionInvocations.tenantId, tenantId),
            eq(actionInvocations.idempotencyKey, 'internal-c14-revoked-revision'),
          ),
        );
      const revisionIdentity = yield* prepareCreatePriceGroupDefinitionRevisionOriginalRequestIdentity(
        revisionPayload,
        { principalId, tenantId },
      );
      expect(getActionAccessTargetResolver(createPriceGroupDefinitionRevisionAction)).toBeUndefined();
      expect(revisionIdentity.actionKey).toBe(createPriceGroupDefinitionRevisionAction.descriptor.actionKey);
      expect(revisionIdentity.schemaVersion).toBe(createPriceGroupDefinitionRevisionAction.descriptor.schemaVersion);
      expect(revisionIdentity.target).toEqual({});
      expect(revisionIdentity.requestHash).toBe(revisionInvocation?.requestHash);
      expect(revisionInvocation?.targetResourceId).toBeNull();
      expect(revisionInvocation?.status).toBe('rejected');

      const accepted = yield* runtime.runAction({
        payload: {
          effectiveAt: retirementEffectiveAt,
          expectedCurrent,
          reason: 'Schedule retirement after server-trusted acceptance.',
        },
        principal,
        registration: retirePriceGroupAction,
        transport: {
          correlationId: 'scheduled-retirement-accept',
          idempotencyKey: 'scheduled-retirement-accept',
        },
      });
      const [persistedRetirement] = yield* admin
        .select()
        .from(priceGroupRetirements)
        .where(
          and(
            eq(priceGroupRetirements.tenantId, tenantId),
            eq(priceGroupRetirements.actionInvocationId, accepted.retirementProvenance.actionInvocationId),
          ),
        );
      const [persistedLedger] = yield* admin
        .select()
        .from(priceGroupCatalogLedger)
        .where(
          and(
            eq(priceGroupCatalogLedger.tenantId, tenantId),
            eq(priceGroupCatalogLedger.actionInvocationId, accepted.retirementProvenance.actionInvocationId),
          ),
        );

      expect(yield* readDeliveryReceipt(duplicatePrincipalId)).toEqual(duplicateReceipt);
      expect(persistedRetirement).toBeDefined();
      expect(persistedLedger).toBeDefined();
      if (persistedRetirement === undefined || persistedLedger === undefined) {
        throw new Error('Expected committed retirement and ledger evidence');
      }
      expect(accepted.retirementEffectiveAt).toBe(retirementEffectiveAt);
      expect(persistedRetirement.effectiveAt.toISOString()).toBe(retirementEffectiveAt);
      expect(Date.parse(accepted.retirementEffectiveAt)).toBeGreaterThan(
        Date.parse(accepted.retirementProvenance.trustedAt),
      );
      expect(accepted.retirementProvenance.trustedAt).toBe(accepted.trustedOperationAt);
      expect(Date.parse(accepted.trustedOperationAt)).toBeLessThanOrEqual(Date.parse(accepted.verifiedAt));
      expect(persistedLedger.trustedEffectiveAt.toISOString()).toBe(accepted.retirementProvenance.trustedAt);
      expect(Date.parse(accepted.retirementProvenance.trustedAt)).toBeLessThanOrEqual(
        persistedRetirement.recordedAt.getTime(),
      );
      expect(persistedRetirement.recordedAt.getTime()).toBe(Date.parse(accepted.verifiedAt));
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
