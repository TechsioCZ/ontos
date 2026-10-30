import {
  ContextAccess,
  LegalEntityContext,
  OAuthAuthenticationAudit,
  OAuthGrantRegistryLive,
  PrincipalResolver,
  PrincipalResolverUnavailableError,
} from '@app/core-runtime';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Result } from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';

import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, BetterAuthNativeAdapterLive } from '../../api/auth/db/client.ts';
import { authRelations } from '../../api/auth/db/schema.ts';
import { BetterAuthFrameworkLive } from '../../api/auth/better-auth-framework.ts';
import { BetterAuthRuntimeLive } from '../../api/auth/better-auth-runtime.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';
import { OAuthEndpointGuardsLive } from '../../api/auth/oauth-server/endpoint-guards.ts';
import { OAuthEndpointGuardData } from '../../api/oauth-connections/grant-store.ts';
import { OAuthConnectionHooksLive } from '../../api/oauth-connections/better-auth-hooks.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

const { createAuth, getSession, handleRequest, initializeAuth } = rs.hoisted(() => ({
  createAuth: rs.fn(),
  getSession: rs.fn(),
  handleRequest: rs.fn(),
  initializeAuth: rs.fn(Promise.resolve.bind(Promise, { ready: true })),
}));
rs.mock('better-auth/minimal', () => ({
  betterAuth: () => {
    createAuth();
    return { $context: initializeAuth(), api: { getSession }, handler: handleRequest };
  },
}));

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const authBindingId = '40000000-0000-4000-8000-000000000001';
const userId = 'document-user';
const principalIdentity = {
  authBindingId,
  displayName: 'Document user',
  principalId,
  principalKind: 'human' as const,
  tenantId,
};
const legalEntity = { legalEntityId, legalName: 'Document company' };
const availableTenants = [{ name: 'Document tenant', tenantId }];
const headers = new Headers({ cookie: 'session=test-session', origin: 'http://localhost:3020' });
const sessionResponse = () => ({
  headers: new Headers({ 'set-cookie': 'session=renewed; HttpOnly' }),
  response: {
    session: {
      activeContextKind: 'company',
      activeLegalEntityId: legalEntityId,
      activeTenantId: tenantId,
      id: 'document-session',
    },
    user: { email: 'document@example.test', id: userId },
  },
});
const authenticationConfig = {
  baseUrl: 'http://localhost:3020',
  connectionString: 'postgresql://unused',
  secret: 'document-context-unit-test-secret',
  secureCookies: false,
  supportUserIds: [],
  trustedOrigins: ['http://localhost:3020'],
};
const driver = scriptedPgClientLayer(
  Effect.succeed(testSqlConnection(() => Effect.die('The document fixture must not execute SQL'))),
).pipe(Layer.provide(Reactivity.layer));
const registryDatabase = Layer.effect(
  CoreDatabase,
  makeWithDefaults({ relations: coreRelations }).pipe(Effect.map((executor) => ({ executor }))),
).pipe(Layer.provide(driver));
const hooks = OAuthConnectionHooksLive.pipe(
  Layer.provide(OAuthGrantRegistryLive.pipe(Layer.provide(registryDatabase))),
);
const persistence = Layer.effect(
  AuthDatabase,
  makeWithDefaults({ relations: authRelations }).pipe(
    Effect.map((executor) => ({
      adapter: () => {
        throw new Error('The document fixture must not open the Better Auth adapter');
      },
      executor,
    })),
  ),
).pipe(Layer.provide(driver));
const legalEntityContext = {
  listActiveForTenant: () => Effect.succeed([legalEntity]),
  validateSelection: () => Effect.succeed(legalEntity),
};
const context = Layer.mergeAll(
  BetterAuthRuntimeLive,
  hooks,
  Layer.succeed(AuthConfig, authenticationConfig),
  Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
  Layer.succeed(LegalEntityContext, legalEntityContext),
  Layer.succeed(OAuthAuthenticationAudit, {
    record: () => Effect.die('Document resolution must not record an OAuth observation'),
  }),
  Layer.succeed(OAuthEndpointGuardData, {
    consentApproved: () => Effect.die('Document resolution must not check OAuth consent'),
    loadRefresh: () => Effect.succeed(Option.none()),
    revokeFamily: () => Effect.die('Document resolution must not revoke an OAuth token family'),
  }),
  BetterAuthNativeAdapterLive.pipe(Layer.provideMerge(persistence)),
).pipe(Layer.provide(NodeCrypto.layer));

const frameworkLive = BetterAuthFrameworkLive();
const requestServices = Layer.merge(frameworkLive, OAuthEndpointGuardsLive.pipe(Layer.provide(frameworkLive)));
const makeAuthentication = () => makeAuthenticationService().pipe(Effect.provide(requestServices));

