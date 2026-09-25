import { randomUUID } from 'node:crypto';

import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { toBusinessPermissionAccessKey } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/permissions/owner-authorization-overlay.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  advanceReservationConfirmationHealth,
  ReservationConfirmationRejected,
  ReservationConfirmationSchema,
} from '../../shared/domain/reservation-confirmation.ts';
import { CommitmentProtectionSchema } from '../../shared/domain/commitment-protection.ts';
import { CommitmentProtectionRejected } from '../../shared/domain/commitment-protection-rejected.ts';
import {
  InventoryObligationRejected,
  ProvisionalInventoryReservationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { CorrectCatalogToStockBindingPayloadSchema } from '../../shared/actions/correct-catalog-to-stock-binding.ts';
import {
  correctCatalogToStockBindingAction,
  handleCorrectCatalogToStockBinding,
  makeCorrectCatalogToStockBindingServices,
} from '../../src/actions/correct-catalog-to-stock-binding.action.ts';
import {
  inventoryBackendConfigurations,
  inventoryBindingCorrectionReconciliations,
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindings,
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
  inventoryRelations,
  inventoryReservationCreateEffects,
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
  inventoryStockItems,
} from '../../src/database/schema.ts';
import { commitmentProtectionPersistenceForScope } from '../../src/persistence/commitment-protection-repository.ts';
import { makeDrizzleCatalogToStockBindingPersistence } from '../../src/persistence/catalog-to-stock-binding-repository.ts';
import { inventoryObligationPersistenceForScope } from '../../src/persistence/inventory-obligation-repository.ts';
import { reservationConfirmationPersistenceForScope } from '../../src/persistence/reservation-confirmation-repository.ts';
import {
  buildInventoryOwnerAcceptanceBindingCorrectionLineage,
  inventoryOwnerAcceptanceBindingCorrectionFixture,
} from '../support/inventory-owner-acceptance-binding-correction.ts';

const fixture = inventoryOwnerAcceptanceBindingCorrectionFixture;
const { tenantId } = fixture.originalBinding.bindingRef;
const otherTenantId = '10101010-1010-4010-8010-101010101010';
const principalId = '19191919-1919-4191-8191-191919191919';
const authBindingId = '18181818-1818-4181-8181-181818181818';
const authenticationNamespaceId = 'test.inventory-binding-correction.v1';
const unrelatedBindingId = '20202020-2020-4020-8020-202020202020';
const unrelatedItemId = '30303030-3030-4030-8030-303030303030';
const otherTenantBindingId = '40404040-4040-4040-8040-404040404040';
const otherTenantItemId = '50505050-5050-4050-8050-505050505050';

const principal = {
  authBindingId,
  authContextRef: `better-auth-session:${authBindingId}`,
  authenticationNamespaceId,
  authMethod: 'session' as const,
  principalId,
  tenantId,
};

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const contextAccess: ContextAccessService = {
  businessPermissions: (input) =>
    Effect.succeed(
      input.targets.map((target) => ({
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

const valuesForProtection = (protection: Schema.Schema.Type<typeof CommitmentProtectionSchema>) => ({
  attemptId: protection.confirmation.reservation.origin.attemptId,
  authorityEffectId: protection.authorityEvidence.effectId,
  confirmationId: protection.confirmation.ref.resourceId,
  currentHealthState: protection.health.state,
  currentRevision: protection.revision,
  establishedAt: new Date(protection.establishedAt),
  issuerBackendId: protection.authorityEvidence.issuer.backendId,
  issuerBackendKind: protection.authorityEvidence.issuer.backend,
  ownerConfigurationId: protection.confirmation.reservation.authority.configurationId,
  ownerEvidenceRef: protection.authorityEvidence.evidence.ownerEvidenceRef,
  protectionId: protection.ref.resourceId,
  reservationId: protection.confirmation.reservation.ref.resourceId,
  snapshot: protection,
  tenantId: protection.ref.tenantId,
  updatedAt: new Date(protection.health.observation.effectiveAt),
});

type InventoryTestDatabase = TestDatabaseFromPool<typeof inventoryRelations>;
type InventoryTestTransaction = Parameters<Parameters<InventoryTestDatabase['transaction']>[0]>[0];

const cleanupTenant = (admin: InventoryTestDatabase, id: string) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupBindingCorrectionFixture() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
      for (const table of [
        inventoryCommitmentProtectionHistory,
        inventoryCommitmentProtections,
        inventoryReservationReleaseEffectHistory,
        inventoryReservationReleaseEffects,
        inventoryReservationConfirmationHistory,
        inventoryReservationConfirmations,
        inventoryBindingCorrectionReconciliations,
        inventoryObligationAllocations,
        inventoryObligationRequirements,
        inventoryObligations,
        inventoryCatalogToStockBindingHistory,
        inventoryCatalogToStockBindings,
        inventoryStockItems,
        inventoryBackendConfigurations,
      ]) {
        yield* transaction.delete(table).where(eq(table.tenantId, id));
      }
    }),
  );

const cleanupCoreTenant = (database: TestDatabaseFromPool<typeof coreRelations>) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupCoreBindingCorrectionFixture() {
      yield* transaction.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
      yield* transaction.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
      yield* transaction.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
      yield* transaction.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
      yield* transaction.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
      yield* transaction.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
      yield* transaction.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* transaction.delete(tenants).where(eq(tenants.tenantId, tenantId));
    }),
  );

const seedStockAndBinding = (transaction: InventoryTestTransaction) =>
  Effect.gen(function* seedStockAndBindingRows() {
    for (const item of [fixture.originalStockItem, fixture.correctedStockItem]) {
      yield* transaction.insert(inventoryStockItems).values({
        createdAt: new Date(item.createdAt),
        exactSelectionKind: item.exactSelectionMeaning.kind,
        exactSelectionMeaningId: item.exactSelectionMeaning.id,
        lifecycleState:
          item.stockItemRef.resourceId === fixture.originalStockItem.stockItemRef.resourceId ? 'RETIRED' : 'CURRENT',
        retiredAt:
          item.stockItemRef.resourceId === fixture.originalStockItem.stockItemRef.resourceId
            ? new Date('2026-09-25T10:04:00.000Z')
            : null,
        revision:
          item.stockItemRef.resourceId === fixture.originalStockItem.stockItemRef.resourceId ? 2 : item.revision,
        stockItemId: item.stockItemRef.resourceId,
        stockUnitModuleId: item.unitRef.moduleId,
        stockUnitResourceId: item.unitRef.resourceId,
        stockUnitResourceType: item.unitRef.resourceType,
        stockUnitTenantId: item.unitRef.tenantId,
        tenantId: item.stockItemRef.tenantId,
      });
    }
    yield* transaction.insert(inventoryCatalogToStockBindings).values({
      bindingId: fixture.originalBinding.bindingRef.resourceId,
      catalogSelection: fixture.originalBinding.catalogSelection,
      currentRevision: fixture.originalBinding.revision,
      effectiveFrom: new Date(fixture.originalBinding.effectiveFrom),
      exactSelectionKind: fixture.originalBinding.exactSelectionMeaning.kind,
      exactSelectionMeaningId: fixture.originalBinding.exactSelectionMeaning.id,
      stockItemId: fixture.originalBinding.stockItemRef.resourceId,
      stockUnitModuleId: fixture.originalBinding.unitRef.moduleId,
      stockUnitResourceId: fixture.originalBinding.unitRef.resourceId,
      stockUnitResourceType: fixture.originalBinding.unitRef.resourceType,
      stockUnitTenantId: fixture.originalBinding.unitRef.tenantId,
      tenantId,
    });
  });

const seedLineage = (
  transaction: InventoryTestTransaction,
  confirmation: Schema.Schema.Type<typeof ReservationConfirmationSchema>,
  protection: Schema.Schema.Type<typeof CommitmentProtectionSchema> | undefined,
  lifecycle: 'COMMITTED_OBLIGATION' | 'PROVISIONAL_RESERVATION',
) =>
  Effect.gen(function* seedLineageRows() {
    const { reservation } = confirmation;
    yield* transaction.insert(inventoryObligations).values({
      acceptedOrderId: lifecycle === 'COMMITTED_OBLIGATION' ? `order:${reservation.ref.resourceId}` : null,
      attemptId: reservation.origin.attemptId,
      authorityBackendId: reservation.authority.selection.backendId,
      authorityBackendKind: reservation.authority.selection.backend,
      authorityExactReservationCapability: reservation.authority.selection.exactReservationCapability,
      authorityRevision: reservation.authority.revision,
      authoritySelectedAt: new Date(reservation.authority.selectedAt),
      authorityStockCorrectionCapability: reservation.authority.selection.stockCorrectionCapability,
      customerConfigurationId: reservation.authority.customerConfigurationId,
      establishedAt: new Date(reservation.establishedAt),
      lifecycleMeaning: lifecycle,
      obligationId: reservation.ref.resourceId,
      orderEvidenceObservedAt: lifecycle === 'COMMITTED_OBLIGATION' ? new Date('2026-09-25T10:02:00.000Z') : null,
      orderEvidenceRef: lifecycle === 'COMMITTED_OBLIGATION' ? `order-proof:${reservation.ref.resourceId}` : null,
      originKind: reservation.origin.kind,
      ownerConfigurationId: reservation.authority.configurationId,
      tenantId: reservation.ref.tenantId,
    });
    for (const requirement of reservation.requirements) {
      yield* transaction.insert(inventoryObligationRequirements).values({
        bindingId: requirement.bindingRef.resourceId,
        catalogSelection: requirement.catalogSelection,
        exactSelectionMeaningId: requirement.exactSelectionMeaning.id,
        exactSelectionMeaningKind: requirement.exactSelectionMeaning.kind,
        obligationId: reservation.ref.resourceId,
        purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
        requestedAmount: requirement.quantity,
        stockItemId: requirement.stockItem.stockItemRef.resourceId,
        stockItemRevision: requirement.stockItem.revision,
        stockItemSnapshot: requirement.stockItem,
        tenantId: reservation.ref.tenantId,
        unitModuleId: requirement.unitRef.moduleId,
        unitResourceId: requirement.unitRef.resourceId,
        unitResourceType: requirement.unitRef.resourceType,
        unitTenantId: requirement.unitRef.tenantId,
      });
      for (const allocation of requirement.allocations) {
        yield* transaction.insert(inventoryObligationAllocations).values({
          allocatedAmount: allocation.quantity.amount,
          allocationId: allocation.allocationId,
          obligationId: reservation.ref.resourceId,
          purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
          stockItemId: allocation.stockItemRef.resourceId,
          stockPositionId: allocation.positionRef.resourceId,
          tenantId: reservation.ref.tenantId,
          unitModuleId: allocation.quantity.unitRef.moduleId,
          unitResourceId: allocation.quantity.unitRef.resourceId,
          unitResourceType: allocation.quantity.unitRef.resourceType,
          unitTenantId: allocation.quantity.unitRef.tenantId,
        });
      }
    }
    yield* transaction.insert(inventoryReservationConfirmations).values(valuesForConfirmation(confirmation));
    if (protection !== undefined) {
      yield* transaction.insert(inventoryCommitmentProtections).values(valuesForProtection(protection));
    }
  });

it.live(
  'runs binding correction through the production Action runtime and persists every owner impact atomically',
  () =>
    Effect.scoped(
      Effect.gen(function* bindingCorrectionProductionAcceptance() {
        const { admin: adminPool, runtimePool } = yield* testDatabasePools;
        const admin = yield* makeTestDatabaseFromPool(adminPool, inventoryRelations);
        const coreAdmin = yield* makeTestDatabaseFromPool(adminPool, coreRelations);
        const runtimeDatabase = yield* makeTestDatabaseFromPool(runtimePool, coreRelations);
        yield* cleanupTenant(admin, tenantId);
        yield* cleanupTenant(admin, otherTenantId);
        yield* cleanupCoreTenant(coreAdmin);
        yield* Effect.addFinalizer(() =>
          Effect.all([
            cleanupTenant(admin, tenantId),
            cleanupTenant(admin, otherTenantId),
            cleanupCoreTenant(coreAdmin),
          ]).pipe(Effect.orDie),
        );
        yield* coreAdmin.insert(tenants).values({
          defaultLocale: 'en',
          name: 'Inventory binding correction Action acceptance',
          slug: `inventory-binding-correction-${tenantId}`,
          status: 'active',
          tenantId,
        });
        yield* coreAdmin.insert(principals).values({
          displayName: 'Inventory binding correction operator',
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
          providerSubjectId: `inventory-binding-correction-${principalId}`,
          status: 'active',
          subjectType: 'user',
          tenantId,
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

        const fixtureLineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
        // The production Action uses the live clock, so this acceptance fixture must remain live when the test runs.
        const liveExpiry = '9999-12-31T23:59:59.999Z';
        const base = {
          confirmation: replaceStrings(ReservationConfirmationSchema, fixtureLineage.confirmation, {
            '2026-09-25T12:00:00.000Z': liveExpiry,
          }),
          protection: replaceStrings(CommitmentProtectionSchema, fixtureLineage.protection, {
            '2026-09-25T12:00:00.000Z': liveExpiry,
          }),
        };
        const secondConfirmation = replaceStrings(ReservationConfirmationSchema, base.confirmation, {
          '99999999-9999-4999-8999-999999999999': '99999999-9999-4999-8999-999999999992',
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
          'owner-acceptance-allocation-1': 'owner-acceptance-allocation-2',
          'owner-acceptance-attempt-1': 'owner-acceptance-attempt-2',
          'owner-acceptance-confirmation-effect-1': 'owner-acceptance-confirmation-effect-2',
          'owner-acceptance-confirmation-proof-1': 'owner-acceptance-confirmation-proof-2',
          'owner-acceptance-demand-1': 'owner-acceptance-demand-2',
        });
        const thirdConfirmation = replaceStrings(ReservationConfirmationSchema, base.confirmation, {
          '99999999-9999-4999-8999-999999999999': '99999999-9999-4999-8999-999999999993',
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
          'owner-acceptance-allocation-1': 'owner-acceptance-allocation-3',
          'owner-acceptance-attempt-1': 'owner-acceptance-attempt-3',
          'owner-acceptance-confirmation-effect-1': 'owner-acceptance-confirmation-effect-3',
          'owner-acceptance-confirmation-proof-1': 'owner-acceptance-confirmation-proof-3',
          'owner-acceptance-demand-1': 'owner-acceptance-demand-3',
        });
        const alreadyAtRisk = yield* advanceReservationConfirmationHealth(thirdConfirmation, {
          _tag: 'MATERIAL_IMPAIRMENT',
          effectiveAt: '2026-09-25T10:03:00.000Z',
          ownerEvidenceRef: 'material-impairment:before-binding-correction',
        });
        const staleReplacements = {
          '99999999-9999-4999-8999-999999999999': '99999999-9999-4999-8999-999999999994',
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd': 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
          'owner-acceptance-allocation-1': 'owner-acceptance-allocation-4',
          'owner-acceptance-attempt-1': 'owner-acceptance-attempt-4',
          'owner-acceptance-confirmation-effect-1': 'owner-acceptance-confirmation-effect-4',
          'owner-acceptance-confirmation-proof-1': 'owner-acceptance-confirmation-proof-4',
          'owner-acceptance-demand-1': 'owner-acceptance-demand-4',
          'owner-acceptance-protection-effect-1': 'owner-acceptance-protection-effect-4',
          'owner-acceptance-protection-proof-1': 'owner-acceptance-protection-proof-4',
        } as const;
        const staleConfirmation = replaceStrings(ReservationConfirmationSchema, base.confirmation, staleReplacements);
        const staleProtection = replaceStrings(CommitmentProtectionSchema, base.protection, staleReplacements);
        const workerReservation = replaceStrings(ProvisionalInventoryReservationSchema, staleConfirmation.reservation, {
          '99999999-9999-4999-8999-999999999994': '99999999-9999-4999-8999-999999999995',
          'owner-acceptance-allocation-4': 'owner-acceptance-allocation-5',
          'owner-acceptance-attempt-4': 'owner-acceptance-attempt-5',
          'owner-acceptance-demand-4': 'owner-acceptance-demand-5',
        });
        const workerLegalEntityId = 'abababab-abab-4bab-8bab-abababababab';
        const workerRequest = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
          authority: fixture.authority,
          commerceContext: {
            channel: 'B2C',
            commerceMarketRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: 'binding-correction-worker-market',
              resourceType: 'commerce.market-catalog.market',
              tenantId,
            },
            customerConfigurationId: fixture.authority.customerConfigurationId,
            evidenceRef: 'binding-correction-worker-commerce-context',
            observedAt: '2026-09-25T10:00:00.000Z',
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: workerLegalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            status: 'CURRENT_OWNER_VERIFIED',
            storefrontRef: { appId: 'binding-correction-worker-storefront', tenantId },
            tenantId,
          },
          effectId: 'binding-correction-worker-finalizer-effect',
          legalEntityId: workerLegalEntityId,
          mutationId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
          requestedAt: '2026-09-25T10:00:00.000Z',
          reservation: {
            origin: workerReservation.origin,
            ref: workerReservation.ref,
            requirements: workerReservation.requirements,
          },
          sourceActionInvocationId: 'efefefef-efef-4fef-8fef-efefefefefef',
        });
        const workerTerminal = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)({
          _tag: 'ESTABLISHED',
          ownerEvidenceRef: 'binding-correction-worker-owner-evidence',
          request: workerRequest,
          reservation: workerReservation,
        });

        yield* admin.transaction((transaction) =>
          Effect.gen(function* seedProductionState() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.insert(inventoryBackendConfigurations).values({
              backendId: fixture.authority.selection.backendId,
              backendKind: fixture.authority.selection.backend,
              configurationId: fixture.authority.configurationId,
              customerConfigurationId: fixture.authority.customerConfigurationId,
              exactReservationCapability: fixture.authority.selection.exactReservationCapability,
              revision: fixture.authority.revision,
              selectedAt: new Date(fixture.authority.selectedAt),
              stockCorrectionCapability: fixture.authority.selection.stockCorrectionCapability,
              tenantId,
            });
            yield* seedStockAndBinding(transaction);
            yield* seedLineage(transaction, base.confirmation, base.protection, 'COMMITTED_OBLIGATION');
            yield* seedLineage(transaction, secondConfirmation, undefined, 'PROVISIONAL_RESERVATION');
            yield* seedLineage(transaction, alreadyAtRisk, undefined, 'COMMITTED_OBLIGATION');
            yield* transaction.insert(inventoryStockItems).values([
              {
                createdAt: new Date('2026-09-25T09:00:00.000Z'),
                exactSelectionKind: 'PRODUCT_VARIANT',
                exactSelectionMeaningId: 'catalog:unrelated-same-tenant',
                lifecycleState: 'CURRENT',
                retiredAt: null,
                stockItemId: unrelatedItemId,
                stockUnitModuleId: 'commerce.catalog',
                stockUnitResourceId: fixture.originalStockItem.unitRef.resourceId,
                stockUnitResourceType: 'commerce.catalog.product-unit',
                stockUnitTenantId: tenantId,
                tenantId,
              },
              {
                createdAt: new Date('2026-09-25T09:00:00.000Z'),
                exactSelectionKind: 'PRODUCT_VARIANT',
                exactSelectionMeaningId: fixture.originalBinding.exactSelectionMeaning.id,
                lifecycleState: 'CURRENT',
                retiredAt: null,
                stockItemId: otherTenantItemId,
                stockUnitModuleId: 'commerce.catalog',
                stockUnitResourceId: fixture.originalStockItem.unitRef.resourceId,
                stockUnitResourceType: 'commerce.catalog.product-unit',
                stockUnitTenantId: otherTenantId,
                tenantId: otherTenantId,
              },
            ]);
            yield* transaction.insert(inventoryCatalogToStockBindings).values([
              {
                bindingId: unrelatedBindingId,
                catalogSelection: fixture.selection,
                currentRevision: 1,
                effectiveFrom: new Date('2026-09-25T09:00:00.000Z'),
                exactSelectionKind: 'PRODUCT_VARIANT',
                exactSelectionMeaningId: 'catalog:unrelated-same-tenant',
                stockItemId: unrelatedItemId,
                stockUnitModuleId: 'commerce.catalog',
                stockUnitResourceId: fixture.originalStockItem.unitRef.resourceId,
                stockUnitResourceType: 'commerce.catalog.product-unit',
                stockUnitTenantId: tenantId,
                tenantId,
              },
              {
                bindingId: otherTenantBindingId,
                catalogSelection: fixture.selection,
                currentRevision: 1,
                effectiveFrom: new Date('2026-09-25T09:00:00.000Z'),
                exactSelectionKind: fixture.originalBinding.exactSelectionMeaning.kind,
                exactSelectionMeaningId: fixture.originalBinding.exactSelectionMeaning.id,
                stockItemId: otherTenantItemId,
                stockUnitModuleId: 'commerce.catalog',
                stockUnitResourceId: fixture.originalStockItem.unitRef.resourceId,
                stockUnitResourceType: 'commerce.catalog.product-unit',
                stockUnitTenantId: otherTenantId,
                tenantId: otherTenantId,
              },
            ]);
            yield* transaction.insert(inventoryReservationConfirmationHistory).values([
              {
                confirmationId: base.confirmation.ref.resourceId,
                healthState: base.confirmation.health.state,
                revision: 1,
                snapshot: base.confirmation,
                tenantId,
                transitionedAt: new Date(base.confirmation.health.observation.effectiveAt),
              },
              {
                confirmationId: base.confirmation.ref.resourceId,
                healthState: base.confirmation.health.state,
                revision: 2,
                snapshot: base.confirmation,
                tenantId,
                transitionedAt: new Date('2026-09-25T10:04:00.000Z'),
              },
            ]);
          }),
        );

        yield* admin.transaction((transaction) =>
          Effect.gen(function* proveWorkerAuthorityCapabilities() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.insert(inventoryReservationCreateEffects).values({
              attemptId: workerRequest.reservation.origin.attemptId,
              backendConfigurationId: workerRequest.authority.configurationId,
              backendId: workerRequest.authority.selection.backendId,
              customerConfigurationId: workerRequest.authority.customerConfigurationId,
              effectId: workerRequest.effectId,
              legalEntityId: workerRequest.legalEntityId,
              mutationId: workerRequest.mutationId,
              recordJson: { _tag: 'REQUESTED', request: workerRequest },
              requestedAt: new Date(workerRequest.requestedAt),
              requestJson: workerRequest,
              reservationId: workerRequest.reservation.ref.resourceId,
              sourceActionInvocationId: workerRequest.sourceActionInvocationId,
              state: 'REQUESTED',
              tenantId,
            });
            yield* transaction.execute(sql`select pg_catalog.set_config('ontos.tenant_id', ${tenantId}, true)`);
            yield* transaction.execute(
              sql`select pg_catalog.set_config('ontos.legal_entity_id', ${workerLegalEntityId}, true)`,
            );
            yield* transaction.execute(
              sql`select * from "inventory"."finalize_reservation_create_effect_for_worker"(
                ${tenantId}::uuid,
                ${workerLegalEntityId}::uuid,
                ${workerRequest.effectId},
                ${JSON.stringify(workerTerminal)}::jsonb
              )`,
            );
            const [workerObligation] = yield* transaction
              .select()
              .from(inventoryObligations)
              .where(eq(inventoryObligations.obligationId, workerReservation.ref.resourceId));
            expect(workerObligation).toMatchObject({
              authorityExactReservationCapability: fixture.authority.selection.exactReservationCapability,
              authorityStockCorrectionCapability: fixture.authority.selection.stockCorrectionCapability,
            });
            yield* transaction
              .delete(inventoryObligationAllocations)
              .where(eq(inventoryObligationAllocations.obligationId, workerReservation.ref.resourceId));
            yield* transaction
              .delete(inventoryObligationRequirements)
              .where(eq(inventoryObligationRequirements.obligationId, workerReservation.ref.resourceId));
            yield* transaction
              .delete(inventoryObligations)
              .where(eq(inventoryObligations.obligationId, workerReservation.ref.resourceId));
            yield* transaction
              .delete(inventoryReservationCreateEffects)
              .where(eq(inventoryReservationCreateEffects.effectId, workerRequest.effectId));
          }),
        );

        const collector = createActionCollector(
          correctCatalogToStockBindingAction.descriptor.domainEvents,
          'commerce.inventory',
          correctCatalogToStockBindingAction.descriptor.accessEvidencePolicy,
          correctCatalogToStockBindingAction.descriptor.auditEvidenceSchema,
        );
        const payload = Schema.decodeUnknownSync(CorrectCatalogToStockBindingPayloadSchema)({
          bindingRef: fixture.originalBinding.bindingRef,
          candidate: {
            catalogSelection: fixture.selection,
            exactSelectionMeaning: fixture.correctedStockItem.exactSelectionMeaning,
            stockItem: fixture.correctedStockItem,
          },
          evidence: {
            authority: 'INVENTORY_BINDING_OWNER',
            ownerEvidenceRef: 'binding-correction:postgres-acceptance',
          },
        });
        const runInjectedFailure = runtimeDatabase.transaction((transaction) =>
          Effect.gen(function* runProductionFactory() {
            const scope = {
              authMethod: 'api_key',
              correlationId: 'binding-correction-production-postgres',
              principalId,
              tenantId,
            } as const;
            const scoped = yield* installOperationalScope(transaction, scope);
            const services = yield* makeCorrectCatalogToStockBindingServices(scoped, scope);
            return yield* handleCorrectCatalogToStockBinding(payload, {
              actionInvocationId: randomUUID(),
              addDomainEvent: collector.addDomainEvent,
              addOutboxMessage: collector.addOutboxMessage,
              recordAuditEvidence: collector.recordAuditEvidence,
              recordDataAccess: collector.recordDataAccess,
              scope: trustVerifiedGatewayPrincipalContext({
                authBindingId: randomUUID(),
                authContextRef: 'test:binding-correction-production-postgres',
                authMethod: 'api_key',
                correlationId: 'binding-correction-production-postgres',
                principalId,
                tenantId,
              }),
              services,
            });
          }),
        );

        const failed = yield* Effect.flip(runInjectedFailure);
        expect(failed).toBeDefined();
        const [rolledBackBinding] = yield* admin
          .select()
          .from(inventoryCatalogToStockBindings)
          .where(eq(inventoryCatalogToStockBindings.bindingId, fixture.originalBinding.bindingRef.resourceId));
        const rolledBackDebt = yield* admin
          .select()
          .from(inventoryBindingCorrectionReconciliations)
          .where(eq(inventoryBindingCorrectionReconciliations.tenantId, tenantId));
        expect(rolledBackBinding?.stockItemId).toBe(fixture.originalStockItem.stockItemRef.resourceId);
        expect(rolledBackDebt).toEqual([]);
        yield* admin.transaction((transaction) =>
          Effect.gen(function* removeInjectedFailure() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction
              .delete(inventoryReservationConfirmationHistory)
              .where(
                and(
                  eq(inventoryReservationConfirmationHistory.tenantId, tenantId),
                  eq(inventoryReservationConfirmationHistory.confirmationId, base.confirmation.ref.resourceId),
                  eq(inventoryReservationConfirmationHistory.revision, 2),
                ),
              );
          }),
        );

        const runCorrectionThroughActionRuntime = actionRuntime.runAction({
          payload,
          principal,
          registration: correctCatalogToStockBindingAction,
          transport: {
            correlationId: 'binding-correction-production-postgres-action',
            idempotencyKey: 'binding-correction-production-postgres-action',
          },
        });

        const readGates = [
          yield* Deferred.make<null>(),
          yield* Deferred.make<null>(),
          yield* Deferred.make<null>(),
        ] as const;
        const release = yield* Deferred.make<null>();
        const staleAttempt = (index: 0 | 1 | 2) =>
          Effect.exit(
            runtimeDatabase.transaction((transaction) =>
              Effect.gen(function* staleEstablishment() {
                const scope = {
                  authMethod: 'api_key',
                  correlationId: 'binding-correction-stale-establishment',
                  principalId,
                  tenantId,
                } as const;
                const scoped = yield* installOperationalScope(transaction, scope);
                yield* scoped
                  .select()
                  .from(inventoryCatalogToStockBindings)
                  .where(eq(inventoryCatalogToStockBindings.bindingId, fixture.originalBinding.bindingRef.resourceId));
                yield* Deferred.succeed(readGates[index], null);
                yield* Deferred.await(release);
                if (index === 0) {
                  return yield* inventoryObligationPersistenceForScope(scoped, scope).establishReservation(
                    staleConfirmation.reservation,
                  );
                }
                if (index === 1) {
                  return yield* reservationConfirmationPersistenceForScope(scoped, scope).createOrRead(
                    staleConfirmation,
                  );
                }
                return yield* commitmentProtectionPersistenceForScope(scoped, scope).createOrRead(staleProtection);
              }),
            ),
          );
        const fibers = [
          yield* Effect.forkScoped(staleAttempt(0)),
          yield* Effect.forkScoped(staleAttempt(1)),
          yield* Effect.forkScoped(staleAttempt(2)),
        ] as const;
        yield* Effect.all(readGates.map(Deferred.await));
        const corrected = yield* runCorrectionThroughActionRuntime;
        yield* Deferred.succeed(release, null);
        const staleResults = yield* Effect.all(fibers.map(Fiber.join));
        const staleFailures = staleResults.map((exit) =>
          Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
        );
        expect(Schema.is(InventoryObligationRejected)(staleFailures[0])).toBe(true);
        expect(staleFailures[0]).toMatchObject({ reason: 'INVALID_PERSISTED_OBLIGATION' });
        expect(Schema.is(ReservationConfirmationRejected)(staleFailures[1])).toBe(true);
        expect(staleFailures[1]).toMatchObject({ reason: 'RESERVATION_SCOPE_MISMATCH' });
        expect(Schema.is(CommitmentProtectionRejected)(staleFailures[2])).toBe(true);
        expect(staleFailures[2]).toMatchObject({ reason: 'CONFIRMATION_SCOPE_MISMATCH' });

        const rolledBackStaleObligations = yield* admin
          .select()
          .from(inventoryObligations)
          .where(
            and(
              eq(inventoryObligations.tenantId, tenantId),
              eq(inventoryObligations.obligationId, staleConfirmation.reservation.ref.resourceId),
            ),
          );
        expect(rolledBackStaleObligations).toEqual([]);

        const confirmations = yield* admin
          .select()
          .from(inventoryReservationConfirmations)
          .where(eq(inventoryReservationConfirmations.tenantId, tenantId));
        const protections = yield* admin
          .select()
          .from(inventoryCommitmentProtections)
          .where(eq(inventoryCommitmentProtections.tenantId, tenantId));
        const debts = yield* admin
          .select()
          .from(inventoryBindingCorrectionReconciliations)
          .where(eq(inventoryBindingCorrectionReconciliations.tenantId, tenantId));
        const requirements = yield* admin
          .select()
          .from(inventoryObligationRequirements)
          .where(eq(inventoryObligationRequirements.tenantId, tenantId));
        const allocations = yield* admin
          .select()
          .from(inventoryObligationAllocations)
          .where(eq(inventoryObligationAllocations.tenantId, tenantId));
        const releaseEffects = yield* admin
          .select()
          .from(inventoryReservationReleaseEffects)
          .where(eq(inventoryReservationReleaseEffects.tenantId, tenantId));
        const [storedBinding] = yield* admin
          .select()
          .from(inventoryCatalogToStockBindings)
          .where(
            and(
              eq(inventoryCatalogToStockBindings.tenantId, tenantId),
              eq(inventoryCatalogToStockBindings.bindingId, fixture.originalBinding.bindingRef.resourceId),
            ),
          );
        const unrelatedBindings = yield* admin
          .select()
          .from(inventoryCatalogToStockBindings)
          .where(sql`${inventoryCatalogToStockBindings.bindingId} in (${unrelatedBindingId}, ${otherTenantBindingId})`);
        const futureBindings = yield* runtimeDatabase.transaction((transaction) =>
          Effect.gen(function* resolveFutureCurrentBinding() {
            const scope = {
              authMethod: 'session',
              correlationId: 'binding-correction-future-binding-resolution',
              principalId,
              tenantId,
            } as const;
            const scoped = yield* installOperationalScope(transaction, scope);
            return yield* makeDrizzleCatalogToStockBindingPersistence(scoped).findCurrentByExactSelectionMeaning(
              tenantId,
              fixture.originalBinding.exactSelectionMeaning,
            );
          }),
        );

        expect(corrected.stockItemRef.resourceId).toBe(fixture.correctedStockItem.stockItemRef.resourceId);
        expect(storedBinding?.stockItemId).toBe(fixture.correctedStockItem.stockItemRef.resourceId);
        expect(futureBindings).toHaveLength(1);
        expect(futureBindings[0]?.stockItemRef.resourceId).toBe(fixture.correctedStockItem.stockItemRef.resourceId);
        expect(confirmations).toHaveLength(3);
        expect(confirmations.map(({ currentHealthState }) => currentHealthState)).toEqual([
          'AT_RISK',
          'AT_RISK',
          'AT_RISK',
        ]);
        expect(
          confirmations.find(({ confirmationId }) => confirmationId === alreadyAtRisk.ref.resourceId)?.currentRevision,
        ).toBe(3);
        expect(protections).toHaveLength(1);
        expect(protections[0]).toMatchObject({ currentHealthState: 'AT_RISK', currentRevision: 2 });
        expect(debts).toHaveLength(2);
        expect(
          debts.every(({ currentStockItemId, historicalStockItemId }) => historicalStockItemId !== currentStockItemId),
        ).toBe(true);
        expect(requirements).toHaveLength(3);
        expect(
          requirements.every(
            ({ bindingId, stockItemId }) =>
              bindingId === fixture.originalBinding.bindingRef.resourceId &&
              stockItemId === fixture.originalStockItem.stockItemRef.resourceId,
          ),
        ).toBe(true);
        expect(
          requirements.some(({ stockItemId }) => stockItemId === fixture.correctedStockItem.stockItemRef.resourceId),
        ).toBe(false);
        expect(allocations).toHaveLength(3);
        expect(
          allocations.every(({ stockItemId }) => stockItemId === fixture.originalStockItem.stockItemRef.resourceId),
        ).toBe(true);
        expect(
          allocations.some(({ stockItemId }) => stockItemId === fixture.correctedStockItem.stockItemRef.resourceId),
        ).toBe(false);
        expect(releaseEffects).toEqual([]);
        expect(unrelatedBindings.map(({ bindingId, stockItemId }) => ({ bindingId, stockItemId }))).toEqual([
          { bindingId: unrelatedBindingId, stockItemId: unrelatedItemId },
          { bindingId: otherTenantBindingId, stockItemId: otherTenantItemId },
        ]);
        const confirmationIdentityMutation = yield* Effect.flip(
          admin
            .update(inventoryReservationConfirmations)
            .set({ attemptId: 'mutated-attempt' })
            .where(eq(inventoryReservationConfirmations.confirmationId, base.confirmation.ref.resourceId)),
        );
        const protectionIdentityMutation = yield* Effect.flip(
          admin
            .update(inventoryCommitmentProtections)
            .set({ reservationId: randomUUID() })
            .where(eq(inventoryCommitmentProtections.protectionId, base.protection.ref.resourceId)),
        );
        expect(confirmationIdentityMutation).toBeDefined();
        expect(protectionIdentityMutation).toBeDefined();
        const [storedProtection] = protections;
        if (storedProtection === undefined) {
          return;
        }
        const protectionEvidenceMutation = yield* Effect.flip(
          admin
            .update(inventoryCommitmentProtections)
            .set({
              snapshot: replaceStrings(CommitmentProtectionSchema, storedProtection.snapshot, {
                'owner-acceptance-allocation-1': 'mutated-embedded-allocation',
              }),
            })
            .where(eq(inventoryCommitmentProtections.protectionId, base.protection.ref.resourceId)),
        );
        expect(protectionEvidenceMutation).toBeDefined();
      }),
    ),
);

