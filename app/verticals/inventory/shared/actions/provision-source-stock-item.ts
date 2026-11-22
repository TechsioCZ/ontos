import { Schema, SchemaGetter } from 'effect';

import {
  canonicalSourceProvisioningExpectedPolicy,
  ProvisionSourceStockItemInputSchema,
} from '../domain/source-provisioning.ts';
import { SourceProvisioningUnavailable } from '../domain/source-provisioning-unavailable.ts';
import { SourceStockItemProvisioningRejected } from '../domain/source-stock-item-provisioning-rejected.ts';

// Core hashes the encoded Action payload before calling Inventory. The receipt schema retains its original order.
const canonicalTerms = SchemaGetter.transform(canonicalSourceProvisioningExpectedPolicy);
export const ProvisionSourceStockItemPayloadSchema = ProvisionSourceStockItemInputSchema.mapFields(
  (fields) => ({
    ...fields,
    expectedPolicy: fields.expectedPolicy.pipe(Schema.decode({ decode: canonicalTerms, encode: canonicalTerms })),
  }),
  // Only location order changes; the original same-tenant refinement remains valid.
  { unsafePreserveChecks: true },
);
export { SourceStockItemProvisioningSchema as ProvisionSourceStockItemResultSchema } from '../domain/source-provisioning.ts';
export type { ProvisionSourceStockItemInput as ProvisionSourceStockItemPayload } from '../domain/source-provisioning.ts';

export const ProvisionSourceStockItemErrorSchema = Schema.Union([
  SourceStockItemProvisioningRejected,
  SourceProvisioningUnavailable,
]);
export type ProvisionSourceStockItemError = typeof ProvisionSourceStockItemErrorSchema.Type;
