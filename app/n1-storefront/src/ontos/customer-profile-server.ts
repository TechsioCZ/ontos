import "server-only";
import { Effect, Match, Schema } from "effect";
import type { StorefrontConfiguration } from "./config";
import { readConfiguration } from "./config";
import {
  readPortalOwnProfile,
  updatePortalOwnProfile,
  readPortalIdentityWithConfiguration,
} from "./portal-server";
import type { PortalRequestContext } from "./portal-server";
import { CustomerProfileSchema, CustomerProfileUpdateSchema } from "./customer-profile";
import type {
  CustomerProfilePageState,
  CustomerProfileRead,
  CustomerProfileUpdate,
} from "./customer-profile";
import { storefrontRuntime } from "./runtime";

export class CustomerProfileFailure extends Schema.TaggedError<CustomerProfileFailure>()(
  "CustomerProfileFailure",
  {
    state: Schema.Literals([
      "invalid",
      "anonymous",
      "forbidden",
      "conflict",
      "unavailable",
      "unconfirmed",
    ]),
  },
) {}
const configuration = () =>
  readConfiguration(process.env).pipe(
    Effect.mapError(() => new CustomerProfileFailure({ state: "unavailable" })),
  );
const admission = (config: StorefrontConfiguration, request: PortalRequestContext) =>
  readPortalIdentityWithConfiguration(config, request).pipe(
    Effect.mapError((problem) =>
      Match.value(problem).pipe(
        Match.tag(
          "CommercePortalAuthSessionForbiddenProblem",
          () => new CustomerProfileFailure({ state: "forbidden" }),
        ),
        Match.tag(
          "PortalFailure",
          (portalFailure) =>
            new CustomerProfileFailure({
              state: portalFailure.reason === "refused" ? "forbidden" : "unavailable",
            }),
        ),
        Match.orElse(() => new CustomerProfileFailure({ state: "unavailable" })),
      ),
    ),
  );

export const readCustomerProfileWithConfiguration = (
  config: StorefrontConfiguration,
  request: PortalRequestContext,
) =>
  Effect.gen(function* readCustomerProfileProgram() {
    const identity = yield* admission(config, request);
    if (identity.state === "anonymous") {
      return { state: "anonymous" as const };
    }
    const native = yield* readPortalOwnProfile(config, request).pipe(
      Effect.catch((error) =>
        Match.value(error).pipe(
          Match.tag("CustomerOwnProfileAuthenticationProblem", () =>
            Effect.fail(new CustomerProfileFailure({ state: "anonymous" })),
          ),
          Match.tag("CustomerOwnProfileForbiddenProblem", () =>
            Effect.fail(new CustomerProfileFailure({ state: "forbidden" })),
          ),
          Match.orElse(() => Effect.fail(new CustomerProfileFailure({ state: "unavailable" }))),
        ),
      ),
    );
    const profile = yield* Schema.decodeUnknownEffect(CustomerProfileSchema)(native).pipe(
      Effect.mapError(() => new CustomerProfileFailure({ state: "unavailable" })),
    );
    return { profile, state: "ready" as const, viewerEmail: identity.account.email };
  });

export const readCustomerProfile = (request: PortalRequestContext) =>
  configuration().pipe(
    Effect.flatMap((config) => readCustomerProfileWithConfiguration(config, request)),
    Effect.map((result): CustomerProfileRead =>
      result.state === "ready"
        ? { profile: result.profile, state: "ready" }
        : { state: "anonymous" },
    ),
  );

export const updateCustomerProfileWithConfiguration = (
  config: StorefrontConfiguration,
  input: CustomerProfileUpdate,
  request: PortalRequestContext,
) =>
  Effect.gen(function* updateCustomerProfileProgram() {
    const payload = yield* Schema.decodeUnknownEffect(CustomerProfileUpdateSchema, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => new CustomerProfileFailure({ state: "invalid" })));
    const identity = yield* admission(config, request);
    if (identity.state === "anonymous") {
      return yield* new CustomerProfileFailure({ state: "anonymous" });
    }
    // Admission consumed its assertion. The profile update always acquires a new one.
    const native = yield* updatePortalOwnProfile(config, payload, request).pipe(
      Effect.catch((error) =>
        Match.value(error).pipe(
          Match.tag("PortalFailure", () =>
            Effect.fail(new CustomerProfileFailure({ state: "unavailable" })),
          ),
          Match.tag("CustomerOwnProfileAuthenticationProblem", () =>
            Effect.fail(new CustomerProfileFailure({ state: "anonymous" })),
          ),
          Match.tag("CustomerOwnProfileForbiddenProblem", () =>
            Effect.fail(new CustomerProfileFailure({ state: "forbidden" })),
          ),
          Match.tag("CustomerOwnProfileInvalidProblem", () =>
            Effect.fail(new CustomerProfileFailure({ state: "invalid" })),
          ),
          Match.tag("CustomerOwnProfileConflictProblem", () =>
            Effect.fail(new CustomerProfileFailure({ state: "conflict" })),
          ),
          // A failed transport, unavailable owner or malformed reply may follow a committed update.
          Match.orElse(() => Effect.fail(new CustomerProfileFailure({ state: "unconfirmed" }))),
        ),
      ),
    );
    const profile = yield* Schema.decodeUnknownEffect(CustomerProfileSchema)(native).pipe(
      Effect.mapError(() => new CustomerProfileFailure({ state: "unconfirmed" })),
    );
    return { profile, state: "ready" as const };
  });
export const updateCustomerProfile = (
  input: CustomerProfileUpdate,
  request: PortalRequestContext,
) =>
  configuration().pipe(
    Effect.flatMap((config) => updateCustomerProfileWithConfiguration(config, input, request)),
  );

/** Safe SSR projection. A fresh read reconciles an unconfirmed update without replaying it. */
export const getCustomerProfile = async (
  request: PortalRequestContext,
): Promise<CustomerProfilePageState> =>
  await storefrontRuntime.runPromise(
    configuration().pipe(
      Effect.flatMap((config) => readCustomerProfileWithConfiguration(config, request)),
      Effect.match({
        onFailure: (error) =>
          Match.value(error.state).pipe(
            Match.when("anonymous", () => ({ state: "anonymous" as const })),
            Match.when("forbidden", () => ({ state: "forbidden" as const })),
            Match.orElse(() => ({ state: "unavailable" as const })),
          ),
        onSuccess: (value) => value,
      }),
    ),
  );
