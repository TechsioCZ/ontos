import { expect, test } from '@rstest/core';
import { Effect } from 'effect';

import { runBrowserEffect } from '../../src/runtime/browser-effect-runtime.ts';

test('preserves Effect success and failure behavior at the browser boundary', async () => {
  const failure = { _tag: 'ExpectedFailure' } as const;

  await expect(runBrowserEffect(Effect.succeed('ready'))).resolves.toBe(
    'ready'
  );
  await expect(runBrowserEffect(Effect.fail(failure))).rejects.toBe(failure);
});

test('interrupts the running Effect when its AbortSignal is aborted', async () => {
  const controller = new AbortController();
  let finalized = false;
  const request = runBrowserEffect(
    Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalized = true;
        })
      )
    ),
    { signal: controller.signal }
  );

  controller.abort();

  await expect(request).rejects.toBeTruthy();
  expect(finalized).toBe(true);
});
