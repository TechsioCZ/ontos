import {
  SourceStockPositionResolutionRequestSchema,
  SourceStockPositionResolutionResponseSchema,
} from '@app/inventory/api/source-stock-position-resolution';
import { SourceExternalKeySchema, SourceProvisioningPolicySchema } from '@app/inventory/source-provisioning';
import { InventorySourceAssertionProposalSchema } from '@app/inventory/source-assertion';
import { Schema } from 'effect';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const proposal = InventorySourceAssertionProposalSchema.fields;

/**
 * One normalized absolute on-hand figure from the public stock route. The identifier kinds, the
 * meaning and the whole source scope are fixed by the route enrollment, never sent by the caller.
 */
export const SymmyStockRowSchema = Schema.Struct({
  businessObservedAt: proposal.businessObservedAt,
  itemKey: SourceExternalKeySchema,
  locationKey: SourceExternalKeySchema,
  quantity: proposal.quantity,
  revision: boundedText,
  sourceReference: proposal.sourceReference,
});
export type SymmyStockRow = typeof SymmyStockRowSchema.Type;

/** One request carries at most sixteen rows, which is the item limit of a synchronous plan. */
export const SymmyStockRowsSchema = Schema.NonEmptyArray(SymmyStockRowSchema).check(Schema.isMaxLength(16));
export type SymmyStockRows = typeof SymmyStockRowsSchema.Type;

/** One integration-wide policy. No item key or Stock Position is enrolled here. */
export const SymmyInventorySourceSchema = Schema.Struct({
  customerConfigurationId: SourceProvisioningPolicySchema.fields.customerConfigurationId,
  externalScope: SourceProvisioningPolicySchema.fields.externalScope,
  issuer: SourceProvisioningPolicySchema.fields.issuer,
  locations: SourceProvisioningPolicySchema.fields.locations,
  namespace: SourceProvisioningPolicySchema.fields.namespace,
  policyRef: SourceProvisioningPolicySchema.fields.policyRef,
  unitRef: SourceProvisioningPolicySchema.fields.unitRef,
}).check(
  Schema.makeFilter(
    ({ locations, policyRef, unitRef }) =>
      (unitRef.tenantId === policyRef.tenantId &&
        locations.every(({ stockLocationRef }) => stockLocationRef.tenantId === policyRef.tenantId)) ||
      'Inventory source policy, locations and unit share one Tenant',
  ),
);
export type SymmyInventorySource = typeof SymmyInventorySourceSchema.Type;

/** Length prefixes keep two different external key pairs apart. */
export const symmyStockScopeKey = ({
  itemKey: item,
  locationKey: location,
}: {
  readonly itemKey: string;
  readonly locationKey: string;
}): string => `${item.length}:${item}${location.length}:${location}`;

/** Current Inventory answers read before synchronous admission. They never enter caller-intent identity. */
export const SymmyStockPositionFactsSchema = Schema.Array(
  Schema.Struct({
    request: SourceStockPositionResolutionRequestSchema,
    resolution: SourceStockPositionResolutionResponseSchema,
  }),
).check(Schema.isMaxLength(16));
export type SymmyStockPositionFacts = typeof SymmyStockPositionFactsSchema.Type;
