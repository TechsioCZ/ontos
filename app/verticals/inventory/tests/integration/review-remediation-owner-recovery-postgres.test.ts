import { and, eq, inArray, sql } from 'drizzle-orm';
import { Context, Effect, Match, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  actionInvocations,
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
import { RecoverInventoryEffectPayloadSchema } from '../../shared/actions/recover-inventory-effect.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  InventoryEffectLedgerEffectIdSchema,
  PhysicalIssueInventoryEffectLedgerResolutionSchema,
  ReservationCreateInventoryEffectLedgerIntentSchema,
} from '../../shared/domain/inventory-effect-ledger.ts';
import {
  AlreadyTerminalInventoryEffectResultSchema,
  RecoveredInventoryEffectResultSchema,
} from '../../shared/domain/inventory-effect-recovery.ts';
import { ProvisionalInventoryReservationSchema } from '../../shared/domain/inventory-obligation.ts';
import {
  PhysicalStockEffectRecordSchema,
  PhysicalStockEffectRequestSchema,
} from '../../shared/domain/physical-stock-effect.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { recoverInventoryEffectAction } from '../../src/actions/recover-inventory-effect.action.ts';
import {
  inventoryBackendConfigurations,
  inventoryCatalogToStockBindings,
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
  inventoryPhysicalStockEffects,
  inventoryRelations,
  inventoryReservationCreateEffects,
  inventoryStockItems,
  inventoryStockLocations,
  inventoryStockPositions,
} from '../../src/database/schema.ts';
import { inventoryEffectLedgerPersistenceForScope } from '../../src/persistence/inventory-effect-ledger-repository.ts';
import { physicalStockEffectPersistenceForScope } from '../../src/persistence/physical-stock-effect-repository.ts';
import { reservationCreateEffectPersistenceForScope } from '../../src/persistence/reservation-create-effect-repository.ts';
import type { InventoryEffectRecoveryAuthority } from '../../src/services/inventory-effect-recovery-authority.ts';
import { InventoryEffectRecoveryAuthorityPort } from '../../src/services/inventory-effect-recovery-authority.ts';
import {
  makeInventoryEffectLedgerService,
  physicalStockLedgerIntent,
  reservationCreateLedgerIntent,
} from '../../src/services/inventory-effect-ledger.service.ts';
import {
  buildInventoryOwnerAcceptanceBindingCorrectionLineage,
  inventoryOwnerAcceptanceBindingCorrectionFixture,
} from '../support/inventory-owner-acceptance-binding-correction.ts';

const InventoryEffectRecoveryAuthorityRequirement = Context.Service<
  InventoryEffectRecoveryAuthority,
  InventoryEffectRecoveryAuthority
>()(InventoryEffectRecoveryAuthorityPort.key);

const sourceTenantId = '11111111-1111-4111-8111-111111111111';
const tenantId = 'a1111111-1111-4111-8111-111111111111';
const legalEntityId = 'a2121212-1212-4121-8121-121212121212';
const principalId = 'a3131313-1313-4131-8131-131313131313';
const authBindingId = 'a4141414-1414-4141-8141-141414141414';
const authenticationNamespaceId = 'test.inventory-owner-recovery.v1';

const replacements = {
  '22222222-2222-4222-8222-222222222222': 'a2222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333': 'a3333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444': 'a4444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555': 'a5555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666': 'a6666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777': 'a7777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888': 'a8888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999': 'a9999999-9999-4999-8999-999999999999',
  [sourceTenantId]: tenantId,
} as const;

const replaceStrings = <A>(schema: Schema.Codec<A, unknown>, value: A): A => {
  let encoded = JSON.stringify(value);
  for (const [from, to] of Object.entries(replacements)) {
    encoded = encoded.replaceAll(from, to);
  }
  return Schema.decodeUnknownSync(schema)(JSON.parse(encoded));
};

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const contextAccess: ContextAccessService = {
  businessPermissions: ({ targets }) =>
    Effect.succeed(
      targets.map((target) => ({ decision: 'allowed' as const, key: toBusinessPermissionAccessKey(target) })),
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

const principal = {
  authBindingId,
  authContextRef: `better-auth-session:${authBindingId}`,
  authenticationNamespaceId,
  authMethod: 'session' as const,
  legalEntityId,
  principalId,
  tenantId,
};

type InventoryTestDatabase = TestDatabaseFromClient<typeof inventoryRelations>;

const cleanupInventory = (database: InventoryTestDatabase) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupOwnerRecoveryInventory() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
      for (const table of [
        inventoryEffectLedgerHistory,
        inventoryEffectLedger,
        inventoryPhysicalStockEffects,
        inventoryObligationAllocations,
        inventoryObligationRequirements,
        inventoryObligations,
        inventoryReservationCreateEffects,
        inventoryCatalogToStockBindings,
        inventoryStockPositions,
        inventoryStockLocations,
        inventoryStockItems,
        inventoryBackendConfigurations,
      ]) {
        yield* transaction.delete(table).where(eq(table.tenantId, tenantId));
      }
    }),
  );

