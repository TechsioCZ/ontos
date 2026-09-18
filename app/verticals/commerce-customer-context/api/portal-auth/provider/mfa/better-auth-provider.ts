import { isAPIError } from 'better-auth/api';
import { splitSetCookieHeader } from 'better-auth/cookies';
import type { InferAPI } from 'better-auth';
import { Duration, Effect, Layer, Option, Schema } from 'effect';

import type {
  CommercePortalAuthMfaDisableProviderRequest,
  CommercePortalAuthMfaEnableProviderRequest,
  CommercePortalAuthMfaPasswordProviderRequest,
  CommercePortalAuthMfaProvider,
  CommercePortalAuthMfaProviderFailure,
  CommercePortalAuthMfaResponse,
  CommercePortalAuthMfaSendOtpProviderRequest,
  CommercePortalAuthMfaVerificationResult,
  CommercePortalAuthMfaVerifyBackupCodeProviderRequest,
  CommercePortalAuthMfaVerifyOtpProviderRequest,
  CommercePortalAuthMfaVerifyTotpProviderRequest,
} from './contracts.ts';
import {
  CommercePortalAuthMfaBackupCodesResultSchema,
  CommercePortalAuthMfaEnableResultSchema,
  CommercePortalAuthMfaStatusResultSchema,
  CommercePortalAuthMfaTotpUriResultSchema,
} from './contracts.ts';
import { CommercePortalAuthInstance } from '../auth.ts';
import { CommercePortalAuthMfaChallengeExpired } from './challenge-expired.ts';
import { CommercePortalAuthMfaProviderService } from './provider-service.ts';
import {
  CommercePortalAuthMfaProviderRejectionCodeSchema,
  CommercePortalAuthMfaProviderRejected,
} from './provider-rejected.ts';
import { commercePortalAuthMfaProviderUnavailable } from './service.ts';
import { CommercePortalAuthMfaRateLimitCodeSchema, CommercePortalAuthMfaRateLimited } from './rate-limited.ts';
import type { CommercePortalAuthTwoFactorPlugin } from './plugin.ts';

/** The plugin endpoint API preserved by an inferred Better Auth options object. */
export type CommercePortalAuthTwoFactorApi = Pick<
  InferAPI<CommercePortalAuthTwoFactorPlugin['endpoints']>,
  | 'disableTwoFactor'
  | 'enableTwoFactor'
  | 'generateBackupCodes'
  | 'getTOTPURI'
  | 'sendTwoFactorOTP'
  | 'verifyBackupCode'
  | 'verifyTOTP'
  | 'verifyTwoFactorOTP'
>;

const CHALLENGE_EXPIRED_CODES = new Set(['OTP_HAS_EXPIRED']);
const RATE_LIMIT_CODES = new Set([
  'ACCOUNT_TEMPORARILY_LOCKED',
  'RATE_LIMITED',
  'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
  'TOO_MANY_REQUESTS',
]);

const withCause = <ErrorValue extends object>(error: ErrorValue, cause: unknown): ErrorValue =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

interface CommercePortalAuthMfaProviderCause {
  readonly code?: string | undefined;
  readonly kind: 'api-error' | 'http-error' | 'unknown';
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

const setCookieHeadersFrom = (headers: HeadersInit | undefined): readonly string[] => {
  const responseHeaders = new Headers(headers);
  return splitSetCookieHeader(responseHeaders.get('set-cookie') ?? '');
};

const BetterAuthErrorBodySchema = Schema.Struct({ code: Schema.optional(Schema.String) });

const rejectionCode = (
  code: string | undefined,
  statusCode: number,
): typeof CommercePortalAuthMfaProviderRejectionCodeSchema.Type => {
  if (code !== undefined && Schema.is(CommercePortalAuthMfaProviderRejectionCodeSchema)(code)) {
    return code;
  }
  if (statusCode === 400 || statusCode === 422) {
    return 'INVALID_REQUEST';
  }
  return 'PROVIDER_REJECTED';
};

const rateLimitCode = (code: string | undefined): typeof CommercePortalAuthMfaRateLimitCodeSchema.Type =>
  code !== undefined && Schema.is(CommercePortalAuthMfaRateLimitCodeSchema)(code) ? code : 'RATE_LIMITED';

const classifyProviderFailure = (
  operation: string,
  code: string | undefined,
  statusCode: number | undefined,
  setCookieHeaders: readonly string[],
  cause: CommercePortalAuthMfaProviderCause,
): CommercePortalAuthMfaProviderFailure => {
  if (code !== undefined && CHALLENGE_EXPIRED_CODES.has(code)) {
    return withCause(
      new CommercePortalAuthMfaChallengeExpired({
        operation,
        reason: 'The Commerce portal MFA challenge has expired',
        setCookieHeaders,
      }),
      cause,
    );
  }
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || statusCode === 429) {
    return withCause(
      new CommercePortalAuthMfaRateLimited({
        code: rateLimitCode(code),
        operation,
        reason: 'The Commerce portal MFA provider rate limit was reached',
        setCookieHeaders,
      }),
      cause,
    );
  }
  /**
   * A status the provider reports below 500 is the only rejection. A provider fault keeps its
   * retryable unavailable whatever error code rides with it, and a failure that carries no status
   * at all is never reported to the portal as an authentication rejection.
   */
  if (statusCode !== undefined && statusCode < 500) {
    return withCause(
      new CommercePortalAuthMfaProviderRejected({
        code: rejectionCode(code, statusCode),
        operation,
        reason: 'The Commerce portal MFA provider rejected the request',
        setCookieHeaders,
      }),
      cause,
    );
  }
  return commercePortalAuthMfaProviderUnavailable(operation, cause, setCookieHeaders);
};

