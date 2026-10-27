import { Effect } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { AuthenticationService } from '../service.ts';
import { forwardOAuthRequest } from './forward.ts';
import { oauthNotFoundResponse } from './policy.ts';

/** Mounts {basePath}/oauth2/<allow-listed>, /jwks, /.well-known/* and /error (ONTOS-MCP-AUTH-DESIGN.md §2.2). */
export const OAuthServerTransportLive = HttpRouter.add('*', '/oauth/*', (request) =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap((webRequest) =>
      AuthenticationService.pipe(
        Effect.flatMap((service) =>
          service.oauth === undefined
            ? Effect.succeed(oauthNotFoundResponse())
            : forwardOAuthRequest(service.oauth)(webRequest),
        ),
      ),
    ),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logError('OAuth transport unavailable', error).pipe(
          Effect.as(
            HttpServerResponse.text('OAuth server is unavailable', {
              headers: { 'cache-control': 'no-store' },
              status: 503,
            }),
          ),
        ),
      onSuccess: (response) =>
        Effect.succeed(HttpServerResponse.raw(response, { status: response.status, statusText: response.statusText })),
    }),
  ),
);
