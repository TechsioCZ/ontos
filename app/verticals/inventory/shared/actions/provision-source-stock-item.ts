import { Schema } from 'effect';

import { SourceProvisioningUnavailable } from '../domain/source-provisioning-unavailable.ts';
import { SourceStockItemProvisioningRejected } from '../domain/source-stock-item-provisioning-rejected.ts';

export { SourceStockItemProvisioningSchema as ProvisionSourceStockItemResultSchema } from '../domain/source-provisioning.ts';

export const ProvisionSourceStockItemErrorSchema = Schema.Union([
  SourceStockItemProvisioningRejected,
  SourceProvisioningUnavailable,
]);
