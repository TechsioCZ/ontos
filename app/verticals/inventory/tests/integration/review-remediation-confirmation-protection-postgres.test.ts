import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Option, Ref, Schema, Semaphore } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../../../packages/core-runtime/src/auth/system-principal-context-provenance.ts';
import {
  actionInvocations,
  applicationCompositionAuthority,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  legalEntities,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import type { CoreTransaction } from '../../../../packages/core-runtime/src/db/types.ts';
import { lockApplicationCompositionPublication } from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { extractOutboxWorkerSubscriptions } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import {
  makeOutboxWorkerLegalEntityScopeFanout,
  makePostgresOutboxWorkerLegalEntityScopeBackend,
} from '../../../../packages/core-runtime/src/outbox/legal-entity-scope-fanout.ts';
import { makeOutboxRepository } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../../../packages/core-runtime/src/outbox/runtime.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { toBusinessPermissionAccessKey } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/permissions/owner-authorization-overlay.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { CatalogSelectionSchema } from '../../../catalog/shared/domain/catalog-selection-evidence.ts';
import { EstablishCommitmentProtectionPayloadSchema } from '../../shared/actions/establish-commitment-protection.ts';
import {
  CommitmentProtectionPendingResultSchema,
  establishCommitmentProtection,
} from '../../shared/domain/commitment-protection.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { CreateInventoryReservationPayloadSchema } from '../../shared/domain/inventory-reservation-create.ts';
import type { InventoryReservationCreateRequest } from '../../shared/domain/inventory-reservation-create.ts';
import { CommitmentProtectionInventoryEffectLedgerIntentSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import { advanceReservationConfirmationHealth } from '../../shared/domain/reservation-confirmation.ts';
import type { ReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import {
  AuthoritativeReservationEvidenceSchema,
  ReservationAuthorityConfirmedObservationSchema,
  ReservationAuthorityObservationSchema,
} from '../../shared/domain/reservation-authority.ts';
import type {
  ReservationAuthorityIssueRequest,
  ReservationAuthorityObservation,
} from '../../shared/domain/reservation-authority.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { TrustedCurrentCommercePurchasingContextSchema } from '../../shared/domain/stock-sharing-eligibility.ts';
import { CommitmentProtectionRefSchema } from '../../shared/resources/commitment-protection.ts';
import { ReservationConfirmationVerificationRequestSchema } from '../../shared/apis/reservation-confirmation-verification.ts';
import {
  OutboxPayloadSchema as ConfirmationIssuancePayloadSchema,
  outboxTopic as confirmationIssuanceTopic,
} from '../../shared/outbox/commerce-inventory-reservation-confirmation-issuance-requested-v1.ts';
import { createInventoryReservationAction } from '../../src/actions/create-inventory-reservation.action.ts';
import { establishCommitmentProtectionAction } from '../../src/actions/establish-commitment-protection.action.ts';
import { reservationConfirmationVerificationRead } from '../../src/api/reservation-confirmation-verification.read.ts';
import {
  inventoryBackendConfigurations,
  inventoryCatalogToStockBindings,
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
  inventoryRelations,
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
  inventoryReservationCreateEffects,
  inventoryStockItems,
  inventoryStockLocationRevisions,
  inventoryStockLocations,
  inventoryStockPositions,
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
} from '../../src/database/schema.ts';
import { finalizeCommitmentProtectionForWorker } from '../../src/persistence/commitment-protection-repository.ts';
import { inventoryEffectLedgerPersistenceForWorkerScope } from '../../src/persistence/inventory-effect-ledger-repository.ts';
import {
  reservationConfirmationPersistenceForScope,
  reservationConfirmationPersistenceForWorkerScope,
} from '../../src/persistence/reservation-confirmation-repository.ts';
import { reservationCreateEffectPersistenceForWorkerScope } from '../../src/persistence/reservation-create-effect-repository.ts';
import type { CommitmentProtectionAuthority } from '../../src/services/commitment-protection-authority.ts';
import { makeCommitmentProtectionEstablishmentExecutionService } from '../../src/services/commitment-protection.service.ts';
import { InventoryReservationCommerceContextAuthorityPort } from '../../src/services/inventory-reservation-commerce-context.ts';
import {
  commitmentProtectionLedgerResolution,
  makeInventoryEffectLedgerService,
} from '../../src/services/inventory-effect-ledger.service.ts';
import type { InventoryReservationCreateBackend } from '../../src/services/inventory-reservation-create.service.ts';
import { makeInventoryReservationCreateExecutionService } from '../../src/services/inventory-reservation-create.service.ts';
import { makeReservationConfirmationService } from '../../src/services/reservation-confirmation.service.ts';
import type { ReservationAuthorityIssuerPort } from '../../src/services/reservation-issuer.service.ts';
import { makeReservationIssuerService } from '../../src/services/reservation-issuer.service.ts';
import {
  CommitmentProtectionEstablishmentExecution,
  executeCommitmentProtectionEstablishmentWorker,
} from '../../src/workers/execute-commitment-protection-establishment.worker.ts';
import {
  executeInventoryReservationCreateWorker,
  InventoryReservationCreateExecution,
} from '../../src/workers/execute-inventory-reservation-create.worker.ts';
import {
  executeReservationConfirmationIssuanceWorker,
  ReservationConfirmationIssuanceExecution,
} from '../../src/workers/execute-reservation-confirmation-issuance.worker.ts';

const compositionRevision = 'a'.repeat(64);
const compositionSubscriptions = extractOutboxWorkerSubscriptions([
  executeInventoryReservationCreateWorker,
  executeReservationConfirmationIssuanceWorker,
  executeCommitmentProtectionEstablishmentWorker,
]);

const tenantId = 'd1000000-0000-4000-8000-000000000001';
const legalEntityId = 'd2000000-0000-4000-8000-000000000001';
const principalId = 'd3000000-0000-4000-8000-000000000001';
const authBindingId = 'd4000000-0000-4000-8000-000000000001';
const configurationId = 'd5000000-0000-4000-8000-000000000001';
const reservationId = 'd6000000-0000-4000-8000-000000000001';
const stockItemId = 'd7000000-0000-4000-8000-000000000001';
const stockLocationId = 'd8000000-0000-4000-8000-000000000001';
const stockPositionId = 'd9000000-0000-4000-8000-000000000001';
const bindingId = 'da000000-0000-4000-8000-000000000001';
const eligibilityId = 'db000000-0000-4000-8000-000000000001';
const productId = 'dc000000-0000-4000-8000-000000000001';
const variantId = 'dd000000-0000-4000-8000-000000000001';
const unitId = 'de000000-0000-4000-8000-000000000001';
const protectionId = 'df000000-0000-4000-8000-000000000001';
const reservationCreateEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)(
  'review-remediation:reservation-create:1',
);
const protectionEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)(
  'review-remediation:commitment-protection:1',
);
const customerConfigurationId = 'review-remediation-customer';
const attemptId = 'review-remediation-attempt-1';
const storefrontId = 'review-remediation-storefront';
const authenticationNamespaceId = 'test.inventory-review-remediation.v1';
const fixtureInstant = '2026-09-28T08:00:00.000Z';
const scenarioSemaphore = Semaphore.makeUnsafe(1);
const currentIso = DateTime.nowAsDate.pipe(Effect.map((instant) => instant.toISOString()));

const principal = trustVerifiedGatewayPrincipalContext(
  {
    authBindingId,
    authContextRef: `better-auth-session:${authBindingId}`,
    authenticationNamespaceId,
    authMethod: 'session' as const,
    legalEntityId,
    principalId,
    tenantId,
    trustedStorefrontId: storefrontId,
  },
  compositionRevision,
);

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const contextAccess: ContextAccessService = {
  businessPermissions: ({ targets }) =>
    Effect.succeed(
      targets.map((target) => ({
        decision: 'allowed' as const,
        key: toBusinessPermissionAccessKey(target),
      })),
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

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = {
  id: 'review-remediation:variant',
  kind: 'PRODUCT_VARIANT' as const,
};
const authority = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId,
  revision: 1,
  selectedAt: fixtureInstant,
  selection: {
    backend: 'external_business_system',
    backendId: 'review-remediation-erp',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const commerceContext = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema)({
  channel: 'B2C',
  commerceMarketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: 'review-remediation-market',
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  customerConfigurationId,
  evidenceRef: 'review-remediation:commerce-context',
  observedAt: fixtureInstant,
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  status: 'CURRENT_OWNER_VERIFIED',
  storefrontRef: { appId: storefrontId, tenantId },
  tenantId,
});

const createPayload = Schema.decodeUnknownSync(CreateInventoryReservationPayloadSchema)({
  attemptId,
  commerceContext,
  customerConfigurationId,
  demands: [
    {
      catalogSelection: selection,
      exactSelectionMeaning,
      purchaseDemandOccurrenceId: 'review-remediation-demand-1',
      quantity: '4',
      unitRef,
    },
  ],
  effectId: reservationCreateEffectId,
  reservationRef: {
    moduleId: 'commerce.inventory',
    resourceId: reservationId,
    resourceType: 'commerce.inventory.inventory-reservation',
    tenantId,
  },
});

type InventoryDatabase = TestDatabaseFromClient<typeof inventoryRelations>;
type CoreDatabase = TestDatabaseFromClient<typeof coreRelations>;

const cleanupInventory = (database: InventoryDatabase) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupReviewRemediationInventory() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
      for (const table of [
        inventoryCommitmentProtectionHistory,
        inventoryCommitmentProtections,
        inventoryReservationConfirmationHistory,
        inventoryReservationConfirmations,
        inventoryObligationAllocations,
        inventoryObligationRequirements,
        inventoryObligations,
        inventoryEffectLedgerHistory,
        inventoryEffectLedger,
        inventoryReservationCreateEffects,
        inventoryStockSharingEligibilityHistory,
        inventoryStockSharingEligibilities,
        inventoryStockPositions,
        inventoryStockLocationRevisions,
        inventoryStockLocations,
        inventoryCatalogToStockBindings,
        inventoryStockItems,
        inventoryBackendConfigurations,
      ]) {
        yield* transaction.delete(table).where(eq(table.tenantId, tenantId));
      }
    }),
  );

