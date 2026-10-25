/**
 * Authentication of one MCP request, in-process: the bearer JWT is verified against the Shell's own authorization
 * server (exact issuer, audience `<shell>/mcp`, `ontos` scope, grant claim), then the grant is re-checked live
 * (`loadLiveConnection`) so a revoked connection, a removed right or a narrowed grant applies to the very next
 * request. The resulting principal is the trusted `oauth_connection` context gateway assertions are issued for.
 */
import { OAuthAuthenticationAudit } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  OAUTH_GRANT_CLAIM,
  OAUTH_GRANT_CONTEXT_PREFIX,
  OAUTH_MCP_SCOPE,
} from '@app/shared-contracts/oauth-connections';
import { Context, Effect, Layer, Option, Schema, SynchronizedRef } from 'effect';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

import type { OAuthServerEndpoint } from '../auth/oauth-server/policy.ts';
import { AuthenticationService } from '../auth/service.ts';
import type { LiveConnection } from '../oauth-connections/connection-service.ts';
import { loadLiveConnection } from '../oauth-connections/connection-service.ts';
import { ConnectionUnauthorized, ConnectionUnavailable } from '../oauth-connections/errors.ts';
import { touchGrantLastUsed } from '../oauth-connections/grant-store.ts';
import { loadOAuthServerConfig } from '../oauth-connections/server-config.ts';

export interface VerifiedAccessToken {
  readonly grantId: string;
  readonly sub: string;
}

const AccessTokenClaims = Schema.Struct({
  [OAUTH_GRANT_CLAIM]: Schema.String,
  scope: Schema.optional(Schema.String),
  scp: Schema.optional(Schema.Array(Schema.String)),
  sub: Schema.String,
});
const SigningKeys = Schema.Struct({
  keys: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ kty: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)]),
  ),
});
const invalidToken = (cause: unknown): ConnectionUnauthorized => {
  const failure = { cause, code: 'token_invalid' as const };
  return new ConnectionUnauthorized(failure);
};

/** Local crypto still has a deadline; verification failures retain JOSE/Schema evidence. */
const verifyAccessToken = Effect.fn('Mcp.verifyAccessToken')(function* verifyAccessToken(
  token: string,
  issuer: string,
  audience: string,
  keys: JWTVerifyGetKey,
) {
  const { payload } = yield* Effect.tryPromise({
    catch: invalidToken,
    try: jwtVerify.bind(undefined, token, keys, {
      algorithms: ['EdDSA'],
      audience,
      clockTolerance: 60,
      issuer,
    }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.fail(new ConnectionUnavailable({ cause: 'Token verification timed out' })),
    }),
  );
  const claims = yield* Schema.decodeUnknownEffect(AccessTokenClaims)(payload).pipe(Effect.mapError(invalidToken));
  const scopes = claims.scope === undefined ? (claims.scp ?? []) : claims.scope.split(' ');
  if (!scopes.includes(OAUTH_MCP_SCOPE)) {
    return yield* invalidToken('Required MCP scope missing');
  }
  return { grantId: claims[OAUTH_GRANT_CLAIM], sub: claims.sub } satisfies VerifiedAccessToken;
});

/** Loads local AS keys in-process: Workers must never fetch their own public hostname. */
const readOAuthJwks = (endpoint: OAuthServerEndpoint): Effect.Effect<string, ConnectionUnavailable> =>
  endpoint.handler(new Request(`${endpoint.issuer}/jwks`)).pipe(
    Effect.mapError((cause) => new ConnectionUnavailable({ cause })),
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => new ConnectionUnavailable({ cause: `OAuth signing keys answered HTTP ${response.status}` }),
    ),
    Effect.flatMap((response) =>
      Effect.tryPromise({
        catch: (cause) => new ConnectionUnavailable({ cause }),
        try: response.text.bind(response),
      }),
    ),
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.fail(new ConnectionUnavailable({ cause: 'OAuth signing keys timed out' })),
    }),
  );

export class OAuthAccessTokens extends Context.Service<
  OAuthAccessTokens,
  {
    readonly verify: (
      token: string,
    ) => Effect.Effect<VerifiedAccessToken, ConnectionUnauthorized | ConnectionUnavailable, AuthenticationService>;
  }
