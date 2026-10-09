import { isAPIError } from 'better-auth/api';
import type { Auth } from 'better-auth';
import { Duration, Effect, Layer, Option, Schema } from 'effect';

import { withCause } from '../../problems-support.ts';
import { CommercePortalAuthInstance } from '../auth.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import { CommercePortalAuthStepUpCodeRejected } from '../step-up/code-rejected.ts';
import { CommercePortalAuthStepUpCodeVerifierService } from '../step-up/code-verifier-service.ts';
import type { CommercePortalAuthStepUpCodeInput } from '../step-up/contracts.ts';
import type { CommercePortalAuthStepUpCodeVerifier } from '../step-up/code-verifier-service.ts';
import { CommercePortalAuthStepUpUnavailable } from '../step-up/unavailable.ts';
import type { CommercePortalAuthTwoFactorApi } from './better-auth-provider.ts';

/** Better Auth session lookup is required before MFA so the claimed subject and session are exact. */
export type CommercePortalAuthMfaTwoFactorApi = CommercePortalAuthTwoFactorApi & Pick<Auth['api'], 'getSession'>;

const CurrentSessionSchema = Schema.Union([
  Schema.Null,
  Schema.Struct({
    session: Schema.Struct({ id: Schema.String }),
    user: Schema.Struct({
      id: Schema.String,
      /**
       * The installed two-factor plugin owns this user field; a row predating it answers null and a
       * provider build without the plugin omits the key. Both absences decode to `Option.none`, so
       * the precondition below reads one value instead of re-deriving absence from `null`/`undefined`.
       */
      twoFactorEnabled: Schema.OptionFromOptionalNullOr(Schema.Boolean),
    }),
  }),
]);

const VerifiedResponseSchema = Schema.Struct({
  token: Schema.String,
  user: Schema.Struct({ id: Schema.String }),
});

/** `returnHeaders: true` makes Better Auth answer with this exact envelope; both halves are concrete. */
const SessionEnvelopeSchema = Schema.Struct({
  headers: Schema.instanceOf(Headers),
  response: CurrentSessionSchema,
});

const VerifiedEnvelopeSchema = Schema.Struct({
  headers: Schema.instanceOf(Headers),
  response: VerifiedResponseSchema,
});

const SESSION_READ_OPERATION = 'step-up-session-read';
const MFA_VERIFY_OPERATION = 'step-up-mfa-verify';

interface CommercePortalAuthMfaMalformedResponseCause {
  readonly kind: 'malformed-response';
}

const malformedResponseCause = <ErrorValue>(_cause: ErrorValue): CommercePortalAuthMfaMalformedResponseCause => ({
  kind: 'malformed-response',
});

interface CommercePortalAuthMfaSessionRotatedCause {
  readonly kind: 'session-rotated';
}

const sessionRotatedCause = (): CommercePortalAuthMfaSessionRotatedCause => ({ kind: 'session-rotated' });

interface CommercePortalAuthMfaProviderCause {
  readonly code?: string | undefined;
  readonly kind: 'api-error' | 'unknown';
  readonly status?: number | string | undefined;
  readonly statusCode?: number | undefined;
}

/** Keep Better Auth diagnostics typed without retaining a response body or headers in `cause`. */
const safeProviderCause = (cause: unknown): CommercePortalAuthMfaProviderCause =>
  isAPIError(cause)
    ? {
        code: Schema.is(Schema.String)(cause.body?.code) ? cause.body.code : undefined,
        kind: 'api-error',
        status: cause.status,
        statusCode: cause.statusCode,
      }
    : { kind: 'unknown' };

const unavailable = (operation: string, cause: unknown): CommercePortalAuthStepUpUnavailable =>
  withCause(
    new CommercePortalAuthStepUpUnavailable({
      operation,
      reason: 'Commerce portal MFA step-up provider is unavailable',
    }),
    cause,
  );

const rejected = (): CommercePortalAuthStepUpCodeRejected =>
  new CommercePortalAuthStepUpCodeRejected({
    reason: 'Commerce portal MFA step-up verification was rejected',
  });

