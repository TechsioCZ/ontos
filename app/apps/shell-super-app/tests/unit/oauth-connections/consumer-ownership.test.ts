// @rstest-environment node
import {
  ContextAccess,
  OAuthAuthenticationAudit,
  OAuthAuthenticationAuditUnavailable,
  OAuthConnectionCompanies,
} from '@app/core-runtime';
import {
  ConnectionDescriptionSchema,
  ConnectApproveRequestSchema,
  ConnectDenyRequestSchema,
  OAUTH_GRANT_CLAIM,
} from '@app/shared-contracts/oauth-connections';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { scriptedPgClientLayer } from '../../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { authRelations } from '../../../api/auth/db/schema.ts';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { NodeCrypto } from '@effect/platform-node';

import { CoreDatabase } from '../../../../../packages/core-runtime/src/db/client.ts';
import { coreRelations } from '../../../../../packages/core-runtime/src/db/schema.ts';
import { OAuthGrantRegistryLive } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-live.ts';
import { AuthDatabase } from '../../../api/auth/db/client.ts';
import { OAuthCredentialsLive } from '../../../api/auth/db/oauth-credentials-live.ts';
import { AuthenticationService } from '../../../api/auth/service.ts';
import { ShellInstalledModuleCatalog } from '../../../api/modules/installed-module-catalog.ts';
import { authenticateMcpRequest, OAuthAccessTokensLive } from '../../../api/mcp/connection.ts';
import type { LiveConnection } from '../../../api/oauth-connections/connection-service.ts';
import { approve, deny, draftSummary } from '../../../api/oauth-connections/connect-service.ts';
import type { ConnectSession } from '../../../api/oauth-connections/connect-service.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import { ConnectionUnauthorized, ConnectionUnavailable } from '../../../api/oauth-connections/errors.ts';
import type { GrantRow } from '../../../api/oauth-connections/types.ts';

type OAuthAuthenticationObservation = Parameters<(typeof OAuthAuthenticationAudit)['Service']['record']>[0];
const unexpectedAuthentication = () => Effect.die('MCP must not authenticate through a browser session');

interface ConsumerControls {
  active?: GrantRow;
  denied?: GrantRow;
  grant?: GrantRow;
  live?: LiveConnection;
  touchCalls: string[];
  touchUpdates: boolean[];
}
const controls = rs.hoisted(() => {
  const state: ConsumerControls = { touchCalls: [], touchUpdates: [] };
  return state;
});
rs.mock('../../../api/oauth-connections/grant-store.ts', () => ({
  approveDraftGrant: () =>
    Effect.succeed(controls.active === undefined ? undefined : { active: controls.active, superseded: [] }),
  findGrant: () => Effect.succeed(controls.grant),
  findSessionGrant: () => Effect.succeed(controls.grant),
  setGrantStatus: () => Effect.succeed(controls.denied),
  touchGrantLastUsed: (grantId: string) =>
    Effect.sync(() => {
      controls.touchCalls.push(grantId);
      return controls.touchUpdates.shift() ?? true;
    }),
}));
rs.mock('../../../api/oauth-connections/connection-service.ts', () => ({
  loadActingAuthority: () =>
    Effect.succeed({
      labelOf: (moduleId: string | null | undefined) => moduleId ?? '',
      live: { read: new Set<string>(), write: new Set<string>() },
      offered: [],
      policyCap: 'direct',
    }),
  loadLiveConnection: () =>
    controls.live === undefined ? Effect.die('Live connection is not configured') : Effect.succeed(controls.live),
}));
const scriptedDatabase = scriptedPgClientLayer(
  Effect.succeed(testSqlConnection(() => Effect.die('OAuth consumer tests must not execute SQL'))),
).pipe(Layer.provide(Reactivity.layer));
const authDatabase = Layer.effect(
  AuthDatabase,
  makeWithDefaults({ relations: authRelations }).pipe(
    Effect.map((executor) => ({
      adapter: () => {
        throw new Error('OAuth consumer tests must not open Better Auth');
      },
      executor,
    })),
  ),
).pipe(Layer.provide(scriptedDatabase));
const coreDatabase = Layer.effect(
  CoreDatabase,
  makeWithDefaults({ relations: coreRelations }).pipe(Effect.map((executor) => ({ executor }))),
).pipe(Layer.provide(scriptedDatabase));
const unusedCollaborators = Layer.mergeAll(
  Layer.mock(ActionAuthority, {}),
  authDatabase,
  OAuthCredentialsLive.pipe(Layer.provide(authDatabase)),
  OAuthGrantRegistryLive.pipe(Layer.provide(coreDatabase)),
  Layer.mock(ContextAccess, {}),
  Layer.mock(OAuthConnectionCompanies, {}),
  Layer.mock(OAuthFlow, {}),
  Layer.mock(ShellInstalledModuleCatalog, {}),
).pipe(Layer.provide(NodeCrypto.layer));
rs.mock('../../../api/oauth-connections/server-config.ts', () => ({
  get loadOAuthServerConfig() {
    return Effect.succeed({
      issuer: 'http://localhost:3020/shell-super-app-api/oauth',
      resource: 'http://localhost:3020/mcp',
    });
  },
}));