const cleanupCore = (database: CoreDatabase) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupReviewRemediationCore() {
      const messageIds = yield* transaction
        .select({ id: outboxMessages.outboxMessageId })
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      const ids = messageIds.map(({ id }) => id);
      if (ids.length > 0) {
        const deliveryIds = yield* transaction
          .select({ id: outboxDeliveries.outboxDeliveryId })
          .from(outboxDeliveries)
          .where(inArray(outboxDeliveries.outboxMessageId, ids));
        const deliveries = deliveryIds.map(({ id }) => id);
        if (deliveries.length > 0) {
          yield* transaction.delete(outboxAttempts).where(inArray(outboxAttempts.outboxDeliveryId, deliveries));
        }
        yield* transaction.delete(outboxDeliveries).where(inArray(outboxDeliveries.outboxMessageId, ids));
      }
      yield* transaction.delete(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId));
      yield* transaction.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
      yield* transaction.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
      yield* transaction.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
      yield* transaction.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
      yield* transaction.delete(tenantModuleStateChanges).where(eq(tenantModuleStateChanges.tenantId, tenantId));
      yield* transaction.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId));
      yield* transaction.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
      yield* transaction.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
      yield* transaction.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* transaction.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
      yield* transaction.delete(tenants).where(eq(tenants.tenantId, tenantId));
    }),
  );

