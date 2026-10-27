import { Effect, Result, Schema } from 'effect';
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';

import type { OAuthServerEndpoint } from '../oauth-server/policy.ts';
import { AuthenticationService } from '../service.ts';

const PasswordSchema = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)));
const TokenSchema = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)));
const SetPasswordSchema = Schema.Struct({ password: PasswordSchema, token: TokenSchema });
const NativeResetBodySchema = Schema.fromJsonString(Schema.Struct({ newPassword: PasswordSchema, token: TokenSchema }));
const InvitationFailureSchema = Schema.Struct({
  code: Schema.Literals(['INVALID_INVITATION', 'INVITATION_UNAVAILABLE']),
});
const invitationFailure = (code: typeof InvitationFailureSchema.Type.code, status: 400 | 503) => {
  const body = Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(InvitationFailureSchema))({ code }));
  return HttpServerResponse.toWeb(
    HttpServerResponse.text(body, {
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      status,
    }),
  );
};
const invalidRequest = () => invitationFailure('INVALID_INVITATION', 400);
const unavailable = () => invitationFailure('INVITATION_UNAVAILABLE', 503);

/** A narrow mount of Better Auth's native reset-password endpoint, not an alternative password implementation. */
export const setInvitationPassword = Effect.fn('Invitation.setPassword')(function* setInvitationPassword(
  authentication: OAuthServerEndpoint,
  request: Request,
) {
  if (request.method !== 'POST') {
    return invalidRequest();
  }
  const body = yield* HttpIncomingMessage.schemaBodyJson(SetPasswordSchema)(HttpServerRequest.fromWeb(request)).pipe(
    Effect.timeout('5 seconds'),
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
export const InvitationTransportLive = HttpRouter.add('POST', '/invitation/set-password', (request) =>
  invitationTransport(request),
);
