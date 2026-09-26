import { Schema } from 'effect';

import {
  EstablishStockSharingEligibilityInputSchema,
  InventoryCommerceMarketRefSchema,
  InventorySellingLegalEntityRefSchema,
  InventoryStorefrontRefSchema,
  StockSharingEligibilityRejected,
  StockSharingEligibilitySchema,
} from '../domain/stock-sharing-eligibility.ts';
import { StockSharingEligibilityUnavailable } from '../domain/stock-sharing-eligibility-unavailable.ts';
import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import { StockSharingEligibilityRefSchema } from '../resources/stock-sharing-eligibility.ts';

export class StockSharingEligibilityLifecycleRejected extends Schema.TaggedError<StockSharingEligibilityLifecycleRejected>()(
  'StockSharingEligibilityLifecycleRejected',
  {
    code: Schema.Literal('stock_sharing_eligibility_lifecycle_rejected'),
    reason: Schema.Literals(['POSITION_SCOPE_MISMATCH', 'TRUSTED_LEGAL_ENTITY_MISMATCH']),
  },
) {}

export const StockSharingEligibilityLifecycleErrorSchema = Schema.Union([
  StockSharingEligibilityRejected,
  StockSharingEligibilityLifecycleRejected,
  StockSharingEligibilityUnavailable,
]);

export const StockSharingEligibilityLifecycleAuditEvidenceSchema = Schema.Struct({
  channel: Schema.Literals(['B2C', 'B2B']),
  commerceMarketId: Schema.optionalKey(InventoryCommerceMarketRefSchema.fields.resourceId),
  customerConfigurationId: CustomerConfigurationIdSchema,
  operation: Schema.Literals(['ESTABLISH', 'CHANGE', 'END']),
  ownerConfigurationId: InventoryBackendConfigurationRefSchema.fields.resourceId,
  positionId: StockPositionRefSchema.fields.resourceId,
  relationId: StockSharingEligibilityRefSchema.fields.resourceId,
  sellingLegalEntityId: InventorySellingLegalEntityRefSchema.fields.resourceId,
  storefrontAppId: Schema.optionalKey(InventoryStorefrontRefSchema.fields.appId),
});

export const EstablishStockSharingEligibilityPayloadSchema = EstablishStockSharingEligibilityInputSchema;
export type EstablishStockSharingEligibilityPayload = typeof EstablishStockSharingEligibilityPayloadSchema.Type;

export const EstablishStockSharingEligibilityResultSchema = StockSharingEligibilitySchema;
export type EstablishStockSharingEligibilityResult = typeof EstablishStockSharingEligibilityResultSchema.Type;