const providerFailure = (
  operation: string,
  cause: unknown,
): CommercePortalAuthStepUpCodeRejected | CommercePortalAuthStepUpUnavailable =>
  isAPIError(cause) && cause.statusCode < 500
    ? withCause(rejected(), safeProviderCause(cause))
    : unavailable(operation, safeProviderCause(cause));

const callProvider = <ResponseValue>(
  operation: string,
  call: () => Promise<ResponseValue>,
): Effect.Effect<ResponseValue, CommercePortalAuthStepUpCodeRejected | CommercePortalAuthStepUpUnavailable> =>
  Effect.tryPromise({
    catch: (cause) => providerFailure(operation, cause),
    try: call,
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.session.providerCallTimeoutMilliseconds),
      orElse: () => Effect.fail(unavailable(operation, 'Commerce portal MFA step-up provider call timed out')),
    }),
  );

/**
 * Build the step-up code verifier over Better Auth's public API. The session is freshly read with
 * cache and refresh disabled, then the exact subject, the provider session id and an already
 * activated second factor are checked before the code endpoint runs. Neither call may rotate the
 * session, so no provider cookie is produced, and Better Auth's token/user response is discarded.
 */
export const makeCommercePortalAuthMfaStepUpCodeVerifier = (
  api: CommercePortalAuthMfaTwoFactorApi,
): CommercePortalAuthStepUpCodeVerifier => {
  const verify = Effect.fn('CommercePortalAuthMfaStepUpCodeVerifier.verify')(function* verifyEffect(
    input: CommercePortalAuthStepUpCodeInput,
  ): Effect.fn.Return<void, CommercePortalAuthStepUpCodeRejected | CommercePortalAuthStepUpUnavailable> {
    const sessionResult = yield* callProvider(
      SESSION_READ_OPERATION,
      api.getSession.bind(api, {
        asResponse: false,
        headers: input.headers,
        query: { disableCookieCache: true, disableRefresh: true },
        returnHeaders: true,
      }),
    );
    const sessionEnvelope = yield* Schema.decodeUnknownEffect(SessionEnvelopeSchema)(sessionResult).pipe(
      Effect.mapError((cause) => unavailable(SESSION_READ_OPERATION, malformedResponseCause(cause))),
    );
    const currentSession = sessionEnvelope.response;
    /**
     * An activated factor is a step-up precondition. Better Auth activates a first-time TOTP factor
     * inside `verifyTOTP`: it rotates the session, writes the replacement cookie on the response and
     * deletes the current one. This port answers `void`, so that cookie could only be dropped here
     * and the caller would be signed out; activation stays on the MFA transport, which forwards it.
     */
    if (
      currentSession === null ||
      currentSession.user.id !== input.providerSubjectId ||
      !Option.getOrElse(currentSession.user.twoFactorEnabled, () => false) ||
      currentSession.session.id !== input.sessionId
    ) {
      return yield* rejected();
    }

    const verificationResult = yield* callProvider(
      MFA_VERIFY_OPERATION,
      api.verifyTOTP.bind(api, {
        body: { code: input.code, trustDevice: false },
        headers: input.headers,
        returnHeaders: true,
      }),
    );
    const verificationEnvelope = yield* Schema.decodeUnknownEffect(VerifiedEnvelopeSchema)(verificationResult).pipe(
      Effect.mapError((cause) => unavailable(MFA_VERIFY_OPERATION, malformedResponseCause(cause))),
    );
    /**
     * The precondition keeps this call off the rotating branch. A provider cookie would still be a
     * replacement credential this port cannot carry, so it fails instead of being dropped silently.
     */
    if (verificationEnvelope.headers.getSetCookie().length > 0) {
      return yield* unavailable(MFA_VERIFY_OPERATION, sessionRotatedCause());
    }
    if (verificationEnvelope.response.user.id !== input.providerSubjectId) {
      return yield* rejected();
    }
    return yield* Effect.void;
  });

  return Object.freeze({ verify });
};

/** The constructed realm stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthMfaStepUpCodeVerifierLive = Layer.effect(
  CommercePortalAuthStepUpCodeVerifierService,
  Effect.gen(function* makeCommercePortalAuthMfaStepUpCodeVerifierLive() {
    const auth = yield* CommercePortalAuthInstance;
    return makeCommercePortalAuthMfaStepUpCodeVerifier(auth.api);
  }),
);
