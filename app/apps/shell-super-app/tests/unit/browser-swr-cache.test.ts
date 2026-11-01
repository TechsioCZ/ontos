import { Deferred, Effect, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SafeAuthenticatedIdentitySchema } from '../../shared/api.ts';
import { browserReadKey, browserStaleWhileRevalidateCache } from '../../src/routes/browser-swr-cache.ts';

const personOf = (principalUuid: string) =>
  Schema.decodeUnknownSync(SafeAuthenticatedIdentitySchema)({
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId: '71000000-0000-4000-8000-000000000022',
    legalName: 'Alpha company',
    principalId: principalUuid,
    tenantId: '70000000-0000-4000-8000-000000000020',
  });

it.effect('never answers a fresh-only entry stale: once its window has passed, the next read is made again', () =>
  Effect.gen(function* verifyFreshOnly() {
    let lookups = 0;
    const cache = browserStaleWhileRevalidateCache(
      (_key: string) =>
        Effect.sync(() => {
          lookups += 1;
          return lookups;
        }),
      { capacity: 2, freshMillis: 0, keep: () => true },
    );

    expect(yield* cache.get('session')).toBe(1);
    expect(yield* cache.get('session')).toBe(2);
    expect(lookups).toBe(2);
  }),
);

it.effect('serves a fresh entry inside its window without another read', () =>
  Effect.gen(function* verifyWindow() {
    let lookups = 0;
    const cache = browserStaleWhileRevalidateCache(
      (_key: string) =>
        Effect.sync(() => {
          lookups += 1;
          return lookups;
        }),
      { capacity: 2, freshMillis: 60_000, keep: () => true },
    );

    expect(yield* cache.get('session')).toBe(1);
    expect(yield* cache.get('session')).toBe(1);
    expect(lookups).toBe(1);
  }),
);

it.effect('shares one read of a fresh-only key between concurrent callers', () =>
  Effect.gen(function* verifySharing() {
    let lookups = 0;
    const gate = yield* Deferred.make<boolean>();
    const cache = browserStaleWhileRevalidateCache(
      (_key: string) =>
        Deferred.await(gate).pipe(
          Effect.andThen(
            Effect.sync(() => {
              lookups += 1;
              return 'answer';
            }),
          ),
        ),
      { capacity: 2, freshMillis: 60_000, keep: () => true },
    );

    const callers = Effect.all([cache.get('session'), cache.get('session'), cache.get('session')], {
      concurrency: 'unbounded',
    });
    const fiber = yield* Effect.forkChild(callers);
    yield* Deferred.succeed(gate, true);
    yield* Fiber.join(fiber);

    expect(lookups).toBe(1);
  }),
);

it.effect('keys a read by the person as well as the company, so two people never share an answer', () =>
  Effect.sync(() => {
    const base = 'https://ontos.example.test/shell-super-app-api';
    const first = personOf('849fdb3c-fab6-5c14-b20a-d885dc27313d');
    const second = personOf('0c1f5a52-3e0b-4c5d-9e1a-6b7f8d9e0a11');

    expect(browserReadKey(base, first, 'revision')).not.toBe(browserReadKey(base, second, 'revision'));
    expect(browserReadKey(base, first, 'revision')).toBe(browserReadKey(base, first, 'revision'));
  }),
);
