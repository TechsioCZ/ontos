import { Context, Effect, Layer, Schema } from 'effect';

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

export const makeCommercePortalAuthMfaService = Effect.fn('CommercePortalAuthMfaService.make')(
  function* makeCommercePortalAuthMfaServiceEffect() {
    const provider = yield* CommercePortalAuthMfaProviderService;
    const enableTwoFactor = (input: CommercePortalAuthMfaEnableProviderRequest) =>
      callProvider('enableTwoFactor', provider.enableTwoFactor(input), CommercePortalAuthMfaEnableResultSchema);

    const disableTwoFactor = (input: CommercePortalAuthMfaDisableProviderRequest) =>
      callProvider('disableTwoFactor', provider.disableTwoFactor(input), CommercePortalAuthMfaStatusResultSchema);

    const sendTwoFactorOTP = (input: CommercePortalAuthMfaSendOtpProviderRequest) =>
      callProvider('sendTwoFactorOTP', provider.sendTwoFactorOTP(input), CommercePortalAuthMfaStatusResultSchema);

    const verifyTOTP = (input: CommercePortalAuthMfaVerifyTotpProviderRequest) =>
      callProvider('verifyTOTP', provider.verifyTOTP(input), CommercePortalAuthMfaVerificationResultSchema);

    const verifyTwoFactorOTP = (input: CommercePortalAuthMfaVerifyOtpProviderRequest) =>
      callProvider(
        'verifyTwoFactorOTP',
        provider.verifyTwoFactorOTP(input),
        CommercePortalAuthMfaVerificationResultSchema,
      );

    const verifyBackupCode = (input: CommercePortalAuthMfaVerifyBackupCodeProviderRequest) =>
      callProvider('verifyBackupCode', provider.verifyBackupCode(input), CommercePortalAuthMfaVerificationResultSchema);

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
  makeCommercePortalAuthMfaService(),
);
