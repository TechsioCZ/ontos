import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { PricingPurchaseContextVerificationRequestSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

export const RelevantStockPositionSetScopeSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  stockItemRef: StockItemRefSchema,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter(({ ownerConfigurationRef, stockItemRef, unitRef }) =>
    Schema.toEquivalence(Schema.String)(ownerConfigurationRef.tenantId, stockItemRef.tenantId) &&
    Schema.toEquivalence(Schema.String)(unitRef.tenantId, stockItemRef.tenantId)
      ? undefined
      : 'Position-set scope must share one Tenant',
  ),
);
export type RelevantStockPositionSetScope = typeof RelevantStockPositionSetScopeSchema.Type;

const requestScope = {
  previousCompleteness: Schema.optionalKey(OwnerVerifiableSetCompletenessEvidenceSchema),
  scope: RelevantStockPositionSetScopeSchema,
};
export const RelevantStockPositionSetRequestSchema = Schema.Struct({
  ...requestScope,
  commerceVerificationRequest: Schema.optionalKey(PricingPurchaseContextVerificationRequestSchema),
  mode: Schema.Literals(['POTENTIALLY_RELEVANT_POSITIONS', 'EXACT_COMMERCE_SCOPE']),
}).check(
  Schema.makeFilter((input) =>
    input.mode === 'EXACT_COMMERCE_SCOPE' && input.commerceVerificationRequest === undefined
      ? 'Exact Commerce scope requires its owner verification request'
      : undefined,
  ),
);
export type RelevantStockPositionSetRequest = typeof RelevantStockPositionSetRequestSchema.Type;

export const RelevantStockPositionSetResponseSchema = Schema.Union([
  Schema.Struct({
    completeness: OwnerVerifiableSetCompletenessEvidenceSchema,
    outcome: Schema.Literal('COMPLETE'),
    positionRefs: Schema.Array(StockPositionRefSchema),
    previousProof: Schema.Literals(['NOT_REQUESTED', 'CURRENT', 'INVALIDATED']),
    sharingEligibility: Schema.Literals(['NOT_EVALUATED', 'OWNER_VERIFIED']),
    verificationRule: Schema.Literal('OWNER_REVALIDATION_REQUIRED_AT_EACH_USE'),
  }),
  Schema.Struct({
    outcome: Schema.Literal('UNPROVEN'),
    reason: Schema.Literals(['COMMERCE_CONTEXT_UNVERIFIABLE', 'OWNER_SCOPE_UNVERIFIABLE']),
  }),
]);

export class RelevantStockPositionSetUnavailable extends Schema.TaggedError<RelevantStockPositionSetUnavailable>()(
  'RelevantStockPositionSetUnavailable',
  {
    code: Schema.Literal('relevant_stock_position_set_unavailable'),
    reason: Schema.Literal('Inventory Position-set observation is unavailable'),
    retryable: Schema.Literal(true),
  },
) {}
