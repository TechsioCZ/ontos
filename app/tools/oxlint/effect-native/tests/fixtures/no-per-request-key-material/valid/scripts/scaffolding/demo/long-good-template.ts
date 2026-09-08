// A generator that already emits the target shape. The `Layer.effect` marker sits far more than a
// few hundred characters before the emitted `createLocalJWKSet`, so the template scan must look back
// to the start of the whole template literal rather than through a fixed character window.
export const renderKeyLayer = (moduleId: string): string => `
import { Context, Effect, Layer } from 'effect';
import { createLocalJWKSet } from 'jose';

export class ActionJwks extends Context.Service<ActionJwks, unknown>()('${moduleId}/ActionJwks') {}

export const ActionJwksLive = Layer.effect(
  ActionJwks,
  Effect.gen(function* buildActionJwks() {
    const configuration = yield* ActionAuthConfig;
    yield* Effect.annotateCurrentSpan('module', '${moduleId}');
    yield* Effect.logDebug('Building the action JWKS for this MicroVertical once per layer build');
    yield* Effect.logDebug('The emitted body is deliberately longer than any fixed lookback window');
    if (configuration.jwks.keys.length === 0) {
      return yield* new ActionAuthConfigurationError({ reason: 'The configured JWKS is empty' });
    }
    return createLocalJWKSet(configuration.jwks);
  }),
);
`;
