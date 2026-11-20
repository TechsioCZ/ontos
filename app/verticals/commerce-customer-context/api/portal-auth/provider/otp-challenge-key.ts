import { getAuthoritativeSessionFromCtx } from 'better-auth/api';
import type { OTPOptions } from 'better-auth/plugins/two-factor';
import { Data, Duration, Effect, Option, Redacted, Schema } from 'effect';

import { COMMERCE_PORTAL_AUTH_POLICY } from './config.ts';
import type { CommercePortalAuthOtpChallengeKey } from './recovery/store-service.ts';
import { safeFailureOf } from './safe-failure.ts';
import type { SafeFailure } from './safe-failure.ts';

type OtpContext = NonNullable<Parameters<NonNullable<OTPOptions['sendOTP']>>[1]>;

/**
 * The name of the signed cookie Better Auth's two-factor plugin names a pending sign-in challenge by (its own constant; the
 * end-to-end suite of the one-time code runs the real plugin, so a change of it fails there, never silently).
 */
const TWO_FACTOR_COOKIE_NAME = 'two_factor';

const decodeCookie = Schema.decodeUnknownOption(Schema.String.check(Schema.isMinLength(1)));

/** Expected failure of the foreign Promise boundary: Better Auth could not answer. It carries nothing of what it was asked. */
class ChallengeKeyUnavailable extends Data.TaggedError('ChallengeKeyUnavailable')<{
  /** Only the safe kind of the failure (see `safeFailureOf`), never what Better Auth was asked or answered. */
  readonly failure?: SafeFailure;
  readonly part: string;
}> {}

const bridgeTimeout = Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds);

/**
 * The challenge KEY the two-factor plugin stores a freshly issued one-time code under, derived the way the plugin derives it
 * (`verifyTwoFactor`): the authoritative session when the request has one (`<user id>!<session id>`), else the signed
 * challenge cookie of a pending sign-in. It is what lets Auth find the exact challenge of THIS issuance for THIS user, never a
 * row that happens to hold the same code. None when the request names neither or Better Auth cannot answer or stays silent:
 * the issuance is then never submitted, never guessed.
 */
export const otpChallengeKeyOf = (
  ctx: OtpContext | undefined,
): Effect.Effect<Option.Option<CommercePortalAuthOtpChallengeKey>> => {
  if (ctx === undefined) {
    return Effect.succeed(Option.none());
  }
  const session = Effect.tryPromise({
    catch: (cause) => new ChallengeKeyUnavailable({ failure: safeFailureOf(cause), part: 'session' }),
    try: getAuthoritativeSessionFromCtx.bind(undefined, ctx),
  }).pipe(
    Effect.timeoutOrElse({
      duration: bridgeTimeout,
      orElse: () => Effect.fail(new ChallengeKeyUnavailable({ part: 'session-timeout' })),
    }),
    Effect.map((found) => Option.fromNullishOr(found?.session)),
    // a session that cannot be read is "no session": the pending sign-in challenge is then tried, as the plugin does
    Effect.orElseSucceed(() => Option.none<{ readonly id: string }>()),
  );
  const cookie = Effect.tryPromise({
    catch: (cause) => new ChallengeKeyUnavailable({ failure: safeFailureOf(cause), part: 'cookie' }),
    try: ctx.getSignedCookie.bind(
      ctx,
      ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME).name,
      ctx.context.secret,
      undefined,
    ),
  }).pipe(
    Effect.timeoutOrElse({
      duration: bridgeTimeout,
      orElse: () => Effect.fail(new ChallengeKeyUnavailable({ part: 'cookie-timeout' })),
    }),
    Effect.map((signed) => decodeCookie(signed)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  return session.pipe(
    Effect.flatMap((found) =>
      Option.isSome(found)
        ? Effect.succeed(Option.some<CommercePortalAuthOtpChallengeKey>({ kind: 'SESSION', sessionId: found.value.id }))
        : cookie.pipe(
            Effect.map(
              Option.map((value): CommercePortalAuthOtpChallengeKey => ({
                cookie: Redacted.make(value),
                kind: 'SIGN_IN',
              })),
            ),
          ),
    ),
  );
};