const principalId = '20000000-0000-4000-8000-000000000001';
const session: ConnectSession = {
  activeLegalEntityId: null,
  authBindingId: '40000000-0000-4000-8000-000000000001',
  companies: [],
  displayName: 'Connector user',
  principalId,
  sessionId: 'connector-session',
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: 'connector-user',
};
const grant = (): GrantRow => ({
  actingKind: 'human',
  actingPrincipalId: principalId,
  authBindingId: null,
  clientHost: 'localhost',
  clientId: 'https://example.test/client.json',
  clientKind: 'loopback',
  clientLogoUri: null,
  clientName: 'Connector client',
  consentedAt: null,
  consentId: null,
  createdAt: new Date(0),
  grantId: '50000000-0000-4000-8000-000000000001',
  lastUsedAt: null,
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  modules: 'all',
  profileId: '60000000-0000-4000-8000-000000000001',
  revokedAt: null,
  revokedByPrincipalId: null,
  revokeReason: null,
  sessionId: session.sessionId,
  status: 'draft',
  tenantId: session.tenantId,
  userId: session.userId,
  userPrincipalId: principalId,
  writePolicy: 'read_only',
});
const flow = {
  deleteGrantTokens: () => Effect.void,
  findClient: () =>
    Effect.succeed(Option.some({ clientId: grant().clientId, logoUri: null, name: 'Connector client' })),
  verifyQuery: () =>
    Effect.succeed({
      agent: null,
      clientId: grant().clientId,
      company: null,
      redirectUri: 'http://localhost:5555/callback',
      resource: 'http://localhost:3020/mcp',
      scope: 'ontos',
      state: 'original-state',
    }),
};
const unavailable = new OAuthAuthenticationAuditUnavailable({
  cause: new Error('Observer persistence failed'),
  reason: 'OAuth observation unavailable',
});

it.effect('records fixed creation and denial observations through the Core observer', () =>
  Effect.gen(function* connectionObservations() {
    const draft = { ...grant(), createdAt: yield* DateTime.nowAsDate };
    const active = { ...draft, authBindingId: session.authBindingId ?? null, status: 'active' as const };
    controls.grant = draft;
    controls.active = active;
    controls.denied = { ...draft, status: 'denied' };
    const observations: OAuthAuthenticationObservation[] = [];
    const audit = {
      record: (observation: OAuthAuthenticationObservation) =>
        Effect.sync(() => {
          observations.push(observation);
        }),
    };
    const approved = yield* approve(
      session,
      yield* Schema.decodeEffect(ConnectApproveRequestSchema)({ grantId: draft.grantId, oauthQuery: 'signed-query' }),
    ).pipe(Effect.provideService(OAuthAuthenticationAudit, audit));
    expect(approved.status).toBe('active');
    const denied = yield* deny(
      session,
      yield* Schema.decodeEffect(ConnectDenyRequestSchema)({ grantId: draft.grantId, oauthQuery: 'signed-query' }),
    ).pipe(Effect.provideService(OAuthAuthenticationAudit, audit));
    expect(denied.redirectTo).toContain('state=original-state');
    expect(observations).toEqual([
      {
        authBindingId: session.authBindingId,
        authMethod: 'session',
        eventType: 'oauth.connection.created',
        evidence: {
          actingPrincipalId: principalId,
          clientKind: draft.clientKind,
          delegatedByPrincipalId: null,
          legalEntityId: draft.legalEntityId,
          modules: '"all"',
          writePolicy: draft.writePolicy,
        },
        grant: active,
        outcome: 'succeeded',
        outcomeCode: 'connection_created',
        principalId,
      },
      {
        authBindingId: session.authBindingId,
        authMethod: 'session',
        eventType: 'oauth.connection.denied',
        evidence: { actingPrincipalId: principalId, clientKind: draft.clientKind },
        grant: { ...draft, status: 'denied' },
        outcome: 'denied',
        outcomeCode: 'access_denied',
        principalId,
      },
    ]);
  }).pipe(Effect.provideService(OAuthFlow, flow), Effect.provide(unusedCollaborators)),
);