const mapBetterAuthFailure = (operation: string, cause: unknown): CommercePortalAuthMfaProviderFailure => {
  const code = isAPIError(cause) && Schema.is(Schema.String)(cause.body?.code) ? cause.body.code : undefined;
  const statusCode = isAPIError(cause) ? cause.statusCode : undefined;
  const headers = isAPIError(cause) ? cause.headers : undefined;
  return classifyProviderFailure(operation, code, statusCode, setCookieHeadersFrom(headers), safeProviderCause(cause));
};

interface BetterAuthHttpResponse {
  readonly bodyText: string;
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
}

type CommercePortalAuthMfaSchema = Schema.Constraint & { readonly DecodingServices: never };

interface CommercePortalAuthMfaMalformedResponseCause {
  readonly kind: 'malformed-response';
}

const malformedResponseCause = <ErrorValue>(_cause: ErrorValue): CommercePortalAuthMfaMalformedResponseCause => ({
  kind: 'malformed-response',
});

const readBetterAuthResponse = (
  operation: string,
  response: Response,
): Effect.Effect<BetterAuthHttpResponse, CommercePortalAuthMfaProviderFailure> => {
  const bodyTextEffect =
    response.status === 204
      ? Effect.succeed('')
      : Effect.tryPromise({
          catch: (cause) => commercePortalAuthMfaProviderUnavailable(operation, safeProviderCause(cause), []),
          try: response.text.bind(response),
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(5000),
            orElse: () =>
              Effect.fail(
                commercePortalAuthMfaProviderUnavailable(
                  operation,
                  'Commerce portal MFA response body read timed out',
                  [],
                ),
              ),
          }),
        );
  return bodyTextEffect.pipe(
    Effect.map((bodyText) => ({
      bodyText,
      headers: new Headers(response.headers),
      ok: response.ok,
      status: response.status,
    })),
  );
};

/**
 * Better Auth answers a verification with `{ token, user }`. Only the subject identifier is
 * modelled: the struct stays open so provider-owned user fields are ignored rather than rejected,
 * and neither the token nor the user record is projected past `mapVerificationResult`.
 */
const CommercePortalAuthMfaVerificationProviderResultSchema = Schema.Struct({
  token: Schema.String,
  user: Schema.Struct({ id: Schema.String }),
});

const callBetterAuth = <SchemaValue extends CommercePortalAuthMfaSchema, ResponseValue>(
  operation: string,
  call: () => Promise<ResponseValue>,
  schema: SchemaValue,
): Effect.Effect<
  CommercePortalAuthMfaResponse<SchemaValue['Type']>,
  CommercePortalAuthMfaProviderFailure,
  SchemaValue['DecodingServices']
> =>
  Effect.tryPromise({
    catch: (cause) => mapBetterAuthFailure(operation, cause),
    try: call,
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(5000),
      orElse: () =>
        Effect.fail(
          commercePortalAuthMfaProviderUnavailable(operation, 'Commerce portal MFA provider call timed out', []),
        ),
    }),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(Schema.instanceOf(Response))(response).pipe(
        Effect.mapError((cause) => commercePortalAuthMfaProviderUnavailable(operation, safeProviderCause(cause), [])),
      ),
    ),
    Effect.flatMap((response) => readBetterAuthResponse(operation, response)),
    Effect.flatMap((response) => {
      const setCookieHeaders = setCookieHeadersFrom(response.headers);
      if (!response.ok) {
        const errorBody = Schema.decodeOption(Schema.fromJsonString(BetterAuthErrorBodySchema))(response.bodyText);
        const code = Option.isSome(errorBody) ? errorBody.value.code : undefined;
        return Effect.fail(
          classifyProviderFailure(operation, code, response.status, setCookieHeaders, {
            code,
            kind: 'http-error',
            statusCode: response.status,
          }),
        );
      }
      return Schema.decodeEffect(Schema.fromJsonString(schema))(response.bodyText).pipe(
        Effect.map((body) => ({ body, setCookieHeaders })),
        Effect.mapError((cause) =>
          commercePortalAuthMfaProviderUnavailable(operation, malformedResponseCause(cause), setCookieHeaders),
        ),
      );
    }),
  );

