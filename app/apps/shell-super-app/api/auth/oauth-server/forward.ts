import { Effect, Option, Redacted, Schema } from 'effect';
import { HttpServerResponse } from 'effect/http';

import {
  classifyOAuthPath,
  fullOAuthPath,
  OAUTH_BASE_PATH,
  OAuthMetadataDocumentSchema,
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
const BODY_READ_TIMEOUT = '10 seconds';
const CONTENT_TYPE_HEADER = 'content-type';

/** The request Better Auth sees: full issuer-prefixed path on the configured issuer origin (never X-Forwarded-*). */
export const toBetterAuthRequest = (issuer: string, request: Request, body?: ArrayBuffer): Request => {
  const incoming = new URL(request.url);
  const path = fullOAuthPath(incoming.pathname);
  const search = path === AUTHORIZE_PATH ? withOfflineAccess(incoming.search) : incoming.search;
  const target = new URL(`${path}${search}`, issuer);
  const init: RequestInit = {
    headers: request.headers,
    method: request.method,
    redirect: 'manual',
    signal: request.signal,
  };
  if (body !== undefined) {
    init.body = body;
  }
  return new Request(target, init);
};

const serverError = (): Response =>
  HttpServerResponse.raw('{"error":"server_error"}', {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status: 500,
  }).pipe(HttpServerResponse.toWeb);

// Only the fields owned by the pre-dispatch guards are decoded here. Better Auth owns the rest of the request.
const GuardBody = Schema.Struct({
  accept: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  grant_type: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  token: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
});
const decodeGuardJson = Schema.decodeEffect(Schema.fromJsonString(GuardBody));
const decodeGuardForm = Schema.decodeUnknownEffect(GuardBody);
const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthMetadataDocumentSchema));
const decodeAuthorizeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.optionalKey(Schema.String) })),
);

const decodeText = (body: ArrayBuffer | undefined): string =>
  body === undefined ? '' : new TextDecoder().decode(body);

/** A response that replaces Better Auth's, or none to let Better Auth answer. Invalid guard input fails closed. */
const guardRequest = Effect.fn('OAuth.guardRequest')(function* guardRequest(
  guards: OAuthEndpointGuards | undefined,
  path: string,
  request: Request,
  body: ArrayBuffer | undefined,
) {
  if (guards === undefined || request.method !== 'POST') {
    return Option.none<Response>();
  }
  if (path !== TOKEN_PATH && path !== REVOKE_PATH && path !== CONSENT_PATH) {
    return Option.none<Response>();
  }
  const text = decodeText(body);
  const fields = yield* request.headers.get(CONTENT_TYPE_HEADER)?.includes('application/json') === true
    ? decodeGuardJson(text)
    : decodeGuardForm(Object.fromEntries(new URLSearchParams(text)));
  // Better Auth's refresh-reuse reaction deletes tokens across companies. The guard limits it to this grant.
  if (path === TOKEN_PATH) {
    const credential = fields.refresh_token;
    if (fields.grant_type !== 'refresh_token' || credential === undefined || Redacted.value(credential) === '') {
      return Option.none<Response>();
    }
    const verdict = yield* guards.refreshTokenStatus(credential, { revokeOnReuse: true });
    return verdict === 'pass'
      ? Option.none<Response>()
      : Option.some(oauthJsonError(400, 'invalid_grant', 'invalid refresh token'));
  }
  if (path === REVOKE_PATH) {
    const credential = fields.token;
    if (credential === undefined || Redacted.value(credential) === '') {
      return Option.none<Response>();
    }
    // RFC 7009 §2.2: revoking an already invalid token answers 200.
    const verdict = yield* guards.refreshTokenStatus(credential, { revokeOnReuse: false });
    return verdict === 'pass'
      ? Option.none<Response>()
      : Option.some(
          HttpServerResponse.empty({ headers: { 'cache-control': 'no-store' }, status: 200 }).pipe(
            HttpServerResponse.toWeb,
          ),
        );
  }
  if (fields.accept !== true && fields.accept !== 'true') {
    return Option.none<Response>();
  }
  // The code is issued only after the draft has been approved by /oauth-connections/approve.
  const approved = yield* guards.consentApproved(request.headers);
  return approved
    ? Option.none<Response>()
    : Option.some(oauthJsonError(400, 'invalid_request', 'connection not approved'));
});

