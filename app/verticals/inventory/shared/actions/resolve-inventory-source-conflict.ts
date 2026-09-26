/* oxlint-disable unicorn/prefer-export-from -- Codesmith Action HTTP requires concrete local schema export declarations. */
import { Schema } from 'effect';

import {
  InventorySourceConflictErrorSchema,
  InventorySourceConflictResolutionInputSchema,
  InventorySourceConflictResolvedSchema,
} from '../domain/inventory-source-conflict.ts';

export const ResolveInventorySourceConflictPayloadSchema = InventorySourceConflictResolutionInputSchema;
export type ResolveInventorySourceConflictPayload = typeof ResolveInventorySourceConflictPayloadSchema.Type;
export const ResolveInventorySourceConflictResultSchema = Schema.Struct({
  conflict: InventorySourceConflictResolvedSchema,
});
export const ResolveInventorySourceConflictErrorSchema = InventorySourceConflictErrorSchema;
/* oxlint-enable unicorn/prefer-export-from */
