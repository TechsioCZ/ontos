// Audit B4 targets unique-symbol capability slots, not imported literal-string keys.
// Correction: importing a computed key (named, aliased, or namespace-qualified) does not prove
// it is a symbol. AST/scope cannot inspect this external declaration; local proven-symbol
// declaration/construction regressions remain in invalid/. No name heuristic is sound here.
// Control probe: an aliased named import of the slot symbol, plus a plain and an optional-chained
// cross-module accessor.
import { operationHandler as handlerSlot } from './slots.ts';

export interface OperationRecord {
  readonly [handlerSlot]: (payload: unknown) => Promise<void>;
}

export const build = (handler: (payload: unknown) => Promise<void>): OperationRecord =>
  ({ [handlerSlot]: handler }) as OperationRecord;

export const handlerOf = (
  record: OperationRecord,
): ((payload: unknown) => Promise<void>) => record[handlerSlot];

export const maybeHandlerOf = (
  record: OperationRecord | undefined,
): ((payload: unknown) => Promise<void>) | undefined => record?.[handlerSlot];
