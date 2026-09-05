import { readFile } from 'node:fs/promises';
import * as Effect from 'effect/Effect';
import { Config as Cfg, Schema as S } from 'effect';

import { createMutation } from '../shared.mts';

/**
 * The generator's OWN driver code. None of this is emitted, so none of it is this rule's business:
 * `no-throw-in-scripts` and `no-native-json-parse` own these lines.
 */
export const loadGeneratorManifest = async (path: string) => {
  const manifest = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  if (typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('generator manifest must be a JSON object');
  }
  const registry = new URL(process.env.ONTOS_GENERATOR_REGISTRY ?? 'https://example.invalid');
  const key = manifest['signingKey'] as Record<string, unknown>;
  if (key['kty'] !== 'OKP') {
    throw new Error('generator manifest signing key must be Ed25519');
  }
  return { manifest, registry };
};

/** The Effect-native replacement template: Config.schema + Schema.fromJsonString + Redacted. */
export const renderActionPrincipalServer = (appId: string): string => `
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

export class ActionPrincipalConfigurationError extends Schema.TaggedError<ActionPrincipalConfigurationError>()(
  'ActionPrincipalConfigurationError',
  { reason: Schema.String },
) {}

const JsonWebKey = Schema.Struct({
  kty: Schema.Literal('OKP'),
  crv: Schema.Literal('Ed25519'),
  alg: Schema.Literal('EdDSA'),
  use: Schema.Literal('sig'),
  kid: Schema.NonEmptyString,
  x: Schema.NonEmptyString,
});

const JsonWebKeySet = Schema.Struct({ keys: Schema.NonEmptyArray(JsonWebKey) });

const ActionBoundaryConfig = Config.schema(
  Schema.Struct({
    ONTOS_GATEWAY_ISSUER: Schema.URL,
    ONTOS_GATEWAY_PUBLIC_JWKS: Schema.Redacted(Schema.fromJsonString(JsonWebKeySet)),
  }),
);

export const ActionPrincipalConfigLayer = Layer.effect(ActionPrincipalConfig)(
  Effect.gen(function* () {
    const config = yield* ActionBoundaryConfig;
    const keySet = Redacted.value(config.ONTOS_GATEWAY_PUBLIC_JWKS);
    return { audience: '${appId}', issuer: config.ONTOS_GATEWAY_ISSUER, keySet };
  }),
);
`;

export const planActionBoundary = (appId: string) =>
  Effect.sync(() =>
    createMutation(
      `verticals/${appId}/api/auth/action-principal.ts`,
      renderActionPrincipalServer(appId),
    ),
  );

export const audienceConfig = Cfg.string('ONTOS_GATEWAY_AUDIENCE');
export const audienceSchema = S.NonEmptyString;
