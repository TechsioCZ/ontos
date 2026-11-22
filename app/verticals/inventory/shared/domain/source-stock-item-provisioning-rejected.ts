import { Schema } from 'effect';

import { SourceProvisioningConflictRefSchema } from './source-provisioning-conflict-ref.ts';

export class SourceStockItemProvisioningRejected extends Schema.TaggedError<SourceStockItemProvisioningRejected>()(
  'SourceStockItemProvisioningRejected',
  {
    code: Schema.Literal('source_stock_item_provisioning_rejected'),
    /** The existing record whose content conflicts with the request, when there is one. */
    conflictRef: Schema.optionalKey(SourceProvisioningConflictRefSchema),
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'POLICY_NOT_FOUND',
      'POLICY_TERMS_MISMATCH',
      /** The Catalog meaning already has a Stock Item in another Unit than the policy's. */
      'STOCK_UNIT_CONFLICT',
      /** The meaning id is registered with another selection kind. */
      'EXACT_SELECTION_MEANING_CONFLICT',
      /** The policy's backend configuration is not the selected owner of a Position it needs. */
      'BACKEND_CONFLICT',
      /** The ERP item key already correlates to another Stock Item, or its period overlaps an ended one. */
      'ITEM_CORRELATION_CONFLICT',
      /** The meaning is bound to another Catalog selection, or the Stock Item to another meaning. */
      'BINDING_CONFLICT',
      'STOCK_LOCATION_NOT_ACTIVE',
    ]),
  },
) {}