>()('@app/shell-super-app/api/mcp/connection/OAuthAccessTokens') {}

interface ImportedSigningKeys {
  readonly keys: JWTVerifyGetKey;
  readonly serialized: string;
}

const importSigningKeys = Effect.fn('Mcp.importSigningKeys')(function* importSigningKeys(serialized: string) {
  const document = yield* Schema.decodeEffect(Schema.fromJsonString(SigningKeys))(serialized).pipe(
    Effect.mapError((cause) => new ConnectionUnavailable({ cause })),
  );
  return yield* Effect.try({
    catch: (cause) => new ConnectionUnavailable({ cause }),
    try: () => createLocalJWKSet({ keys: [...document.keys] }),
  });
});

/** Keep only imported public key material in the runtime, never another Worker's request-bound endpoint or sockets. */
export const OAuthAccessTokensLive = Layer.effect(
  OAuthAccessTokens,
  Effect.gen(function* oauthAccessTokens() {
    const config = yield* loadOAuthServerConfig;
    const imported = yield* SynchronizedRef.make(Option.none<ImportedSigningKeys>());
    const verify = Effect.fn('Mcp.verify')(function* verify(token: string) {
      const authentication = yield* AuthenticationService;
      if (authentication.oauth === undefined || authentication.oauth.issuer !== config.issuer) {
        return yield* new ConnectionUnavailable({ cause: 'OAuth issuer unavailable or mismatched' });
      }
      // Read live AS keys on this request's database, so removal/rotation never waits on a cache TTL.
      const serialized = yield* readOAuthJwks(authentication.oauth);
      const keys = yield* SynchronizedRef.modifyEffect(imported, (previous) => {
        if (Option.isSome(previous) && previous.value.serialized === serialized) {
          return Effect.succeed([previous.value.keys, previous] as const);
        }
        return importSigningKeys(serialized).pipe(
          Effect.map((resolver) => [resolver, Option.some({ keys: resolver, serialized })] as const),
        );
      });
      return yield* verifyAccessToken(token, config.issuer, config.resource, keys);
    });
    return { verify };
  }),
);

/** Trusted principal context of a connection (`oauth_connection`, delegated when an agent acts). */
export const connectionPrincipalContext = (live: LiveConnection) => {
  const { description, grant } = live;
  const agent = grant.actingKind === 'agent';
  const principal = {
    authBindingId: grant.authBindingId ?? '',
    authContextRef: `${OAUTH_GRANT_CONTEXT_PREFIX}${grant.grantId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'oauth_connection' as const,
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
  };
  return agent ? { ...principal, delegatedByPrincipalId: grant.userPrincipalId } : principal;
};
export type ConnectionPrincipal = ReturnType<typeof connectionPrincipalContext>;

/** The throttled `authn.connector_exchange` audit row (at most once a minute per grant). */
const auditUse = Effect.fn('Mcp.auditUse')(function* auditUse(live: LiveConnection) {
  if (yield* touchGrantLastUsed(live.grant.grantId)) {
    yield* (yield* OAuthAuthenticationAudit)
      .record({
        authBindingId: live.grant.authBindingId,
        authMethod: 'oauth_connection',
        eventType: 'authn.connector_exchange',
        evidence: { operation: 'mcp' },
        grant: live.grant,
        outcome: 'succeeded',
        outcomeCode: 'connector_exchange',
        principalId: live.grant.actingPrincipalId,
      })
      .pipe(Effect.mapError((cause) => new ConnectionUnavailable({ cause })));
  }
});

/** Bearer token -> live connection. Unauthorized means HTTP 401 with a challenge; Unavailable means 503. */
export const authenticateMcpRequest = Effect.fn('Mcp.authenticate')(function* authenticateMcpRequest(token: string) {
  const claims = yield* (yield* OAuthAccessTokens).verify(token);
  const live = yield* loadLiveConnection(claims.grantId);
  if (live.grant.userId !== claims.sub) {
    return yield* new ConnectionUnauthorized({ code: 'token_invalid' });
  }
  yield* auditUse(live);
  return live;
});
