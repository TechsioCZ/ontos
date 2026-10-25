import { NodeServices } from '@effect/platform-node';
import { Config, Effect, Layer } from 'effect';
import { Cookies, FetchHttpClient } from 'effect/unstable/http';

import {
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  LegalEntityContextLive,
  PrincipalResolverLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ActionAuthorityLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  ActionAuthorizationLifecycleLive,
  ScopedRoleMembershipLifecycleLive,
  SpiceDbConfigLive,
} from '@app/core-runtime/outbox/core-system-worker';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This operator composition root binds the approved deployment identity to the native Action runtime.
import { makeActionRuntimeLive } from '../../packages/core-runtime/src/actions/runtime.ts';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This composition root opens the privileged SELECT-only audit/membership reader; native Actions use the separate runtime-role pool.
import { makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { OAuthFlowLive } from '../../apps/shell-super-app/api/auth/db/oauth-flow-live.ts';
import { ApiKeyServiceLive } from '../../apps/shell-super-app/api/auth/api-key-service.ts';
import { IdentityLifecycleLive } from '../../apps/shell-super-app/api/auth/identity-lifecycle.ts';
import { AuthConfig, AuthConfigLive } from '../../apps/shell-super-app/api/auth/config.ts';
import { AuthDatabaseLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { AuthenticationService, AuthenticationServiceLive } from '../../apps/shell-super-app/api/auth/service.ts';
import { StaffAuthenticationNamespaceRegistryLive } from '../../apps/shell-super-app/api/auth/authentication-namespace-registry.ts';
import { ShellInstalledModuleCatalogLive } from '../../apps/shell-super-app/api/modules/installed-module-catalog.ts';
import { AgentProfileReadDatabase, AgentProfileSetupError } from './agent-profile-setup.mts';

const persistence = CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive));
const access = ContextAccessLive;
const authConfig = AuthConfigLive;
const authDatabase = AuthDatabaseLive.pipe(Layer.provide(authConfig));
const resolver = PrincipalResolverLive({ authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID }).pipe(
  Layer.provide(persistence),
);
const authentication = AuthenticationServiceLive.pipe(
  Layer.provide(Layer.mergeAll(authConfig, authDatabase, resolver, StaffAuthenticationNamespaceRegistryLive)),
);
const composition = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
);
const modules = ModuleStateGateLive.pipe(Layer.provide(TenantModuleStateServiceLive.pipe(Layer.provide(persistence))));
const operations = Layer.mergeAll(
  persistence,
  access,
  modules,
  ModuleEntrypointGatewayLive.pipe(Layer.provide(modules)),
  OperationalScopeResolverLive.pipe(Layer.provide(Layer.merge(persistence, access))),
);
// The operator runs the approved Shell contract, not whichever marker happens to be in an unbuilt checkout.
const actionRuntime = Layer.unwrap(
  Effect.gen(function* nativeRuntime() {
    const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
    return makeActionRuntimeLive(snapshot.composition.shell.deployment).pipe(
      Layer.provide(Layer.mergeAll(operations, composition, ActionPermissionLive, ActionRepositoryLive)),
    );
  }),
).pipe(Layer.provide(composition));
const reads = Layer.effect(
  AgentProfileReadDatabase,
  Effect.gen(function* readOnlyOperatorDatabase() {
    const configuration = yield* loadDatabaseConnectionPair();
    // Privileged connection is deliberately exposed as SELECT-only. All identity writes use runtime scoped transactions.
    const database = yield* makeCoreDatabase(configuration.admin);
    return { executor: database.executor };
  }),
);
const legalEntityContext = LegalEntityContextLive.pipe(Layer.provide(persistence));
const readRuntime = ReadRuntimeLive.pipe(Layer.provide(operations));
const authorizationLifecycle = ActionAuthorizationLifecycleLive.pipe(
  Layer.provide(ScopedRoleMembershipLifecycleLive),
  Layer.provide(Layer.mergeAll(persistence, DatabaseConfigLive, SpiceDbConfigLive, composition)),
);
const apiKeys = ApiKeyServiceLive.pipe(Layer.provide(Layer.merge(authConfig, authDatabase)));
const identityLifecycle = IdentityLifecycleLive.pipe(Layer.provide(Layer.mergeAll(actionRuntime, apiKeys, resolver)));
export const AgentProfileOperatorLive = Layer.mergeAll(
  // Core revalidates the staff namespace when Actions run, not only while the authentication service is built.
  StaffAuthenticationNamespaceRegistryLive,
  identityLifecycle,
  ActionAuthorityLive,
  OAuthFlowLive.pipe(Layer.provide(Layer.merge(authConfig, authDatabase))),
  authentication,
  actionRuntime,
  readRuntime,
  legalEntityContext,
  authorizationLifecycle,
  composition,
  ActionPermissionLive,
  reads,
  authDatabase,
  authConfig,
  access,
  ShellInstalledModuleCatalogLive.pipe(Layer.provide(composition)),
  NodeServices.layer,
);

/** Real Better Auth sign-in and native principal binding resolution; no synthetic session context or default password. */
export const authenticateAgentProfileOperator = Effect.gen(function* authenticateOperator() {
  const email = yield* Config.String('ONTOS_AGENT_SETUP_EMAIL');
  const secret = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
  const service = yield* AuthenticationService;
  const config = yield* AuthConfig;
  const headers = new Headers({ origin: config.baseUrl });
  const signedIn = yield* service.signIn(email, secret, headers);
  headers.set('cookie', Cookies.toCookieHeader(Cookies.fromSetCookie(signedIn.setCookieHeaders)));
  const context = yield* service.resolveTenantContext(headers);
  if (context.state !== 'authenticated') {
    return yield* new AgentProfileSetupError({
      reason: 'The operator could not resolve an authenticated native principal',
    });
  }
  return { close: service.signOut(headers), principal: context.principal, requestHeaders: headers };
});
