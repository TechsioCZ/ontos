import { Schema } from 'effect';

export class InventoryBackendEffectUnavailable extends Schema.TaggedError<InventoryBackendEffectUnavailable>()(
  'InventoryBackendEffectUnavailable',
  {
    code: Schema.Literal('inventory_backend_effect_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
