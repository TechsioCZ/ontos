import { randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { decodeJwt } from 'jose';
import { Pool } from 'pg';

import { PrincipalResolver, makePrincipalResolver } from '../../packages/core-runtime/src/auth/principal-resolver.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import { makeTestDatabaseFromPool } from '../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import { toLegalEntityAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { spiceDbClientSecurity } from '../../packages/core-runtime/src/permissions/client.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import {
  GatewayContextResponseSchema,
  GatewayContextV2ClaimsSchema,
} from '../../packages/shared-contracts/src/gateway-context.ts';
import { AuthConfig, loadAuthConfig } from '../../apps/shell-super-app/api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { account, apikey, session, user } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../apps/shell-super-app/api/auth/authentication-namespace.ts';
import { makeAuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';

const gatewayAudience = 'party-registry';

/** The isolated composition has one valid gateway audience and no Commerce vertical. */
const isolatedTopology = Object.freeze({
  verticals: Object.freeze([Object.freeze({ id: gatewayAudience, kind: 'vertical', surfaceProfile: 'api-only' })]),
});
const isolatedAllowlist = Object.freeze({
  environment: 'development',
  overlay: Object.freeze({
    environment: 'development',
    ontosModuleManifests: Object.freeze({}),
    schemaVersion: 1,
  }),
  topology: isolatedTopology,
});

// The root integration project does not use the Shell application's Modern/Rstest define block.
// Supply the same build inputs before the default API module is dynamically evaluated.
Reflect.set(globalThis, 'ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY', isolatedTopology);
Reflect.set(globalThis, 'ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST', isolatedAllowlist);

const principalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const tenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const authBindingIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AuthBindingId'));

const isolatedSignInResponseSchema = Schema.Struct({
  identity: Schema.Struct({
    email: Schema.String,
    principalId: principalIdSchema,
    tenantId: tenantIdSchema,
  }),
});
const authenticatedSessionResponseSchema = Schema.Struct({
  identity: Schema.Struct({
    legalEntityId: legalEntityIdSchema,
    principalId: principalIdSchema,
    tenantId: tenantIdSchema,
  }),
  state: Schema.Literal('authenticated'),
});
const apiKeyIssueResponseSchema = Schema.Struct({
  authBindingId: authBindingIdSchema,
  cleanupPending: Schema.Boolean,
  enabled: Schema.Boolean,
  secret: Schema.String,
});
const externalIdentityForbiddenProblemSchema = Schema.Struct({
  _tag: Schema.Literal('ExternalIdentityForbiddenProblem'),
  status: Schema.Literal(403),
});

type SpiceDbClient = ReturnType<typeof v1.NewClient>;
type SpiceDbRelationshipOperation = v1.RelationshipUpdate_Operation;

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({
      objectId: resourceId,
      objectType: resourceType,
    }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectId: subjectId,
        objectType: subjectType,
      }),
    }),
  });

const writeSpiceDbRelationships = (
  client: SpiceDbClient,
  relationships: readonly v1.Relationship[],
  operation: SpiceDbRelationshipOperation,
) =>
  Effect.tryPromise(() =>
    client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: relationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation,
            relationship: item,
          }),
        ),
      }),
    ),
  );

const cookieHeader = (setCookieHeaders: readonly string[]): string => {
  const cookies = new Map<string, string>();
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair !== undefined && separator > 0) {
      cookies.set(pair.slice(0, separator), pair);
    }
  }
  return [...cookies.values()].join('; ');
};

const mergeResponseCookies = (current: string, response: Response): string => {
  const merged = cookieHeader([
    ...(current.length === 0 ? [] : current.split('; ').map((pair) => `${pair};`)),
    ...response.headers.getSetCookie(),
  ]);
  return merged;
};

const requestFor = (
  baseUrl: string,
  path: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: 'GET' | 'POST';
  },
) => {
  const headers = new Headers({
    origin: baseUrl,
    'x-correlation-id': randomUUID(),
    ...options.headers,
  });
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${baseUrl}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method,
  });
};

