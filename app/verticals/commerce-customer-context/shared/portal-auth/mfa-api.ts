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
/**
 * The public boundary bounds `password` loosely only (never Redacted at rest here: it crosses the
 * wire as a plain string exactly like `session-api.ts`'s sign-in password). The owner's stricter,
 * policy-bound schema in `provider/mfa/contracts.ts` re-decodes it inside the handler before any
 * Better Auth call, so a caller-supplied length outside policy still surfaces as `invalid_request`
 * rather than a provider-level rejection.
 */
const MfaPasswordFieldSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const MfaIssuerFieldSchema = Schema.optionalKey(
  Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
);
const MfaMethodFieldSchema = Schema.optionalKey(Schema.Literals(['otp', 'totp']));

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

/**
 * Administrative bodies. `enable`/`disable`/`regenerate-backup-codes`/`totp-uri` all reverify the
 * caller's password; `confirm-enable` carries only the first TOTP code, matching Better Auth's own
 * `verifyTOTP` payload for its non-sign-in (activation) branch.
 *
 * Module-private: only this file's own `HttpApiEndpoint` payloads reference these directly. Every
 * other consumer (`provider/mfa/http.ts`, `provider/mfa/contracts.ts`) imports the exported
 * `CommercePortalAuthMfa*Body` *types* below instead, which `typeof ...Schema.Type` can still derive
 * from an unexported const in the same module.
 */
const CommercePortalAuthMfaEnableBodySchema = Schema.Struct({
  issuer: MfaIssuerFieldSchema,
  method: MfaMethodFieldSchema,
  password: MfaPasswordFieldSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const CommercePortalAuthMfaConfirmEnableBodySchema = Schema.Struct({
  code: VerificationCodeSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const CommercePortalAuthMfaDisableBodySchema = Schema.Struct({
  password: MfaPasswordFieldSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/** Shared by `regenerate-backup-codes` and `totp-uri`: both reverify the password alone. */
const CommercePortalAuthMfaPasswordBodySchema = Schema.Struct({
  password: MfaPasswordFieldSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthMfaSendOtpBody = typeof CommercePortalAuthMfaSendOtpBodySchema.Type;
export type CommercePortalAuthMfaVerifyTotpBody = typeof CommercePortalAuthMfaVerifyTotpBodySchema.Type;
export type CommercePortalAuthMfaVerifyOtpBody = typeof CommercePortalAuthMfaVerifyOtpBodySchema.Type;
export type CommercePortalAuthMfaVerifyBackupCodeBody = typeof CommercePortalAuthMfaVerifyBackupCodeBodySchema.Type;
export type CommercePortalAuthMfaConfirmEnableBody = typeof CommercePortalAuthMfaConfirmEnableBodySchema.Type;

export const CommercePortalAuthMfaStatusResultSchema = Schema.Struct({
  status: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/** A successful verification changes provider session state; the provider token never crosses this seam. */
export const CommercePortalAuthMfaVerificationResultSchema = Schema.Struct({
  status: Schema.Literal(true),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthMfaStatusResult = typeof CommercePortalAuthMfaStatusResultSchema.Type;
export type CommercePortalAuthMfaVerificationResult = typeof CommercePortalAuthMfaVerificationResultSchema.Type;

/**
 * Enrollment results. TOTP enrollment returns the backup codes and the `otpauth://` URI once, at
 * activation; neither value is ever logged (see `provider/mfa/http.ts`) or repeated by any other
 * response on this surface.
 */
export const CommercePortalAuthMfaEnableResultSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal('otp') }),
  Schema.Struct({
    backupCodes: Schema.Array(Schema.String),
    method: Schema.Literal('totp'),
    totpURI: Schema.String,
  }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const CommercePortalAuthMfaBackupCodesResultSchema = Schema.Struct({
  backupCodes: Schema.Array(Schema.String),
  status: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const CommercePortalAuthMfaTotpUriResultSchema = Schema.Struct({
  totpURI: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthMfaEnableResult = typeof CommercePortalAuthMfaEnableResultSchema.Type;
export type CommercePortalAuthMfaBackupCodesResult = typeof CommercePortalAuthMfaBackupCodesResultSchema.Type;
export type CommercePortalAuthMfaTotpUriResult = typeof CommercePortalAuthMfaTotpUriResultSchema.Type;

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
    code: Schema.Literals(['mfa_authentication_not_fresh', 'mfa_challenge_expired', 'mfa_rejected']),
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
  .add(
    HttpApiEndpoint.post('enable', '/api/portal-auth/two-factor/enable', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaEnableBodySchema,
      success: CommercePortalAuthMfaEnableResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('confirmEnable', '/api/portal-auth/two-factor/confirm-enable', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaConfirmEnableBodySchema,
      success: CommercePortalAuthMfaVerificationResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('disable', '/api/portal-auth/two-factor/disable', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaDisableBodySchema,
      success: CommercePortalAuthMfaStatusResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('regenerateBackupCodes', '/api/portal-auth/two-factor/regenerate-backup-codes', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaPasswordBodySchema,
      success: CommercePortalAuthMfaBackupCodesResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('totpUri', '/api/portal-auth/two-factor/totp-uri', {
      error: mfaErrors,
      payload: CommercePortalAuthMfaPasswordBodySchema,
      success: CommercePortalAuthMfaTotpUriResultSchema,
    }),
  )
  .middleware(CommercePortalAuthMfaSchemaErrorMiddleware);

export type CommercePortalAuthMfaGroupContract = HttpApiGroup.HttpApiGroup<
  'portalAuthMfa',
  HttpApiGroup.Endpoints<typeof commercePortalAuthMfaGroupDefinition>
>;

const CommercePortalAuthMfaGroup: CommercePortalAuthMfaGroupContract = commercePortalAuthMfaGroupDefinition;

export const CommercePortalAuthMfaApi = HttpApi.make('CommercePortalAuthMfaApi').add(CommercePortalAuthMfaGroup);
