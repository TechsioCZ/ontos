import { Schema } from 'effect';

import { CatalogToStockBindingRefSchema } from '../resources/catalog-to-stock-binding.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { SourceProvisioningPolicyRefSchema } from '../resources/source-provisioning-policy.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockLocationRefSchema } from '../resources/stock-location.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

/** The existing Inventory record a provisioning request collides with. */
export const SourceProvisioningConflictRefSchema = Schema.Union([
  CatalogToStockBindingRefSchema,
  ExternalStockCorrelationRefSchema,
  InventoryBackendConfigurationRefSchema,
  SourceProvisioningPolicyRefSchema,
  StockItemRefSchema,
  StockLocationRefSchema,
  StockPositionRefSchema,
]);
export type SourceProvisioningConflictRef = typeof SourceProvisioningConflictRefSchema.Type;
