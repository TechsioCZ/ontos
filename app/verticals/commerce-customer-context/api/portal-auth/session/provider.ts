import { isAPIError } from 'better-auth/api';
import { Duration, Effect, Layer, Redacted, Schema } from 'effect';

import { providerSetCookieHeaders } from '../http-transport.ts';
import { CommercePortalAuthInstance } from '../provider/auth.ts';
import type { CommercePortalAuth } from '../provider/auth.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import { CommercePortalAuthSessionProviderService } from './provider-service.ts';
import { CommercePortalAuthProviderUnavailable } from './errors.ts';
import { CommercePortalAuthSessionMfaMethodSchema } from './contracts.ts';
import type {
  CommercePortalAuthProviderSignInRejection,
  CommercePortalAuthProviderSignInResult,
  CommercePortalAuthSignInInput,
} from './contracts.ts';
import type { CommercePortalAuthSessionProvider } from './lifecycle.ts';

const SignInResultSchema = Schema.Struct({ token: Schema.String });
const SignInPendingMfaSchema = Schema.Struct({
  twoFactorMethods: Schema.Array(CommercePortalAuthSessionMfaMethodSchema),
  twoFactorRedirect: Schema.Literal(true),
});
const ProviderSignInResponseSchema = Schema.Union([SignInResultSchema, SignInPendingMfaSchema]);

/** `returnHeaders: true` makes Better Auth answer with this exact envelope; both halves are concrete. */
const SignInEnvelopeSchema = Schema.Struct({
  headers: Schema.instanceOf(Headers),
  response: ProviderSignInResponseSchema,
});

const DEFINITIVE_AUTHENTICATION_FAILURE_CODES = new Set([
  'INVALID_EMAIL',
  'INVALID_EMAIL_OR_PASSWORD',
  'INVALID_PASSWORD',
  'INVALID_USERNAME_OR_PASSWORD',
]);
const VERIFICATION_REQUIRED_CODES = new Set(['EMAIL_NOT_VERIFIED']);
const RATE_LIMIT_CODES = new Set(['ACCOUNT_TEMPORARILY_LOCKED', 'RATE_LIMITED', 'TOO_MANY_REQUESTS']);
/**
 * The provider's own session hook repeats the deployment's concurrent-device cap. Its refusal is
 * the device cap, not a throttle, so it keeps the outcome whose remedy is ending another session.
 */
const SESSION_LIMIT_CODES = new Set(['CONCURRENT_DEVICE_LIMIT']);

const withCause = <TError extends object>(error: TError, cause: unknown): TError =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

const providerUnavailable = (cause: unknown): CommercePortalAuthProviderUnavailable =>
  withCause(
    new CommercePortalAuthProviderUnavailable({
      operation: 'sign-in',
      reason: 'Commerce portal authentication provider did not complete sign-in',
    }),
    cause,
  );

const classifyProviderError = (cause: unknown): CommercePortalAuthProviderSignInRejection | null => {
  if (!isAPIError(cause)) {
    return null;
  }
  const code = Schema.is(Schema.String)(cause.body?.code) ? cause.body.code : undefined;
  if (code !== undefined && DEFINITIVE_AUTHENTICATION_FAILURE_CODES.has(code)) {
    return { outcome: 'AUTHENTICATION_FAILED' };
  }
  if (code !== undefined && VERIFICATION_REQUIRED_CODES.has(code)) {
    return { outcome: 'VERIFICATION_REQUIRED' };
  }
  if (code !== undefined && SESSION_LIMIT_CODES.has(code)) {
    return { outcome: 'SESSION_LIMIT_REACHED' };
  }
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || cause.status === 'TOO_MANY_REQUESTS') {
    return { outcome: 'RATE_LIMITED' };
  }
  // Better Auth's failed-to-create-session and all unknown provider errors remain indeterminate.
  return null;
};

/**
 * Adapter from the installed Better Auth API to the owner-local Effect port. The raw token is
 * consumed only to resolve the durable session row and is never returned by this adapter. The
 * provider's own `Set-Cookie` strings travel with the result so the transport forwards exactly the
 * cookies Better Auth minted, without a second provider call.
 */
export const makeCommercePortalAuthSessionProvider = (
  auth: Pick<CommercePortalAuth, 'api'>,
): CommercePortalAuthSessionProvider => {
  const signInEmail = Effect.fn('CommercePortalAuthSessionProvider.signInEmail')(function* signInEmail(
    input: CommercePortalAuthSignInInput,
  ): Effect.fn.Return<CommercePortalAuthProviderSignInResult, CommercePortalAuthProviderUnavailable> {
    const request = {
      body:
        input.rememberMe === undefined
          ? { email: input.email, password: Redacted.value(input.password) }
          : { email: input.email, password: Redacted.value(input.password), rememberMe: input.rememberMe },
      returnHeaders: true,
    };
    const result = yield* Effect.tryPromise({
      catch: (cause) => providerUnavailable(cause),
      try: auth.api.signInEmail.bind(auth.api, request),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.session.providerCallTimeoutMilliseconds),
        orElse: () =>
          Effect.fail(
            new CommercePortalAuthProviderUnavailable({
              operation: 'sign-in',
              reason: 'Better Auth sign-in timed out',
            }),
          ),
      }),
      Effect.catchTag('CommercePortalAuthProviderUnavailable', (error) => {
        const classified = classifyProviderError(Object.getOwnPropertyDescriptor(error, 'cause')?.value);
        return classified === null ? Effect.fail(error) : Effect.succeed(classified);
      }),
    );
    if ('outcome' in result) {
      return result;
    }
    const envelope = yield* Schema.decodeUnknownEffect(SignInEnvelopeSchema)(result).pipe(
      // Do not attach a malformed Better Auth response as a cause: it may contain token material.
      Effect.mapError((cause) =>
        providerUnavailable({
          code: 'MALFORMED_RESPONSE',
          observed: cause !== undefined,
          reason: 'Better Auth sign-in response was malformed',
        }),
      ),
    );
    const setCookieHeaders = providerSetCookieHeaders(envelope.headers);
    return 'token' in envelope.response
      ? { setCookieHeaders, token: envelope.response.token }
      : { methods: envelope.response.twoFactorMethods, outcome: 'MFA_REQUIRED', setCookieHeaders };
  });

  return Object.freeze({ signInEmail });
};

/** The constructed realm stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthSessionProviderLive = Layer.effect(
  CommercePortalAuthSessionProviderService,
  Effect.gen(function* makeCommercePortalAuthSessionProviderLive() {
    const auth = yield* CommercePortalAuthInstance;
    return makeCommercePortalAuthSessionProvider(auth);
  }),
);
