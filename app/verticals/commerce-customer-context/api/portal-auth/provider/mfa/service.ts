import { Context, DateTime, Effect, Layer, Result, Schema } from 'effect';

import {
  CommercePortalAuthAudit,
  recordCommercePortalAuthAudit,
  unauditedCommercePortalAuthRecorder,
} from '../../../../src/portal-auth/audit/audit-service.ts';
import type { CommercePortalAuthAuditRecorder } from '../../../../src/portal-auth/audit/audit-service.ts';

import {
  CommercePortalAuthMfaBackupCodesResultSchema,
  CommercePortalAuthMfaEnableResultSchema,
  CommercePortalAuthMfaStatusResultSchema,
  CommercePortalAuthMfaTotpUriResultSchema,
  CommercePortalAuthMfaVerificationResultSchema,
} from './contracts.ts';
import type {
  CommercePortalAuthMfaBackupCodesResult,
  CommercePortalAuthMfaDisableProviderRequest,
  CommercePortalAuthMfaEnableProviderRequest,
  CommercePortalAuthMfaEnableResult,
  CommercePortalAuthMfaPasswordProviderRequest,
  CommercePortalAuthMfaProviderFailure,
  CommercePortalAuthMfaResponse,
  CommercePortalAuthMfaSendOtpProviderRequest,
  CommercePortalAuthMfaStatusResult,
  CommercePortalAuthMfaTotpUriResult,
  CommercePortalAuthMfaVerificationResult,
  CommercePortalAuthMfaVerifyBackupCodeProviderRequest,
  CommercePortalAuthMfaVerifyOtpProviderRequest,
  CommercePortalAuthMfaVerifyTotpProviderRequest,
} from './contracts.ts';
import { CommercePortalAuthMfaProviderUnavailable } from './provider-unavailable.ts';
import { CommercePortalAuthMfaProviderService } from './provider-service.ts';

/**
 * Every request body reaching this facade is already decoded by the owner's published payload
 * schemas, so the service validates only what Better Auth sends back.
 */
