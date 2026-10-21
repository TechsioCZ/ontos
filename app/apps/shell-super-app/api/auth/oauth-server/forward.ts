import { Effect, Option } from 'effect';

import {
  classifyOAuthPath,
  fullOAuthPath,
  OAUTH_BASE_PATH,
  oauthErrorPageRedirect,
  oauthJsonError,
  oauthNotFoundResponse,
  oauthPreflightResponse,
  publicMetadataDocument,
  withOAuthResponseHeaders,
  withOfflineAccess,
} from './policy.ts';
import type { OAuthEndpointGuards, OAuthServerEndpoint } from './policy.ts';

const AUTHORIZE_PATH = `${OAUTH_BASE_PATH}/oauth2/authorize`;
const CONSENT_PATH = `${OAUTH_BASE_PATH}/oauth2/consent`;
const ERROR_PATH = `${OAUTH_BASE_PATH}/error`;
const REVOKE_PATH = `${OAUTH_BASE_PATH}/oauth2/revoke`;
const TOKEN_PATH = `${OAUTH_BASE_PATH}/oauth2/token`;

/** The request Better Auth sees: full issuer-prefixed path on the configured issuer origin (never X-Forwarded-*). */
export const toBetterAuthRequest = (issuer: string, request: Request, body: ArrayBuffer | undefined): Request => {
  const incoming = new URL(request.url);
  const path = fullOAuthPath(incoming.pathname);
  const search = path === AUTHORIZE_PATH ? withOfflineAccess(incoming.search) : incoming.search;
  const target = new URL(`${path}${search}`, issuer);
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

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Form or JSON body fields as strings (Better Auth accepts both on consent). */
export const bodyFields = (contentType: string | null, text: string): ReadonlyMap<string, string> => {
  if (contentType?.includes('application/json') === true) {
    const parsed = parseJson(text);
    return new Map(isObject(parsed) ? Object.entries(parsed).map(([key, value]) => [key, String(value)]) : []);
  }
  return new Map(new URLSearchParams(text));
};

const decodeText = (body: ArrayBuffer | undefined): string => (body === undefined ? '' : new TextDecoder().decode(body));

/** A response that replaces Better Auth's, or none to let Better Auth answer. */
const guardRequest = (
  guards: OAuthEndpointGuards | undefined,
  path: string,
  request: Request,
  body: ArrayBuffer | undefined,
): Effect.Effect<Option.Option<Response>> => {
  if (guards === undefined || request.method !== 'POST') {
    return Effect.succeedNone;
  }
  // Better Auth would answer a dead or reused refresh token by deleting all of the user's tokens for this client,
  // across companies; the guard refuses it here and limits the reaction to the one grant.
  if (path === TOKEN_PATH) {
    const fields = bodyFields(request.headers.get('content-type'), decodeText(body));
    const refreshToken = fields.get('refresh_token');
    if (fields.get('grant_type') !== 'refresh_token' || refreshToken === undefined || refreshToken === '') {
      return Effect.succeedNone;
    }
    return guards
      .refreshTokenStatus(refreshToken, { revokeOnReuse: true })
      .pipe(
        Effect.map((verdict) =>
          verdict === 'pass' ? Option.none() : Option.some(oauthJsonError(400, 'invalid_grant', 'invalid refresh token')),
        ),
      );
  }
  if (path === REVOKE_PATH) {
    const token = bodyFields(request.headers.get('content-type'), decodeText(body)).get('token');
    if (token === undefined || token === '') {
      return Effect.succeedNone;
    }
    // RFC 7009 §2.2: revoking an already invalid token answers 200.
    return guards
      .refreshTokenStatus(token, { revokeOnReuse: false })
      .pipe(
        Effect.map((verdict) =>
          verdict === 'pass'
            ? Option.none()
            : Option.some(new Response(null, { headers: { 'cache-control': 'no-store' }, status: 200 })),
        ),
      );
  }
  if (path === CONSENT_PATH) {
    const fields = bodyFields(request.headers.get('content-type'), decodeText(body));
    if (fields.get('accept') !== 'true') {
      return Effect.succeedNone;
    }
    // The code is issued only after "Povolit přístup" approved the draft (/oauth-connections/approve).
    return guards
      .consentApproved(request.headers)
      .pipe(
        Effect.map((approved) =>
          approved ? Option.none() : Option.some(oauthJsonError(400, 'invalid_request', 'connection not approved')),
        ),
      );
  }
  return Effect.succeedNone;
};

/** Metadata without the endpoints and methods this AS does not serve (unparseable bodies pass unchanged). */
const rewriteMetadata = (response: Response): Effect.Effect<Response> =>
  Effect.promise(() => response.clone().text()).pipe(
    Effect.map((text) => {
      const parsed = parseJson(text);
      if (!response.ok || !isObject(parsed)) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(publicMetadataDocument(parsed)), {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    }),
  );

/**
 * An authorize request Better Auth refuses without redirecting to the client (unknown client, unregistered redirect)
 * answers JSON; a browser would show raw English. It goes to the Czech error card instead (§3.4).
 */
const authorizeFailureToErrorPage = (response: Response): Effect.Effect<Response> => {
  if (response.status < 400 || response.headers.has('location')) {
    return Effect.succeed(response);
  }
  return Effect.promise(() => response.clone().text()).pipe(
    Effect.map((text) => {
      const parsed = parseJson(text);
      const error = isObject(parsed) && typeof parsed['error'] === 'string' ? parsed['error'] : null;
      return oauthErrorPageRedirect(error);
    }),
  );
};

/** Serves only the allow-listed OAuth routes (policy.ts); everything else under the basePath is 404. */
export const forwardOAuthRequest =
  (endpoint: OAuthServerEndpoint) =>
  (request: Request): Effect.Effect<Response> => {
    const url = new URL(request.url);
    const path = fullOAuthPath(url.pathname);
    const kind = classifyOAuthPath(path);
    if (kind === 'blocked') {
      return Effect.succeed(oauthNotFoundResponse());
    }
    if (kind === 'metadata' && request.method === 'OPTIONS') {
      return Effect.succeed(oauthPreflightResponse());
    }
    // Better Auth's own error page sends the browser to "/" (English); the Czech error card explains it instead.
    if (path === ERROR_PATH) {
      return Effect.succeed(oauthErrorPageRedirect(url.searchParams.get('error')));
    }
    const body = Effect.tryPromise(() =>
      request.method === 'GET' || request.method === 'HEAD' ? Promise.resolve(undefined) : request.arrayBuffer(),
    );
    return body.pipe(
      Effect.flatMap((payload) =>
        guardRequest(endpoint.guards, path, request, payload).pipe(
          Effect.flatMap((guarded) =>
            Option.isNone(guarded)
              ? Effect.tryPromise(() => endpoint.handler(toBetterAuthRequest(endpoint.issuer, request, payload))).pipe(
                  Effect.flatMap((response) =>
                    kind === 'metadata' && path.includes('/.well-known/')
                      ? rewriteMetadata(response)
                      : path === AUTHORIZE_PATH && request.method === 'GET'
                        ? authorizeFailureToErrorPage(response)
                        : Effect.succeed(response),
                  ),
                )
              : Effect.succeed(guarded.value),
          ),
        ),
      ),
      Effect.map((response) => withOAuthResponseHeaders(kind, response)),
      Effect.orElseSucceed(serverError),
    );
  };
