// Audit B4 targets unique-symbol capability slots, not imported literal-string keys.
// Correction: importing a computed key (named, aliased, or namespace-qualified) does not prove
// it is a symbol. AST/scope cannot inspect this external declaration; local proven-symbol
// declaration/construction regressions remain in invalid/. No name heuristic is sound here.
// Evasion: the same cross-module unique-symbol slot as action-registry.ts, reached through a
// namespace import instead of a named import, so the computed key is `slots.operationHandler`.
import * as slots from '@app/core-runtime/operations/slots.ts';

export interface ShellOperationRecord {
  readonly [slots.operationHandler]: (payload: unknown) => Promise<void>;
}

export const buildRecord = (
  handler: (payload: unknown) => Promise<void>,
): ShellOperationRecord => ({ [slots.operationHandler]: handler }) as ShellOperationRecord;

export const handlerOf = (
  record: ShellOperationRecord,
): ((payload: unknown) => Promise<void>) => record[slots.operationHandler];