const seedCore = (database: CoreDatabase) =>
  Effect.gen(function* seedReviewRemediationCore() {
    yield* database.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Inventory review remediation acceptance',
      slug: `inventory-review-remediation-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* database.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Inventory review remediation legal entity',
      registrationCountry: 'CZ',
      registrationNumber: `REVIEW-${legalEntityId}`,
      status: 'active',
      tenantId,
    });
    yield* database.insert(principals).values({
      displayName: 'Inventory review remediation operator',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    yield* database.insert(principalAuthBindings).values({
      authenticationNamespaceId,
      principalAuthBindingId: authBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: `review-remediation-${principalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    yield* database.insert(tenantModuleStates).values({ moduleKey: 'commerce.inventory', state: 'active', tenantId });
  });

const seedInventory = (database: InventoryDatabase) =>
  database.transaction((transaction) =>
    Effect.gen(function* seedReviewRemediationInventory() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
      yield* transaction.insert(inventoryBackendConfigurations).values({
        backendId: authority.selection.backendId,
        backendKind: authority.selection.backend,
        configurationId,
        customerConfigurationId,
        exactReservationCapability: authority.selection.exactReservationCapability,
        revision: 1,
        selectedAt: new Date(fixtureInstant),
        stockCorrectionCapability: authority.selection.stockCorrectionCapability,
        tenantId,
      });
      yield* transaction.insert(inventoryStockItems).values({
        createdAt: new Date(fixtureInstant),
        exactSelectionKind: exactSelectionMeaning.kind,
        exactSelectionMeaningId: exactSelectionMeaning.id,
        lifecycleState: 'CURRENT',
        retiredAt: null,
        revision: 1,
        stockItemId,
        stockUnitModuleId: unitRef.moduleId,
        stockUnitResourceId: unitRef.resourceId,
        stockUnitResourceType: unitRef.resourceType,
        stockUnitTenantId: tenantId,
        tenantId,
      });
      yield* transaction.insert(inventoryCatalogToStockBindings).values({
        bindingId,
        catalogSelection: selection,
        currentRevision: 1,
        effectiveFrom: new Date(fixtureInstant),
        exactSelectionKind: exactSelectionMeaning.kind,
        exactSelectionMeaningId: exactSelectionMeaning.id,
        stockItemId,
        stockUnitModuleId: unitRef.moduleId,
        stockUnitResourceId: unitRef.resourceId,
        stockUnitResourceType: unitRef.resourceType,
        stockUnitTenantId: tenantId,
        tenantId,
      });
      yield* transaction.insert(inventoryStockLocations).values({
        addressEvidence: null,
        currentRevision: 1,
        displayName: 'Review remediation stock location',
        lifecycleState: 'ACTIVE',
        physicalSiteKeys: ['review-remediation-site'],
        scopeKind: 'PHYSICAL_SITE',
        stockLocationId,
        successorStockLocationId: null,
        tenantId,
        transitionedAt: null,
        transitionReason: null,
      });
      yield* transaction.insert(inventoryStockPositions).values({
        createdAt: new Date(fixtureInstant),
        customerConfigurationId,
        endedAt: null,
        lifecycleState: 'CURRENT',
        onHandAmount: '10',
        onHandEvidenceRef: 'review-remediation:on-hand',
        onHandObservedAt: new Date(fixtureInstant),
        onHandState: 'CURRENT',
        ownerConfigurationId: configurationId,
        revision: 1,
        stockItemId,
        stockLocationId,
        stockPositionId,
        stockUnitModuleId: unitRef.moduleId,
        stockUnitResourceId: unitRef.resourceId,
        stockUnitResourceType: unitRef.resourceType,
        stockUnitTenantId: tenantId,
        tenantId,
      });
      yield* transaction.insert(inventoryStockSharingEligibilities).values({
        channel: commerceContext.channel,
        commerceMarketId: commerceContext.commerceMarketRef.resourceId,
        commerceValidationEvidenceRef: commerceContext.evidenceRef,
        commerceValidationObservedAt: new Date(commerceContext.observedAt),
        currentRevision: 1,
        customerConfigurationId,
        effectiveFrom: new Date(fixtureInstant),
        effectiveTo: null,
        eligibilityId,
        lifecycleState: 'CURRENT',
        ownerConfigurationId: configurationId,
        sellingLegalEntityId: legalEntityId,
        stockPositionId,
        storefrontAppId: storefrontId,
        tenantId,
      });
    }),
  );

