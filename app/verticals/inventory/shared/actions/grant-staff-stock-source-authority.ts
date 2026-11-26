import { Schema } from 'effect';

import { ExternalStockKeySchema, InventoryBackendOriginSchema } from '../domain/external-stock-correlation.ts';
import { InventorySourceOrderingEvidenceSchema } from '../domain/inventory-source-assertion.ts';
import { PhysicalStockEffectIdSchema } from '../domain/physical-stock-effect.ts';
import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import { StaffStockSourceAuthorityRejected } from '../domain/staff-stock-source-authority-rejected.ts';
import { StaffStockSourceAuthorityUnavailable } from '../domain/staff-stock-source-authority-unavailable.ts';

export { StaffStockSourceAuthorityRejected } from '../domain/staff-stock-source-authority-rejected.ts';
export { StaffStockSourceAuthorityUnavailable } from '../domain/staff-stock-source-authority-unavailable.ts';

/**
 * Staff asks to report the absolute on-hand figure of exactly one Stock Position whose Customer Configuration is
 * held by an External Business System. Inventory answers with the exact source qualification (issuer, ERP keys,
 * next ordering evidence and the physical effects to cover) the following import-source-assertion must carry.
 */
export const GrantStaffStockSourceAuthorityPayloadSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  positionRef: StockPositionRefSchema,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type GrantStaffStockSourceAuthorityPayload = typeof GrantStaffStockSourceAuthorityPayloadSchema.Type;

export const GrantStaffStockSourceAuthorityResultSchema = Schema.Struct({
  coverageEffectIds: Schema.Array(PhysicalStockEffectIdSchema),
  issuer: InventoryBackendOriginSchema,
  itemExternalKey: ExternalStockKeySchema,
  locationExternalKey: ExternalStockKeySchema,
  orderingEvidence: InventorySourceOrderingEvidenceSchema,
  selectedAt: Schema.toEncoded(Schema.DateTimeUtcFromString),
});
export type GrantStaffStockSourceAuthorityResult = typeof GrantStaffStockSourceAuthorityResultSchema.Type;

export const GrantStaffStockSourceAuthorityErrorSchema = Schema.Union([
  StaffStockSourceAuthorityRejected,
  StaffStockSourceAuthorityUnavailable,
]);