it.effect('resolves one session and principal per document and observes revocation on the next document', () =>
  Effect.gen(function* documentSessionResolution() {
    getSession.mockReset().mockResolvedValueOnce(sessionResponse()).mockResolvedValueOnce({
      headers: new Headers(),
      response: null,
    });
    let principalReads = 0;
    let tenantReads = 0;
    const authentication = yield* makeAuthentication().pipe(
      Effect.provideService(
        PrincipalResolver,
        makePrincipalResolverDouble({
          listAvailableTenants: (resolvedUserId) => {
            expect(resolvedUserId).toBe(userId);
            tenantReads += 1;
            return Effect.succeed(availableTenants);
          },
          resolveBetterAuthUserForTenant: () => {
            principalReads += 1;
            return Effect.succeed(principalIdentity);
          },
        }),
      ),
    );
    const document = yield* authentication.resolveDocumentContext(headers);
    expect(document.context.state).toBe('authenticated');
    expect(document.context.setCookieHeaders).toEqual(['session=renewed; HttpOnly']);
    expect(Result.getOrThrow(document.tenants).tenants).toEqual(availableTenants);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(principalReads).toBe(1);
    expect(tenantReads).toBe(1);
    const revoked = yield* authentication.resolveDocumentContext(headers);
    expect(revoked.context.state).toBe('anonymous');
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(principalReads).toBe(1);
    expect(tenantReads).toBe(1);
  }).pipe(Effect.provide(context)),
);

it.effect('loads tenant choices and legal-entity selection concurrently after authenticating', () =>
  Effect.gen(function* parallelDocumentContext() {
    getSession.mockReset().mockResolvedValue(sessionResponse());
    const legalStarted = yield* Deferred.make<boolean>();
    const tenantsStarted = yield* Deferred.make<boolean>();
    const authentication = yield* makeAuthentication().pipe(
      Effect.provideService(
        PrincipalResolver,
        makePrincipalResolverDouble({
          listAvailableTenants: () =>
            Deferred.succeed(tenantsStarted, true).pipe(
              Effect.andThen(Deferred.await(legalStarted)),
              Effect.as(availableTenants),
            ),
          resolveBetterAuthUserForTenant: () => Effect.succeed(principalIdentity),
        }),
      ),
    );
    const document = yield* authentication.resolveDocumentContext(headers).pipe(
      Effect.provideService(LegalEntityContext, {
        ...legalEntityContext,
        listActiveForTenant: () =>
          Deferred.succeed(legalStarted, true).pipe(
            Effect.andThen(Deferred.await(tenantsStarted)),
            Effect.as([legalEntity]),
          ),
      }),
    );
    expect(document.context.state).toBe('authenticated');
    expect(Result.getOrThrow(document.tenants).tenants).toEqual(availableTenants);
    expect(getSession).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(context)),
);

it.effect('binds OAuth consent to the real Better Auth session without resolving a principal', () =>
  Effect.gen(function* oauthConsentSession() {
    createAuth.mockClear();
    getSession.mockReset().mockResolvedValue({
      session: { id: 'oauth-session' },
      user: { id: userId },
    });
    const consentReads: { readonly sessionId: string; readonly userId: string }[] = [];
    const authentication = yield* makeAuthentication().pipe(
      Effect.provideService(PrincipalResolver, makePrincipalResolverDouble()),
      Effect.provideService(OAuthEndpointGuardData, {
        consentApproved: (session) => {
          consentReads.push(session);
          return Effect.succeed(true);
        },
        loadRefresh: () => Effect.succeed(Option.none()),
        revokeFamily: () => Effect.void,
      }),
    );
    const guards = authentication.oauth?.guards;
    expect(guards).toBeDefined();
    if (guards === undefined) {
      return yield* Effect.die('OAuth guards were not composed');
    }
    // Construction remains lazy: API-key admission never initializes Better Auth.
    expect(createAuth).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(yield* guards.consentApproved(headers)).toBe(true);
    expect(getSession).toHaveBeenCalledWith({ headers }, undefined);
    expect(consentReads).toEqual([{ sessionId: 'oauth-session', userId }]);
    getSession.mockResolvedValueOnce(null);
    expect(yield* guards.consentApproved(headers)).toBe(false);
    expect(consentReads).toHaveLength(1);
    const failure = new Error('Better Auth session lookup failed');
    getSession.mockRejectedValueOnce(failure);
    const result = yield* guards.consentApproved(headers).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.pretty(result.cause)).toContain('Better Auth session lookup failed');
    }
    expect(consentReads).toHaveLength(1);
    return yield* Effect.void;
  }).pipe(Effect.provide(context)),
);

it.effect('defers native dispatch and reuses only the ready provider while retaining native handler failures', () =>
  Effect.gen(function* lazyNativeDispatch() {
    createAuth.mockClear();
    const response = new Response('native OAuth response');
    handleRequest.mockReset().mockResolvedValueOnce(response);
    const authentication = yield* makeAuthentication();
    const endpoint = authentication.oauth;
    if (endpoint === undefined) {
      return yield* Effect.die('OAuth endpoint was not composed');
    }
    const request = new Request(`${endpoint.issuer}/jwks`);
    const dispatch = endpoint.handler(request);
    expect(createAuth).not.toHaveBeenCalled();
    expect(handleRequest).not.toHaveBeenCalled();
    expect(yield* dispatch).toBe(response);
    expect(handleRequest).toHaveBeenCalledWith(request, undefined);
    expect(createAuth).toHaveBeenCalledTimes(1);
    // The isolate-owned observer publishes only after SDK setup has completed.
    yield* Effect.yieldNow;

    const next = yield* makeAuthentication();
    const failure = new Error('Native Better Auth handler failed');
    handleRequest.mockRejectedValueOnce(failure);
    if (next.oauth === undefined) {
      return yield* Effect.die('The next request has no OAuth endpoint');
    }
    const result = yield* next.oauth.handler(request).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.cause).toBe(failure);
    }
    expect(createAuth).toHaveBeenCalledTimes(1);
    return yield* Effect.void;
  }).pipe(Effect.provideService(PrincipalResolver, makePrincipalResolverDouble()), Effect.provide(context)),
);

