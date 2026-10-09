import { Schema } from 'effect';

export class InventoryObligationPersistenceUnavailable extends Schema.TaggedError<InventoryObligationPersistenceUnavailable>()(
  'InventoryObligationPersistenceUnavailable',
  {
    code: Schema.Literal('inventory_obligation_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
