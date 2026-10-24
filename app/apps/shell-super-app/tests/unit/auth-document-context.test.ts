import {
  ContextAccess,
  LegalEntityContext,
  PrincipalResolver,
  PrincipalResolverUnavailableError,
} from '@app/core-runtime';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Deferred, Effect, Layer, Result } from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { Reactivity } from 'effect/unstable/reactivity';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authRelations } from '../../api/auth/db/schema.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

const { getSession } = rs.hoisted(() => ({ getSession: rs.fn() }));
rs.mock('better-auth/minimal', () => ({
  betterAuth: () => ({ $context: Promise.resolve({}), api: { getSession } }),
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
).pipe(
  Layer.provide(
    scriptedPgClientLayer(
      Effect.succeed(testSqlConnection(() => Effect.die('The document fixture must not execute SQL'))),
    ).pipe(Layer.provide(Reactivity.layer)),
  ),
);
const legalEntityContext = {
  listActiveForTenant: () => Effect.succeed([legalEntity]),
  validateSelection: () => Effect.succeed(legalEntity),
};
const context = Layer.mergeAll(
  Layer.succeed(AuthConfig, authenticationConfig),
  Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
  Layer.succeed(LegalEntityContext, legalEntityContext),
  persistence,
);

it.effect('resolves one session and principal per document and observes revocation on the next document', () =>
  Effect.gen(function* documentSessionResolution() {
    getSession.mockReset().mockResolvedValueOnce(sessionResponse()).mockResolvedValueOnce({
      headers: new Headers(),
      response: null,
    });
    let principalReads = 0;
    let tenantReads = 0;
    const authentication = yield* makeAuthenticationService().pipe(
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
    const authentication = yield* makeAuthenticationService().pipe(
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

it.effect('keeps a tenant-choice failure separate from the authenticated document context', () =>
  Effect.gen(function* unavailableTenantChoices() {
    getSession.mockReset().mockResolvedValue(sessionResponse());
    const authentication = yield* makeAuthenticationService().pipe(
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
