/**
 * Connector side of MCP connection grants (lane mcp-connection-grants): the MCP server exchanges a user access token
 * (plus the shared connector key) for a live connection description and for a gateway assertion. Every call checks
 * the grant against OntOS through `loadLiveConnection`; the throttled `authn.connector_exchange` audit row is written
 * at most once a minute per grant (`touchGrantLastUsed`).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { agentApprovalModuleByAppId } from '@app/shared-contracts/agent-proposals';
import {
  type ConnectorGatewayContextRequest,
  type ConnectorGatewayContextResponse,
  OAUTH_GRANT_CLAIM,
  OAUTH_GRANT_CONTEXT_PREFIX,
  OAUTH_MCP_SCOPE,
} from '@app/shared-contracts/oauth-connections';
import { Effect } from 'effect';
import { type JWTVerifyGetKey, createLocalJWKSet, jwtVerify } from 'jose';

import { issueGatewayContextAssertion } from '../auth/gateway-issuer.ts';
import { AuthenticationService } from '../auth/service.ts';
import type { OAuthServerEndpoint } from '../auth/oauth-server/policy.ts';
import type { AgentPlatformCaller } from '../agent-platform/caller.ts';
import { ConnectionForbidden, ConnectionUnauthorized, ConnectionUnavailable } from './errors.ts';
import { type LiveConnection, loadLiveConnection } from './connection-service.ts';
import { loadOAuthServerConfig, type OAuthServerConfig } from './server-config.ts';
import { recordConnectionAudit, touchGrantLastUsed } from './grant-store.ts';
import type { GrantRow } from './types.ts';

/** Headers the connector sends: the shared connector key and the user access token. */
export interface ConnectorHeaders {
  readonly authorization?: string | undefined;
  readonly 'x-ontos-connector-key'?: string | undefined;
}

export interface VerifiedAccessToken {
  readonly grantId: string;
  readonly sub: string;
}

export interface ConnectorDeps<R> {
  readonly config: OAuthServerConfig;
  readonly loadLive: (
    grantId: string,
  ) => Effect.Effect<LiveConnection, ConnectionUnauthorized | ConnectionUnavailable, R>;
  readonly verifyAccessToken: (token: string) => Effect.Effect<VerifiedAccessToken, ConnectionUnauthorized>;
}

export const bearerOf = (authorization: string | undefined): string | undefined =>
  authorization?.match(/^Bearer\s+(\S+)$/iu)?.[1];

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time comparison of the shared connector key; an unset or short secret never matches. */
export const connectorKeyMatches = (secret: string, presented: string | undefined): boolean => {
  if (secret.length < 16 || presented === undefined) {
    return false;
  }
  return timingSafeEqual(digest(secret), digest(presented));
};

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

/** Resolve the local AS keys in-process: Workers must never fetch their own public hostname. */
export const makeOAuthJwksResolver =
  (endpoint: OAuthServerEndpoint): JWTVerifyGetKey =>
  async (header, token) => {
    const response = await endpoint.handler(new Request(`${endpoint.issuer}/jwks`));
    if (!response.ok) {
      throw new Error('OAuth signing keys unavailable');
    }
    return createLocalJWKSet(await response.json())(header, token);
  };

/** Checks the connector key and the user token, then the live grant; the token's subject must be the grant's user. */
export const authenticateConnector = <R>(
  headers: ConnectorHeaders,
  deps: ConnectorDeps<R>,
): Effect.Effect<LiveConnection, ConnectionUnauthorized | ConnectionUnavailable, R> =>
  Effect.gen(function* authenticateConnectorEffect() {
    if (deps.config.connectorSecret === '') {
      return yield* new ConnectionUnavailable({ cause: 'ONTOS_MCP_CONNECTOR_SECRET is not set' });
    }
    if (!connectorKeyMatches(deps.config.connectorSecret, headers['x-ontos-connector-key'])) {
      return yield* new ConnectionUnauthorized({ code: 'connector_key_invalid' });
    }
    const token = bearerOf(headers.authorization);
    if (token === undefined) {
      return yield* new ConnectionUnauthorized({ code: 'token_missing' });
    }
    const claims = yield* deps.verifyAccessToken(token);
    const live = yield* deps.loadLive(claims.grantId);
    if (live.grant.userId !== claims.sub) {
      return yield* new ConnectionUnauthorized({ code: 'token_invalid' });
    }
    return live;
  });