it.effect('does not share pending setup and reuses a provider only after setup is ready', () =>
  Effect.gen(function* pendingNativeSetup() {
    createAuth.mockClear();
    const pending = Promise.withResolvers<{ ready: boolean }>();
    initializeAuth.mockReturnValueOnce(pending.promise);
    handleRequest.mockReset().mockResolvedValue(new Response('native OAuth response'));
    yield* Effect.gen(function* pendingSetupRequests() {
      const first = yield* makeAuthentication();
      const second = yield* makeAuthentication();
      if (first.oauth === undefined || second.oauth === undefined) {
        return yield* Effect.die('OAuth endpoint was not composed');
      }
      const request = new Request(`${first.oauth.issuer}/jwks`);
      yield* first.oauth.handler(request);
      yield* second.oauth.handler(request);
      expect(createAuth).toHaveBeenCalledTimes(2);
      pending.resolve({ ready: true });
      yield* Effect.yieldNow;
      const third = yield* makeAuthentication();
      if (third.oauth === undefined) {
        return yield* Effect.die('The next request has no OAuth endpoint');
      }
      yield* third.oauth.handler(request);
      expect(createAuth).toHaveBeenCalledTimes(2);
      return yield* Effect.void;
    }).pipe(Effect.ensuring(Effect.sync(() => pending.resolve({ ready: true }))));
  }).pipe(Effect.provideService(PrincipalResolver, makePrincipalResolverDouble()), Effect.provide(context)),
);

it.effect('never publishes failed SDK setup and retains its original request failure', () =>
  Effect.gen(function* failedNativeSetup() {
    createAuth.mockClear();
    const failure = new Error('Native Better Auth setup failed');
    initializeAuth.mockRejectedValueOnce(failure);
    handleRequest.mockReset().mockRejectedValueOnce(failure).mockResolvedValue(new Response('recovered'));
    const first = yield* makeAuthentication();
    if (first.oauth === undefined) {
      return yield* Effect.die('OAuth endpoint was not composed');
    }
    const request = new Request(`${first.oauth.issuer}/jwks`);
    const result = yield* first.oauth.handler(request).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.cause).toBe(failure);
    }
    const next = yield* makeAuthentication();
    if (next.oauth === undefined) {
      return yield* Effect.die('The next request has no OAuth endpoint');
    }
    expect((yield* next.oauth.handler(request)).ok).toBe(true);
    expect(createAuth).toHaveBeenCalledTimes(2);
    return yield* Effect.void;
  }).pipe(Effect.provideService(PrincipalResolver, makePrincipalResolverDouble()), Effect.provide(context)),
);

it.effect('interrupts request-owned dispatch without changing the original SDK request', () =>
  Effect.gen(function* interruptedNativeDispatch() {
    const pending = Promise.withResolvers<Response>();
    handleRequest.mockReset().mockReturnValueOnce(pending.promise);
    yield* Effect.gen(function* interruptedRequest() {
      const authentication = yield* makeAuthentication();
      if (authentication.oauth === undefined) {
        return yield* Effect.die('OAuth endpoint was not composed');
      }
      const request = new Request(`${authentication.oauth.issuer}/jwks`);
      const fiber = yield* authentication.oauth.handler(request).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(handleRequest).toHaveBeenCalledWith(request, undefined);
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(request.signal.aborted).toBe(false);
      return yield* Effect.void;
    }).pipe(Effect.ensuring(Effect.sync(() => pending.resolve(new Response('finished')))));
  }).pipe(Effect.provideService(PrincipalResolver, makePrincipalResolverDouble()), Effect.provide(context)),
);

it.effect('keeps a tenant-choice failure separate from the authenticated document context', () =>
  Effect.gen(function* unavailableTenantChoices() {
    getSession.mockReset().mockResolvedValue(sessionResponse());
    const authentication = yield* makeAuthentication().pipe(
      Effect.provideService(
        PrincipalResolver,
        makePrincipalResolverDouble({
          listAvailableTenants: () =>
            Effect.fail(new PrincipalResolverUnavailableError({ reason: 'Tenant choices unavailable' })),
          resolveBetterAuthUserForTenant: () => Effect.succeed(principalIdentity),
        }),
      ),
    );
    const document = yield* authentication.resolveDocumentContext(headers);
    expect(document.context.state).toBe('authenticated');
    expect(Result.isFailure(document.tenants)).toBe(true);
    expect(getSession).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(context)),
);