it.effect('fails approval and denial with ConnectionUnavailable retaining the observer cause', () =>
  Effect.gen(function* unavailableConnectionObservations() {
    const draft = { ...grant(), createdAt: yield* DateTime.nowAsDate };
    controls.grant = draft;
    controls.active = { ...draft, status: 'active' };
    controls.denied = { ...draft, status: 'denied' };
    const request = { grantId: draft.grantId, oauthQuery: 'signed-query' };
    const results = yield* Effect.all([
      approve(session, yield* Schema.decodeEffect(ConnectApproveRequestSchema)(request)).pipe(
        Effect.asVoid,
        Effect.result,
      ),
      deny(session, yield* Schema.decodeEffect(ConnectDenyRequestSchema)(request)).pipe(Effect.asVoid, Effect.result),
    ]);
    for (const result of results) {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ConnectionUnavailable);
        expect(result.failure).toMatchObject({ cause: unavailable });
      }
    }
  }).pipe(
    Effect.provideService(OAuthFlow, flow),
    Effect.provideService(OAuthAuthenticationAudit, { record: () => Effect.fail(unavailable) }),
    Effect.provide(unusedCollaborators),
  ),
);

it.effect('loads draft company names from Core and preserves company lookup failures', () =>
  Effect.gen(function* draftCompanyOwnership() {
    const draft = { ...grant(), createdAt: yield* DateTime.nowAsDate };
    controls.grant = draft;
    const summary = yield* draftSummary(session, { oauthQuery: 'signed-query' }).pipe(
      Effect.provideService(OAuthConnectionCompanies, {
        names: (tenantId, ids) => {
          expect(tenantId).toBe(session.tenantId);
          expect(ids).toEqual([draft.legalEntityId]);
          return Effect.succeed(new Map([[draft.legalEntityId, 'Core company name']]));
        },
      }),
    );
    expect(summary.legalName).toBe('Core company name');
    const failed = yield* draftSummary(session, { oauthQuery: 'signed-query' }).pipe(
      Effect.provideService(OAuthConnectionCompanies, { names: () => Effect.fail(unavailable) }),
      Effect.result,
    );
    expect(Result.isFailure(failed)).toBe(true);
    if (Result.isFailure(failed)) {
      expect(failed.failure).toBeInstanceOf(ConnectionUnavailable);
      expect(failed.failure).toMatchObject({ cause: unavailable });
    }
  }).pipe(Effect.provideService(OAuthFlow, flow), Effect.provide(unusedCollaborators)),
);

