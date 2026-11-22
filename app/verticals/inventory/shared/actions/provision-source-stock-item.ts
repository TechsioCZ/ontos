import { Schema } from 'effect';

import { SourceProvisioningUnavailable } from '../domain/source-provisioning-unavailable.ts';
import { SourceStockItemProvisioningRejected } from '../domain/source-stock-item-provisioning-rejected.ts';

/**
 * One committed ERP item: its exact Catalog selection and meaning, the ERP's own item key, and the provisioning policy
 * of the backend it comes from. The result names every provisioned ref.
 */
export {
  ProvisionSourceStockItemInputSchema as ProvisionSourceStockItemPayloadSchema,
  SourceStockItemProvisioningSchema as ProvisionSourceStockItemResultSchema,
} from '../domain/source-provisioning.ts';
export type { ProvisionSourceStockItemInput as ProvisionSourceStockItemPayload } from '../domain/source-provisioning.ts';

export const ProvisionSourceStockItemErrorSchema = Schema.Union([
  SourceStockItemProvisioningRejected,
  SourceProvisioningUnavailable,
]);
export type ProvisionSourceStockItemError = typeof ProvisionSourceStockItemErrorSchema.Type;
