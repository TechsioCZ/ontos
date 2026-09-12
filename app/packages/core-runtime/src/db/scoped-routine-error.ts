import { Schema } from 'effect';

export const SCOPED_ROUTINE_INVOCATION_ERROR_CODES = [
  'scoped_routine_arguments_invalid',
  'scoped_routine_invocation_failed',
  'scoped_routine_result_invalid',
  'scoped_routine_scope_missing',
] as const;
export type ScopedRoutineInvocationErrorCode = (typeof SCOPED_ROUTINE_INVOCATION_ERROR_CODES)[number];

const OwnerModuleKeySchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/u)).pipe(
  Schema.brand('ScopedRoutineOwnerModuleKey'),
  Schema.decodeTo(Schema.String),
);
const RoutineKeySchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)).pipe(
  Schema.brand('ScopedRoutineKey'),
  Schema.decodeTo(Schema.String),
);

export class ScopedRoutineInvocationError extends Schema.TaggedError<ScopedRoutineInvocationError>()(
  'ScopedRoutineInvocationError',
  {
    code: Schema.Literals(SCOPED_ROUTINE_INVOCATION_ERROR_CODES),
    constraint: Schema.OptionFromNullOr(Schema.String),
    ownerModuleKey: OwnerModuleKeySchema,
    postgresCode: Schema.OptionFromNullOr(Schema.String),
    reason: Schema.String,
    routineKey: RoutineKeySchema,
  },
) {}