const cleanupCore = (database: TestDatabaseFromClient<typeof coreRelations>) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupOwnerRecoveryCore() {
      for (const table of [
        outboxMessages,
        domainEvents,
        dataAccessEvents,
        auditEvents,
        actionInvocations,
        principalAuthBindings,
        principals,
        legalEntities,
        tenants,
      ]) {
        yield* transaction.delete(table).where(eq(table.tenantId, tenantId));
      }
    }),
  );

it.live('repairs physical and reservation owner state before terminal recovery without duplicate effects', () =>
  Effect.scoped(
    Effect.gen(function* ownerRecoveryProductionAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, inventoryRelations);
      const coreAdmin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtimeDatabase = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);

      yield* cleanupInventory(admin);
      yield* cleanupCore(coreAdmin);
      yield* Effect.addFinalizer(() =>
        Effect.all([cleanupInventory(admin), cleanupCore(coreAdmin)]).pipe(Effect.orDie),
      );

      yield* coreAdmin.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Inventory owner recovery acceptance',
        slug: `inventory-owner-recovery-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* coreAdmin.insert(legalEntities).values({
        legalEntityId,
        legalName: 'Inventory owner recovery legal entity',
        registrationCountry: 'CZ',
        registrationNumber: `OWNER-RECOVERY-${legalEntityId}`,
        status: 'active',
        tenantId,
      });
      yield* coreAdmin.insert(principals).values({
        displayName: 'Inventory owner recovery operator',
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
        providerSubjectId: `inventory-owner-recovery-${principalId}`,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });

      const fixture = inventoryOwnerAcceptanceBindingCorrectionFixture;
      const baseLineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
      const authorityConfiguration = replaceStrings(InventoryBackendConfigurationSchema, fixture.authority);
      const stockItem = replaceStrings(StockItemSchema, fixture.originalStockItem);
      const binding = replaceStrings(CatalogToStockBindingSchema, fixture.originalBinding);
      const reservation = replaceStrings(ProvisionalInventoryReservationSchema, baseLineage.reservation);
      const positionRef = reservation.requirements[0]?.allocations[0]?.positionRef;
      const unitRef = reservation.requirements[0]?.unitRef;
      if (positionRef === undefined || unitRef === undefined) {
        yield* Effect.die('owner recovery fixture requires one allocated stock position');
      }
      const stockLocationRef = {
        moduleId: 'commerce.inventory' as const,
        resourceId: 'a6666666-6666-4666-8666-666666666666',
        resourceType: 'commerce.inventory.stock-location' as const,
        tenantId,
      };

      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedInventoryScope() {
          yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
          yield* transaction.insert(inventoryBackendConfigurations).values({
            backendId: authorityConfiguration.selection.backendId,
            backendKind: authorityConfiguration.selection.backend,
            configurationId: authorityConfiguration.configurationId,
            customerConfigurationId: authorityConfiguration.customerConfigurationId,
            exactReservationCapability: authorityConfiguration.selection.exactReservationCapability,
            revision: authorityConfiguration.revision,
            selectedAt: new Date(authorityConfiguration.selectedAt),
            stockCorrectionCapability: authorityConfiguration.selection.stockCorrectionCapability,
            tenantId,
          });
          yield* transaction.insert(inventoryStockItems).values({
            createdAt: new Date(stockItem.createdAt),
            exactSelectionKind: stockItem.exactSelectionMeaning.kind,
            exactSelectionMeaningId: stockItem.exactSelectionMeaning.id,
            lifecycleState: 'CURRENT',
            retiredAt: null,
            revision: stockItem.revision,
            stockItemId: stockItem.stockItemRef.resourceId,
            stockUnitModuleId: stockItem.unitRef.moduleId,
            stockUnitResourceId: stockItem.unitRef.resourceId,
            stockUnitResourceType: stockItem.unitRef.resourceType,
            stockUnitTenantId: tenantId,
            tenantId,
          });
          yield* transaction.insert(inventoryStockLocations).values({
            addressEvidence: null,
            currentRevision: 1,
            displayName: 'Owner recovery warehouse',
            lifecycleState: 'ACTIVE',
            physicalSiteKeys: ['owner-recovery-warehouse'],
            scopeKind: 'PHYSICAL_SITE',
            stockLocationId: stockLocationRef.resourceId,
            successorStockLocationId: null,
            tenantId,
            transitionedAt: null,
            transitionReason: null,
          });
          yield* transaction.insert(inventoryStockPositions).values({
            customerConfigurationId: authorityConfiguration.customerConfigurationId,
            endedAt: null,
            lifecycleState: 'CURRENT',
            onHandAmount: '10',
            onHandEvidenceRef: 'owner-recovery:on-hand',
            onHandObservedAt: new Date('2026-09-25T09:30:00.000Z'),
            onHandState: 'CURRENT',
            ownerConfigurationId: authorityConfiguration.configurationId,
            revision: 1,
            stockItemId: stockItem.stockItemRef.resourceId,
            stockLocationId: stockLocationRef.resourceId,
            stockPositionId: positionRef.resourceId,
            stockUnitModuleId: unitRef.moduleId,
            stockUnitResourceId: unitRef.resourceId,
            stockUnitResourceType: unitRef.resourceType,
            stockUnitTenantId: tenantId,
            tenantId,
          });
          yield* transaction.insert(inventoryCatalogToStockBindings).values({
            bindingId: binding.bindingRef.resourceId,
            catalogSelection: binding.catalogSelection,
            currentRevision: binding.revision,
            effectiveFrom: new Date(binding.effectiveFrom),
            exactSelectionKind: binding.exactSelectionMeaning.kind,
            exactSelectionMeaningId: binding.exactSelectionMeaning.id,
            stockItemId: binding.stockItemRef.resourceId,
            stockUnitModuleId: binding.unitRef.moduleId,
            stockUnitResourceId: binding.unitRef.resourceId,
            stockUnitResourceType: binding.unitRef.resourceType,
            stockUnitTenantId: tenantId,
            tenantId,
          });
        }),
      );

      const physicalRequest = Schema.decodeUnknownSync(PhysicalStockEffectRequestSchema)({
        actionInvocationId: 'a8181818-1818-4181-8181-181818181818',
        backend: authorityConfiguration.selection.backend,
        backendConfigurationRef: {
          moduleId: 'commerce.inventory',
          resourceId: authorityConfiguration.configurationId,
          resourceType: 'commerce.inventory.inventory-backend-configuration',
          tenantId,
        },
        backendId: authorityConfiguration.selection.backendId,
        customerConfigurationId: authorityConfiguration.customerConfigurationId,
        effectId: 'a9191919-1919-4191-8191-191919191919',
        kind: 'ISSUE',
        legalEntityId,
        positionRef,
        quantity: { amount: '2', unitRef },
        reason: { code: 'ORDER_FULFILLMENT', reference: 'owner-recovery-order' },
        requestedAt: '2026-09-25T10:30:00.000Z',
        stockItemRef: stockItem.stockItemRef,
        stockLocationRef,
      });
      const physicalTerminal = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
        _tag: 'APPLIED',
        evidence: {
          appliedAt: '2026-09-25T10:31:00.000Z',
          backend: physicalRequest.backend,
          backendConfigurationRef: physicalRequest.backendConfigurationRef,
          backendEvidenceRef: 'owner-recovery:physical-issue',
          backendId: physicalRequest.backendId,
          effectId: physicalRequest.effectId,
          issuer: physicalRequest.backendId,
          kind: physicalRequest.kind,
          positionRef: physicalRequest.positionRef,
          quantity: physicalRequest.quantity,
        },
        request: physicalRequest,
      });
      const physicalResolution = Schema.decodeUnknownSync(PhysicalIssueInventoryEffectLedgerResolutionSchema)({
        _tag: 'PHYSICAL_ISSUE',
        effect: physicalTerminal,
      });

      const createRequest = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
        authority: authorityConfiguration,
        commerceContext: {
          channel: 'B2C',
          commerceMarketRef: {
            moduleId: 'commerce.market-catalog',
            resourceId: 'owner-recovery-market',
            resourceType: 'commerce.market-catalog.market',
            tenantId,
          },
          customerConfigurationId: authorityConfiguration.customerConfigurationId,
          evidenceRef: 'owner-recovery-commerce-context',
          observedAt: '2026-09-25T10:00:00.000Z',
          sellingLegalEntityRef: {
            moduleId: 'core.identity',
            resourceId: legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId,
          },
          status: 'CURRENT_OWNER_VERIFIED',
          storefrontRef: { appId: 'owner-recovery-storefront', tenantId },
          tenantId,
        },
        effectId: 'owner-recovery-reservation-create-effect',
        legalEntityId,
        mutationId: 'ab121212-1212-4121-8121-121212121212',
        requestedAt: '2026-09-25T10:00:00.000Z',
        reservation: {
          origin: reservation.origin,
          ref: reservation.ref,
          requirements: reservation.requirements,
        },
        sourceActionInvocationId: 'ac131313-1313-4131-8131-131313131313',
      });
      const createTerminal = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)({
        _tag: 'ESTABLISHED',
        ownerEvidenceRef: 'owner-recovery:reservation-create',
        request: createRequest,
        reservation,
      });
      const createIntent = Schema.decodeUnknownSync(ReservationCreateInventoryEffectLedgerIntentSchema)(
        reservationCreateLedgerIntent(createTerminal),
      );
      const createResolution = { _tag: 'RESERVATION_CREATE' as const, effect: createTerminal };

      yield* runtimeDatabase.transaction((transaction) =>
        Effect.gen(function* seedLostAnswers() {
          const scope = {
            authMethod: 'api_key',
            correlationId: 'owner-recovery-seed',
            legalEntityId,
            principalId,
            tenantId,
          } as const;
          const scoped = yield* installOperationalScope(transaction, scope);
          const ledger = makeInventoryEffectLedgerService(
            inventoryEffectLedgerPersistenceForScope(scoped, scope),
            Effect.succeed('2026-09-25T10:32:00.000Z'),
          );
          const physicalRequested = (yield* physicalStockEffectPersistenceForScope(scoped, scope)
            .createOrRead(physicalRequest)
            .pipe(
              Effect.catch((error) => Effect.die('cause' in error && error.cause !== undefined ? error.cause : error)),
            )).effect;
          const physicalClaim = yield* ledger
            .claim(
              tenantId,
              InventoryEffectLedgerEffectIdSchema.make(physicalRequest.effectId),
              physicalStockLedgerIntent(physicalRequested),
            )
            .pipe(
              Effect.catch((error) => Effect.die('cause' in error && error.cause !== undefined ? error.cause : error)),
            );
          yield* ledger
            .transition(physicalClaim.record, { currentState: 'INDETERMINATE', resolution: null })
            .pipe(
              Effect.catch((error) => Effect.die('cause' in error && error.cause !== undefined ? error.cause : error)),
            );
          const createRequested = (yield* reservationCreateEffectPersistenceForScope(scoped, scope).createOrRead(
            createRequest,
          )).effect;
          const createClaim = yield* ledger
            .claim(tenantId, InventoryEffectLedgerEffectIdSchema.make(createRequest.effectId), createIntent)
            .pipe(
              Effect.catch((error) => Effect.die('cause' in error && error.cause !== undefined ? error.cause : error)),
            );
          expect(reservationCreateLedgerIntent(createRequested)).toEqual(createIntent);
          yield* ledger
            .transition(createClaim.record, { currentState: 'INDETERMINATE', resolution: null })
            .pipe(
              Effect.catch((error) => Effect.die('cause' in error && error.cause !== undefined ? error.cause : error)),
            );
        }),
      );

      const seededLedgerRows = yield* admin
        .select()
        .from(inventoryEffectLedger)
        .where(eq(inventoryEffectLedger.tenantId, tenantId));
      expect(seededLedgerRows).toHaveLength(2);
      expect(seededLedgerRows.map(({ currentState }) => currentState)).toEqual(['INDETERMINATE', 'INDETERMINATE']);

      const authorityCalls = yield* Ref.make({ physical: 0, reservation: 0 });
      const recoveryAuthority: InventoryEffectRecoveryAuthority = {
        recoverOriginal: (record) => {
          const updateCalls = Match.value(record.intent).pipe(
            Match.tag('PHYSICAL_ISSUE', () => (calls: { physical: number; reservation: number }) => ({
              ...calls,
              physical: calls.physical + 1,
            })),
            Match.orElse(() => (calls: { physical: number; reservation: number }) => ({
              ...calls,
              reservation: calls.reservation + 1,
            })),
          );
          const observation = Match.value(record.intent).pipe(
            Match.tag('PHYSICAL_ISSUE', (intent) => ({
              _tag: 'AUTHORITATIVE_SUCCESS' as const,
              effectId: record.effectId,
              intent,
              kind: intent._tag,
              learnedAt: '2026-09-25T10:35:00.000Z',
              occurredAt: '2026-09-25T10:31:00.000Z',
              ownerEvidenceRef: 'owner-recovery:physical-issue',
              resolution: physicalResolution,
            })),
            Match.orElse((intent) => ({
              _tag: 'AUTHORITATIVE_SUCCESS' as const,
              effectId: record.effectId,
              intent,
              kind: intent._tag,
              learnedAt: '2026-09-25T10:35:00.000Z',
              occurredAt: reservation.establishedAt,
              ownerEvidenceRef: 'owner-recovery:reservation-create',
              resolution: createResolution,
            })),
          );
          return Ref.update(authorityCalls, updateCalls).pipe(Effect.as(observation));
        },
      };
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
      const recover = (kind: 'PHYSICAL_ISSUE' | 'RESERVATION_CREATE', replay: boolean) => {
        const isPhysical = kind === 'PHYSICAL_ISSUE';
        const effectId = isPhysical ? physicalRequest.effectId : createRequest.effectId;
        const targetRef = isPhysical ? physicalRequest.positionRef : reservation.ref;
        const payload = Schema.decodeUnknownSync(RecoverInventoryEffectPayloadSchema)({
          effectId,
          expectedKind: kind,
          targetRef,
        });
        return actionRuntime
          .runAction({
            payload,
            principal,
            registration: recoverInventoryEffectAction,
            transport: {
              correlationId: `owner-recovery-${kind.toLowerCase()}-${replay ? 'replay' : 'first'}`,
              idempotencyKey: `owner-recovery-${kind.toLowerCase()}-${replay ? 'replay' : 'first'}`,
            },
          })
          .pipe(Effect.provideService(InventoryEffectRecoveryAuthorityRequirement, recoveryAuthority));
      };

      const firstPhysical = yield* recover('PHYSICAL_ISSUE', false);
      const firstReservation = yield* recover('RESERVATION_CREATE', false);
      const replayPhysical = yield* recover('PHYSICAL_ISSUE', true);
      const replayReservation = yield* recover('RESERVATION_CREATE', true);

      expect(Schema.is(RecoveredInventoryEffectResultSchema)(firstPhysical)).toBe(true);
      expect(Schema.is(RecoveredInventoryEffectResultSchema)(firstReservation)).toBe(true);
      expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(replayPhysical)).toBe(true);
      expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(replayReservation)).toBe(true);
      expect(yield* Ref.get(authorityCalls)).toEqual({ physical: 1, reservation: 1 });

      const physicalRows = yield* admin
        .select()
        .from(inventoryPhysicalStockEffects)
        .where(eq(inventoryPhysicalStockEffects.tenantId, tenantId));
      const obligationRows = yield* admin
        .select()
        .from(inventoryObligations)
        .where(eq(inventoryObligations.tenantId, tenantId));
      const requirementRows = yield* admin
        .select()
        .from(inventoryObligationRequirements)
        .where(eq(inventoryObligationRequirements.tenantId, tenantId));
      const allocationRows = yield* admin
        .select()
        .from(inventoryObligationAllocations)
        .where(eq(inventoryObligationAllocations.tenantId, tenantId));
      const createRows = yield* admin
        .select()
        .from(inventoryReservationCreateEffects)
        .where(eq(inventoryReservationCreateEffects.tenantId, tenantId));
      const ledgerRows = yield* admin
        .select()
        .from(inventoryEffectLedger)
        .where(
          and(
            eq(inventoryEffectLedger.tenantId, tenantId),
            inArray(inventoryEffectLedger.effectId, [physicalRequest.effectId, createRequest.effectId]),
          ),
        );

      expect(physicalRows).toHaveLength(1);
      expect(physicalRows[0]).toMatchObject({
        effectId: physicalRequest.effectId,
        state: 'APPLIED',
      });
      expect(obligationRows).toHaveLength(1);
      expect(obligationRows[0]).toMatchObject({ obligationId: reservation.ref.resourceId });
      expect(requirementRows).toHaveLength(reservation.requirements.length);
      expect(allocationRows).toHaveLength(
        reservation.requirements.reduce((count, requirement) => count + requirement.allocations.length, 0),
      );
      expect(createRows).toHaveLength(1);
      expect(createRows[0]).toMatchObject({ effectId: createRequest.effectId, state: 'ESTABLISHED' });
      expect(ledgerRows).toHaveLength(2);
      expect(ledgerRows.every(({ currentState }) => currentState === 'SUCCEEDED')).toBe(true);
    }),
  ),
);
