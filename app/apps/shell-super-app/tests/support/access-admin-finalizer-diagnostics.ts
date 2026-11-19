import { Effect, Scope } from 'effect';

// Lifecycle-only metadata survives an uninterruptible finalizer: a start without an end names the blocked owner.
export const finalizing = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.sync(() => process.stderr.write(`access-admin finalizer start pid=${process.pid} ${label}\n`)).pipe(
    Effect.andThen(effect),
    Effect.onExit((exit) =>
      Effect.sync(() =>
        process.stderr.write(`access-admin finalizer end pid=${process.pid} ${label} outcome=${exit._tag}\n`),
      ),
    ),
  );

export const diagnosticScope = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* tracedScope() {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => finalizing(label, Scope.close(scope, exit)));
    return yield* Scope.provide(effect, scope);
  });
