// Audit B4 targets unique-symbol capability slots, not imported literal-string keys.
// Correction: importing a computed key (named, aliased, or namespace-qualified) does not prove
// it is a symbol. AST/scope cannot inspect this external declaration; local proven-symbol
// declaration/construction regressions remain in invalid/. No name heuristic is sound here.
import { OPERATION_KEY, operationHandler } from '@app/core-runtime/operations/slots.ts';

// Not reported: an imported computed slot (TS only accepts a computed interface key for a
// `unique symbol` OR a literal-typed constant; syntax alone does not distinguish them).
export interface ShellOperationRecord {
  readonly [operationHandler]: (payload: unknown) => Promise<void>;
}

// Not reported: a read whose imported key may be a literal string.
export const handlerOf = (record: ShellOperationRecord): ((payload: unknown) => Promise<void>) =>
  record[operationHandler];

// Not reported: construction with an imported key of unknown primitive identity.
export const buildRecord = (
  handler: (payload: unknown) => Promise<void>,
): ShellOperationRecord => ({ [operationHandler]: handler }) as ShellOperationRecord;

// must NOT report: an imported *string* constant used as a computed key
export const readOption = (config: Record<string, string>): string | undefined =>
  config[OPERATION_KEY];
