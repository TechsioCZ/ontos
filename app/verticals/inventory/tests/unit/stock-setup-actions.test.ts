import { NodeCrypto } from '@effect/platform-node';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Crypto, Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { CreateStockLocationPayloadSchema } from '../../shared/actions/create-stock-location.ts';
import { EstablishStockPositionPayloadSchema } from '../../shared/actions/establish-stock-position.ts';
import { RegisterStockItemPayloadSchema } from '../../shared/actions/register-stock-item.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { StockItem } from '../../shared/domain/stock-item.ts';
import type { StockLocation } from '../../shared/domain/stock-location.ts';
import type { StockPosition } from '../../shared/domain/stock-position.ts';
import { StockPositionRejected, UnknownOnHandEvidenceSchema } from '../../shared/domain/stock-position.ts';
import { StockItemRejected } from '../../shared/domain/stock-item.ts';
import type { StockItemRepositoryService } from '../../src/persistence/stock-item-repository.ts';
import type { StockPositionPersistence } from '../../src/persistence/stock-position-repository.ts';
import {
  createStockLocationAction,
  handleCreateStockLocation,
} from '../../src/actions/create-stock-location.action.ts';
import {
  establishStockPositionAction,
  handleEstablishStockPosition,
} from '../../src/actions/establish-stock-position.action.ts';
import { handleRegisterStockItem, registerStockItemAction } from '../../src/actions/register-stock-item.action.ts';
import { stockItemRegistration } from '../../src/services/stock-item-service.ts';
import { stockPositionEstablishment } from '../../src/services/stock-position-service.ts';

const compositionRevision = 'a'.repeat(64);
const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const configurationId = '22222222-2222-4222-8222-222222222222';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

const scope = trustVerifiedGatewayPrincipalContext(
  {
    authBindingId: '44444444-4444-4444-8444-444444444444',
    authContextRef: 'test:stock-setup-actions',
    authMethod: 'api_key',
    correlationId: 'stock-setup-actions-test',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  },
  compositionRevision,
);

const handlerContext = <Services>(
  action: typeof registerStockItemAction | typeof createStockLocationAction | typeof establishStockPositionAction,
  services: Services,
) => {
  const collector = createActionCollector(
    action.descriptor.domainEvents,
    'commerce.inventory',
    action.descriptor.accessEvidencePolicy,
    action.descriptor.auditEvidenceSchema,
  );
  return {
    collector,
    context: {
      actionInvocationId: '66666666-6666-4666-8666-666666666666',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      compositionRevision,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services,
    },
  };
};

const makeStockItems = Effect.gen(function* makeStockItems() {
  const items = yield* Ref.make<ReadonlyMap<string, StockItem>>(new Map());
  const repository: Pick<StockItemRepositoryService, 'findByExactSelectionMeaning' | 'insert'> = {
    findByExactSelectionMeaning: (requestedTenantId, meaningId) =>
      Ref.get(items).pipe(
        Effect.map((stored) =>
          Option.fromNullishOr(
            [...stored.values()].find(
              (item) => item.stockItemRef.tenantId === requestedTenantId && item.exactSelectionMeaning.id === meaningId,
            ),
          ),
        ),
      ),
    insert: (item) =>
      Ref.modify(items, (stored) => [item, new Map(stored).set(item.stockItemRef.resourceId, item)] as const),
  };
  return { register: stockItemRegistration(repository, yield* Crypto.Crypto) };
});

const selectedConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId: 'customer-configuration:erp',
  revision: 1,
  selectedAt: '2026-11-20T08:00:00.000Z',
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-primary',
    exactReservationCapability: 'UNSUPPORTED',
    stockCorrectionCapability: 'UNSUPPORTED',
  },
  tenantId,
});

