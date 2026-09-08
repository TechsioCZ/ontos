import { expect, it } from '@app/effect-rstest';
import { Effect } from 'effect';
import { runBrowserEffect } from '../../src/runtime/browser-effect-runtime.ts';

it.effect('preserves Effect success and failure behavior at the browser boundary', () =>
  Effect.gen(function* browserBoundaryResults() {
    const failure = { _tag: 'ExpectedFailure' } as const;

    yield* Effect.promise(() =>
      expect(runBrowserEffect(Effect.succeed('ready'))).resolves.toBe('ready'),
    );
    yield* Effect.promise(() =>
      expect(runBrowserEffect(Effect.fail(failure))).rejects.toBe(failure),
    );
  }),
);

it.effect('interrupts the running Effect when its AbortSignal is aborted', () =>
  Effect.gen(function* browserBoundaryInterruption() {
    const controller = new AbortController();
    let finalized = false;
    const request = runBrowserEffect(
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
      { signal: controller.signal },
    );

    controller.abort();

    yield* Effect.promise(() => expect(request).rejects.toBeTruthy());
    expect(finalized).toBe(true);
  }),
);