it.live('enforces Current-only exact-meaning uniqueness in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* currentStockItemUniquenessRegression() {
      const { admin: adminPool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, inventoryRelations);
      const localTenant = randomUUID();
      yield* Effect.addFinalizer(() => cleanupTenant(admin, localTenant).pipe(Effect.orDie));
      const shared = {
        exactSelectionKind: 'PRODUCT_VARIANT',
        exactSelectionMeaningId: 'catalog:historical-and-current',
        stockUnitModuleId: 'commerce.catalog',
        stockUnitResourceId: randomUUID(),
        stockUnitResourceType: 'commerce.catalog.product-unit',
        stockUnitTenantId: localTenant,
        tenantId: localTenant,
      } as const;
      yield* admin.insert(inventoryStockItems).values({
        ...shared,
        lifecycleState: 'RETIRED',
        retiredAt: new Date('2026-09-25T10:00:00.000Z'),
        stockItemId: randomUUID(),
      });
      yield* admin
        .insert(inventoryStockItems)
        .values({ ...shared, lifecycleState: 'CURRENT', retiredAt: null, stockItemId: randomUUID() });
      const duplicate = yield* Effect.flip(
        admin
          .insert(inventoryStockItems)
          .values({ ...shared, lifecycleState: 'CURRENT', retiredAt: null, stockItemId: randomUUID() }),
      );
      expect(duplicate).toBeDefined();
    }),
  ),
);
