import { Cause, Exit, Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import type { SuiteContext, TestContext } from 'node:test';
import type { Effect as EffectType } from 'effect';

const testTracer = Tracer.make({
  span: (options) => new Tracer.NativeSpan(options),
});

const testRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, testTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);

export const runEffectTestPromise = testRuntime.runPromise;
export const runEffectTestSync = testRuntime.runSync;

/** Adapts a fully provided Effect to Node's completion-callback test boundary. */
export const makeEffectTestCallback =
  <A, E>(effect: EffectType.Effect<A, E>) =>
  (_context: TestContext | SuiteContext, done: (result?: Error) => void): void => {
    testRuntime.runCallback(effect, {
      onExit: Exit.match({
        onFailure: (cause) => {
          done(new Error(Cause.pretty(cause), { cause: Cause.squash(cause) }));
        },
        onSuccess: () => {
          done();
        },
      }),
    });
  };
