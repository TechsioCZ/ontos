/**
 * Authentication of one MCP request, in-process: the bearer JWT is verified against the Shell's own authorization
 * server (exact issuer, audience `<shell>/mcp`, `ontos` scope, grant claim), then the grant is re-checked live
 * (`loadLiveConnection`) so a revoked connection, a removed right or a narrowed grant applies to the very next
 * request. The resulting principal is the trusted `oauth_connection` context gateway assertions are issued for.
 */
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  OAUTH_GRANT_CLAIM,
  OAUTH_GRANT_CONTEXT_PREFIX,
  OAUTH_MCP_SCOPE,
} from '@app/shared-contracts/oauth-connections';
import { Effect } from 'effect';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWTVerifyGetKey } from 'jose';

import type { OAuthServerEndpoint } from '../auth/oauth-server/policy.ts';
import { AuthenticationService } from '../auth/service.ts';
import { type LiveConnection, loadLiveConnection } from '../oauth-connections/connection-service.ts';
import { ConnectionUnauthorized, ConnectionUnavailable } from '../oauth-connections/errors.ts';
import { recordConnectionAudit, touchGrantLastUsed } from '../oauth-connections/grant-store.ts';
import { type OAuthServerConfig, loadOAuthServerConfig } from '../oauth-connections/server-config.ts';

export interface VerifiedAccessToken {
  readonly grantId: string;
  readonly sub: string;
}

/** Verifies the EdDSA user token: exact issuer, exact MCP audience, `ontos` scope and a grant claim. */
export const makeAccessTokenVerifier = (config: OAuthServerConfig, keys: JWTVerifyGetKey) => {
  const invalid = () => new ConnectionUnauthorized({ code: 'token_invalid' });
  return (token: string): Effect.Effect<VerifiedAccessToken, ConnectionUnauthorized> =>
    Effect.tryPromise({
      catch: invalid,
      try: () =>
        jwtVerify(token, keys, {
          algorithms: ['EdDSA'],
          audience: config.resource,
          clockTolerance: 60,
          issuer: config.issuer,
        }),
    }).pipe(
      Effect.flatMap(({ payload }) => {
        const grantId = payload[OAUTH_GRANT_CLAIM];
        const scopes: readonly unknown[] =
          typeof payload['scope'] === 'string'
            ? payload['scope'].split(' ')
            : Array.isArray(payload['scp'])
              ? payload['scp']
              : [];
        if (typeof payload.sub !== 'string' || typeof grantId !== 'string' || !scopes.includes(OAUTH_MCP_SCOPE)) {
          return Effect.fail(invalid());
        }
        return Effect.succeed({ grantId, sub: payload.sub });
      }),
    );
};

/** Loads the local AS keys in-process: Workers must never fetch their own public hostname. */
export const loadOAuthJwks = (endpoint: OAuthServerEndpoint): Effect.Effect<JWTVerifyGetKey, ConnectionUnavailable> =>
  Effect.tryPromise({
    catch: (cause) => new ConnectionUnavailable({ cause }),
    try: () => endpoint.handler(new Request(`${endpoint.issuer}/jwks`)),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => new ConnectionUnavailable({ cause: `OAuth signing keys answered HTTP ${response.status}` }),
    ),
    Effect.flatMap((response) =>
      Effect.tryPromise({
        catch: (cause) => new ConnectionUnavailable({ cause }),
        try: (): Promise<JSONWebKeySet> => response.json(),
      }),
    ),
    Effect.map((keys) => createLocalJWKSet(keys)),
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.fail(new ConnectionUnavailable({ cause: 'OAuth signing keys timed out' })),
    }),
  );

/** Trusted principal context of a connection (`oauth_connection`, delegated when an agent acts). */
export const connectionPrincipalContext = (live: LiveConnection) => {
  const { description, grant } = live;
  const agent = grant.actingKind === 'agent';
  return {
    authBindingId: grant.authBindingId ?? '',
    authContextRef: `${OAUTH_GRANT_CONTEXT_PREFIX}${grant.grantId}`,
    authMethod: 'oauth_connection' as const,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    connection: {
      clientId: grant.clientId,
      clientName: grant.clientName.slice(0, 200),
      grantId: grant.grantId,
      modules: description.modules.map((module) => ({
        access: module.write ? ('write' as const) : ('read' as const),
        moduleId: module.moduleId,
      })),
      writePolicy: description.writePolicy,
    },
    legalEntityId: grant.legalEntityId,
    principalId: grant.actingPrincipalId,
    tenantId: grant.tenantId,
    ...(agent ? { delegatedByPrincipalId: grant.userPrincipalId } : {}),
  };
};
export type ConnectionPrincipal = ReturnType<typeof connectionPrincipalContext>;

/** The throttled `authn.connector_exchange` audit row (at most once a minute per grant). */
const auditUse = (live: LiveConnection) =>
  Effect.gen(function* auditUseEffect() {
    if (yield* touchGrantLastUsed(live.grant.grantId)) {
      yield* recordConnectionAudit({
        authBindingId: live.grant.authBindingId,
        authMethod: 'oauth_connection',
        eventType: 'authn.connector_exchange',
        evidence: { operation: 'mcp' },
        grant: live.grant,
        outcome: 'succeeded',
        outcomeCode: 'connector_exchange',
        principalId: live.grant.actingPrincipalId,
      });
    }
  });

/** Bearer token -> live connection. Unauthorized means HTTP 401 with a challenge; Unavailable means 503. */
export const authenticateMcpRequest = Effect.fn('Mcp.authenticate')(function* authenticateMcpRequest(token: string) {
  const config = yield* loadOAuthServerConfig;
  const authentication = yield* AuthenticationService;
  if (authentication.oauth === undefined || authentication.oauth.issuer !== config.issuer) {
    return yield* new ConnectionUnavailable({ cause: 'OAuth issuer unavailable or mismatched' });
  }
  const claims = yield* makeAccessTokenVerifier(config, yield* loadOAuthJwks(authentication.oauth))(token);
  const live = yield* loadLiveConnection(claims.grantId);
  if (live.grant.userId !== claims.sub) {
    return yield* new ConnectionUnauthorized({ code: 'token_invalid' });
  }
  yield* auditUse(live);
  return live;
});
