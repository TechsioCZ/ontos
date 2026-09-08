import { expect, it, rstest } from 'effect-rstest';
import { Effect, Fiber } from 'effect';
import { client } from 'external-sdk';
import { expect as foreignExpect } from 'external-assertions';
import { runBrowserEffect } from '../browser-runtime';

it.effect('SDK Promise adaptation', () => Effect.promise(() => client.request()));
it.effect('SDK mocks', () => {
  const request = rstest.fn().mockResolvedValue('ready');
  return Effect.promise(() => request());
});
it.effect('foreign names', () => {
  const foreign = { runPromise: () => client.request() };
  return Effect.promise(() => foreign.runPromise());
});
it.effect('foreign assertion', () =>
  Effect.promise(() => foreignExpect(client.request()).resolves.toBe('ready')),
);
it.effect('shadowed expect', () => {
  const expect = foreignExpect;
  return Effect.promise(() => expect(client.request()).rejects.toBe('failed'));
});
it.effect('shadowed Effect runner', () =>
  Effect.promise(() => {
    const Effect = client;
    return Effect.runPromise();
  }),
);
it.effect('shadowed adapter', () => {
  const Effect = { promise: (value: unknown) => value };
  return Effect.promise(() => expect(client.request()).resolves.toBe('ready'));
});
it.effect('native assertions and Fiber', () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.succeed('ready'));
    expect(yield* Fiber.join(fiber)).toBe('ready');
  }),
);
// Cross-file runner provenance is intentionally not inferred from its name.
it.effect('opaque imported browser runtime', () =>
  Effect.promise(() => runBrowserEffect(Effect.succeed('ready'))),
);
