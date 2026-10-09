import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const InventoryBackendConfigurationCurrentDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'InventoryBackendConfigurationCurrentDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('inventory_backend_configuration_persistence_unavailable') },
);
export type InventoryBackendConfigurationCurrentDomainUnavailableProblem =
  typeof InventoryBackendConfigurationCurrentDomainUnavailableProblemSchema.Type;