const makePositions = Effect.gen(function* makePositions() {
  const positions = yield* Ref.make<ReadonlyMap<string, StockPosition>>(new Map());
  const persistence: StockPositionPersistence = {
    create: (position) =>
      Ref.modify(positions, (stored) => [position, new Map(stored).set(position.ref.resourceId, position)] as const),
    findCurrent: (positionScope) =>
      Ref.get(positions).pipe(
        Effect.map((stored) =>
          Option.fromNullishOr(
            [...stored.values()].find(
              (position) =>
                position.lifecycle === 'CURRENT' &&
                position.scope.customerConfigurationId === positionScope.customerConfigurationId &&
                position.scope.stockItemRef.resourceId === positionScope.stockItemRef.resourceId &&
                position.scope.stockLocationRef.resourceId === positionScope.stockLocationRef.resourceId,
            ),
          ),
        ),
      ),
    read: (ref) => Ref.get(positions).pipe(Effect.map((stored) => Option.fromNullishOr(stored.get(ref.resourceId)))),
    save: ({ next }) => Effect.succeed(next),
  };
  return { persistence, positions };
});

const positionPayload = Schema.decodeUnknownSync(EstablishStockPositionPayloadSchema)({
  ownerConfigurationRef: {
    moduleId: 'commerce.inventory',
    resourceId: configurationId,
    resourceType: 'commerce.inventory.inventory-backend-configuration',
    tenantId,
  },
  scope: {
    customerConfigurationId: 'customer-configuration:erp',
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    stockLocationRef: {
      moduleId: 'commerce.inventory',
      resourceId: '88888888-8888-4888-8888-888888888888',
      resourceType: 'commerce.inventory.stock-location',
      tenantId,
    },
    unitRef,
  },
});

