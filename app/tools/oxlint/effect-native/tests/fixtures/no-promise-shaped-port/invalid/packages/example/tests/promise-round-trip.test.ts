// expect-count: 6
import { expect, it } from '@app/effect-rstest';
import * as rstest from '@rstest/core';
import { Cause, Effect } from 'effect';
import * as E from 'effect';
import { promise as adapt, runPromise as run } from 'effect/Effect';
import { runBrowserEffect } from '../browser-runtime';

const check = expect;
const execute = run;
const promise = Effect.promise;

it.effect('browser runtime assertion', () =>
  Effect.promise(() => expect(runBrowserEffect(Effect.succeed('ready'))).resolves.toBe('ready')),
);
it.effect('direct runner', () => Effect.promise(() => Effect.runPromise(Effect.succeed('ready'))));
it.effect('runner aliases', () => adapt(() => execute(Effect.succeed('ready'))));
it.effect('object tryPromise and namespace', () =>
  E.Effect.tryPromise({
    try: () => E.Effect['runPromiseExit'](Effect.succeed('ready')),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
it.effect('assertion alias and transparent wrappers', () =>
  (promise!)(() => (check!(runBrowserEffect(Effect.succeed('ready'))) as any)['resolves'].toBe('ready')),
);
it.effect('Rstest namespace rejects', () =>
  Effect.tryPromise({
    try: () => rstest.expect(runBrowserEffect(Effect.fail('failed')))[`rejects`].toBe('failed'),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
