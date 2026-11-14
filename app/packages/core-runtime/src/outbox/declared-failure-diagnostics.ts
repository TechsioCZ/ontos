import { Option, Result, Schema } from 'effect';

const diagnosticToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/u),
);
export const OutboxDeclaredFailureIdentitySchema = Schema.Struct({
  _tag: diagnosticToken,
  code: Schema.OptionFromOptionalKey(diagnosticToken),
});

/** Parse only the declared identity. Never inspect driver causes or log messages, payloads, SQL, or stacks. */
export const outboxDeclaredFailureDiagnostics = (
  parsed: Result.Result<typeof OutboxDeclaredFailureIdentitySchema.Type, Schema.SchemaError>,
) =>
  parsed.pipe(
    Result.match({
      onFailure: () => ({ declared_failure_code: 'none', declared_failure_tag: 'untyped' }),
      onSuccess: ({ _tag: failureTag, code }) => ({
        declared_failure_code: Option.getOrElse(code, () => 'none'),
        declared_failure_tag: failureTag,
      }),
    }),
  );
