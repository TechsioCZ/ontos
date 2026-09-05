// expect-count: 6
// Evasion probe: authority-shaped call sites that are not the Effect authority (local objects that
// shadow `Schema`/`Predicate`), delegation that is only one clause of a compound refinement, and
// `Schema` members that do not narrow.
import { Predicate, Schema } from 'effect';

export interface ActionPolicy {
  readonly id: string;
}
declare const ActionPolicySchema: Schema.Codec<ActionPolicy, ActionPolicy>;
declare function handWritten(value: unknown): boolean;

const LocalSchema = { is: (_schema: unknown) => (value: unknown) => handWritten(value) };
const LocalPredicate = { isString: handWritten };

export const isPolicyLocalSchema = (value: unknown): value is ActionPolicy =>
  LocalSchema.is(ActionPolicySchema)(value);

export const isTextLocalPredicate = (value: unknown): value is string => LocalPredicate.isString(value);

// Delegation plus a hand-written clause: the extra clause is exactly what A2 moves into the Schema.
export const isNonEmptyPolicy = (value: unknown): value is ActionPolicy =>
  Schema.is(ActionPolicySchema)(value) && value.id.length > 0;

export const isTrimmedText = (value: unknown): value is string =>
  Predicate.isString(value) && value.trim().length > 0;

// `decodeUnknownSync` / `encodeSync` are not narrowing members.
export const isDecodablePolicy = (value: unknown): value is ActionPolicy =>
  Boolean(Schema.decodeUnknownSync(ActionPolicySchema)(value));

export function assertPolicy(value: unknown): asserts value is ActionPolicy {
  Schema.encodeSync(ActionPolicySchema)(value as ActionPolicy);
}
