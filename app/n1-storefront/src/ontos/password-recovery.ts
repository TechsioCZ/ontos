import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";

const password = Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128));
export const PasswordRecoveryRequestSchema = Schema.Struct({
  email: Schema.Trim.check(
    Schema.isMaxLength(320),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  ),
});
export const PasswordRecoveryResetSchema = Schema.Struct({
  newPassword: password,
  passwordConfirmation: password,
}).check(Schema.makeFilter((input) => input.newPassword === input.passwordConfirmation));
export type PasswordRecoveryRequest = typeof PasswordRecoveryRequestSchema.Type;
export type PasswordRecoveryReset = typeof PasswordRecoveryResetSchema.Type;
export const PasswordRecoveryOutcomeSchema = Schema.Struct({
  state: Schema.Literals([
    "requested",
    "completed",
    "reconciliation",
    "invalid",
    "invalid-token",
    "forbidden",
    "rate-limited",
    "unavailable",
    "unconfirmed",
  ]),
});
export type PasswordRecoveryOutcome = typeof PasswordRecoveryOutcomeSchema.Type;
export const PasswordRecoveryInvalidProblem = makeProblemDetailsSchema(
  "PasswordRecoveryInvalidProblem",
  400,
  { state: Schema.Literals(["invalid", "invalid-token"]) },
);
export const PasswordRecoveryForbiddenProblem = makeProblemDetailsSchema(
  "PasswordRecoveryForbiddenProblem",
  403,
  { state: Schema.Literal("forbidden") },
);
export const PasswordRecoveryRateLimitedProblem = makeProblemDetailsSchema(
  "PasswordRecoveryRateLimitedProblem",
  429,
  { state: Schema.Literal("rate-limited") },
);
export const PasswordRecoveryUnavailableProblem = makeProblemDetailsSchema(
  "PasswordRecoveryUnavailableProblem",
  503,
  { state: Schema.Literals(["unavailable", "unconfirmed"]) },
);
export class PasswordRecoverySchemaErrorMiddleware extends HttpApiMiddleware.Service<PasswordRecoverySchemaErrorMiddleware>()(
  "n1/PasswordRecoverySchemaErrorMiddleware",
  { error: PasswordRecoveryInvalidProblem },
) {}
const errors = [
  PasswordRecoveryInvalidProblem,
  PasswordRecoveryForbiddenProblem,
  PasswordRecoveryRateLimitedProblem,
  PasswordRecoveryUnavailableProblem,
];
export const PasswordRecoveryApi = HttpApi.make("N1PasswordRecovery")
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .annotate(HttpApi.ParseOptions, { onExcessProperty: "error" })
  .add(
    HttpApiGroup.make("passwordRecovery")
      .add(
        HttpApiEndpoint.post("request", "/api/account/password/request", {
          error: errors,
          payload: PasswordRecoveryRequestSchema,
          success: PasswordRecoveryOutcomeSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("reset", "/api/account/password/reset", {
          error: errors,
          payload: PasswordRecoveryResetSchema,
          success: PasswordRecoveryOutcomeSchema,
        }),
      )
      .add(
        HttpApiEndpoint.get(
          "callback",
          "/commerce-customer-context-api/api/portal-auth/reset-password/:token",
          {
            error: errors,
            params: Schema.Struct({
              token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
            }),
            query: Schema.Struct({
              callbackURL: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
            }),
            success: PasswordRecoveryOutcomeSchema,
          },
        ),
      )
      .middleware(PasswordRecoverySchemaErrorMiddleware),
  );
