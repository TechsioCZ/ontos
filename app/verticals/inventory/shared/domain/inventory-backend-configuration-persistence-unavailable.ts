import { Schema } from 'effect';

export class InventoryBackendConfigurationPersistenceUnavailable extends Schema.TaggedError<InventoryBackendConfigurationPersistenceUnavailable>()(
  'InventoryBackendConfigurationPersistenceUnavailable',
  {
    code: Schema.Literal('inventory_backend_configuration_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
