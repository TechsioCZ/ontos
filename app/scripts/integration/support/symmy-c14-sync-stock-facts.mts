import { randomUUID } from 'node:crypto';

import type { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { C14InventorySourceImportSetupSchema } from '@app/inventory/testing/c14-source-import-native';
import { Schema } from 'effect';

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
