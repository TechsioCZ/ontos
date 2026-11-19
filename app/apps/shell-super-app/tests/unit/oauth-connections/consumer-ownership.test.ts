// @rstest-environment node
import {
  ContextAccess,
  OAuthAuthenticationAudit,
  OAuthAuthenticationAuditUnavailable,
  OAuthConnectionCompanies,
} from '@app/core-runtime';
import {
  ConnectApproveRequestSchema,
  ConnectDenyRequestSchema,
  OAUTH_GRANT_CLAIM,
} from '@app/shared-contracts/oauth-connections';
import { getTableColumns } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { scriptedPgClientLayer } from '../../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { authRelations } from '../../../api/auth/db/schema.ts';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { NodeCrypto } from '@effect/platform-node';

import { CoreDatabase } from '../../../../../packages/core-runtime/src/db/client.ts';
import {
  coreRelations,
  oauthConnectionGrants,
  principals,
} from '../../../../../packages/core-runtime/src/db/schema.ts';
import { OAuthGrantRegistryLive } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-live.ts';
import { AuthDatabase } from '../../../api/auth/db/client.ts';
import { OAuthCredentialsLive } from '../../../api/auth/db/oauth-credentials-live.ts';
import { AuthenticationService } from '../../../api/auth/service.ts';
import { makeInstalledModuleCatalogLayer } from '../../../api/modules/installed-module-catalog.ts';
import { authenticateMcpRequest, OAuthAccessTokensLive } from '../../../api/mcp/connection.ts';
import { approve, deny, draftSummary } from '../../../api/oauth-connections/connect-service.ts';
import type { ConnectSession } from '../../../api/oauth-connections/connect-service.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import { ConnectionUnauthorized, ConnectionUnavailable } from '../../../api/oauth-connections/errors.ts';
import type { GrantRow } from '../../../api/oauth-connections/types.ts';
import { pageCarrierCatalog, subjectInspectionFixture } from '../oauth-connections-admin/subject-inspection.fixture.ts';
import { agentConnectionStoreDouble, unusedPeopleCommandsLayer } from '../../support/agent-connection-store-double.ts';

type OAuthAuthenticationObservation = Parameters<(typeof OAuthAuthenticationAudit)['Service']['record']>[0];
const unexpectedAuthentication = () => Effect.die('MCP must not authenticate through a browser session');

const principalId = '20000000-0000-4000-8000-000000000001';
const session: ConnectSession = {
  activeLegalEntityId: '30000000-0000-4000-8000-000000000001',
  authBindingId: '40000000-0000-4000-8000-000000000001',
  companies: [],
  displayName: 'Connector user',
  principalId,
  scope: {
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:connector-session',
    authMethod: 'session',
    correlationId: 'consumer-ownership',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
    principalId,
    tenantId: '10000000-0000-4000-8000-000000000001',
  },
  sessionId: 'connector-session',
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: 'connector-user',
};

interface ConsumerControls {
  active?: GrantRow;
  denied?: GrantRow;
  grant?: GrantRow;
  touchCalls: string[];
  touchUpdates: boolean[];
}
const controls: ConsumerControls = { touchCalls: [], touchUpdates: [] };

