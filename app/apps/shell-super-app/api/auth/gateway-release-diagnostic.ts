import { Context, Effect, Schema } from 'effect';

export const ShellGatewayReleaseDiagnosticSchema = Schema.Literals([
  'catalog_invalid',
  'catalog_unavailable',
  'composition_revision_mismatch',
  'shell_marker_mismatch',
]);

export class ShellGatewayReleaseObservationError extends Schema.TaggedError<ShellGatewayReleaseObservationError>()(
  'ShellGatewayReleaseObservationError',
  {},
) {}

export const ShellGatewayReleaseObserver = Context.Reference<
  (reason: typeof ShellGatewayReleaseDiagnosticSchema.Type) => Effect.Effect<void, ShellGatewayReleaseObservationError>
>('@app/shell-super-app/api/auth/gateway-release-diagnostic/ShellGatewayReleaseObserver', {
  defaultValue: () => () => Effect.void,
});

/** Optional infrastructure observation never changes a release decision or its typed result. */
export const withShellGatewayReleaseDiagnostic = <Value, Failure, Requirements>(
  reason: typeof ShellGatewayReleaseDiagnosticSchema.Type,
  operation: Effect.Effect<Value, Failure, Requirements>,
) =>
  ShellGatewayReleaseObserver.pipe(
    Effect.flatMap((observe) => Effect.suspend(() => observe(reason))),
    Effect.exit,
    Effect.andThen(operation),
  );
