// A generator that already emits the Effect-native shape must not be reported.
export const renderKeyLayer = (appId: string): string => `
import { Context, Effect, Layer } from 'effect';
import { createLocalJWKSet } from 'jose';

export class ActionJwks extends Context.Tag('${appId}/ActionJwks')<ActionJwks, unknown>() {}

export const ActionJwksLive = Layer.effect(
  ActionJwks,
  Effect.gen(function* buildActionJwks() {
    const config = yield* ActionAuthConfig;
    return createLocalJWKSet(config.jwks);
  }),
);
`;
