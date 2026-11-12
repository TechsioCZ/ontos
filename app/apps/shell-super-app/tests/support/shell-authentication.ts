// TEST support: the Shell's real Better Auth framework, OAuth server dependencies and endpoint guards.
import { OAuthAuthenticationAuditLive, OAuthGrantRegistryLive } from '@app/core-runtime';
import { Effect, Layer } from 'effect';

import { AuthenticationService, AuthenticationServiceLive } from '../../api/auth/service.ts';

import { BetterAuthFrameworkLive } from '../../api/auth/better-auth-framework.ts';
import { BetterAuthRuntimeLive } from '../../api/auth/better-auth-runtime.ts';
import { BetterAuthNativeAdapterLive } from '../../api/auth/db/client.ts';
import { OAuthCredentialsLive } from '../../api/auth/db/oauth-credentials-live.ts';
import { OAuthEndpointGuardsLive } from '../../api/auth/oauth-server/endpoint-guards.ts';
import { OAuthConnectionHooksLive } from '../../api/oauth-connections/better-auth-hooks.ts';
import { OAuthEndpointGuardDataLive } from '../../api/oauth-connections/grant-store.ts';

const oauthAuthenticationLive = Layer.mergeAll(
  BetterAuthRuntimeLive,
  BetterAuthNativeAdapterLive,
  OAuthAuthenticationAuditLive,
  OAuthEndpointGuardDataLive,
  OAuthConnectionHooksLive.pipe(Layer.provide(OAuthGrantRegistryLive)),
).pipe(Layer.provide(Layer.mergeAll(OAuthGrantRegistryLive, OAuthCredentialsLive)));

/**
 * What `AuthenticationServiceLive` consumes besides configuration, persistence and the
 * principal resolver: the same framework and guards the Shell composes. Fixture sign-up exists only for test users.
 */
export const shellAuthenticationFrameworkLive = (options: { readonly allowFixtureSignUp: boolean }) =>
  OAuthEndpointGuardsLive.pipe(
    Layer.provideMerge(BetterAuthFrameworkLive({ allowFixtureSignUp: options.allowFixtureSignUp })),
    Layer.provideMerge(oauthAuthenticationLive),
  );

/**
 * The real AuthenticationService from its owning Layer over the Shell's framework, captured with the test's own
 * configuration, database and principal resolver (still required, and provided by the caller).
 */
export const shellTestAuthentication = (options: { readonly allowFixtureSignUp?: boolean } = {}) =>
  Effect.gen(function* yieldShellTestAuthentication() {
    return yield* AuthenticationService;
  }).pipe(
    Effect.provide(
      AuthenticationServiceLive.pipe(
        Layer.provide(shellAuthenticationFrameworkLive({ allowFixtureSignUp: options.allowFixtureSignUp === true })),
      ),
    ),
  );
