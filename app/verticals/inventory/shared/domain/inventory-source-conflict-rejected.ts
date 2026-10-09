import { Schema } from 'effect';

import { InventorySourceConflictRefSchema } from '../resources/inventory-source-conflict.ts';

export class InventorySourceConflictRejected extends Schema.TaggedError<InventorySourceConflictRejected>()(
  'InventorySourceConflictRejected',
  {
    code: Schema.Literal('inventory_source_conflict_rejected'),
    conflictRef: InventorySourceConflictRefSchema,
    reason: Schema.Literals([
      'ALREADY_RESOLVED',
      'ASSERTION_AUTHORITY_MISMATCH',
      'ASSERTION_NOT_FOUND',
      'BACKEND_CONFIGURATION_NOT_FOUND',
      'BACKEND_CONFIGURATION_NOT_SINGULAR',
      'CONFLICT_ID_CONFLICT',
      'CONFLICT_REVISION_CONFLICT',
      'CURRENT_RESULT_NOT_ESTABLISHED',
      'INVALID_ASSERTION_INTEGRITY_CONFLICT',
      'INVALID_BACKEND_CONFIGURATION_CONFLICT',
      'INVALID_CORRELATION_CONFLICT',
      'INVALID_FACT_VALUE_CONFLICT',
      'POSITION_NOT_CURRENT',
      'POSITION_NOT_FOUND',
      'POSITION_REVISION_CONFLICT',
      'RESOLUTION_TIME_BEFORE_DETECTION',
      'RESOLUTION_TYPE_MISMATCH',
      'TENANT_SCOPE_MISMATCH',
    ]),
  },
) {}
