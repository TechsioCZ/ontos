import { Effect } from 'effect';

import {
  classifyOAuthPath,
  fullOAuthPath,
  oauthNotFoundResponse,
  oauthPreflightResponse,
  withOAuthResponseHeaders,
} from './policy.ts';
import type { OAuthServerEndpoint } from './policy.ts';

/** The request Better Auth sees: full issuer-prefixed path on the configured issuer origin (never X-Forwarded-*). */
export const toBetterAuthRequest = (issuer: string, request: Request, body: ArrayBuffer | undefined): Request => {
  const incoming = new URL(request.url);
  const target = new URL(`${fullOAuthPath(incoming.pathname)}${incoming.search}`, issuer);
  return new Request(target, {
    ...(body === undefined ? {} : { body }),
    headers: request.headers,
    method: request.method,
    redirect: 'manual',
  });
};

const serverError = (): Response =>
  new Response('{"error":"server_error"}', {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status: 500,
  });

/** Serves only the allow-listed OAuth routes (policy.ts); everything else under the basePath is 404. */
export const forwardOAuthRequest =
  (endpoint: OAuthServerEndpoint) =>
  (request: Request): Effect.Effect<Response> => {
    const kind = classifyOAuthPath(fullOAuthPath(new URL(request.url).pathname));
    if (kind === 'blocked') {
      return Effect.succeed(oauthNotFoundResponse());
    }
    if (kind === 'metadata' && request.method === 'OPTIONS') {
      return Effect.succeed(oauthPreflightResponse());
    }
    const body = Effect.tryPromise(() =>
      request.method === 'GET' || request.method === 'HEAD' ? Promise.resolve(undefined) : request.arrayBuffer(),
    );
    return body.pipe(
      Effect.flatMap((payload) =>
        Effect.tryPromise(() => endpoint.handler(toBetterAuthRequest(endpoint.issuer, request, payload))),
      ),
      Effect.map((response) => withOAuthResponseHeaders(kind, response)),
      Effect.orElseSucceed(serverError),
    );
  };