const mapVerificationResult = <SchemaValue extends CommercePortalAuthMfaSchema>(
  call: Effect.Effect<
    CommercePortalAuthMfaResponse<SchemaValue['Type']>,
    CommercePortalAuthMfaProviderFailure,
    SchemaValue['DecodingServices']
  >,
): Effect.Effect<
  CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
  CommercePortalAuthMfaProviderFailure,
  SchemaValue['DecodingServices']
> => call.pipe(Effect.map(({ setCookieHeaders }) => ({ body: { status: true } as const, setCookieHeaders })));

/**
 * Adapt Better Auth's inferred Promise API to the provider-owned Effect port. Verification
 * responses are deliberately projected to a status result so Better Auth session tokens and
 * user records cannot leak into Commerce application code. Response cookies remain a private
 * handoff because MFA may rotate or expire the provider session.
 */
export const makeCommercePortalAuthMfaProvider = (
  api: CommercePortalAuthTwoFactorApi,
): CommercePortalAuthMfaProvider => ({
  disableTwoFactor: (input: CommercePortalAuthMfaDisableProviderRequest) =>
    callBetterAuth(
      'disableTwoFactor',
      api.disableTwoFactor.bind(api, { ...input, asResponse: true }),
      CommercePortalAuthMfaStatusResultSchema,
    ),
  enableTwoFactor: (input: CommercePortalAuthMfaEnableProviderRequest) =>
    callBetterAuth(
      'enableTwoFactor',
      api.enableTwoFactor.bind(api, { ...input, asResponse: true }),
      CommercePortalAuthMfaEnableResultSchema,
    ),
  generateBackupCodes: (input: CommercePortalAuthMfaPasswordProviderRequest) =>
    callBetterAuth(
      'generateBackupCodes',
      api.generateBackupCodes.bind(api, { ...input, asResponse: true }),
      CommercePortalAuthMfaBackupCodesResultSchema,
    ),
  getTOTPURI: (input: CommercePortalAuthMfaPasswordProviderRequest) =>
    callBetterAuth(
      'getTOTPURI',
      api.getTOTPURI.bind(api, { ...input, asResponse: true }),
      CommercePortalAuthMfaTotpUriResultSchema,
    ),
  sendTwoFactorOTP: (input: CommercePortalAuthMfaSendOtpProviderRequest) =>
    callBetterAuth(
      'sendTwoFactorOTP',
      api.sendTwoFactorOTP.bind(api, { ...input, asResponse: true }),
      CommercePortalAuthMfaStatusResultSchema,
    ),
  verifyBackupCode: (input: CommercePortalAuthMfaVerifyBackupCodeProviderRequest) =>
    mapVerificationResult(
      callBetterAuth(
        'verifyBackupCode',
        api.verifyBackupCode.bind(api, { ...input, asResponse: true }),
        CommercePortalAuthMfaVerificationProviderResultSchema,
      ),
    ),
  verifyTOTP: (input: CommercePortalAuthMfaVerifyTotpProviderRequest) =>
    mapVerificationResult(
      callBetterAuth(
        'verifyTOTP',
        api.verifyTOTP.bind(api, { ...input, asResponse: true }),
        CommercePortalAuthMfaVerificationProviderResultSchema,
      ),
    ),
  verifyTwoFactorOTP: (input: CommercePortalAuthMfaVerifyOtpProviderRequest) =>
    mapVerificationResult(
      callBetterAuth(
        'verifyTwoFactorOTP',
        api.verifyTwoFactorOTP.bind(api, { ...input, asResponse: true }),
        CommercePortalAuthMfaVerificationProviderResultSchema,
      ),
    ),
});

/** The constructed realm stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthMfaProviderLive = Layer.effect(
  CommercePortalAuthMfaProviderService,
  Effect.gen(function* makeCommercePortalAuthMfaProviderLive() {
    const auth = yield* CommercePortalAuthInstance;
    return makeCommercePortalAuthMfaProvider(auth.api);
  }),
);
