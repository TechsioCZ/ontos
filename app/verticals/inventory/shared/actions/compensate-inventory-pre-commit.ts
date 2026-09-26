/* oxlint-disable unicorn/prefer-export-from -- Codesmith Action HTTP requires concrete local schema export declarations. */
import {
  CompensateInventoryPreCommitErrorSchema as ErrorSchema,
  CompensateInventoryPreCommitPayloadSchema as PayloadSchema,
  CompensateInventoryPreCommitResultSchema as ResultSchema,
} from '../domain/inventory-pre-commit-compensation.ts';

export const CompensateInventoryPreCommitErrorSchema = ErrorSchema;
export const CompensateInventoryPreCommitPayloadSchema = PayloadSchema;
export const CompensateInventoryPreCommitResultSchema = ResultSchema;
export type { CompensateInventoryPreCommitPayload } from '../domain/inventory-pre-commit-compensation.ts';
/* oxlint-enable unicorn/prefer-export-from */
