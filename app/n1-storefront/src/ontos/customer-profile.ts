import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";

/** Native own-profile value only. It contains neither login identity nor Party/customer references. */
export const CustomerProfileSchema = Schema.Struct({
  contactEmail: Schema.String,
  displayName: Schema.String,
  phone: Schema.String,
  version: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u)),
});
export type CustomerProfile = typeof CustomerProfileSchema.Type;
export const CustomerProfileUpdateSchema = Schema.Struct({
  ...CustomerProfileSchema.fields,
  contactEmail: Schema.Trim.check(
    Schema.isMaxLength(320),
    Schema.isPattern(/^(?:|[^\s@]+@[^\s@]+\.[^\s@]+)$/u),
  ),
  displayName: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  phone: Schema.Trim.check(Schema.isPattern(/^(?:|\+?[()\d .-]{3,100})$/u)),
});
export type CustomerProfileUpdate = typeof CustomerProfileUpdateSchema.Type;
export const CustomerProfileReadySchema = Schema.Struct({
  profile: CustomerProfileSchema,
  state: Schema.Literal("ready"),
});
export const CustomerProfileReadSchema = Schema.Union([
  CustomerProfileReadySchema,
  Schema.Struct({ state: Schema.Literal("anonymous") }),
]);
export type CustomerProfileRead = typeof CustomerProfileReadSchema.Type;
export type CustomerProfilePageState =
  | { profile: CustomerProfile; state: "ready"; viewerEmail: string }
  | { state: "anonymous" | "forbidden" | "unavailable" };

export const CustomerProfileInvalidProblem = makeProblemDetailsSchema(
  "CustomerProfileInvalidProblem",
  400,
  {
    state: Schema.Literal("invalid"),
  },
);
export const CustomerProfileAuthenticationProblem = makeProblemDetailsSchema(
  "CustomerProfileAuthenticationProblem",
  401,
  {
    state: Schema.Literal("anonymous"),
  },
);
export const CustomerProfileForbiddenProblem = makeProblemDetailsSchema(
  "CustomerProfileForbiddenProblem",
  403,
  {
    state: Schema.Literal("forbidden"),
  },
);
export const CustomerProfileConflictProblem = makeProblemDetailsSchema(
  "CustomerProfileConflictProblem",
  409,
  {
    state: Schema.Literal("conflict"),
  },
);
export const CustomerProfileUnavailableProblem = makeProblemDetailsSchema(
  "CustomerProfileUnavailableProblem",
  503,
  {
    state: Schema.Literal("unavailable"),
  },
);
export const CustomerProfileUnconfirmedProblem = makeProblemDetailsSchema(
  "CustomerProfileUnconfirmedProblem",
  503,
  {
    state: Schema.Literal("unconfirmed"),
  },
);
const problems = [
  CustomerProfileInvalidProblem,
  CustomerProfileAuthenticationProblem,
  CustomerProfileForbiddenProblem,
  CustomerProfileConflictProblem,
  CustomerProfileUnavailableProblem,
  CustomerProfileUnconfirmedProblem,
];
export class CustomerProfileSchemaErrorMiddleware extends HttpApiMiddleware.Service<CustomerProfileSchemaErrorMiddleware>()(
  "n1/CustomerProfileSchemaErrorMiddleware",
  { error: CustomerProfileInvalidProblem },
) {}
export const CustomerProfileApi = HttpApi.make("N1CustomerProfile")
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .add(
    HttpApiGroup.make("customerProfile")
      .add(
        HttpApiEndpoint.get("read", "/api/customer-profile", {
          error: problems,
          success: CustomerProfileReadSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post("update", "/api/customer-profile", {
          error: problems,
          payload: CustomerProfileUpdateSchema,
          success: CustomerProfileReadySchema,
        }),
      )
      .middleware(CustomerProfileSchemaErrorMiddleware),
  );
