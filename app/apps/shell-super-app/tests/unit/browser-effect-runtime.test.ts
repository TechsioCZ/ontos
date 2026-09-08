import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

class ExpectedFailure extends Schema.TaggedError<ExpectedFailure>()(
  'ExpectedFailure',
  {}
) {}

/** Forks on the real browser runtime, interrupting on scope close so a failed assertion leaks no fiber. */
const forkOnBrowserRuntime = <Value, Failure>(
  program: Effect.Effect<Value, Failure>,
  options?: Effect.RunOptions
) =>
  Effect.acquireRelease(
    Effect.sync(() => browserRuntime.runFork(program, options)),
    (fiber) => Fiber.interrupt(fiber)
  );

it.effect('carries success values out of the browser runtime', () =>
  Effect.gen(function* browserRuntimeSuccess() {
    const fiber = yield* forkOnBrowserRuntime(Effect.succeed('ready'));

    expect(yield* Fiber.join(fiber)).toBe('ready');
  })
);

it.effect('keeps the typed failure identity of a browser runtime program', () =>
  Effect.gen(function* browserRuntimeTypedFailure() {
    const failure = new ExpectedFailure();

    const fiber = yield* forkOnBrowserRuntime(Effect.fail(failure));

    expect(yield* Effect.flip(Fiber.join(fiber))).toBe(failure);
  })
);

it.effect('interrupts the running Effect when its AbortSignal is aborted', () =>
  Effect.gen(function* browserRuntimeInterruption() {
    const controller = new AbortController();
    const finalized: string[] = [];
    const finalizersInstalled = yield* Deferred.make<'installed'>();
    const fiber = yield* forkOnBrowserRuntime(
      Effect.andThen(
        Deferred.succeed(finalizersInstalled, 'installed'),
        Effect.never
      ).pipe(
        Effect.ensuring(Effect.sync(() => finalized.push('inner'))),
        Effect.ensuring(Effect.sync(() => finalized.push('outer')))
      ),
      { signal: controller.signal }
    );
    yield* Deferred.await(finalizersInstalled);

    controller.abort();
    const exit = yield* Fiber.await(fiber);

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(finalized).toEqual(['inner', 'outer']);
  })
);
