/**
 * HTTP group of the shell connect flow (`oauthConnect`, shared/oauth-connect-api.ts). Resolves the signed-in shell
 * session, runs the connect service and maps its errors to Problem Details: Invalid 400 (404 for unknown drafts and
 * grants), Unauthorized 401, Forbidden 403 (detail = Czech reason), Unavailable 503.
 */
import { PrincipalResolver } from '@app/core-runtime';
import { Cookies, HttpApiBuilder, HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Match } from 'effect';

import { ShellAuthenticationApi } from '../../shared/api.ts';
import type { OAuthConnectProblem } from '../../shared/oauth-connect-api.ts';
import { AuthenticationService } from '../auth/service.ts';
import { type ConnectSession, approve, connectOptions, createDraft, deny, draftSummary } from './connect-service.ts';
import { ConnectionForbidden, ConnectionUnauthorized, ConnectionUnavailable } from './errors.ts';
import type { ConnectionInvalid } from './errors.ts';
import { demoDisplayName } from '../../src/routes/shell-demo-presentation.ts';
import { isSameOriginRequest } from './request-origin.ts';
import { loadOAuthServerConfig } from './server-config.ts';

type RequestHeaders = Readonly<Record<string, string | undefined>>;
interface RequestWithHeaders {
  readonly headers: RequestHeaders;
}

const SESSION_CONTEXT_PREFIX = 'better-auth-session:';

const requestHeaders = (headers: RequestHeaders): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
};

const forwardSetCookieHeaders = (headers: readonly string[]) =>
  headers.length === 0
    ? Effect.void
    : HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(response.pipe(HttpServerResponse.mergeCookies(Cookies.fromSetCookie(headers)))),
      );

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', 'no-store')),
);

type ConnectError = ConnectionForbidden | ConnectionInvalid | ConnectionUnauthorized | ConnectionUnavailable;

const toProblem = (error: ConnectError): Effect.Effect<OAuthConnectProblem> =>
  Match.value(error).pipe(
    Match.tag('ConnectionInvalid', (invalid) =>
      Effect.succeed<OAuthConnectProblem>(
        invalid.code === 'draft_not_found' || invalid.code === 'grant_not_found' || invalid.code === 'connection_active'
          ? {
              _tag: 'OAuthConnectNotFoundProblem',
              code: invalid.code,
              detail:
                invalid.code === 'connection_active'
                  ? 'Připojení je hotové. Toto okno můžete zavřít.'
                  : 'Žádost o připojení vypršela nebo neexistuje. Spusťte připojení znovu z aplikace.',
              status: 404,
              title: 'OAuth connect draft not found',
              type: 'https://ontos.dev/problems/oauth-connect-not-found',
            }
          : {
              _tag: 'OAuthConnectInvalidProblem',
              code: invalid.code,
              detail:
                invalid.code === 'modules_invalid'
                  ? 'Vybrané moduly nejsou dostupné.'
                  : 'Odkaz pro připojení je neplatný nebo vypršel. Spusťte připojení znovu z aplikace.',
              status: 400,
              title: 'OAuth connect request invalid',
              type: 'https://ontos.dev/problems/oauth-connect-invalid',
            },
      ),
    ),
    Match.tag('ConnectionUnauthorized', (unauthorized) =>
      Effect.succeed<OAuthConnectProblem>({
        _tag: 'OAuthConnectUnauthorizedProblem',
        code: unauthorized.code,
        detail: 'Přihlaste se prosím do OntOS.',
        status: 401,
        title: 'OAuth connect requires a session',
        type: 'https://ontos.dev/problems/oauth-connect-unauthorized',
      }),
    ),
    Match.tag('ConnectionForbidden', (forbidden) =>
      Effect.succeed<OAuthConnectProblem>({
        _tag: 'OAuthConnectForbiddenProblem',
        code: forbidden.code,
        detail: forbidden.reason,
        status: 403,
        title: 'OAuth connect forbidden',
        type: 'https://ontos.dev/problems/oauth-connect-forbidden',
      }),
    ),
    Match.tag('ConnectionUnavailable', (unavailable) =>
      Effect.logError('OAuth connect unavailable', unavailable.cause).pipe(
        Effect.as<OAuthConnectProblem>({
          _tag: 'OAuthConnectUnavailableProblem',
          detail: 'Připojení je dočasně nedostupné. Zkuste to prosím znovu.',
          retryable: true,
          status: 503,
          title: 'OAuth connect unavailable',
          type: 'https://ontos.dev/problems/oauth-connect-unavailable',
        }),
      ),
    ),
    Match.exhaustive,
  );

