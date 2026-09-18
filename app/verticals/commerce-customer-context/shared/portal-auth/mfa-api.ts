import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { HttpApiMiddleware } from 'effect/unstable/httpapi';

/**
 * Commerce never mints a trusted-device cookie. The field stays on the wire so an explicit `false`
 * is accepted, and the group answers `true` with the dedicated `trust_device_not_allowed` problem
 * rather than a generic decoding failure.
 */
const TrustDeviceSchema = Schema.optionalKey(Schema.Boolean);
const VerificationCodeSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(32));
const BackupCodeSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128));

/** Request payloads are closed at the public boundary; excess fields are a decoding failure. */
const CommercePortalAuthMfaSendOtpBodySchema = Schema.Struct({
  trustDevice: TrustDeviceSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const CommercePortalAuthMfaVerifyTotpBodySchema = Schema.Struct({
  code: VerificationCodeSchema,
  trustDevice: TrustDeviceSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const CommercePortalAuthMfaVerifyOtpBodySchema = Schema.Struct({
  code: VerificationCodeSchema,
  trustDevice: TrustDeviceSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/**
 * `disableSession` is deliberately not published. Better Auth consumes the backup code *before* it
 * branches on that flag, and its `disableSession` branch answers with a body that carries no session
 * token on the two-factor sign-in path — a body the owner's provider result cannot decode, which
 * would be reported to the caller as a retryable 503 after the one-time code was already destroyed.
 * The closed payload turns the request into a 400 that costs the caller no recovery credential, and
 * the published verification result (`{ status: true }`) never depended on the flag.
 */
export const CommercePortalAuthMfaVerifyBackupCodeBodySchema = Schema.Struct({
  code: BackupCodeSchema,
  trustDevice: TrustDeviceSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthMfaSendOtpBody = typeof CommercePortalAuthMfaSendOtpBodySchema.Type;
export type CommercePortalAuthMfaVerifyTotpBody = typeof CommercePortalAuthMfaVerifyTotpBodySchema.Type;
export type CommercePortalAuthMfaVerifyOtpBody = typeof CommercePortalAuthMfaVerifyOtpBodySchema.Type;
export type CommercePortalAuthMfaVerifyBackupCodeBody = typeof CommercePortalAuthMfaVerifyBackupCodeBodySchema.Type;

export const CommercePortalAuthMfaStatusResultSchema = Schema.Struct({
  status: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/** A successful verification changes provider session state; the provider token never crosses this seam. */
export const CommercePortalAuthMfaVerificationResultSchema = Schema.Struct({
  status: Schema.Literal(true),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthMfaStatusResult = typeof CommercePortalAuthMfaStatusResultSchema.Type;
export type CommercePortalAuthMfaVerificationResult = typeof CommercePortalAuthMfaVerificationResultSchema.Type;

export const CommercePortalAuthMfaInvalidProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthMfaInvalidProblem',
  400,
  {
    code: Schema.Literals(['invalid_request', 'trust_device_not_allowed']),
  },
);
export const CommercePortalAuthMfaAuthenticationProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthMfaAuthenticationProblem',
  401,
  {
    code: Schema.Literals(['mfa_challenge_expired', 'mfa_rejected']),
  },
);
export const CommercePortalAuthMfaForbiddenProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthMfaForbiddenProblem',
  403,
  {
    code: Schema.Literal('origin_not_trusted'),
  },
);
/** The provider throttle code is reported verbatim so a client can distinguish lockout from retry. */
export const CommercePortalAuthMfaRateLimitedProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthMfaRateLimitedProblem',
  429,
  {
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  },
);
export const CommercePortalAuthMfaUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CommercePortalAuthMfaUnavailableProblem',
  503,
  {
    code: Schema.Literal('authentication_unavailable'),
  },
);

export type CommercePortalAuthMfaProblem =
  | typeof CommercePortalAuthMfaInvalidProblemSchema.Type
  | typeof CommercePortalAuthMfaAuthenticationProblemSchema.Type
  | typeof CommercePortalAuthMfaForbiddenProblemSchema.Type
  | typeof CommercePortalAuthMfaRateLimitedProblemSchema.Type
  | typeof CommercePortalAuthMfaUnavailableProblemSchema.Type;

export class CommercePortalAuthMfaSchemaErrorMiddleware extends HttpApiMiddleware.Service<CommercePortalAuthMfaSchemaErrorMiddleware>()(
  'commerce-customer-context/CommercePortalAuthMfaSchemaErrorMiddleware',
  { error: CommercePortalAuthMfaInvalidProblemSchema },
) {}

const mfaErrors = [
  CommercePortalAuthMfaInvalidProblemSchema,
  CommercePortalAuthMfaAuthenticationProblemSchema,
  CommercePortalAuthMfaForbiddenProblemSchema,
  CommercePortalAuthMfaRateLimitedProblemSchema,
  CommercePortalAuthMfaUnavailableProblemSchema,
] as const;

/**
 * The endpoint chain stays a `const`. The MicroVertical API boundary checker walks a root API's
 * operands through const bindings only, so a class declaration hides the composed endpoints from
 * it. The exported group is annotated with a named type alias so its type still has a name: `shared/api.ts`
 * merges roughly a hundred group types into one `HttpApi` and declaration emit serializes that
 * union verbatim, so an anonymous group type pushes the composed contract past the compiler's
 * serialization limit (TS7056).
 *
 * The same checker reads declared routes syntactically, so each path is written as a literal
 * rather than composed from `COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH` (`/api/portal-auth`).
 */
const commercePortalAuthMfaGroupDefinition = HttpApiGroup.make('portalAuthMfa')
  .add(
    HttpApiEndpoint.post('sendOtp', '/api/portal-auth/two-factor/send-otp', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaSendOtpBodySchema,
      success: CommercePortalAuthMfaStatusResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('verifyTotp', '/api/portal-auth/two-factor/verify-totp', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaVerifyTotpBodySchema,
      success: CommercePortalAuthMfaVerificationResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('verifyOtp', '/api/portal-auth/two-factor/verify-otp', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaVerifyOtpBodySchema,
      success: CommercePortalAuthMfaVerificationResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('verifyBackupCode', '/api/portal-auth/two-factor/verify-backup-code', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaVerifyBackupCodeBodySchema,
      success: CommercePortalAuthMfaVerificationResultSchema,
    }),
  )
  .middleware(CommercePortalAuthMfaSchemaErrorMiddleware);

export type CommercePortalAuthMfaGroupContract = HttpApiGroup.HttpApiGroup<
  'portalAuthMfa',
  HttpApiGroup.Endpoints<typeof commercePortalAuthMfaGroupDefinition>
>;

const CommercePortalAuthMfaGroup: CommercePortalAuthMfaGroupContract = commercePortalAuthMfaGroupDefinition;

export const CommercePortalAuthMfaApi = HttpApi.make('CommercePortalAuthMfaApi').add(CommercePortalAuthMfaGroup);
