import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { Effect, Match, Schema } from 'effect';
import { SqlError, UnknownError } from 'effect/unstable/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  actionInvocations,
  applicationCompositionAuthority,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { attestOutboxWorkerHandlerContext } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import {
  makeOutboxWorkerLegalEntityScopeFanout,
  makePostgresOutboxWorkerLegalEntityScopeBackend,
  OutboxWorkerLegalEntityScopeFanout,
} from '../../../../packages/core-runtime/src/outbox/legal-entity-scope-fanout.ts';
import { lockApplicationCompositionPublication } from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { toBusinessPermissionAccessKey } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/permissions/owner-authorization-overlay.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { injectStatementFaults } from '../../../../packages/core-runtime/tests/support/database-faults.ts';
import { EstablishCommitmentProtectionPayloadSchema } from '../../shared/actions/establish-commitment-protection.ts';
import {
  CommitmentProtectionPendingResultSchema,
  establishCommitmentProtection,
} from '../../shared/domain/commitment-protection.ts';
import type { ReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { AuthoritativeSuccessInventoryEffectRecoveryObservationSchema } from '../../shared/domain/inventory-effect-recovery.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { ReservationConfirmationSchema } from '../../shared/domain/reservation-confirmation.ts';
import {
  AuthoritativeReservationEvidenceSchema,
  ReservationAuthorityObservationSchema,
} from '../../shared/domain/reservation-authority.ts';
import { CommitmentProtectionRefSchema } from '../../shared/resources/commitment-protection.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-inventory-commitment-protection-establishment-requested-v1.ts';
import { establishCommitmentProtectionAction } from '../../src/actions/establish-commitment-protection.action.ts';
import {
  inventoryBackendConfigurations,
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
  inventoryRelations,
  inventoryReservationCreateEffects,
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
} from '../../src/database/schema.ts';
import { finalizeCommitmentProtectionForWorker } from '../../src/persistence/commitment-protection-repository.ts';
import { inventoryEffectLedgerPersistenceForWorkerScope } from '../../src/persistence/inventory-effect-ledger-repository.ts';
import { reservationConfirmationPersistenceForWorkerScope } from '../../src/persistence/reservation-confirmation-repository.ts';
import type { CommitmentProtectionAuthority } from '../../src/services/commitment-protection-authority.ts';
import type { InventoryEffectRecoveryAuthority } from '../../src/services/inventory-effect-recovery-authority.ts';
import { makeCommitmentProtectionEstablishmentExecutionService } from '../../src/services/commitment-protection.service.ts';
import {
  commitmentProtectionLedgerResolution,
  makeInventoryEffectLedgerService,
} from '../../src/services/inventory-effect-ledger.service.ts';
import {
  CommitmentProtectionEstablishmentExecution,
  handleExecuteCommitmentProtectionEstablishment,
} from '../../src/workers/execute-commitment-protection-establishment.worker.ts';
import {
  buildInventoryOwnerAcceptanceBindingCorrectionLineage,
  inventoryOwnerAcceptanceBindingCorrectionFixture,
} from '../support/inventory-owner-acceptance-binding-correction.ts';

const compositionRevision = 'a'.repeat(64);

const tenantId = '91000000-0000-4000-8000-000000000001';
const legalEntityId = '92000000-0000-4000-8000-000000000001';
const principalId = '93000000-0000-4000-8000-000000000001';
const authBindingId = '94000000-0000-4000-8000-000000000001';
const configurationId = '95000000-0000-4000-8000-000000000001';
const reservationId = '96000000-0000-4000-8000-000000000001';
const confirmationId = '97000000-0000-4000-8000-000000000001';
const protectionId = '98000000-0000-4000-8000-000000000001';
const effectId = 'commitment-protection:postgres-crash-recovery';
const authenticationNamespaceId = 'test.inventory-commitment-protection.v1';
const requestedTopic = 'commerce.inventory.commitment-protection-establishment-requested.v1';
const changedTopic = 'commerce.inventory.commitment-protection-changed.v1';
const workerKey = 'commerce.inventory.execute-commitment-protection-establishment';

const principal = {
  authBindingId,
  authContextRef: `better-auth-session:${authBindingId}`,
  authenticationNamespaceId,
  authMethod: 'session' as const,
  legalEntityId,
  principalId,
  tenantId,
};

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const contextAccess: ContextAccessService = {
  businessPermissions: (input) =>
    Effect.succeed(
      input.targets.map((target) => ({ decision: 'allowed' as const, key: toBusinessPermissionAccessKey(target) })),
    ),
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

const replaceStrings = <A>(
  schema: Schema.Codec<A, unknown>,
  value: A,
  replacements: Readonly<Record<string, string>>,
): A => {
  let encoded = JSON.stringify(value);
  for (const [from, to] of Object.entries(replacements)) {
    encoded = encoded.replaceAll(from, to);
  }
  return Schema.decodeUnknownSync(schema)(JSON.parse(encoded));
};

const valuesForConfirmation = (confirmation: Schema.Schema.Type<typeof ReservationConfirmationSchema>) => ({
  attemptId: confirmation.reservation.origin.attemptId,
  authorityEffectId: confirmation.authorityEvidence.effectId,
  confirmationId: confirmation.ref.resourceId,
  currentHealthState: confirmation.health.state,
  currentRevision: confirmation.revision,
  expiresAt: new Date(confirmation.expiresAt),
  issuedAt: new Date(confirmation.issuedAt),
  issuerBackendId: confirmation.authorityEvidence.issuer.backendId,
  issuerBackendKind: confirmation.authorityEvidence.issuer.backend,
  ownerConfigurationId: confirmation.reservation.authority.configurationId,
  ownerEvidenceRef: confirmation.issuanceRank.ownerEvidenceRef,
  reservationId: confirmation.reservation.ref.resourceId,
  snapshot: confirmation,
  tenantId: confirmation.ref.tenantId,
  updatedAt: new Date(confirmation.health.observation.effectiveAt),
});

const authoritativeAllocationsFor = (confirmation: ReservationConfirmation) =>
  confirmation.reservation.requirements.flatMap(({ allocations }) =>
    allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
      allocationId,
      quantity,
      stockItemRef,
      stockPositionRef: positionRef,
    })),
  );

