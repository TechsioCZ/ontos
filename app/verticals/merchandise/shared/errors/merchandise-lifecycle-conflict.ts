import { Schema } from 'effect';

/**
 * A command the current state does not allow. `merchandise_offered_price_changed`: an order line added at the price
 * the editor offered, while the product's price changed before the edit was saved; the editor takes the new price
 * and staff save again.
 */
export class MerchandiseLifecycleConflict extends Schema.TaggedError<MerchandiseLifecycleConflict>()(
  'MerchandiseLifecycleConflict',
  {
    code: Schema.Literals([
      'merchandise_lifecycle_conflict',
      'merchandise_offered_price_changed',
      'merchandise_stock_reconciliation_required',
      'merchandise_variant_bulk_price_unsupported',
      'merchandise_variant_sku_required',
      'merchandise_category_slug_taken',
      'merchandise_tier_base_price_required',
    ]),
    reason: Schema.String,
  },
) {}
