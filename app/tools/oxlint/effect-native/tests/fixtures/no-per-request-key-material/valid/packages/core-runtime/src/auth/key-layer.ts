// The audit's target shape: import the key material once, inside a Layer.
import { Config, Context, Effect, Layer } from 'effect';
import { createLocalJWKSet, importJWK } from 'jose';

const staticJwks = { keys: [] as readonly unknown[] };

// Module scope: built exactly once per process.
export const localSet = createLocalJWKSet(staticJwks as never);

export class KeySet extends Context.Tag('KeySet')<KeySet, unknown>() {}

export const KeySetLive = Layer.effect(
  KeySet,
  Effect.gen(function* buildKeySet() {
    const raw = yield* Config.string('AUTH_JWKS');
    return createLocalJWKSet(JSON.parse(raw) as never);
  }),
);

export const SigningKeyLive = Layer.scoped(
  KeySet,
  Effect.acquireRelease(
    Effect.promise(() => importJWK(staticJwks as never, 'EdDSA')),
    () => Effect.void,
  ),
);

export const SyncKeyLive = Layer.sync(KeySet, () => createLocalJWKSet(staticJwks as never));

export const UnwrappedKeyLive = Layer.unwrap(
  Effect.sync(() => Layer.succeed(KeySet, createLocalJWKSet(staticJwks as never))),
);

// Memoised per runtime rather than per request.
export const cachedSet = Effect.cached(Effect.sync(() => createLocalJWKSet(staticJwks as never)));

export const cachedByIssuer = Effect.cachedFunction((issuer: string) =>
  Effect.promise(() => importJWK({ issuer } as never, 'EdDSA')),
);