/** The signed-in shell session behind a connect request. */
const connectSession = Effect.fn('shell.oauthConnect.session')(function* connectSession(request: RequestWithHeaders) {
  const context = yield* (yield* AuthenticationService)
    .resolveShellContext(requestHeaders(request.headers))
    .pipe(Effect.mapError((cause) => new ConnectionUnavailable({ cause })));
  yield* forwardSetCookieHeaders(context.setCookieHeaders);
  if (context.state === 'anonymous') {
    return yield* new ConnectionUnauthorized({ code: 'session_missing' });
  }
  if (context.identity.impersonating === true) {
    return yield* new ConnectionForbidden({
      code: 'access_blocked',
      reason: 'Při zastoupení nelze připojovat aplikace.',
    });
  }
  const { principal } = context;
  const authContextRef = principal.authContextRef ?? '';
  if (!authContextRef.startsWith(SESSION_CONTEXT_PREFIX)) {
    return yield* new ConnectionUnauthorized({ code: 'session_missing' });
  }
  const sessionId = authContextRef.slice(SESSION_CONTEXT_PREFIX.length);
  if (sessionId.length === 0) {
    return yield* new ConnectionUnauthorized({ code: 'session_missing' });
  }
  const userId = yield* (yield* PrincipalResolver)
    .resolveBetterAuthUserForPrincipal({ principalId: principal.principalId, tenantId: principal.tenantId })
    .pipe(Effect.mapError((cause) => new ConnectionUnavailable({ cause })));
  return {
    activeLegalEntityId: context.state === 'authenticated' ? context.identity.legalEntityId : null,
    authBindingId: principal.authBindingId,
    companies: context.availableLegalEntities,
    displayName: demoDisplayName(context.identity),
    principalId: principal.principalId,
    sessionId,
    tenantId: principal.tenantId,
    userId,
  } satisfies ConnectSession;
});

const run = <Value, Requirements>(
  request: RequestWithHeaders,
  handler: (session: ConnectSession) => Effect.Effect<Value, ConnectError, Requirements>,
) =>
  Effect.gen(function* runConnect() {
    yield* noStore;
    const config = yield* loadOAuthServerConfig;
    const issuerOrigin = URL.canParse(config.issuer) ? new URL(config.issuer).origin : '';
    if (!isSameOriginRequest(request.headers, issuerOrigin)) {
      return yield* new ConnectionForbidden({
        code: 'access_blocked',
        reason: 'Žádost nepřišla z OntOS. Spusťte připojení znovu z aplikace.',
      });
    }
    const session = yield* connectSession(request);
    return yield* handler(session);
  }).pipe(Effect.catch((error) => Effect.flatMap(toProblem(error), Effect.fail)));

export const oauthConnectGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'oauthConnect', (handlers) =>
  handlers
    .handle('connectOptions', ({ payload, request }) => run(request, (session) => connectOptions(session, payload)))
    .handle('connectDraft', ({ payload, request }) => run(request, (session) => createDraft(session, payload)))
    .handle('connectDraftSummary', ({ payload, request }) => run(request, (session) => draftSummary(session, payload)))
    .handle('connectApprove', ({ payload, request }) => run(request, (session) => approve(session, payload)))
    .handle('connectDeny', ({ payload, request }) => run(request, (session) => deny(session, payload))),
);