it.effect('audits MCP use only when last-used is updated and preserves observer failures', () =>
  Effect.gen(function* throttledMcpObservation() {
    const active = { ...grant(), authBindingId: session.authBindingId ?? null, status: 'active' as const };
    const live: LiveConnection = {
      description: yield* Schema.decodeEffect(ConnectionDescriptionSchema)({
        acting: { displayName: session.displayName, kind: 'human', principalId },
        client: {
          clientId: active.clientId,
          host: active.clientHost,
          kind: active.clientKind,
          logoUri: null,
          name: active.clientName,
        },
        compositionRevision: 'test',
        delegatedBy: null,
        grantId: active.grantId,
        legalEntityId: active.legalEntityId,
        legalName: 'Core company name',
        modules: [],
        profileId: active.profileId,
        status: 'active',
        tenantId: active.tenantId,
        writePolicy: 'read_only',
      }),
      grant: active,
    };
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('EdDSA'));
    const key = yield* Effect.promise(() => exportJWK(publicKey));
    const issuer = 'http://localhost:3020/shell-super-app-api/oauth';
    const token = yield* Effect.promise(() =>
      new SignJWT({ [OAUTH_GRANT_CLAIM]: active.grantId, scope: 'ontos' })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuer(issuer)
        .setAudience('http://localhost:3020/mcp')
        .setSubject(session.userId)
        .setExpirationTime('5m')
        .sign(privateKey),
    );
    controls.live = live;
    controls.touchCalls = [];
    controls.touchUpdates = [false, true];
    const observations: OAuthAuthenticationObservation[] = [];
    let signingKeyLoads = 0;
    let signingKeys = [key];
    const tokenContext = yield* Layer.build(
      OAuthAccessTokensLive.pipe(
        Layer.provideMerge(
          Layer.succeed(AuthenticationService, {
            availableTenants: unexpectedAuthentication,
            createFixtureUser: unexpectedAuthentication,
            currentSession: unexpectedAuthentication,
            oauth: {
              handler: () =>
                Effect.sync(() => {
                  signingKeyLoads += 1;
                  return Response.json({ keys: signingKeys });
                }),
              issuer,
            },
            resolveDocumentContext: unexpectedAuthentication,
            resolveShellContext: unexpectedAuthentication,
            resolveTenantContext: unexpectedAuthentication,
            signIn: unexpectedAuthentication,
            signOut: unexpectedAuthentication,
            switchLegalEntity: unexpectedAuthentication,
            switchTenant: unexpectedAuthentication,
            switchToTenantContext: unexpectedAuthentication,
          }),
        ),
      ),
    );
    expect(signingKeyLoads).toBe(0);
    const authenticate = authenticateMcpRequest(token).pipe(Effect.provide(tokenContext));
    const audit = {
      record: (observation: OAuthAuthenticationObservation) =>
        Effect.sync(() => {
          observations.push(observation);
        }),
    };
    yield* authenticate.pipe(Effect.provideService(OAuthAuthenticationAudit, audit));
    expect(observations).toHaveLength(0);
    yield* authenticate.pipe(Effect.provideService(OAuthAuthenticationAudit, audit));
    expect(observations).toEqual([
      {
        authBindingId: active.authBindingId,
        authMethod: 'oauth_connection',
        eventType: 'authn.connector_exchange',
        evidence: { operation: 'mcp' },
        grant: active,
        outcome: 'succeeded',
        outcomeCode: 'connector_exchange',
        principalId: active.actingPrincipalId,
      },
    ]);
    const failed = yield* authenticate.pipe(
      Effect.provideService(OAuthAuthenticationAudit, { record: () => Effect.fail(unavailable) }),
      Effect.result,
    );
    expect(Result.isFailure(failed)).toBe(true);
    if (Result.isFailure(failed)) {
      expect(failed.failure).toBeInstanceOf(ConnectionUnavailable);
      expect(failed.failure).toMatchObject({ cause: unavailable });
    }
    expect(controls.touchCalls).toEqual([active.grantId, active.grantId, active.grantId]);
    expect(signingKeyLoads).toBe(3);

    const malformedToken = yield* Effect.promise(() =>
      new SignJWT({ [OAUTH_GRANT_CLAIM]: 17, scope: 'ontos' })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuer(issuer)
        .setAudience('http://localhost:3020/mcp')
        .setSubject(session.userId)
        .setExpirationTime('5m')
        .sign(privateKey),
    );
    const malformed = yield* authenticateMcpRequest(malformedToken).pipe(
      Effect.provide(tokenContext),
      Effect.provideService(OAuthAuthenticationAudit, audit),
      Effect.result,
    );
    expect(Result.isFailure(malformed)).toBe(true);
    if (Result.isFailure(malformed)) {
      expect(malformed.failure).toBeInstanceOf(ConnectionUnauthorized);
      expect(malformed.failure.cause).toBeDefined();
    }

    // The same runtime must see removal immediately rather than verify against cached stale JWKS.
    signingKeys = [];
    const removedKey = yield* authenticate.pipe(Effect.provideService(OAuthAuthenticationAudit, audit), Effect.result);
    expect(Result.isFailure(removedKey)).toBe(true);
    if (Result.isFailure(removedKey)) {
      expect(removedKey.failure).toBeInstanceOf(ConnectionUnauthorized);
    }
    expect(controls.touchCalls).toEqual([active.grantId, active.grantId, active.grantId]);
    expect(signingKeyLoads).toBe(5);
  }).pipe(Effect.scoped, Effect.provide(unusedCollaborators)),
);