const reservationCreateBackend = (calls: Ref.Ref<number>): InventoryReservationCreateBackend => ({
  create: (request) =>
    Ref.update(calls, (count) => count + 1).pipe(
      Effect.as({
        _tag: 'ESTABLISHED' as const,
        allocations: request.reservation.requirements.flatMap(({ allocations }) =>
          allocations.map(({ positionRef, ...allocation }) => ({
            ...allocation,
            stockPositionRef: positionRef,
          })),
        ),
        effectId: request.effectId,
        establishedAt: request.requestedAt,
        ownerEvidenceRef: 'review-remediation:reservation-proof',
      }),
    ),
});

const authorityObservation = (
  request: ReservationAuthorityIssueRequest,
  validFrom: string,
  validUntil: string,
  ownerEvidenceRef: string,
): ReservationAuthorityObservation =>
  Schema.decodeUnknownSync(ReservationAuthorityObservationSchema)({
    effectId: request.effectId,
    evidence: {
      ...request.reservation,
      customerConfigurationId: request.configuration.customerConfigurationId,
      ownerEvidenceRef,
      validFrom,
      validUntil,
    },
    issuer: {
      backend: request.configuration.selection.backend,
      backendId: request.configuration.selection.backendId,
      origin: 'EXTERNAL_BUSINESS_SYSTEM',
    },
    kind: 'CONFIRMED',
    operation: request.operation,
  });

const latestMessagePayload = <A>(database: CoreDatabase, topic: string, schema: Schema.Codec<A, unknown>) =>
  database
    .select({ payload: outboxMessages.payloadJson })
    .from(outboxMessages)
    .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.topic, topic)))
    .orderBy(sql`${outboxMessages.createdAt} desc`)
    .limit(1)
    .pipe(
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.die(`Missing outbox message ${topic}`)
          : Schema.decodeUnknownEffect(schema)(row.payload),
      ),
    );

