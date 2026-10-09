import { Schema } from 'effect';

import { InventorySourceConflictRefSchema } from '../resources/inventory-source-conflict.ts';

export class InventorySourceConflictNotFound extends Schema.TaggedError<InventorySourceConflictNotFound>()(
  'InventorySourceConflictNotFound',
  {
    code: Schema.Literal('inventory_source_conflict_not_found'),
    conflictRef: InventorySourceConflictRefSchema,
  },
) {}
