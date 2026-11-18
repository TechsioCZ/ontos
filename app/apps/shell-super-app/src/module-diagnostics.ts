import { Effect, Option, Schema } from 'effect';
import type { Cause } from 'effect';

const FailureDescriptionSchema = Schema.Struct({ message: Schema.String, stack: Schema.optionalKey(Schema.String) });
const WrappedFailureDescriptionSchema = Schema.Struct({ cause: FailureDescriptionSchema });
type ModuleEntrypointDiagnostic = Cause.UnknownError | Schema.SchemaError | typeof FailureDescriptionSchema.Type;

/** Never serialize remote namespace values or arbitrary error properties into diagnostics. */
export const reportModuleEntrypointFailure = (
  moduleOwner: string,
  phase: string,
  error: ModuleEntrypointDiagnostic,
) => {
  const diagnostic = Schema.isSchemaError(error)
    ? 'SchemaError: remote namespace contract mismatch'
    : Option.match(Schema.decodeUnknownOption(WrappedFailureDescriptionSchema)(error), {
        onNone: () =>
          Option.match(Schema.decodeUnknownOption(FailureDescriptionSchema)(error), {
            onNone: () => 'Remote operation failed with a non-Error cause',
            onSome: (description) => description.stack ?? description.message,
          }),
        onSome: ({ cause: description }) => description.stack ?? description.message,
      });
  return Effect.logError(`Remote module entrypoint failed (${moduleOwner}; phase=${phase})`, diagnostic).pipe(
    Effect.annotateLogs({ moduleOwner, phase }),
  );
};
