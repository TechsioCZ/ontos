import { Schema } from 'effect';

import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventorySourceConflictRefSchema } from '../resources/inventory-source-conflict.ts';
import { InventoryBackendIdSchema } from './inventory-backend-identifiers.ts';

export class InventoryBackendSelectionRejected extends Schema.TaggedError<InventoryBackendSelectionRejected>()(
  'InventoryBackendSelectionRejected',
  {
    code: Schema.Literal('inventory_backend_selection_rejected'),
    conflictRef: Schema.optional(InventorySourceConflictRefSchema),
    customerConfigurationId: CustomerConfigurationIdSchema,
    fallbackApplied: Schema.Literal(false),
    reason: Schema.Literals(['authorization_target_mismatch', 'backend_change_requires_explicit_cutover']),
    selectedBackendId: InventoryBackendIdSchema,
  },
) {}
