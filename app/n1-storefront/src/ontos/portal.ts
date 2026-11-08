import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";

const email = Schema.Trim.check(
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
);
const password = Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128));
export const PortalVerificationNoticeSchema = Schema.Literals([
  "verified",
  "reconciliation",
  "invalid",
  "unconfirmed",
]);
export const PortalVerificationQuerySchema = Schema.Struct({
  callbackURL: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export const PortalLoginSchema = Schema.Struct({
  email,
  password,
  rememberMe: Schema.Boolean,
});
export const PortalRegistrationSchema = Schema.Struct({
  email,
  firstName: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  lastName: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(99)),
  password,
  passwordConfirmation: password,
  requestId: Schema.String.check(Schema.isUUID()),
  termsAccepted: Schema.Literal(true),
}).check(Schema.makeFilter((input) => input.password === input.passwordConfirmation));
export type PortalLogin = typeof PortalLoginSchema.Type;
export type PortalRegistration = typeof PortalRegistrationSchema.Type;
export const PortalMfaMethodSchema = Schema.Literals(["totp", "otp"]);
export const PortalMfaVerifySchema = Schema.Struct({
  code: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(32)),
  method: PortalMfaMethodSchema,
});
export type PortalMfaVerify = typeof PortalMfaVerifySchema.Type;
const PortalMfaErrorReasonSchema = Schema.Literals([
  "invalid",
  "rejected",
  "expired",
  "authentication-required",
  "throttled",
  "refused",
  "unavailable",
  "unconfirmed",
]);
export type PortalMfaErrorReason = typeof PortalMfaErrorReasonSchema.Type;
const PortalEnrollmentPhaseSchema = Schema.Literals([
  "IN_PROGRESS",
  "VERIFICATION_REQUIRED",
  "COMPLETE",
  "RECONCILIATION_REQUIRED",
  "TERMINATED",
  "FAILED",
]);
export type PortalEnrollmentPhase = typeof PortalEnrollmentPhaseSchema.Type;
export const PortalRefusalDiagnosticSchema = Schema.Literals([
  "bff-origin-refused",
  "gateway-context-forbidden",
  "owner-origin-not-trusted",
  "owner-enrollment-rejected",
  "owner-journey-unavailable",
]);
export const PortalOutcomeSchema = Schema.Union([
  Schema.Struct({ email: Schema.String, name: Schema.String, state: Schema.Literal("admitted") }),
  Schema.Struct({
    phase: PortalEnrollmentPhaseSchema,
    state: Schema.Literal("registration-progress"),
  }),
  Schema.Struct({
    feedback: Schema.optionalKey(
      Schema.Literals(["otp-sent", "invalid", "rejected", "throttled", "unavailable"]),
    ),
    methods: Schema.Array(PortalMfaMethodSchema),
    state: Schema.Literal("mfa"),
  }),
  Schema.Struct({
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    state: Schema.Literal("rate-limited"),
  }),
  Schema.Struct({
    diagnostic: Schema.optionalKey(PortalRefusalDiagnosticSchema),
    state: Schema.Literal("refused"),
  }),
  Schema.Struct({
    state: Schema.Literals([
      "invalid",
      "credentials",
      "unavailable",
      "unconfirmed",
      "verification-required",
      "anonymous",
      "email-verified",
      "mfa-expired",
      "mfa-authentication-required",
    ]),
  }),
]);
export type PortalOutcome = typeof PortalOutcomeSchema.Type;
export const PortalMfaResultSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("otp-sent") }),
  Schema.Struct({ outcome: PortalOutcomeSchema, state: Schema.Literal("complete") }),
  Schema.Struct({ reason: PortalMfaErrorReasonSchema, state: Schema.Literal("mfa-error") }),
]);
export type PortalMfaResult = typeof PortalMfaResultSchema.Type;
export const PortalMfaInvalidProblem = makeProblemDetailsSchema("PortalMfaInvalidProblem", 400, {
  reason: Schema.Literal("invalid"),
  state: Schema.Literal("mfa-error"),
});
export const PortalMfaAuthenticationProblem = makeProblemDetailsSchema(
  "PortalMfaAuthenticationProblem",
  401,
  {
    reason: Schema.Literals(["rejected", "expired", "authentication-required"]),
    state: Schema.Literal("mfa-error"),
  },
);
export const PortalMfaRateLimitedProblem = makeProblemDetailsSchema(
  "PortalMfaRateLimitedProblem",
  429,
  {
    reason: Schema.Literal("throttled"),
    state: Schema.Literal("mfa-error"),
  },
);
export const PortalMfaRefusedProblem = makeProblemDetailsSchema("PortalMfaRefusedProblem", 403, {
  reason: Schema.Literal("refused"),
  state: Schema.Literal("mfa-error"),
});
export const PortalMfaUnavailableProblem = makeProblemDetailsSchema(
  "PortalMfaUnavailableProblem",
  503,
  {
    reason: Schema.Literals(["unavailable", "unconfirmed"]),
    state: Schema.Literal("mfa-error"),
  },
);
export const PortalInvalidProblem = makeProblemDetailsSchema("PortalInvalidProblem", 400, {
  state: Schema.Literal("invalid"),
});
export const PortalCredentialsProblem = makeProblemDetailsSchema("PortalCredentialsProblem", 401, {
  state: Schema.Literal("credentials"),
});
export const PortalRefusedProblem = makeProblemDetailsSchema("PortalRefusedProblem", 403, {
  diagnostic: Schema.optionalKey(PortalRefusalDiagnosticSchema),
  state: Schema.Literal("refused"),
});
export const PortalRateLimitedProblem = makeProblemDetailsSchema("PortalRateLimitedProblem", 429, {
  retryAfterSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Literal("rate-limited"),
});
export const PortalUnavailableProblem = makeProblemDetailsSchema("PortalUnavailableProblem", 503, {
  state: Schema.Literal("unavailable"),
});
export const PortalUnconfirmedProblem = makeProblemDetailsSchema("PortalUnconfirmedProblem", 503, {
  state: Schema.Literal("unconfirmed"),
});
const portalProblems = [
  PortalInvalidProblem,
  PortalCredentialsProblem,
  PortalRefusedProblem,
  PortalRateLimitedProblem,
  PortalUnavailableProblem,
  PortalUnconfirmedProblem,
] as const;
export class PortalSchemaErrorMiddleware extends HttpApiMiddleware.Service<PortalSchemaErrorMiddleware>()(
  "n1/PortalSchemaErrorMiddleware",
  { error: PortalInvalidProblem },
) {}
const mfaProblems = [
  PortalInvalidProblem,
  PortalRefusedProblem,
  PortalMfaInvalidProblem,
  PortalMfaAuthenticationProblem,
  PortalMfaRateLimitedProblem,
  PortalMfaRefusedProblem,
  PortalMfaUnavailableProblem,
] as const;
const empty = Schema.Record(Schema.String, Schema.Never);
export const PortalApi = HttpApi.make("N1Portal")
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .add(
    HttpApiGroup.make("portal")
      .add(
        HttpApiEndpoint.get(
          "verifyEmail",
          "/commerce-customer-context-api/api/portal-auth/verify-email",
          {
            query: PortalVerificationQuerySchema,
            success: Schema.Void,
          },
        ),
      )
      .add(
        HttpApiEndpoint.post("login", "/api/account/login", {
          error: portalProblems,
          payload: PortalLoginSchema,
          success: PortalOutcomeSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("requestMfaOtp", "/api/account/mfa/request", {
          error: mfaProblems,
          payload: empty,
          success: PortalMfaResultSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("verifyMfa", "/api/account/mfa/verify", {
          error: mfaProblems,
          payload: PortalMfaVerifySchema,
          success: PortalMfaResultSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("register", "/api/enrollment", {
          error: portalProblems,
          payload: PortalRegistrationSchema,
          success: PortalOutcomeSchema,
        }),
      )
      .add(
        HttpApiEndpoint.get("current", "/api/account", {
          error: portalProblems,
          success: PortalOutcomeSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("logout", "/api/account/logout", {
          error: portalProblems,
          payload: empty,
          success: PortalOutcomeSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("resume", "/api/enrollment/resume", {
          error: portalProblems,
          payload: empty,
          success: PortalOutcomeSchema,
        }),
      )
      .middleware(PortalSchemaErrorMiddleware),
  );

export const decodePortalLogin = Schema.decodeUnknownEffect(PortalLoginSchema, {
  onExcessProperty: "error",
});
export const decodePortalRegistration = Schema.decodeUnknownEffect(PortalRegistrationSchema, {
  onExcessProperty: "error",
});

export const decodePortalMfaVerify = Schema.decodeUnknownEffect(PortalMfaVerifySchema, {
  onExcessProperty: "error",
});
