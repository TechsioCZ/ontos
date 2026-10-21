/**
 * HTTP group of the MCP connector (`oauthConnector`, shared/oauth-connector-api.ts). Authenticates with the connector
 * key and the user Bearer token (service in connector-service.ts) and maps errors to Problem Details: Unauthorized 401
 * (with `WWW-Authenticate: Bearer error="invalid_token"`), Forbidden 403, revision change 409, Unavailable 503.
 * Every response is `no-store`.
 */
import { HttpApiBuilder, HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Match } from 'effect';

import { ShellAuthenticationApi } from '../../shared/api.ts';
import type { ConnectorProblem } from '../../shared/oauth-connector-api.ts';
import type { GatewayIssuerError } from '../auth/gateway-issuer.ts';
import { ConnectionForbidden, ConnectionInvalid, ConnectionUnauthorized, ConnectionUnavailable } from './errors.ts';
import { type ConnectorHeaders, connectorGatewayContext, describeConnection } from './connector-service.ts';

export type ConnectorError =
  | ConnectionForbidden
  | ConnectionInvalid
  | ConnectionUnauthorized
  | ConnectionUnavailable
  | GatewayIssuerError;

/** HTTP status of a connector failure: 401 re-authenticate, 403 tool error, 409 re-describe, 503 retryable. */
export const connectorProblemStatus = (error: ConnectorError): 401 | 403 | 409 | 503 =>
  Match.value(error).pipe(
    Match.tag('ConnectionUnauthorized', () => 401 as const),
    Match.tag('ConnectionInvalid', () => 401 as const),
    Match.tag('ConnectionForbidden', () => 403 as const),
    Match.tag('ConnectionUnavailable', () => 503 as const),
    Match.tag('GatewayIssuerError', (issuerError) =>
      issuerError.code === 'gateway_revision_unsupported'
        ? (409 as const)
        : issuerError.code === 'gateway_audience_invalid'
          ? (403 as const)
          : (503 as const),
    ),
    Match.exhaustive,
  );

const unavailableProblem = (cause: ConnectionUnavailable | GatewayIssuerError) =>
  Effect.logError('MCP connector unavailable', cause).pipe(
    Effect.as<ConnectorProblem>({
      _tag: 'ConnectorUnavailableProblem',
      detail: 'Připojení je dočasně nedostupné. Zkuste to prosím znovu.',
      retryable: true,
      status: 503,
      title: 'Connector unavailable',
      type: 'https://ontos.dev/problems/connector-unavailable',
    }),
  );

const toProblem = (error: ConnectorError): Effect.Effect<ConnectorProblem> =>
  Match.value(error).pipe(
    Match.tag('ConnectionUnauthorized', (unauthorized) =>
      Effect.succeed<ConnectorProblem>({
        _tag: 'ConnectorUnauthorizedProblem',
        code: unauthorized.code,
        detail: 'Připojení vyžaduje nové přihlášení.',
        status: 401,
        title: 'Connector unauthorized',
        type: 'https://ontos.dev/problems/connector-unauthorized',
      }),
    ),
    Match.tag('ConnectionInvalid', (invalid) =>
      Effect.succeed<ConnectorProblem>({
        _tag: 'ConnectorUnauthorizedProblem',
        code: invalid.code,
        detail: 'Připojení vyžaduje nové přihlášení.',
        status: 401,
        title: 'Connector unauthorized',
        type: 'https://ontos.dev/problems/connector-unauthorized',
      }),
    ),
    Match.tag('ConnectionForbidden', (forbidden) =>
      Effect.succeed<ConnectorProblem>({
        _tag: 'ConnectorForbiddenProblem',
        code: forbidden.code,
        detail: forbidden.reason,
        status: 403,
        title: 'Connector forbidden',
        type: 'https://ontos.dev/problems/connector-forbidden',
      }),
    ),
    Match.tag('GatewayIssuerError', (issuerError) => {
      const status = connectorProblemStatus(issuerError);
      if (status === 409) {
        return Effect.succeed<ConnectorProblem>({
          _tag: 'ConnectorReloadRequiredProblem',
          code: issuerError.code,
          detail: 'Složení aplikace se změnilo. Připojení znovu načtěte a zkuste to znovu.',
          status: 409,
          title: 'Connector reload required',
          type: 'https://ontos.dev/problems/connector-reload-required',
        });
      }
      if (status === 403) {
        return Effect.succeed<ConnectorProblem>({
          _tag: 'ConnectorForbiddenProblem',
          code: issuerError.code,
          detail: 'Připojení nemá přístup k této aplikaci.',
          status: 403,
          title: 'Connector forbidden',
          type: 'https://ontos.dev/problems/connector-forbidden',
        });
      }
      return unavailableProblem(issuerError);
    }),
    Match.tag('ConnectionUnavailable', (unavailable) => unavailableProblem(unavailable)),
    Match.exhaustive,
  );

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', 'no-store')),
);

const challengeUnauthorized = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    response.status === 401
      ? HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer error="invalid_token"')
      : response,
  ),
);

const run = <Value, Requirements>(effect: Effect.Effect<Value, ConnectorError, Requirements>) =>
  Effect.gen(function* runConnector() {
    yield* noStore;
    yield* challengeUnauthorized;
    return yield* effect;
  }).pipe(Effect.catch((error: ConnectorError) => Effect.flatMap(toProblem(error), Effect.fail)));

export const oauthConnectorGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'oauthConnector', (handlers) =>
  handlers
    .handle('connectorDescribe', ({ headers }) => run(describeConnection(headers as ConnectorHeaders)))
    .handle('connectorGatewayContext', ({ headers, payload }) =>
      run(connectorGatewayContext(headers as ConnectorHeaders, payload)),
    ),
);
