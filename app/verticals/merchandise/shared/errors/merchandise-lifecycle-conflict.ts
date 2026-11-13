import { Schema } from 'effect';

/**
 * A command the current state does not allow. `merchandise_offered_price_changed`: an order line added at the price
 * the editor offered, while the product's price changed before the edit was saved; the editor takes the new price
 * and staff save again.
 */
export class MerchandiseLifecycleConflict extends Schema.TaggedError<MerchandiseLifecycleConflict>()(
  'MerchandiseLifecycleConflict',
  {
    code: Schema.Literals(['merchandise_lifecycle_conflict', 'merchandise_offered_price_changed']),
    reason: Schema.String,
  },
) {}