// The native registry executes its real SQL and decodes retained facts through Drizzle. Only the driver answers
// are scripted, including whether the conditional last-used update returned a row.
const grantRows = (row: GrantRow | undefined) => {
  if (row === undefined) {
    return [];
  }
  const retained = new Map(Object.entries({ ...row, modulesJson: row.modules }));
  return [
    Object.fromEntries(
      Object.entries(getTableColumns(oauthConnectionGrants)).map(([key]) => {
        const value = retained.get(key);
        return [key, Schema.is(Schema.Date)(value) ? value.toISOString() : value];
      }),
    ),
  ];
};
const scriptedDatabase = scriptedPgClientLayer(
  Effect.succeed(
    testSqlConnection((sql, params) =>
      Effect.suspend((): ReturnType<Parameters<typeof testSqlConnection>[0]> => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
          return Effect.succeed([]);
        }
        if (sql.includes('"oauth_connection_grants"')) {
          if (sql.startsWith('select')) {
            return Effect.succeed(grantRows(controls.grant));
          }
          if (sql.startsWith('update')) {
            if (sql.includes('"last_used_at" = now()')) {
              controls.touchCalls.push(Schema.decodeUnknownSync(Schema.String)(params[0]));
              return Effect.succeed(grantRows((controls.touchUpdates.shift() ?? true) ? controls.grant : undefined));
            }
            if (params.includes('superseded')) {
              return Effect.succeed([]);
            }
            return Effect.succeed(grantRows(params.includes('active') ? controls.active : controls.denied));
          }
        }
        if (sql.startsWith('select') && sql.includes('"principals"')) {
          // The approval locks whole principal rows; live checks select only these four fields.
          if (sql.includes('for share')) {
            const principal = new Map(
              Object.entries({
                displayName: session.displayName,
                kind: 'human',
                principalId,
                status: 'active',
                tenantId: session.tenantId,
              }),
            );
            return Effect.succeed([
              Object.fromEntries(Object.keys(getTableColumns(principals)).map((key) => [key, principal.get(key)])),
            ]);
          }
          return Effect.succeed([{ displayName: session.displayName, kind: 'human', principalId, status: 'active' }]);
        }
        if (sql.includes('"principal_auth_bindings"')) {
          return Effect.succeed(sql.startsWith('select') ? [{ status: 'active' }] : []);
        }
        if (sql.startsWith('select') && sql.includes('"user"')) {
          return Effect.succeed([{ banned: false, emailVerified: true, name: session.displayName }]);
        }
        return Effect.die(`Unexpected OAuth consumer SQL: ${sql}`);
      }),
    ),
  ),
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
const collaborators = Layer.mergeAll(
  agentConnectionStoreDouble().layer,
  unusedPeopleCommandsLayer,
  Layer.unwrap(
    pageCarrierCatalog(['work.tasks']).pipe(
      Effect.map(({ snapshot }) =>
        Layer.merge(
          subjectInspectionFixture({
            capabilities: [{ key: 'work.tasks.page.open', modes: ['run'] }],
            snapshot,
            subjects: [{ legalEntityId: session.activeLegalEntityId ?? '', principalId, tenantId: session.tenantId }],
          }).layer,
          makeInstalledModuleCatalogLayer(Effect.succeed(snapshot)),
        ),
      ),
    ),
  ),
  Layer.mock(ActionAuthority, {}),
  authDatabase,
  OAuthCredentialsLive.pipe(Layer.provide(authDatabase)),
  OAuthGrantRegistryLive.pipe(Layer.provide(coreDatabase)),
  Layer.mock(ContextAccess, {}),
  Layer.mock(OAuthConnectionCompanies, {}),
  Layer.mock(OAuthFlow, {}),
).pipe(Layer.provide(NodeCrypto.layer));

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
  }).pipe(Effect.provideService(OAuthFlow, flow), Effect.provide(collaborators)),
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
    Effect.provide(collaborators),
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
  }).pipe(Effect.provideService(OAuthFlow, flow), Effect.provide(collaborators)),
);

it.effect('rejects a foreign retained draft before reading its company label or projecting requester authority', () =>
  Effect.gen(function* foreignRetainedDraft() {
    controls.grant = { ...grant(), tenantId: '10000000-0000-4000-8000-000000000099' };
    const failure = yield* draftSummary(session, { oauthQuery: 'signed-query' }).pipe(
      Effect.provideService(OAuthConnectionCompanies, {
        names: () => Effect.die('A foreign retained draft must not read a company label'),
      }),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ConnectionUnavailable);
    expect(failure).toMatchObject({ cause: 'Retained connection scope differs from original requester' });
  }).pipe(Effect.provideService(OAuthFlow, flow), Effect.provide(collaborators)),
);

it.effect('audits MCP use only when last-used is updated and preserves observer failures', () =>
  Effect.gen(function* throttledMcpObservation() {
    const active = { ...grant(), authBindingId: session.authBindingId ?? null, status: 'active' as const };
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
    controls.grant = active;
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
  }).pipe(Effect.scoped, Effect.provide(collaborators)),
);