const makeScenario = Effect.fn('ReviewRemediationPostgres.makeScenario')(function* makeScenario() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, inventoryRelations);
  const coreAdmin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
  const runtimeDatabase = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* Effect.acquireRelease(
    coreAdmin.transaction(
      Effect.fn('ReviewRemediationPostgres.seedCompositionAuthority')(function* seedCompositionAuthority(
        transaction: CoreTransaction,
      ) {
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
          subscriptionsJson: compositionSubscriptions,
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
        .transaction(
          Effect.fn('ReviewRemediationPostgres.restoreCompositionAuthority')(function* restoreCompositionAuthority(
            transaction: CoreTransaction,
          ) {
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
  yield* Effect.addFinalizer(() => Effect.all([cleanupInventory(admin), cleanupCore(coreAdmin)]).pipe(Effect.orDie));
  yield* seedCore(coreAdmin);
  yield* seedInventory(admin);

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
  const readRuntime = makeReadRuntime(
    { executor: runtimeDatabase },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    contextAccess,
    { ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay },
  );
  const outbox = makeOutboxRuntime(makeOutboxRepository(runtimeDatabase));
  const baseFanout = makeOutboxWorkerLegalEntityScopeFanout(
    makePostgresOutboxWorkerLegalEntityScopeBackend({
      executor: runtimeDatabase,
    }),
  );
  const currentOwnerScope = yield* Ref.make<Option.Option<OutboxWorkerLegalEntityScope>>(Option.none());
  const fanout = {
    forEachScope: (
      context: Parameters<typeof baseFanout.forEachScope>[0],
      observe: Parameters<typeof baseFanout.forEachScope>[1],
    ) =>
      baseFanout.forEachScope(context, (scope) =>
        Ref.set(currentOwnerScope, Option.some(scope)).pipe(Effect.andThen(observe(scope))),
      ),
  };
  const reservationBackendCalls = yield* Ref.make(0);
  const confirmationAuthorityCalls = yield* Ref.make(0);
  const protectionAuthorityCalls = yield* Ref.make(0);
  const proofValidFrom = yield* currentIso;
  const proofValidUntil = '9999-12-31T23:59:59.999Z';

  const createResult = yield* actionRuntime
    .runAction({
      payload: createPayload,
      principal,
      registration: createInventoryReservationAction,
      transport: {
        correlationId: 'review-remediation-create-action',
        idempotencyKey: 'review-remediation-create-action',
      },
    })
    .pipe(
      Effect.provideService(InventoryReservationCommerceContextAuthorityPort, {
        resolveCurrent: () => Effect.succeed(commerceContext),
      }),
    );
  expect(createResult.outcome).toBe('PENDING');

  const createExecution = {
    execute: (
      _scope: { readonly legalEntityId: string; readonly tenantId: string },
      request: InventoryReservationCreateRequest,
    ) =>
      Ref.get(currentOwnerScope).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die('Reservation create worker did not receive an owner scope'),
            onSome: (ownerScope) =>
              makeInventoryReservationCreateExecutionService({
                backend: reservationCreateBackend(reservationBackendCalls),
                effects: reservationCreateEffectPersistenceForWorkerScope(ownerScope),
                ledger: makeInventoryEffectLedgerService(
                  inventoryEffectLedgerPersistenceForWorkerScope(ownerScope),
                  currentIso,
                ),
              }).execute(ownerScope, request),
          }),
        ),
      ),
  };
  const createMatchNow = yield* DateTime.nowAsDate;
  yield* outbox.matchMessages({
    compositionRevision,
    now: createMatchNow,
  });
  const createNow = new Date(createMatchNow.getTime() + 1000);
  const createCycle = yield* outbox
    .runCycle({
      claimOwner: 'review-remediation-create-worker',
      compositionRevision,
      maxDeliveries: 1,
      now: createNow,
      registrations: [executeInventoryReservationCreateWorker],
      subscriptions: [executeInventoryReservationCreateWorker.descriptor],
    })
    .pipe(
      Effect.provideService(InventoryReservationCreateExecution, createExecution),
      Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
    );
  expect(createCycle).toMatchObject({ failed: 0, succeeded: 1 });

  const issuancePayload = yield* latestMessagePayload(
    coreAdmin,
    confirmationIssuanceTopic,
    ConfirmationIssuancePayloadSchema,
  );
  const issuerPort: ReservationAuthorityIssuerPort = {
    issue: (request) =>
      Ref.update(confirmationAuthorityCalls, (count) => count + 1).pipe(
        Effect.as(
          authorityObservation(request, proofValidFrom, proofValidUntil, 'review-remediation:confirmation-proof'),
        ),
      ),
  };
  const confirmationExecution = {
    execute: (
      _scope: { readonly legalEntityId: string; readonly tenantId: string },
      input: Parameters<ReturnType<typeof makeReservationConfirmationService>['issue']>[0],
    ) =>
      Ref.get(currentOwnerScope).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die('Reservation Confirmation worker did not receive an owner scope'),
            onSome: (ownerScope) =>
              makeReservationConfirmationService({
                issuer: makeReservationIssuerService(issuerPort),
                persistence: reservationConfirmationPersistenceForWorkerScope(ownerScope),
              }).issue(input),
          }),
        ),
      ),
  };
  const confirmationMatchNow = yield* DateTime.nowAsDate;
  yield* outbox.matchMessages({
    compositionRevision,
    now: confirmationMatchNow,
  });
  const confirmationNow = new Date(confirmationMatchNow.getTime() + 1000);
  const confirmationCycle = yield* outbox
    .runCycle({
      claimOwner: 'review-remediation-confirmation-worker',
      compositionRevision,
      maxDeliveries: 1,
      now: confirmationNow,
      registrations: [executeReservationConfirmationIssuanceWorker],
      subscriptions: [executeReservationConfirmationIssuanceWorker.descriptor],
    })
    .pipe(
      Effect.provideService(ReservationConfirmationIssuanceExecution, confirmationExecution),
      Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
    );
  expect(confirmationCycle).toMatchObject({ failed: 0, succeeded: 1 });

  const confirmationRead = yield* readRuntime.runRead({
    input: Schema.decodeUnknownSync(ReservationConfirmationVerificationRequestSchema)({
      attemptId,
      confirmationRef: issuancePayload.request.confirmationRef,
      evaluatedAt: proofValidFrom,
      reservationRef: createPayload.reservationRef,
    }),
    principal,
    registration: reservationConfirmationVerificationRead,
    transport: { correlationId: 'review-remediation-confirmation-read' },
  });
  expect(confirmationRead.evaluation).toEqual({
    outcome: 'READY_TO_ESTABLISH_PROTECTION',
  });

  return {
    actionRuntime,
    admin,
    confirmation: confirmationRead.current,
    confirmationAuthorityCalls,
    coreAdmin,
    fanout,
    outbox,
    proofValidFrom,
    proofValidUntil,
    protectionAuthorityCalls,
    reservationBackendCalls,
  };
});