export interface CommercePortalAuthMfaServiceApi {
  readonly disableTwoFactor: (
    input: CommercePortalAuthMfaDisableProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaStatusResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly enableTwoFactor: (
    input: CommercePortalAuthMfaEnableProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaEnableResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly generateBackupCodes: (
    input: CommercePortalAuthMfaPasswordProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaBackupCodesResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly getTOTPURI: (
    input: CommercePortalAuthMfaPasswordProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaTotpUriResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly sendTwoFactorOTP: (
    input: CommercePortalAuthMfaSendOtpProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaStatusResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyBackupCode: (
    input: CommercePortalAuthMfaVerifyBackupCodeProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyTOTP: (
    input: CommercePortalAuthMfaVerifyTotpProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyTwoFactorOTP: (
    input: CommercePortalAuthMfaVerifyOtpProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
}

export class CommercePortalAuthMfaService extends Context.Service<
  CommercePortalAuthMfaService,
  CommercePortalAuthMfaServiceApi
>()('@app/commerce-customer-context/api/portal-auth/provider/mfa/service/CommercePortalAuthMfaService') {}

const withCause = <ErrorValue extends object>(error: ErrorValue, cause: unknown): ErrorValue =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

interface CommercePortalAuthMfaMalformedResponseCause {
  readonly kind: 'malformed-response';
}

const malformedResponseCause = <ErrorValue>(_cause: ErrorValue): CommercePortalAuthMfaMalformedResponseCause => ({
  kind: 'malformed-response',
});

export const commercePortalAuthMfaProviderUnavailable = (
  operation: string,
  cause: unknown,
  setCookieHeaders: readonly string[] = [],
): CommercePortalAuthMfaProviderUnavailable =>
  withCause(
    new CommercePortalAuthMfaProviderUnavailable({
      operation,
      reason: 'Commerce portal MFA provider operation failed',
      setCookieHeaders,
    }),
    cause,
  );

const callProvider = <SchemaValue extends Schema.Constraint>(
  operation: string,
  call: Effect.Effect<
    CommercePortalAuthMfaResponse<SchemaValue['Type']>,
    CommercePortalAuthMfaProviderFailure,
    SchemaValue['DecodingServices']
  >,
  schema: SchemaValue,
): Effect.Effect<
  CommercePortalAuthMfaResponse<SchemaValue['Type']>,
  CommercePortalAuthMfaProviderFailure,
  SchemaValue['DecodingServices']
> =>
  call.pipe(
    Effect.flatMap((result) =>
      Schema.decodeEffect(schema)(result.body).pipe(
        Effect.map((body) => ({ body, setCookieHeaders: result.setCookieHeaders })),
        Effect.mapError((cause) =>
          commercePortalAuthMfaProviderUnavailable(operation, malformedResponseCause(cause), result.setCookieHeaders),
        ),
      ),
    ),
  );

/**
 * A second-factor verification is an authentication decision in its own right, so each verify call
 * leaves one row naming the method that was attempted and whether it succeeded. The code, the OTP,
 * the backup code and the TOTP seed are never part of the event.
 */
const auditedVerification = Effect.fn('CommercePortalAuthMfaService.auditedVerification')(
  function* auditedVerificationEffect<ResultValue>(
    recorder: CommercePortalAuthAuditRecorder,
    method: string,
    call: Effect.Effect<CommercePortalAuthMfaResponse<ResultValue>, CommercePortalAuthMfaProviderFailure>,
  ): Effect.fn.Return<CommercePortalAuthMfaResponse<ResultValue>, CommercePortalAuthMfaProviderFailure> {
    const outcome = yield* Effect.result(call);
    yield* recordCommercePortalAuthAudit(recorder, {
      eventType: 'commerce.portal-auth.mfa-verified.v1',
      occurredAt: yield* DateTime.nowAsDate,
      operation: method,
      outcome: Result.isSuccess(outcome) ? 'success' : 'authentication_failed',
    });
    if (Result.isFailure(outcome)) {
      return yield* outcome.failure;
    }
    return outcome.success;
  },
);

export const makeCommercePortalAuthMfaService = Effect.fn('CommercePortalAuthMfaService.make')(
  function* makeCommercePortalAuthMfaServiceEffect(
    audit: CommercePortalAuthAuditRecorder = unauditedCommercePortalAuthRecorder,
  ) {
    const provider = yield* CommercePortalAuthMfaProviderService;
    const enableTwoFactor = (input: CommercePortalAuthMfaEnableProviderRequest) =>
      callProvider('enableTwoFactor', provider.enableTwoFactor(input), CommercePortalAuthMfaEnableResultSchema);

    const disableTwoFactor = (input: CommercePortalAuthMfaDisableProviderRequest) =>
      callProvider('disableTwoFactor', provider.disableTwoFactor(input), CommercePortalAuthMfaStatusResultSchema);

    const sendTwoFactorOTP = (input: CommercePortalAuthMfaSendOtpProviderRequest) =>
      callProvider('sendTwoFactorOTP', provider.sendTwoFactorOTP(input), CommercePortalAuthMfaStatusResultSchema);

    const verifyTOTP = (input: CommercePortalAuthMfaVerifyTotpProviderRequest) =>
      auditedVerification(
        audit,
        'verify-totp',
        callProvider('verifyTOTP', provider.verifyTOTP(input), CommercePortalAuthMfaVerificationResultSchema),
      );

    const verifyTwoFactorOTP = (input: CommercePortalAuthMfaVerifyOtpProviderRequest) =>
      auditedVerification(
        audit,
        'verify-otp',
        callProvider(
          'verifyTwoFactorOTP',
          provider.verifyTwoFactorOTP(input),
          CommercePortalAuthMfaVerificationResultSchema,
        ),
      );

    const verifyBackupCode = (input: CommercePortalAuthMfaVerifyBackupCodeProviderRequest) =>
      auditedVerification(
        audit,
        'verify-backup-code',
        callProvider(
          'verifyBackupCode',
          provider.verifyBackupCode(input),
          CommercePortalAuthMfaVerificationResultSchema,
        ),
      );

    const getTOTPURI = (input: CommercePortalAuthMfaPasswordProviderRequest) =>
      callProvider('getTOTPURI', provider.getTOTPURI(input), CommercePortalAuthMfaTotpUriResultSchema);

    const generateBackupCodes = (input: CommercePortalAuthMfaPasswordProviderRequest) =>
      callProvider(
        'generateBackupCodes',
        provider.generateBackupCodes(input),
        CommercePortalAuthMfaBackupCodesResultSchema,
      );

    return {
      disableTwoFactor,
      enableTwoFactor,
      generateBackupCodes,
      getTOTPURI,
      sendTwoFactorOTP,
      verifyBackupCode,
      verifyTOTP,
      verifyTwoFactorOTP,
    } satisfies CommercePortalAuthMfaServiceApi;
  },
);

/** The MFA provider port stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthMfaServiceLive = Layer.effect(
  CommercePortalAuthMfaService,
  Effect.gen(function* makeCommercePortalAuthMfaServiceLive() {
    const audit = yield* CommercePortalAuthAudit;
    return yield* makeCommercePortalAuthMfaService(audit);
  }),
);
