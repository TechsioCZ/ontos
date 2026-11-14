/**
 * Better Auth side of the connect flow (port OAuthFlow of lane mcp-connection-grants): verifies the signed OAuth query
 * Better Auth appended to /cs/pripojit, reads stored client metadata, and deletes a grant's tokens and consent.
 */
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { eq } from 'drizzle-orm';
import { Effect, Layer, Option } from 'effect';

import { ConnectionInvalid, ConnectionUnavailable } from '../../oauth-connections/errors.ts';
import { OAuthFlow } from '../../oauth-connections/oauth-flow.ts';
import type { OAuthClientInfo, VerifiedOAuthQuery } from '../../oauth-connections/oauth-flow.ts';
import { AuthConfig } from '../config.ts';
import { AuthDatabase } from './client.ts';
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from './schema.ts';

/** Fields of an already signature-checked query; undefined when client_id or redirect_uri is missing. */
export const parseVerifiedOAuthQuery = (oauthQuery: string): VerifiedOAuthQuery | undefined => {
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  if (clientId === null || clientId === '' || redirectUri === null || redirectUri === '') {
    return undefined;
  }
  return {
    agent: params.get('agent'),
    clientId,
    company: params.get('company'),
    redirectUri,
    resource: params.get('resource'),
    scope: params.get('scope') ?? '',
    state: params.get('state'),
  };
};

const unavailable = (cause: unknown) => new ConnectionUnavailable({ cause });

export const OAuthFlowLive = Layer.effect(
  OAuthFlow,
  Effect.gen(function* makeOAuthFlow() {
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    return {
      deleteGrantTokens: (grantId: string) =>
        Effect.all(
          [
            database.executor.delete(oauthAccessToken).where(eq(oauthAccessToken.referenceId, grantId)),
            database.executor.delete(oauthRefreshToken).where(eq(oauthRefreshToken.referenceId, grantId)),
            database.executor.delete(oauthConsent).where(eq(oauthConsent.referenceId, grantId)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.mapError(unavailable), Effect.asVoid),
      findClient: (clientId: string) =>
        database.executor
          .select({ clientId: oauthClient.clientId, icon: oauthClient.icon, name: oauthClient.name })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, clientId))
          .limit(1)
          .pipe(
            Effect.mapError(unavailable),
            Effect.map(([row]): Option.Option<OAuthClientInfo> =>
              row === undefined
                ? Option.none()
                : Option.some({ clientId: row.clientId, logoUri: row.icon, name: row.name ?? row.clientId }),
            ),
          ),
      verifyQuery: (oauthQuery: string) =>
        Effect.tryPromise({
          catch: unavailable,
          try: verifyOAuthQueryParams.bind(undefined, oauthQuery, configuration.secret),
        }).pipe(
          Effect.timeout('5 seconds'),
          Effect.catchTag('TimeoutError', (cause) => Effect.fail(unavailable(cause))),
          Effect.flatMap((valid) => {
            const parsed = valid ? parseVerifiedOAuthQuery(oauthQuery) : undefined;
            return parsed === undefined
              ? Effect.fail(new ConnectionInvalid({ code: 'oauth_query_invalid' }))
              : Effect.succeed(parsed);
          }),
        ),
    };
  }),
);