type Scenario = Effect.Success<ReturnType<typeof makeScenario>>;

const protectionPayload = (confirmation: ReservationConfirmation) =>
  Schema.decodeUnknownSync(EstablishCommitmentProtectionPayloadSchema)({
    confirmationRef: confirmation.ref,
    effectId: protectionEffectId,
    protectionRef: Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
      moduleId: 'commerce.inventory',
      resourceId: protectionId,
      resourceType: 'commerce.inventory.commitment-protection',
      tenantId,
    }),
  });

const stageProtection = (scenario: Scenario) =>
  scenario.actionRuntime.runAction({
    payload: protectionPayload(scenario.confirmation),
    principal,
    registration: establishCommitmentProtectionAction,
    transport: {
      correlationId: 'review-remediation-protection-action',
      idempotencyKey: 'review-remediation-protection-action',
    },
  });

const protectionObservation = (
  scenario: Scenario,
  request: ReservationAuthorityIssueRequest,
  ownerEvidenceRef = 'review-remediation:protection-proof',
) => authorityObservation(request, scenario.proofValidFrom, scenario.proofValidUntil, ownerEvidenceRef);

it.live(
  'runs Reservation creation through Action and workers before a governed Confirmation read and Protection execution',
  () =>
    Semaphore.withPermits(
      scenarioSemaphore,
      1,
    )(
      Effect.scoped(
        Effect.gen(function* reservationConfirmationProtectionAcceptance() {
          const scenario = yield* makeScenario();
          const staged = yield* stageProtection(scenario);
          expect(Schema.is(CommitmentProtectionPendingResultSchema)(staged)).toBe(true);

          const authorityPort: CommitmentProtectionAuthority = {
            establish: (request) =>
              Ref.update(scenario.protectionAuthorityCalls, (count) => count + 1).pipe(
                Effect.as(protectionObservation(scenario, request)),
              ),
          };
          const execution = makeCommitmentProtectionEstablishmentExecutionService({
            authority: authorityPort,
            confirmations: reservationConfirmationPersistenceForWorkerScope,
            finalizer: finalizeCommitmentProtectionForWorker,
            ledger: (scope) =>
              makeInventoryEffectLedgerService(inventoryEffectLedgerPersistenceForWorkerScope(scope), currentIso),
            recoveryAuthority: {
              recoverOriginal: () => Effect.die('unexpected Protection recovery'),
            },
          });
          const matchNow = yield* DateTime.nowAsDate;
          yield* scenario.outbox.matchMessages({
            compositionRevision,
            now: matchNow,
          });
          const now = new Date(matchNow.getTime() + 1000);
          const cycle = yield* scenario.outbox
            .runCycle({
              claimOwner: 'review-remediation-protection-worker',
              compositionRevision,
              maxDeliveries: 1,
              now,
              registrations: [executeCommitmentProtectionEstablishmentWorker],
              subscriptions: [executeCommitmentProtectionEstablishmentWorker.descriptor],
            })
            .pipe(
              Effect.provideService(CommitmentProtectionEstablishmentExecution, execution),
              Effect.provideService(OutboxWorkerLegalEntityScopeFanout, scenario.fanout),
            );
          expect(cycle).toMatchObject({ failed: 0, succeeded: 1 });

          const protections = yield* scenario.admin
            .select()
            .from(inventoryCommitmentProtections)
            .where(eq(inventoryCommitmentProtections.tenantId, tenantId));
          expect(protections).toHaveLength(1);
          expect(protections[0]).toMatchObject({
            confirmationId: scenario.confirmation.ref.resourceId,
            currentHealthState: 'PROTECTED',
            protectionId,
          });
          expect(yield* Ref.get(scenario.reservationBackendCalls)).toBe(1);
          expect(yield* Ref.get(scenario.confirmationAuthorityCalls)).toBe(1);
          expect(yield* Ref.get(scenario.protectionAuthorityCalls)).toBe(1);
        }),
      ),
    ),
);

