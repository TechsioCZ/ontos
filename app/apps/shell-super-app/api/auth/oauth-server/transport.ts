import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { AuthenticationService } from '../service.ts';
import type { AuthenticationServiceContract } from '../service.ts';
import { forwardOAuthRequest } from './forward.ts';
import { oauthNotFoundResponse } from './policy.ts';

const oauthRoute = (service: AuthenticationServiceContract) =>
  HttpRouter.add('*', '/oauth/*', (request) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap((webRequest) =>
        service.oauth === undefined ? Effect.succeed(oauthNotFoundResponse()) : forwardOAuthRequest(service.oauth)(webRequest),
      ),
      Effect.match({
        onFailure: () =>
          HttpServerResponse.text('OAuth server is unavailable', { headers: { 'cache-control': 'no-store' }, status: 503 }),
        onSuccess: (response) =>
          HttpServerResponse.raw(response, { status: response.status, statusText: response.statusText }),
      }),
    ),
  );

/** Mounts {basePath}/oauth2/<allow-listed>, /jwks, /.well-known/* and /error (ONTOS-MCP-AUTH-DESIGN.md §2.2). */
export const OAuthServerTransportLive = Layer.unwrap(AuthenticationService.pipe(Effect.map(oauthRoute)));