describe('Inventory stock setup Actions', () => {
  it('declares three idempotent, scope-wide, audited owner Actions', () => {
    const actions = [registerStockItemAction, createStockLocationAction, establishStockPositionAction] as const;
    expect(actions.map(({ descriptor }) => descriptor.actionKey)).toEqual([
      'commerce.inventory.register-stock-item',
      'commerce.inventory.create-stock-location',
      'commerce.inventory.establish-stock-position',
    ]);
    for (const { descriptor } of actions) {
      expect(descriptor).toMatchObject({
        auditProfile: 'sensitive',
        idempotency: 'required',
        legalEntityScope: 'forbidden',
        owningModuleKey: 'commerce.inventory',
      });
      expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
      expect(descriptor.accessDeclaration).toMatchObject({ kind: 'action', selectors: [] });
    }
  });

  it.effect('registers one Stock Item per exact Selection meaning in the trusted Tenant and refuses a second', () =>
    Effect.gen(function* registerStockItem() {
      const service = yield* makeStockItems;
      const payload = Schema.decodeUnknownSync(RegisterStockItemPayloadSchema)({
        exactSelectionMeaning: { id: 'catalog-variant:sku-1', kind: 'PRODUCT_VARIANT' },
        unitRef,
      });
      const first = handlerContext(registerStockItemAction, service);
      const { stockItem } = yield* handleRegisterStockItem(payload, first.context);
      expect(stockItem).toMatchObject({
        exactSelectionMeaning: { id: 'catalog-variant:sku-1', kind: 'PRODUCT_VARIANT' },
        lifecycle: 'CURRENT',
        revision: 1,
        stockItemRef: { tenantId },
        unitRef,
      });
      expect(first.collector.snapshot()).toMatchObject({
        auditEvidence: { operation: 'REGISTERED', stockItemRef: stockItem.stockItemRef },
        dataAccessEvents: [{ targetResourceId: stockItem.stockItemRef.resourceId }],
      });

      const duplicate = yield* Effect.flip(
        handleRegisterStockItem(payload, handlerContext(registerStockItemAction, service).context),
      );
      expect(duplicate).toMatchObject({
        reason: 'exact_selection_meaning_already_registered',
        stockItemId: stockItem.stockItemRef.resourceId,
      });

      const foreignUnit = yield* Effect.flip(
        handleRegisterStockItem(
          Schema.decodeUnknownSync(RegisterStockItemPayloadSchema)({
            exactSelectionMeaning: { id: 'catalog-variant:sku-2', kind: 'PRODUCT_VARIANT' },
            unitRef: { ...unitRef, tenantId: otherTenantId },
          }),
          handlerContext(registerStockItemAction, service).context,
        ),
      );
      expect(Schema.is(StockItemRejected)(foreignUnit)).toBe(true);
      expect(foreignUnit).toMatchObject({ reason: 'tenant_scope_mismatch' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('creates one ACTIVE Stock Location with an owner-assigned identity in the trusted Tenant', () =>
    Effect.gen(function* createStockLocation() {
      const created: StockLocation[] = [];
      const payload = Schema.decodeUnknownSync(CreateStockLocationPayloadSchema)({
        displayName: 'ERP warehouse',
        operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['erp-site:main'] },
      });
      const { collector, context } = handlerContext(createStockLocationAction, {
        create: (location: StockLocation) =>
          Effect.sync(() => {
            created.push(location);
            return location;
          }),
      });
      const { stockLocation } = yield* handleCreateStockLocation(payload, context);
      expect(stockLocation).toMatchObject({
        displayName: 'ERP warehouse',
        lifecycle: { _tag: 'ACTIVE' },
        operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['erp-site:main'] },
        ref: { moduleId: 'commerce.inventory', resourceType: 'commerce.inventory.stock-location', tenantId },
        revision: 1,
      });
      expect(created).toEqual([stockLocation]);
      expect(collector.snapshot()).toMatchObject({
        auditEvidence: { operation: 'CREATED', stockLocationRef: stockLocation.ref },
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('establishes one Current Position with UNKNOWN ON_HAND under the selected backend, never a quantity', () =>
    Effect.gen(function* establishStockPosition() {
      const { persistence, positions } = yield* makePositions;
      const establish = stockPositionEstablishment(persistence, {
        findCurrent: () => Effect.succeed(Option.some(selectedConfiguration)),
      });
      const { collector, context } = handlerContext(establishStockPositionAction, { establish });
      const { stockPosition } = yield* handleEstablishStockPosition(positionPayload, context);
      expect(Schema.is(UnknownOnHandEvidenceSchema)(stockPosition.onHand)).toBe(true);
      expect(stockPosition).toMatchObject({
        lifecycle: 'CURRENT',
        onHand: { meaning: 'ON_HAND', ownerConfigurationRef: positionPayload.ownerConfigurationRef, unitRef },
        revision: 1,
        scope: positionPayload.scope,
      });
      expect([...(yield* Ref.get(positions)).values()]).toEqual([stockPosition]);
      expect(collector.snapshot()).toMatchObject({
        auditEvidence: { operation: 'ESTABLISHED', positionRef: stockPosition.ref },
      });

      const again = yield* Effect.flip(
        handleEstablishStockPosition(
          positionPayload,
          handlerContext(establishStockPositionAction, { establish }).context,
        ),
      );
      expect(again).toMatchObject({ positionRef: stockPosition.ref, reason: 'POSITION_SCOPE_ALREADY_CURRENT' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses a Position whose owner is not the selected backend configuration and stores nothing', () =>
    Effect.gen(function* refuseUnselectedOwner() {
      const { persistence, positions } = yield* makePositions;
      const establish = stockPositionEstablishment(persistence, {
        findCurrent: () => Effect.succeed(Option.none()),
      });
      const failure = yield* Effect.flip(
        handleEstablishStockPosition(
          positionPayload,
          handlerContext(establishStockPositionAction, { establish }).context,
        ),
      );
      expect(Schema.is(StockPositionRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'OWNER_CONFIGURATION_MISMATCH' });
      expect((yield* Ref.get(positions)).size).toBe(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
