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
export const PortalEnrollmentPhaseSchema = Schema.Literals([
  "IN_PROGRESS",
  "VERIFICATION_REQUIRED",
  "COMPLETE",
  "RECONCILIATION_REQUIRED",
  "TERMINATED",
  "FAILED",
]);
export type PortalEnrollmentPhase = typeof PortalEnrollmentPhaseSchema.Type;
export const PortalOutcomeSchema = Schema.Union([
  Schema.Struct({ email: Schema.String, name: Schema.String, state: Schema.Literal("admitted") }),
  Schema.Struct({
    phase: PortalEnrollmentPhaseSchema,
    state: Schema.Literal("registration-progress"),
  }),
  Schema.Struct({
    methods: Schema.Array(Schema.Literals(["otp", "totp"])),
    state: Schema.Literal("mfa"),
  }),
  Schema.Struct({
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    state: Schema.Literal("rate-limited"),
  }),
  Schema.Struct({
    state: Schema.Literals([
      "invalid",
      "credentials",
      "refused",
      "unavailable",
      "unconfirmed",
      "verification-required",
      "anonymous",
      "email-verified",
    ]),
  }),
]);
export type PortalOutcome = typeof PortalOutcomeSchema.Type;
export const PortalInvalidProblem = makeProblemDetailsSchema("PortalInvalidProblem", 400, {
  state: Schema.Literal("invalid"),
});
export const PortalCredentialsProblem = makeProblemDetailsSchema("PortalCredentialsProblem", 401, {
  state: Schema.Literal("credentials"),
});
export const PortalRefusedProblem = makeProblemDetailsSchema("PortalRefusedProblem", 403, {
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
export const portalProblems = [
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