type InventoryTestDatabase = TestDatabaseFromClient<typeof inventoryRelations>;

const cleanupInventory = (database: InventoryTestDatabase) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupProtectionFixture() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
      for (const table of [
        inventoryCommitmentProtectionHistory,
        inventoryCommitmentProtections,
        inventoryEffectLedgerHistory,
        inventoryEffectLedger,
        inventoryReservationConfirmationHistory,
        inventoryReservationConfirmations,
        inventoryReservationCreateEffects,
        inventoryObligationAllocations,
        inventoryObligationRequirements,
        inventoryObligations,
        inventoryBackendConfigurations,
      ]) {
        yield* transaction.delete(table).where(eq(table.tenantId, tenantId));
      }
    }),
  );

const cleanupCore = (database: TestDatabaseFromClient<typeof coreRelations>) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupProtectionCoreFixture() {
      yield* transaction.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
      yield* transaction.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
      yield* transaction.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
      yield* transaction.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
      yield* transaction.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
      yield* transaction.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
      yield* transaction.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* transaction.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
      yield* transaction.delete(tenants).where(eq(tenants.tenantId, tenantId));
    }),
  );

it.live(
  'recovers the exact Protection after an authority success is followed by a PostgreSQL finalizer crash',
  () =>
    Effect.scoped(
      Effect.gen(function* commitmentProtectionCrashRecovery() {
        const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
        const admin = yield* makeTestDatabaseFromClient(adminClient, inventoryRelations);
        const coreAdmin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
        const runtimeDatabase = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
        yield* Effect.acquireRelease(
          coreAdmin.transaction((transaction) =>
            Effect.gen(function* admitFixtureComposition() {
              yield* lockApplicationCompositionPublication(transaction);
              const [previous] = yield* transaction
                .select()
                .from(applicationCompositionAuthority)
                .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
              const admitted: PgInsertValue<typeof applicationCompositionAuthority> = {
                authorityKey: 'active',
                durableWorkAdmission: 'open',
                phase: 'active',
                revision: compositionRevision,
                subscriptionsJson: [],
                validUntil: sql`clock_timestamp() + interval '1 hour'`,
              };
              yield* transaction.insert(applicationCompositionAuthority).values(admitted).onConflictDoUpdate({
                set: admitted,
                target: applicationCompositionAuthority.authorityKey,
              });
              return previous;
            }),
          ),
          (previous) =>
            coreAdmin
              .transaction((transaction) =>
                Effect.gen(function* restoreFixtureComposition() {
                  yield* lockApplicationCompositionPublication(transaction);
                  yield* transaction
                    .delete(applicationCompositionAuthority)
                    .where(eq(applicationCompositionAuthority.revision, compositionRevision));
                  if (previous !== undefined) {
                    yield* transaction.insert(applicationCompositionAuthority).values(previous);
                  }
                }),
              )
              .pipe(Effect.orDie),
        );
        yield* cleanupInventory(admin);
        yield* cleanupCore(coreAdmin);
        yield* Effect.addFinalizer(() =>
          Effect.all([cleanupInventory(admin), cleanupCore(coreAdmin)]).pipe(Effect.orDie),
        );

        yield* coreAdmin.insert(tenants).values({
          defaultLocale: 'en',
          name: 'Commitment Protection worker recovery',
          slug: `commitment-protection-recovery-${tenantId}`,
          status: 'active',
          tenantId,
        });
        yield* coreAdmin.insert(legalEntities).values({
          legalEntityId,
          legalName: 'Commitment Protection test owner',
          registrationCountry: 'CZ',
          registrationNumber: 'COMMITMENT-PROTECTION-RECOVERY',
          status: 'active',
          tenantId,
        });
        yield* coreAdmin.insert(principals).values({
          displayName: 'Commitment Protection operator',
          kind: 'human',
          principalId,
          status: 'active',
          tenantId,
        });
        yield* coreAdmin.insert(principalAuthBindings).values({
          authenticationNamespaceId,
          principalAuthBindingId: authBindingId,
          principalId,
          provider: 'better_auth',
          providerSubjectId: `commitment-protection-${principalId}`,
          status: 'active',
          subjectType: 'user',
          tenantId,
        });

        const issuedAt = '2025-01-01T00:00:00.000Z';
        const expiresAt = '2099-01-01T00:00:00.000Z';
        const recoveryLearnedAt = '2100-01-01T00:00:00.000Z';
        const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
        const replacements = {
          '11111111-1111-4111-8111-111111111111': tenantId,
          '2026-09-25T09:00:00.000Z': '2024-12-31T23:00:00.000Z',
          '2026-09-25T10:00:00.000Z': issuedAt,
          '2026-09-25T12:00:00.000Z': expiresAt,
          '77777777-7777-4777-8777-777777777777': configurationId,
          '99999999-9999-4999-8999-999999999999': reservationId,
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc': confirmationId,
        } as const;
        const confirmation = replaceStrings(ReservationConfirmationSchema, lineage.confirmation, replacements);
        const backend = replaceStrings(
          InventoryBackendConfigurationSchema,
          inventoryOwnerAcceptanceBindingCorrectionFixture.authority,
          replacements,
        );
        const createRequest = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
          authority: backend,
          commerceContext: {
            channel: 'B2C',
            commerceMarketRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: 'commitment-protection-recovery-market',
              resourceType: 'commerce.market-catalog.market',
              tenantId,
            },
            customerConfigurationId: backend.customerConfigurationId,
            evidenceRef: 'commitment-protection-recovery-commerce-context',
            observedAt: issuedAt,
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            status: 'CURRENT_OWNER_VERIFIED',
            storefrontRef: { appId: 'commitment-protection-recovery-storefront', tenantId },
            tenantId,
          },
          effectId: 'commitment-protection-recovery-reservation-create',
          legalEntityId,
          mutationId: '99000000-0000-4000-8000-000000000001',
          requestedAt: issuedAt,
          reservation: {
            origin: confirmation.reservation.origin,
            ref: confirmation.reservation.ref,
            requirements: confirmation.reservation.requirements,
          },
          sourceActionInvocationId: '99100000-0000-4000-8000-000000000001',
        });
        const createTerminal = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)({
          _tag: 'ESTABLISHED',
          ownerEvidenceRef: 'commitment-protection-recovery-reservation-proof',
          request: createRequest,
          reservation: confirmation.reservation,
        });

        yield* admin.transaction((transaction) =>
          Effect.gen(function* seedConfirmationLineage() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.insert(inventoryBackendConfigurations).values({
              backendId: backend.selection.backendId,
              backendKind: backend.selection.backend,
              configurationId: backend.configurationId,
              customerConfigurationId: backend.customerConfigurationId,
              exactReservationCapability: backend.selection.exactReservationCapability,
              revision: backend.revision,
              selectedAt: new Date(backend.selectedAt),
              stockCorrectionCapability: backend.selection.stockCorrectionCapability,
              tenantId,
            });
            const { reservation } = confirmation;
            yield* transaction.insert(inventoryObligations).values({
              acceptedOrderId: null,
              attemptId: reservation.origin.attemptId,
              authorityBackendId: reservation.authority.selection.backendId,
              authorityBackendKind: reservation.authority.selection.backend,
              authorityExactReservationCapability: reservation.authority.selection.exactReservationCapability,
              authorityRevision: reservation.authority.revision,
              authoritySelectedAt: new Date(reservation.authority.selectedAt),
              authorityStockCorrectionCapability: reservation.authority.selection.stockCorrectionCapability,
              customerConfigurationId: reservation.authority.customerConfigurationId,
              establishedAt: new Date(reservation.establishedAt),
              lifecycleMeaning: 'PROVISIONAL_RESERVATION',
              obligationId: reservation.ref.resourceId,
              orderEvidenceObservedAt: null,
              orderEvidenceRef: null,
              originKind: reservation.origin.kind,
              ownerConfigurationId: reservation.authority.configurationId,
              tenantId,
            });
            yield* transaction.insert(inventoryReservationCreateEffects).values({
              attemptId: createRequest.reservation.origin.attemptId,
              backendConfigurationId: createRequest.authority.configurationId,
              backendId: createRequest.authority.selection.backendId,
              customerConfigurationId: createRequest.authority.customerConfigurationId,
              effectId: createRequest.effectId,
              legalEntityId,
              mutationId: createRequest.mutationId,
              recordJson: createTerminal,
              requestedAt: new Date(createRequest.requestedAt),
              requestJson: createRequest,
              reservationId: createRequest.reservation.ref.resourceId,
              sourceActionInvocationId: createRequest.sourceActionInvocationId,
              state: 'ESTABLISHED',
              tenantId,
              updatedAt: new Date(createRequest.requestedAt),
            });
            yield* transaction.insert(inventoryReservationConfirmations).values(valuesForConfirmation(confirmation));
            yield* transaction.insert(inventoryReservationConfirmationHistory).values({
              confirmationId: confirmation.ref.resourceId,
              healthState: confirmation.health.state,
              revision: confirmation.revision,
              snapshot: confirmation,
              tenantId,
              transitionedAt: new Date(confirmation.health.observation.effectiveAt),
            });
          }),
        );

        const payload = Schema.decodeUnknownSync(EstablishCommitmentProtectionPayloadSchema)({
          confirmationRef: confirmation.ref,
          effectId,
          protectionRef: Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
            moduleId: 'commerce.inventory',
            resourceId: protectionId,
            resourceType: 'commerce.inventory.commitment-protection',
            tenantId,
          }),
        });
        const actionRuntime = makeActionRuntime(
          { executor: runtimeDatabase },
          makeActionRepository(),
          allowedPermission,
          testOperationalScopeResolver,
          {
            ...openActionRuntimeOptions,
            contextAccess,
            ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
          },
        );
        const pending = yield* actionRuntime.runAction({
          payload,
          principal,
          registration: establishCommitmentProtectionAction,
          transport: {
            correlationId: 'commitment-protection-postgres-recovery',
            idempotencyKey: 'commitment-protection-postgres-recovery',
          },
        });
        expect(Schema.is(CommitmentProtectionPendingResultSchema)(pending)).toBe(true);

        const requestedMessages = yield* coreAdmin
          .select()
          .from(outboxMessages)
          .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.topic, requestedTopic)));
        expect(requestedMessages).toHaveLength(1);
        const [requestedMessage] = requestedMessages;
        if (requestedMessage === undefined) {
          yield* Effect.die('Action did not commit its Protection establishment request');
        }
        const [requestedLedger] = yield* admin
          .select()
          .from(inventoryEffectLedger)
          .where(and(eq(inventoryEffectLedger.tenantId, tenantId), eq(inventoryEffectLedger.effectId, effectId)));
        if (requestedLedger === undefined) {
          yield* Effect.die('Action did not commit its Protection effect ledger');
        }
        const workerPayload = Schema.decodeUnknownSync(OutboxPayloadSchema)(requestedMessage.payloadJson);
        const authoritySucceededAt = workerPayload.request.requestedAt;
        expect(workerPayload.request.protectionRef.resourceId).toBe(protectionId);

        const authorityCalls: string[] = [];
        const authority: CommitmentProtectionAuthority = {
          establish: (request) =>
            Effect.sync(() => {
              authorityCalls.push(request.effectId);
              return Schema.decodeUnknownSync(ReservationAuthorityObservationSchema)({
                effectId: request.effectId,
                evidence: {
                  allocations: request.reservation.allocations,
                  attemptId: request.reservation.attemptId,
                  customerConfigurationId: request.configuration.customerConfigurationId,
                  ownerEvidenceRef: 'owner-proof:commitment-protection-postgres-recovery',
                  reservationId: request.reservation.reservationId,
                  tenantId,
                  validFrom: authoritySucceededAt,
                  validUntil: expiresAt,
                },
                issuer: {
                  backend: request.configuration.selection.backend,
                  backendId: request.configuration.selection.backendId,
                  origin: 'ONTOS_WMS',
                },
                kind: 'CONFIRMED',
                operation: 'COMMITMENT_PROTECTION',
              });
            }),
        };
        const recoveryAuthority: InventoryEffectRecoveryAuthority = {
          recoverOriginal: (original) =>
            Match.value(original.intent).pipe(
              Match.tag('ESTABLISH_COMMITMENT_PROTECTION', (intent) =>
                Effect.gen(function* recoverOriginalProtection() {
                  const { request } = intent;
                  const evidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
                    effectId: request.effectId,
                    evidence: {
                      allocations: authoritativeAllocationsFor(request.confirmation),
                      attemptId: request.confirmation.reservation.origin.attemptId,
                      customerConfigurationId: request.confirmation.reservation.authority.customerConfigurationId,
                      ownerEvidenceRef: 'owner-proof:commitment-protection-postgres-recovery',
                      reservationId: request.confirmation.reservation.ref.resourceId,
                      tenantId,
                      validFrom: authoritySucceededAt,
                      validUntil: expiresAt,
                    },
                    issuer: {
                      backend: request.confirmation.reservation.authority.selection.backend,
                      backendId: request.confirmation.reservation.authority.selection.backendId,
                      origin: 'ONTOS_WMS',
                    },
                    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
                    operation: 'COMMITMENT_PROTECTION',
                  });
                  const protection = yield* establishCommitmentProtection({
                    authorityEvidence: evidence,
                    confirmation: request.confirmation,
                    protectionRef: request.protectionRef,
                  }).pipe(Effect.orDie);
                  return Schema.decodeUnknownSync(AuthoritativeSuccessInventoryEffectRecoveryObservationSchema)({
                    _tag: 'AUTHORITATIVE_SUCCESS' as const,
                    effectId: original.effectId,
                    intent,
                    kind: intent._tag,
                    learnedAt: recoveryLearnedAt,
                    occurredAt: authoritySucceededAt,
                    ownerEvidenceRef: evidence.evidence.ownerEvidenceRef,
                    resolution: commitmentProtectionLedgerResolution({
                      _tag: 'PROTECTED',
                      protection,
                      request,
                    }),
                  });
                }),
              ),
              Match.orElse(() => Effect.die('Unexpected recovery intent')),
            ),
        };
        const execution = makeCommitmentProtectionEstablishmentExecutionService({
          authority,
          confirmations: reservationConfirmationPersistenceForWorkerScope,
          finalizer: finalizeCommitmentProtectionForWorker,
          ledger: (scope) =>
            makeInventoryEffectLedgerService(
              inventoryEffectLedgerPersistenceForWorkerScope(scope),
              Effect.succeed(requestedLedger.requestedAt.toISOString()),
            ),
          recoveryAuthority,
        });
        const fanout = makeOutboxWorkerLegalEntityScopeFanout(
          makePostgresOutboxWorkerLegalEntityScopeBackend({ executor: runtimeDatabase }),
        );
        const handlerContext = attestOutboxWorkerHandlerContext({
          actorPrincipalId: principalId,
          attemptNumber: 1,
          claimId: randomUUID(),
          compositionRevision,
          consumerModuleKey: 'commerce.inventory',
          correlationId: 'commitment-protection-postgres-recovery-worker',
          deliveryId: randomUUID(),
          domainEventId: requestedMessage.domainEventId,
          legalEntityScope: 'required',
          messageId: requestedMessage.outboxMessageId,
          producerModuleKey: requestedMessage.producerModuleKey,
          tenantId,
          tenantSequenceNo: 1n,
          topic: requestedMessage.topic,
          workerKey,
        });
        const runWorker = handleExecuteCommitmentProtectionEstablishment(workerPayload, handlerContext).pipe(
          Effect.provideService(CommitmentProtectionEstablishmentExecution, execution),
          Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
        );
        const failed = yield* Effect.flip(
          runWorker.pipe(
            injectStatementFaults((statement) =>
              statement.includes('"inventory"."finalize_commitment_protection_for_worker"')
                ? Effect.fail(
                    new SqlError({
                      reason: new UnknownError({
                        cause: new Error('Injected Protection finalizer crash'),
                        message: 'Injected Protection finalizer crash after authority success',
                      }),
                    }),
                  )
                : Effect.void,
            ),
          ),
        );
        expect(failed).toBeDefined();
        const [indeterminate] = yield* admin
          .select()
          .from(inventoryEffectLedger)
          .where(and(eq(inventoryEffectLedger.tenantId, tenantId), eq(inventoryEffectLedger.effectId, effectId)));
        const protectionsAfterCrash = yield* admin
          .select()
          .from(inventoryCommitmentProtections)
          .where(eq(inventoryCommitmentProtections.tenantId, tenantId));
        expect(indeterminate).toMatchObject({ currentRevision: 2, currentState: 'INDETERMINATE' });
        expect(protectionsAfterCrash).toEqual([]);
        expect(authorityCalls).toEqual([effectId]);
        expect(Date.parse(recoveryLearnedAt)).toBeGreaterThan(Date.parse(confirmation.expiresAt));

        yield* runWorker;

        const [terminal] = yield* admin
          .select()
          .from(inventoryEffectLedger)
          .where(and(eq(inventoryEffectLedger.tenantId, tenantId), eq(inventoryEffectLedger.effectId, effectId)));
        const protections = yield* admin
          .select()
          .from(inventoryCommitmentProtections)
          .where(eq(inventoryCommitmentProtections.tenantId, tenantId));
        const protectionHistory = yield* admin
          .select()
          .from(inventoryCommitmentProtectionHistory)
          .where(eq(inventoryCommitmentProtectionHistory.tenantId, tenantId));
        const completions = yield* coreAdmin
          .select()
          .from(outboxMessages)
          .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.topic, changedTopic)));
        expect(terminal).toMatchObject({ currentRevision: 3, currentState: 'SUCCEEDED' });
        expect(protections).toHaveLength(1);
        expect(protections[0]).toMatchObject({
          authorityEffectId: effectId,
          confirmationId,
          protectionId,
          reservationId,
        });
        expect(protectionHistory).toHaveLength(1);
        expect(authorityCalls).toEqual([effectId]);
        expect(completions).toHaveLength(1);
      }),
    ),
  120_000,
);
