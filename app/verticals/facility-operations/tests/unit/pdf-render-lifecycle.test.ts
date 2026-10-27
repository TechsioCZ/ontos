import { expect, it } from 'effect-rstest';
import { Deferred, Effect, Fiber, FiberSet } from 'effect';
import { pdfRenderLifecycle } from '../../src/ui/pdf-render-lifecycle.ts';
import type { NativePdfRenderTask } from '../../src/ui/pdf-render-lifecycle.ts';

const unitNotification: Effect.Effect<Deferred.Deferred<void>> = Deferred.make();

// The SDK captures this test's services once and tracks native completion callbacks in its Scope.
const nativePdfCompletions = Effect.gen(function* nativePdfCompletions() {
  const toNativePromise = yield* FiberSet.makeRuntimePromise();
  return Effect.gen(function* nativePdfCompletion() {
    const completed = yield* unitNotification;
    return {
      complete: () => {
        Deferred.doneUnsafe(completed, Effect.void);
      },
      promise: toNativePromise(Deferred.await(completed)),
    };
  });
});
type NativePdfCompletion = Effect.Success<Effect.Success<typeof nativePdfCompletions>>;

it.effect('replacement rendering waits for cancellation and never publishes stale or interrupted queued work', () =>
  Effect.gen(function* pdfCanvasReplacement() {
    const render = yield* pdfRenderLifecycle;
    const acquireCompletion = yield* nativePdfCompletions;
    const events: string[] = [];
    const published: string[] = [];
    let canvasInUse = false;
    const firstCompletion = yield* acquireCompletion;
    const replacementCompletion = yield* acquireCompletion;
    const firstStarted = yield* unitNotification;
    const replacementStarted = yield* unitNotification;

    const nativeTask = (name: string, completion: NativePdfCompletion): NativePdfRenderTask => {
      expect(canvasInUse).toBe(false);
      canvasInUse = true;
      events.push(`render:${name}`);
      return {
        cancel: () => {
          events.push(`cancel:${name}`);
          canvasInUse = false;
          completion.complete();
        },
        promise: completion.promise,
      };
    };
    const publish = (name: string) => () => {
      events.push(`publish:${name}`);
      published.push(name);
    };
    const first = new AbortController();
    const stale = new AbortController();
    const interrupted = new AbortController();
    const replacement = new AbortController();

    const firstFiber = yield* Effect.forkChild(
      render({
        finish: publish('first'),
        prepare: Effect.succeed(() => {
          const task = nativeTask('first', firstCompletion);
          Deferred.doneUnsafe(firstStarted, Effect.void);
          return task;
        }),
        signal: first.signal,
      }),
      { startImmediately: true },
    );
    yield* Deferred.await(firstStarted);

    const staleFiber = yield* Effect.forkChild(
      render({
        finish: publish('stale'),
        prepare: Effect.succeed(() => nativeTask('stale', firstCompletion)),
        signal: stale.signal,
      }),
      { startImmediately: true },
    );
    const interruptedFiber = yield* Effect.forkChild(
      render({
        finish: publish('interrupted'),
        prepare: Effect.succeed(() => nativeTask('interrupted', firstCompletion)),
        signal: interrupted.signal,
      }),
      { startImmediately: true },
    );
    stale.abort();
    yield* Fiber.interrupt(interruptedFiber);

    const replacementFiber = yield* Effect.forkChild(
      render({
        finish: publish('replacement'),
        prepare: Effect.succeed(() => {
          const task = nativeTask('replacement', replacementCompletion);
          Deferred.doneUnsafe(replacementStarted, Effect.void);
          return task;
        }),
        signal: replacement.signal,
      }),
      { startImmediately: true },
    );
    expect(events).toEqual(['render:first']);

    first.abort();
    yield* Fiber.interrupt(firstFiber);
    yield* Deferred.await(replacementStarted);
    replacementCompletion.complete();
    yield* Fiber.join(replacementFiber);
    yield* Fiber.join(staleFiber);

    expect(events).toEqual([
      'render:first',
      'cancel:first',
      'render:replacement',
      'cancel:replacement',
      'publish:replacement',
    ]);
    expect(published).toEqual(['replacement']);
    expect(canvasInUse).toBe(false);
  }),
);

it.effect('separately acquired canvas owners can render pending native tasks independently', () =>
  Effect.gen(function* independentPdfCanvases() {
    const firstOwner = yield* pdfRenderLifecycle;
    const secondOwner = yield* pdfRenderLifecycle;
    const acquireCompletion = yield* nativePdfCompletions;
    const firstStarted = yield* unitNotification;
    const secondStarted = yield* unitNotification;
    const firstCompletion = yield* acquireCompletion;
    const secondCompletion = yield* acquireCompletion;
    const events: string[] = [];
    const start = (
      owner: Effect.Success<typeof pdfRenderLifecycle>,
      name: string,
      started: Deferred.Deferred<void>,
      completion: NativePdfCompletion,
    ) =>
      owner({
        finish: () => {
          events.push(`publish:${name}`);
        },
        prepare: Effect.succeed(() => {
          events.push(`render:${name}`);
          Deferred.doneUnsafe(started, Effect.void);
          return {
            cancel: () => {
              events.push(`cancel:${name}`);
              completion.complete();
            },
            promise: completion.promise,
          } satisfies NativePdfRenderTask;
        }),
        signal: new AbortController().signal,
      });
    const first = yield* Effect.forkChild(start(firstOwner, 'first', firstStarted, firstCompletion), {
      startImmediately: true,
    });
    yield* Deferred.await(firstStarted);
    const second = yield* Effect.forkChild(start(secondOwner, 'second', secondStarted, secondCompletion), {
      startImmediately: true,
    });
    yield* Deferred.await(secondStarted);
    expect(events).toEqual(['render:first', 'render:second']);

    secondCompletion.complete();
    yield* Fiber.join(second);
    firstCompletion.complete();
    yield* Fiber.join(first);
    expect(events).toEqual([
      'render:first',
      'render:second',
      'cancel:second',
      'publish:second',
      'cancel:first',
      'publish:first',
    ]);
  }),
);