/** Trusted principal context of a connection (`oauth_connection`, delegated when an agent acts). */
export const connectorPrincipalContext = (live: LiveConnection) => {
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

const liveDeps = Effect.gen(function* liveDepsEffect() {
  const config = yield* loadOAuthServerConfig;
  const authentication = yield* AuthenticationService;
  if (authentication.oauth === undefined || authentication.oauth.issuer !== config.issuer) {
    return yield* new ConnectionUnavailable({ cause: 'OAuth issuer unavailable or mismatched' });
  }
  return {
    config,
    loadLive: loadLiveConnection,
    verifyAccessToken: makeAccessTokenVerifier(config, makeOAuthJwksResolver(authentication.oauth)),
  };
});

/** Writes the throttled exchange audit row (at most once a minute per grant). */
const auditExchange = (grant: GrantRow, operation: string) =>
  Effect.gen(function* auditExchangeEffect() {
    if (yield* touchGrantLastUsed(grant.grantId)) {
      yield* recordConnectionAudit({
        authBindingId: grant.authBindingId,
        authMethod: 'oauth_connection',
        eventType: 'authn.connector_exchange',
        evidence: { operation },
        grant,
        outcome: 'succeeded',
        outcomeCode: 'connector_exchange',
        principalId: grant.actingPrincipalId,
      });
    }
  });

/** `POST /auth/connector/describe`: the live description of the connection. */
export const describeConnection = (headers: ConnectorHeaders) =>
  Effect.gen(function* describeConnectionEffect() {
    const live = yield* authenticateConnector(headers, yield* liveDeps);
    yield* auditExchange(live.grant, 'describe');
    return live.description;
  });

/** `POST /auth/connector/gateway-context`: a gateway assertion for one module app of the connection. */
export const connectorGatewayContext = (headers: ConnectorHeaders, request: ConnectorGatewayContextRequest) =>
  Effect.gen(function* connectorGatewayContextEffect() {
    const live = yield* authenticateConnector(headers, yield* liveDeps);
    yield* auditExchange(live.grant, 'gateway-context');
    const response: ConnectorGatewayContextResponse = yield* issueGatewayContextAssertion({
      audience: request.audience,
      compositionRevision: request.compositionRevision,
      principal: connectorPrincipalContext(live),
    });
    return response;
  });

/** Caller of the agent platform proposal endpoints when the connector headers are used. */
export const authenticateConnectorProposalCaller = (
  headers: ConnectorHeaders,
  legalEntityId: string,
  appIds: readonly string[],
) =>
  Effect.gen(function* authenticateConnectorProposalCallerEffect() {
    const live = yield* authenticateConnector(headers, yield* liveDeps);
    const { description } = live;
    if (description.legalEntityId !== legalEntityId) {
      return yield* new ConnectionForbidden({ code: 'connection_scope', reason: 'Připojení patří k jiné firmě.' });
    }
    if (appIds.length > 0) {
      if (description.writePolicy === 'read_only') {
        return yield* new ConnectionForbidden({ code: 'connection_scope', reason: 'Připojení smí jen číst.' });
      }
      for (const appId of appIds) {
        const module = agentApprovalModuleByAppId(appId);
        const writable =
          module !== undefined &&
          description.modules.some((entry) => entry.moduleId === module.moduleKey && entry.write);
        if (!writable) {
          return yield* new ConnectionForbidden({
            code: 'connection_scope',
            reason: `Připojení nesmí navrhovat změny v modulu ${module?.label ?? appId}.`,
          });
        }
      }
    }
    const caller: AgentPlatformCaller = {
      legalName: description.legalName,
      principal: connectorPrincipalContext(live),
    };
    return caller;
  });
