// TEST support: the Shell's real Better Auth framework, OAuth server dependencies and endpoint guards.
import {
  makeDatabaseIdentityEnrollmentLive,
  OAuthAuthenticationAuditLive,
  OAuthGrantRegistryLive,
} from '@app/core-runtime';
import { AgentConnectionStoreLive } from '@app/core-runtime/access/intent/agent-connections';
import { Effect, Layer } from 'effect';

import { makeAuthenticationService } from '../../api/auth/service.ts';

import { BetterAuthFrameworkLive } from '../../api/auth/better-auth-framework.ts';
import { BetterAuthRuntimeLive } from '../../api/auth/better-auth-runtime.ts';
import { BetterAuthNativeAdapterLive } from '../../api/auth/db/client.ts';
import { OAuthCredentialsLive } from '../../api/auth/db/oauth-credentials-live.ts';
import { OAuthEndpointGuardsLive } from '../../api/auth/oauth-server/endpoint-guards.ts';
import { OAuthConnectionHooksLive } from '../../api/oauth-connections/better-auth-hooks.ts';
import { OAuthEndpointGuardDataLive } from '../../api/oauth-connections/grant-store.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';

/** The agent connections a refresh-token replay ends, over the test's own Core database. */
export const testAgentConnectionStoreLive = AgentConnectionStoreLive.pipe(
  Layer.provide(makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT)),
);

const oauthAuthenticationLive = Layer.mergeAll(
  BetterAuthRuntimeLive,
  BetterAuthNativeAdapterLive,
  OAuthAuthenticationAuditLive,
  OAuthEndpointGuardDataLive,
  OAuthConnectionHooksLive.pipe(Layer.provide(OAuthGrantRegistryLive)),
).pipe(Layer.provide(Layer.mergeAll(OAuthGrantRegistryLive, OAuthCredentialsLive, testAgentConnectionStoreLive)));

/**
 * What `makeAuthenticationService` and `AuthenticationServiceLive` consume besides configuration, persistence and the
 * principal resolver: the same framework and guards the Shell composes. Fixture sign-up exists only for test users.
 */
export const shellAuthenticationFrameworkLive = (options: { readonly allowFixtureSignUp: boolean }) =>
  OAuthEndpointGuardsLive.pipe(
    Layer.provideMerge(BetterAuthFrameworkLive({ allowFixtureSignUp: options.allowFixtureSignUp })),
    Layer.provideMerge(oauthAuthenticationLive),
  );

/** Real fixture sign-up framework, captured with the test's own database and principal resolver. */
export const makeShellTestAuthentication = (options: { readonly allowFixtureSignUp?: boolean } = {}) =>
  makeAuthenticationService().pipe(
    Effect.provide(shellAuthenticationFrameworkLive({ allowFixtureSignUp: options.allowFixtureSignUp === true })),
  );