it.live(
  'recovers one in-time Protection after its authority succeeds and the local finalizer rolls back past Confirmation expiry',
  () =>
    Semaphore.withPermits(
      scenarioSemaphore,
      1,
    )(
      Effect.scoped(
        Effect.gen(function* protectionCrashRecoveryAcceptance() {
          const scenario = yield* makeScenario();
          const staged = yield* stageProtection(scenario);
          expect(Schema.is(CommitmentProtectionPendingResultSchema)(staged)).toBe(true);

          const confirmed = yield* Ref.make<Option.Option<ReservationAuthorityObservation>>(Option.none());
          const finalizerCalls = yield* Ref.make(0);
          const authorityPort: CommitmentProtectionAuthority = {
            establish: (request) => {
              const observation = protectionObservation(scenario, request, 'review-remediation:lost-protection-proof');
              return Ref.update(scenario.protectionAuthorityCalls, (count) => count + 1).pipe(
                Effect.andThen(Ref.set(confirmed, Option.some(observation))),
                Effect.as(observation),
              );
            },
          };
          const execution = makeCommitmentProtectionEstablishmentExecutionService({
            authority: authorityPort,
            confirmations: reservationConfirmationPersistenceForWorkerScope,
            finalizer: (scope, expected, effect) =>
              Ref.updateAndGet(finalizerCalls, (count) => count + 1).pipe(
                Effect.flatMap((call) =>
                  finalizeCommitmentProtectionForWorker(scope, expected, effect).pipe(
                    Effect.flatMap((record) =>
                      call === 1
                        ? Effect.die('fault after the local Protection finalizer write')
                        : Effect.succeed(record),
                    ),
                  ),
                ),
              ),
            ledger: (scope) =>
              makeInventoryEffectLedgerService(inventoryEffectLedgerPersistenceForWorkerScope(scope), currentIso),
            recoveryAuthority: {
              recoverOriginal: (original) =>
                Effect.gen(function* recoverProtection() {
                  const observation = yield* Ref.get(confirmed).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.die('Missing original Protection authority proof'),
                        onSome: Effect.succeed,
                      }),
                    ),
                  );
                  const confirmedObservation = yield* Schema.decodeUnknownEffect(
                    ReservationAuthorityConfirmedObservationSchema,
                  )(observation).pipe(Effect.orDie);
                  const intent = yield* Schema.decodeUnknownEffect(
                    CommitmentProtectionInventoryEffectLedgerIntentSchema,
                  )(original.intent).pipe(Effect.orDie);
                  const authorityEvidence = yield* Schema.decodeUnknownEffect(AuthoritativeReservationEvidenceSchema)({
                    ...confirmedObservation,
                    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
                  }).pipe(Effect.orDie);
                  const protection = yield* establishCommitmentProtection({
                    authorityEvidence,
                    confirmation: intent.request.confirmation,
                    protectionRef: intent.request.protectionRef,
                  }).pipe(Effect.orDie);
                  return {
                    _tag: 'AUTHORITATIVE_SUCCESS' as const,
                    effectId: original.effectId,
                    intent,
                    kind: intent._tag,
                    learnedAt: scenario.proofValidUntil,
                    occurredAt: protection.establishedAt,
                    ownerEvidenceRef: protection.authorityEvidence.evidence.ownerEvidenceRef,
                    resolution: commitmentProtectionLedgerResolution({
                      _tag: 'PROTECTED',
                      protection,
                      request: intent.request,
                    }),
                  };
                }),
            },
          });
          const matchNow = yield* DateTime.nowAsDate;
          yield* scenario.outbox.matchMessages({
            compositionRevision,
            now: matchNow,
          });
          const firstNow = new Date(matchNow.getTime() + 1000);
          const failedCycle = yield* scenario.outbox
            .runCycle({
              claimOwner: 'review-remediation-protection-crash',
              compositionRevision,
              maxDeliveries: 1,
              now: firstNow,
              registrations: [executeCommitmentProtectionEstablishmentWorker],
              subscriptions: [executeCommitmentProtectionEstablishmentWorker.descriptor],
            })
            .pipe(
              Effect.provideService(CommitmentProtectionEstablishmentExecution, execution),
              Effect.provideService(OutboxWorkerLegalEntityScopeFanout, scenario.fanout),
            );
          expect(failedCycle).toMatchObject({ failed: 1, succeeded: 0 });

          const [durableAttempt] = yield* scenario.admin
            .select()
            .from(inventoryEffectLedger)
            .where(
              and(eq(inventoryEffectLedger.tenantId, tenantId), eq(inventoryEffectLedger.effectId, protectionEffectId)),
            );
          expect(durableAttempt?.currentState).toBe('INDETERMINATE');

          yield* scenario.coreAdmin.transaction((transaction) =>
            Effect.gen(function* expireConfirmation() {
              const scope = {
                authMethod: 'api_key' as const,
                correlationId: 'review-remediation-expire-confirmation',
                legalEntityId,
                principalId,
                tenantId,
              };
              const current = scenario.confirmation;
              const expired = yield* advanceReservationConfirmationHealth(current, {
                _tag: 'VALIDITY_ELAPSED',
                effectiveAt: current.expiresAt,
              });
              const scopedTransaction = yield* installOperationalScope(transaction, scope);
              yield* reservationConfirmationPersistenceForScope(scopedTransaction, scope).saveRevision({
                current,
                next: expired,
              });
            }),
          );

          const retryNow = new Date(firstNow.getTime() + 61_000);
          const retryCycle = yield* scenario.outbox
            .runCycle({
              claimOwner: 'review-remediation-protection-recovery',
              compositionRevision,
              maxDeliveries: 1,
              now: retryNow,
              registrations: [executeCommitmentProtectionEstablishmentWorker],
              subscriptions: [executeCommitmentProtectionEstablishmentWorker.descriptor],
            })
            .pipe(
              Effect.provideService(CommitmentProtectionEstablishmentExecution, execution),
              Effect.provideService(OutboxWorkerLegalEntityScopeFanout, scenario.fanout),
            );
          expect(retryCycle).toMatchObject({ failed: 0, succeeded: 1 });

          const protections = yield* scenario.admin
            .select()
            .from(inventoryCommitmentProtections)
            .where(eq(inventoryCommitmentProtections.tenantId, tenantId));
          const protectionHistory = yield* scenario.admin
            .select()
            .from(inventoryCommitmentProtectionHistory)
            .where(eq(inventoryCommitmentProtectionHistory.tenantId, tenantId));
          expect(protections).toHaveLength(1);
          expect(protectionHistory).toHaveLength(1);
          expect(protections[0]?.protectionId).toBe(protectionId);
          expect(yield* Ref.get(scenario.protectionAuthorityCalls)).toBe(1);
        }),
      ),
    ),
);
