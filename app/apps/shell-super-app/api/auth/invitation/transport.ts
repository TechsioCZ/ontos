import { Effect, Schema } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';

import type { OAuthServerEndpoint } from '../oauth-server/policy.ts';
import { AuthenticationService } from '../service.ts';

const PasswordSchema = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)));
const TokenSchema = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)));
const SetPasswordSchema = Schema.Struct({ password: PasswordSchema, token: TokenSchema });
const NativeResetBodySchema = Schema.fromJsonString(Schema.Struct({ newPassword: PasswordSchema, token: TokenSchema }));
const invalidRequest = () =>
  new Response('{"code":"INVALID_INVITATION"}', {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status: 400,
  });
const unavailable = () =>
  new Response('{"code":"INVITATION_UNAVAILABLE"}', {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status: 503,
  });

/** A narrow mount of Better Auth's native reset-password endpoint, not an alternative password implementation. */
export const setInvitationPassword = Effect.fn('Invitation.setPassword')(function* setInvitationPassword(
  authentication: OAuthServerEndpoint,
  request: Request,
) {
  if (request.method !== 'POST') {
    return invalidRequest();
  }
  // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the native Request body Promise boundary.
  const body = yield* Effect.tryPromise(() => request.text()).pipe(
    Effect.timeout('5 seconds'),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SetPasswordSchema))),
  );
  const nativeBody = yield* Schema.encodeEffect(NativeResetBodySchema)({
    newPassword: body.password,
    token: body.token,
  });
  const headers = new Headers({ 'content-type': 'application/json' });
  const origin = request.headers.get('origin');
  if (origin !== null) {
    headers.set('origin', origin);
  }
  // Native reset owns its transaction and one-use consumption. Never retry a password mutation.
  return yield* authentication
    .handler(
      new Request(`${authentication.issuer}/reset-password`, {
        body: nativeBody,
        headers,
        method: 'POST',
      }),
    )
    .pipe(Effect.timeout('15 seconds'), Effect.orElseSucceed(unavailable));
}, Effect.orElseSucceed(invalidRequest));

const invitationTransport = Effect.fn('InvitationTransport.handle')(function* invitationTransport(
  request: HttpServerRequest.HttpServerRequest,
) {
  const authentication = yield* AuthenticationService;
  const endpoint = authentication.oauth;
  if (endpoint === undefined) {
    return HttpServerResponse.empty({ status: 503 });
  }
  const response = yield* HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap((webRequest) => setInvitationPassword(endpoint, webRequest)),
  );
  response.headers.set('cache-control', 'no-store');
  return HttpServerResponse.raw(response, { status: response.status, statusText: response.statusText });
});
export const InvitationTransportLive = HttpRouter.add('POST', '/invitation/set-password', invitationTransport);