/** Metadata without unserved endpoints and methods; malformed JSON remains Better Auth's original response. */
const rewriteMetadata = Effect.fn('OAuth.rewriteMetadata')(function* rewriteMetadata(response: Response) {
  if (!response.ok) {
    return response;
  }
  const copy = yield* Effect.try(response.clone.bind(response));
  const text = yield* Effect.tryPromise(copy.text.bind(copy)).pipe(Effect.timeout(BODY_READ_TIMEOUT));
  const parsed = decodeMetadata(text);
  if (Option.isNone(parsed)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthMetadataDocumentSchema))(
    publicMetadataDocument(parsed.value),
  );
  headers.set(CONTENT_TYPE_HEADER, headers.get(CONTENT_TYPE_HEADER) ?? 'application/json');
  const adapted = HttpServerResponse.raw(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  }).pipe(HttpServerResponse.toWeb);
  adapted.headers.delete('set-cookie');
  for (const cookie of headers.getSetCookie()) {
    adapted.headers.append('set-cookie', cookie);
  }
  return adapted;
});

/** Authorize errors without a safe client redirect go to the Czech error card, never the client's redirect. */
const authorizeFailureToErrorPage = Effect.fn('OAuth.authorizeFailureToErrorPage')(
  function* authorizeFailureToErrorPage(response: Response) {
    if (response.status < 400 || response.headers.has('location')) {
      return response;
    }
    const copy = yield* Effect.try(response.clone.bind(response));
    const text = yield* Effect.tryPromise(copy.text.bind(copy)).pipe(Effect.timeout(BODY_READ_TIMEOUT));
    const parsed = decodeAuthorizeError(text);
    return oauthErrorPageRedirect(Option.isSome(parsed) ? parsed.value.error : null);
  },
);

/** Serves only allow-listed OAuth routes. Typed read/dispatch failures produce HTTP errors, never authorization. */
export const forwardOAuthRequest = (endpoint: OAuthServerEndpoint) =>
  Effect.fn('OAuth.forwardRequest')(function* forwardRequest(request: Request) {
    const url = new URL(request.url);
    const path = fullOAuthPath(url.pathname);
    const kind = classifyOAuthPath(path);
    if (kind === 'blocked') {
      return oauthNotFoundResponse();
    }
    if (kind === 'metadata' && request.method === 'OPTIONS') {
      return oauthPreflightResponse();
    }
    if (path === ERROR_PATH) {
      return oauthErrorPageRedirect(url.searchParams.get('error'));
    }
    const dispatch = Effect.gen(function* dispatchOAuthRequest() {
      const payload =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : yield* Effect.tryPromise(request.arrayBuffer.bind(request)).pipe(Effect.timeout(BODY_READ_TIMEOUT));
      const guarded = yield* guardRequest(endpoint.guards, path, request, payload).pipe(
        Effect.catchTag('SchemaError', (failure) =>
          Effect.logWarning('Invalid OAuth guard request', failure._tag).pipe(
            Effect.as(Option.some(oauthJsonError(400, 'invalid_request', 'invalid request body'))),
          ),
        ),
      );
      if (Option.isSome(guarded)) {
        return guarded.value;
      }
      const response = yield* endpoint.handler(toBetterAuthRequest(endpoint.issuer, request, payload));
      if (kind === 'metadata' && path.includes('/.well-known/')) {
        return yield* rewriteMetadata(response);
      }
      if (path === AUTHORIZE_PATH && request.method === 'GET') {
        return yield* authorizeFailureToErrorPage(response);
      }
      return response;
    });
    return yield* dispatch.pipe(
      Effect.map((response) => withOAuthResponseHeaders(kind, response)),
      Effect.matchEffect({
        onFailure: (cause) => Effect.logError('OAuth request failed', cause).pipe(Effect.as(serverError())),
        onSuccess: Effect.succeed,
      }),
    );
  });
