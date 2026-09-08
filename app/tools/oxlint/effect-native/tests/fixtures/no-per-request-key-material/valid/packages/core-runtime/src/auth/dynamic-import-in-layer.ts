// The same dynamic spellings, but the key material is still built once inside a Layer.
import { Context, Effect, Layer } from 'effect';

export class KeySet extends Context.Tag('KeySet')<KeySet, unknown>() {}

export const KeySetLive = Layer.effect(
  KeySet,
  Effect.promise(async () => {
    const { createLocalJWKSet } = await import('jose');
    return createLocalJWKSet({ keys: [] } as never);
  }),
);

// A non-key module keeps its members untracked.
export const unrelated = () => {
  const { createLocalJWKSet } = require('./local-jwks.ts');
  return createLocalJWKSet({ keys: [] });
};
