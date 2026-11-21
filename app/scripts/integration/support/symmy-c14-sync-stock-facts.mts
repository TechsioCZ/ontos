import { createHash, randomUUID } from 'node:crypto';

import type { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { C14InventorySourceImportSetupSchema } from '@app/inventory/testing/c14-source-import-native';
import { SymmyRouteExecutionConfigurationSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Schema } from 'effect';

import { internalSyncSource } from './symmy-c14-sync-plans.mts';

const inventoryModule = 'commerce.inventory';

export const internalStockBackendId = 'INTERNAL_C14_DECLARED_EXTERNAL_STOCK';
export const internalStockConfigurationId = 'INTERNAL_C14_DECLARED_CUSTOMER_CONFIGURATION';

/** All six native owner records are stated explicitly; no assertion, physical effect or quantity is seeded. */
export const makeInternalStockSetup = (input: {
  readonly selectedAt: string;
  readonly tenantId: string;
  readonly unitRef: typeof ProductUnitRefSchema.Encoded;
}) => {
  const { selectedAt, tenantId, unitRef } = input;
  const stockItemRef = {
    moduleId: inventoryModule,
    resourceId: randomUUID(),
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  };
  const stockLocationRef = {
    moduleId: inventoryModule,
    resourceId: randomUUID(),
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  };
  const configurationRef = {
    moduleId: inventoryModule,
    resourceId: randomUUID(),
    resourceType: 'commerce.inventory.inventory-backend-configuration',
    tenantId,
  };
  const issuer = { backendId: internalStockBackendId, backendKind: 'external_business_system' };
  const key = {
    customerConfigurationId: internalStockConfigurationId,
    externalScope: 'INTERNAL_C14_EXPLICIT_STOCK_SCOPE',
    issuer,
    namespace: 'INTERNAL_C14_STOCK',
    tenantId,
  };
  return Schema.decodeUnknownEffect(C14InventorySourceImportSetupSchema)({
    configuration: {
      configurationId: configurationRef.resourceId,
      customerConfigurationId: internalStockConfigurationId,
      revision: 1,
      selectedAt,
      selection: {
        backend: issuer.backendKind,
        backendId: issuer.backendId,
        exactReservationCapability: 'UNSUPPORTED',
        stockCorrectionCapability: 'UNSUPPORTED',
      },
      tenantId,
    },
    itemCorrelation: {
      confirmedAt: selectedAt,
      correlationRef: {
        moduleId: inventoryModule,
        resourceId: randomUUID(),
        resourceType: 'commerce.inventory.external-stock-correlation',
        tenantId,
      },
      effectivePeriod: { from: selectedAt, to: null },
      externalKey: { ...key, externalValue: 'INTERNAL_C14_ITEM', identifierKind: 'ITEM' },
      lifecycle: 'CURRENT',
      ownerEvidenceRef: 'INTERNAL_C14_EXPLICIT_ITEM_CORRELATION',
      revision: 1,
      target: { _tag: 'STOCK_ITEM', ref: stockItemRef },
    },
    locationCorrelation: {
      confirmedAt: selectedAt,
      correlationRef: {
        moduleId: inventoryModule,
        resourceId: randomUUID(),
        resourceType: 'commerce.inventory.external-stock-correlation',
        tenantId,
      },
      effectivePeriod: { from: selectedAt, to: null },
      externalKey: { ...key, externalValue: 'INTERNAL_C14_LOCATION', identifierKind: 'LOCATION' },
      lifecycle: 'CURRENT',
      ownerEvidenceRef: 'INTERNAL_C14_EXPLICIT_LOCATION_CORRELATION',
      revision: 1,
      target: { _tag: 'STOCK_LOCATION', ref: stockLocationRef },
    },
    stockItem: {
      createdAt: selectedAt,
      exactSelectionMeaning: { id: 'INTERNAL_C14_EXPLICIT_CONFIGURED_SELECTION', kind: 'CONFIGURED_SELECTION' },
      lifecycle: 'CURRENT',
      retiredAt: null,
      revision: 1,
      stockItemRef,
      unitRef,
    },
    stockLocation: {
      displayName: 'Internal fixture explicitly declared physical site',
      lifecycle: { _tag: 'ACTIVE' },
      operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['INTERNAL_C14_EXPLICIT_SITE'] },
      ref: stockLocationRef,
      revision: 1,
    },
    stockPosition: {
      createdAt: selectedAt,
      endedAt: null,
      lifecycle: 'CURRENT',
      onHand: { _tag: 'UNKNOWN', meaning: 'ON_HAND', ownerConfigurationRef: configurationRef, unitRef },
      ref: {
        moduleId: inventoryModule,
        resourceId: randomUUID(),
        resourceType: 'commerce.inventory.stock-position',
        tenantId,
      },
      revision: 1,
      scope: {
        customerConfigurationId: internalStockConfigurationId,
        stockItemRef,
        stockLocationRef,
        unitRef,
      },
    },
  });
};

type InternalStockSetup = Effect.Success<ReturnType<typeof makeInternalStockSetup>>;

/**
 * The route enrolls the stock position, never a quantity: the template carries the owner operation and one
 * scope entry for the explicitly set up Item, Location and Position.
 */
export const makeInternalStockEnrollment = (input: {
  readonly setup: InternalStockSetup;
  readonly sourceRouteId: string;
}) =>
  Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
    inventoryBackendId: internalStockBackendId,
    items: [
      {
        effects: [
          {
            effectKey: 'inventory-absolute-on-hand',
            operation: {
              entrypointKey: 'commerce.inventory.import-source-assertion',
              moduleId: inventoryModule,
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'stock',
        source: {
          entityKind: 'STOCK',
          issuerId: internalSyncSource.issuerId,
          sourceNamespace: internalSyncSource.namespace,
          sourceRecordId: 'INTERNAL_C14_STOCK_ENROLLMENT',
        },
      },
    ],
    sourceRouteId: input.sourceRouteId,
    stockScope: [
      {
        customerConfigurationId: input.setup.configuration.customerConfigurationId,
        issuerBackendId: internalStockBackendId,
        itemKey: input.setup.itemCorrelation.externalKey.externalValue,
        locationKey: input.setup.locationCorrelation.externalKey.externalValue,
        namespace: input.setup.itemCorrelation.externalKey.namespace,
        positionRef: input.setup.stockPosition.ref,
        scope: input.setup.itemCorrelation.externalKey.externalScope,
      },
    ],
  }).pipe(Effect.flatMap(Schema.encodeEffect(SymmyRouteExecutionConfigurationSchema)));

/** One public row of `POST /inventory/stock/batch` for the enrolled Item and Location. */
export const makeInternalStockRow = (input: {
  readonly amount: string;
  readonly businessObservedAt: string;
  readonly revision: string;
  readonly setup: InternalStockSetup;
  readonly sourceReference: string;
  readonly unitRef: typeof ProductUnitRefSchema.Encoded;
}) => ({
  businessObservedAt: input.businessObservedAt,
  itemKey: input.setup.itemCorrelation.externalKey.externalValue,
  locationKey: input.setup.locationCorrelation.externalKey.externalValue,
  quantity: { amount: input.amount, unitRef: input.unitRef },
  revision: input.revision,
  sourceReference: input.sourceReference,
});

/** The assertion identity the route derives from the Idempotency-Key and the row index. */
export const deriveInternalStockAssertionId = (idempotencyKey: string, index: number) => {
  const digest = createHash('sha256').update(`assertion\u0000${idempotencyKey}\u0000${index}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${'89ab'.charAt(Number.parseInt(digest.charAt(16), 16) % 4)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