it.live(
  'proves the default Shell runtime starts and serves staff authentication without Commerce',
  Effect.fnUntraced(function* leanCoreModularityProof() {
    const configuration = yield* loadAuthConfig();
    const corePool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: configuration.connectionString })),
      (pool) => Effect.promise(() => pool.end()),
    );
    const coreDatabase = yield* makeTestDatabaseFromPool(corePool, coreRelations);
    const authPersistence = yield* makeAuthDatabase(configuration);
    const authDatabase = authPersistence.executor;
    const resolver = makePrincipalResolver(
      { executor: coreDatabase },
      { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
    );
    const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, resolver),
    );

    const tenantId = randomUUID();
    const principalId = randomUUID();
    const legalEntityId = randomUUID();
    const authBindingId = randomUUID();
    const email = `lean-core-modularity-${randomUUID()}@example.test`;
    const password = randomUUID();

    const spiceDbConfiguration = yield* loadSpiceDbConfig();
    const spiceDbClient = yield* Effect.acquireRelease(
      Effect.sync(() =>
        v1.NewClient(
          spiceDbConfiguration.preSharedKey,
          spiceDbConfiguration.endpoint,
          spiceDbClientSecurity(spiceDbConfiguration),
        ),
      ),
      (client) => Effect.sync(() => client.close()),
    );
    const legalEntityAccessObjectId = toLegalEntityAccessObjectId(tenantId, legalEntityId);
    if (legalEntityAccessObjectId === undefined) {
      return yield* Effect.die('The modularity fixture legal-entity object ID could not be encoded');
    }
    const bindSelfApiKeyActionObjectId = toSpiceDbActionObjectId('core.identity.bind-self-api-key');
    const spiceDbRelationships = [
      relationship('tenant', tenantId, 'member', 'principal', principalId),
      relationship('legal_entity', legalEntityAccessObjectId, 'tenant', 'tenant', tenantId),
      relationship('legal_entity', legalEntityAccessObjectId, 'member', 'principal', principalId),
      relationship('action', bindSelfApiKeyActionObjectId, 'executor', 'principal', principalId),
    ];
    const cleanup = Effect.fnUntraced(function* cleanupLeanCoreModularityFixture() {
      yield* writeSpiceDbRelationships(spiceDbClient, spiceDbRelationships, v1.RelationshipUpdate_Operation.DELETE);
      yield* purgeFixtureRows([
        coreDatabase.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
        coreDatabase.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
        coreDatabase.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId)),
        coreDatabase.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
        coreDatabase.delete(principals).where(eq(principals.principalId, principalId)),
        coreDatabase.delete(legalEntities).where(eq(legalEntities.legalEntityId, legalEntityId)),
        coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId)),
      ]);
      const users = yield* authDatabase.select({ id: user.id }).from(user).where(eq(user.email, email));
      yield* Effect.forEach(
        users,
        ({ id }) =>
          purgeFixtureRows([
            authDatabase.delete(apikey).where(eq(apikey.referenceId, id)),
            authDatabase.delete(session).where(eq(session.userId, id)),
            authDatabase.delete(account).where(eq(account.userId, id)),
            authDatabase.delete(user).where(eq(user.id, id)),
          ]),
        { concurrency: 1, discard: true },
      );
    });
    yield* Effect.acquireRelease(Effect.void, () => cleanup().pipe(Effect.orDie));

    const betterAuthUserId = yield* authentication.createFixtureUser(email, 'Lean Core Modularity', password);
    yield* coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Lean Core Modularity Tenant',
      slug: `lean-core-modularity-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(principals).values({
      displayName: 'Lean Core Modularity User',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Lean Core Modularity Legal Entity',
      registrationCountry: 'CZ',
      registrationNumber: `LCM-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(principalAuthBindings).values({
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: authBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: betterAuthUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    yield* writeSpiceDbRelationships(spiceDbClient, spiceDbRelationships, v1.RelationshipUpdate_Operation.TOUCH);

    const shellApi = yield* Effect.tryPromise(() => import('../../apps/shell-super-app/api/index.ts'));
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => shellApi.default.createHandler()),
      (createdHandler) => Effect.tryPromise(() => createdHandler.dispose()),
    );

    const signInResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/sign-in', {
          body: { email, password },
          method: 'POST',
        }),
      ),
    );
    expect(signInResponse.status).toBe(200);
    const signIn = Schema.decodeUnknownSync(isolatedSignInResponseSchema)(
      yield* Effect.tryPromise(() => signInResponse.json()),
    );
    expect(signIn.identity.email).toBe(email);
    expect(signIn.identity.principalId).toBe(principalId);
    expect(signIn.identity.tenantId).toBe(tenantId);
    let cookies = cookieHeader(signInResponse.headers.getSetCookie());
    expect(cookies.length > 0).toBe(true);

    const sessionResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/session', {
          headers: { cookie: cookies },
          method: 'GET',
        }),
      ),
    );
    expect(sessionResponse.status).toBe(200);
    cookies = mergeResponseCookies(cookies, sessionResponse);
    const currentSession = Schema.decodeUnknownSync(authenticatedSessionResponseSchema)(
      yield* Effect.tryPromise(() => sessionResponse.json()),
    );
    expect(currentSession.identity.principalId).toBe(principalId);
    expect(currentSession.identity.tenantId).toBe(tenantId);
    expect(currentSession.identity.legalEntityId).toBe(legalEntityId);

    const apiKeyResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/identity/api-keys/self', {
          body: { name: 'lean-core-key' },
          headers: {
            cookie: cookies,
            'idempotency-key': randomUUID(),
          },
          method: 'POST',
        }),
      ),
    );
    expect(apiKeyResponse.status).toBe(200);
    const issuedApiKey = Schema.decodeUnknownSync(apiKeyIssueResponseSchema)(
      yield* Effect.tryPromise(() => apiKeyResponse.json()),
    );
    expect(issuedApiKey.enabled).toBe(true);
    expect(issuedApiKey.cleanupPending).toBe(false);
    expect(issuedApiKey.authBindingId).not.toBe(authBindingId);

    const gatewayResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/api-key/gateway-context', {
          body: { audience: gatewayAudience },
          headers: { 'x-api-key': issuedApiKey.secret },
          method: 'POST',
        }),
      ),
    );
    expect(gatewayResponse.status).toBe(200);
    const gateway = Schema.decodeUnknownSync(GatewayContextResponseSchema)(
      yield* Effect.tryPromise(() => gatewayResponse.json()),
    );
    const gatewayClaims = Schema.decodeUnknownSync(GatewayContextV2ClaimsSchema)(decodeJwt(gateway.token));
    expect(gatewayClaims.aud).toBe(gatewayAudience);
    expect(gatewayClaims.principal.authMethod).toBe('api_key');
    expect(gatewayClaims.principal.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);
    expect(gatewayClaims.principal.principalId).toBe(principalId);
    expect(gatewayClaims.principal.tenantId).toBe(tenantId);
    expect(gatewayClaims.principal.authBindingId).toBe(issuedApiKey.authBindingId);

    const absentExternalIdentityResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/identity/external/resolve', {
          body: {
            authenticationNamespaceId: 'unknown.absent.better-auth.v1',
            authenticationRef: `lean-core-absent-${randomUUID()}`,
            providerSubjectId: `absent-provider-subject-${randomUUID()}`,
            subjectType: 'user',
          },
          headers: { 'x-api-key': issuedApiKey.secret },
          method: 'POST',
        }),
      ),
    );
    expect(absentExternalIdentityResponse.status).toBe(403);
    expect(
      Schema.decodeUnknownSync(externalIdentityForbiddenProblemSchema)(
        yield* Effect.tryPromise(() => absentExternalIdentityResponse.json()),
      ).status,
    ).toBe(403);

    const sessionAfterAbsentCapability = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/session', {
          headers: { cookie: cookies },
          method: 'GET',
        }),
      ),
    );
    expect(sessionAfterAbsentCapability.status).toBe(200);
    return yield* Effect.void;
  }),
);
