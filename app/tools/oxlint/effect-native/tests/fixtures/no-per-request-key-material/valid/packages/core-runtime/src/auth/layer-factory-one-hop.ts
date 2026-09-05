// The repo's established `Context.Service` idiom: the tag carries no build logic, so the build effect
// lives in a named module-level factory that is handed to `Layer.effect` by reference — exactly the
// shape of `apps/shell-super-app/api/auth/config.ts:135` (`Layer.effect(AuthConfig, loadAuthConfig())`)
// and `packages/core-runtime/src/auth/principal-resolver.ts:503`
// (`Layer.effect(PrincipalResolver, CoreDatabase.pipe(Effect.map(makePrincipalResolver)))`).
// Key material built that way is imported once per Layer build, so it must not report.
import { Context, Effect, Layer } from 'effect';
import { createLocalJWKSet, importJWK } from 'jose';

interface AuthConfigValue {
  readonly jwks: unknown;
  readonly privateJwk: unknown;
}

declare const AuthConfig: Effect.Effect<AuthConfigValue>;

export class ActionJwks extends Context.Service<ActionJwks, unknown>()('ActionJwks') {}

export const makeActionJwks = (configuration: AuthConfigValue): unknown =>
  createLocalJWKSet(configuration.jwks as never);

export const loadSigningKey = (configuration: AuthConfigValue): Effect.Effect<unknown> =>
  Effect.promise(() => importJWK(configuration.privateJwk as never, 'EdDSA'));

export const ActionJwksLive = Layer.effect(ActionJwks, Effect.map(AuthConfig, makeActionJwks));

export const SigningKeyLive = Layer.effect(
  ActionJwks,
  Effect.flatMap(AuthConfig, loadSigningKey),
);

// The same one hop through a memoising Effect combinator.
export const buildRemoteSet = (url: URL): unknown => createLocalJWKSet({ keys: [], url } as never);

export const cachedRemoteSet = Effect.cachedFunction((url: URL) => Effect.sync(() => buildRemoteSet(url)));
