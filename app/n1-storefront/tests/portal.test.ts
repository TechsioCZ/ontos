import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-rstest";
import {
  decodePortalRegistration,
  PortalLoginSchema,
  PortalRegistrationSchema,
} from "../src/ontos/portal";
import type { PortalOutcome } from "../src/ontos/portal";
import {
  decodePortalAdmission,
  enrollmentBody,
  isPortalOrigin,
  loginWithPortalOwner,
  mergePortalCookies,
  portalAdmission,
  portalCookie,
  portalEnrollmentIdempotencyKey,
  portalEnrollmentProgress,
  portalSetCookies,
  PortalFailure,
  registerWithPortalOwner,
  canResumePortalEnrollment,
  verifyEmailWithPortalOwner,
  portalVerificationOutcome,
} from "../src/ontos/portal-model";

const testPassword = "a".repeat(16);
const shortPassword = "a".repeat(8);
const registration = {
  email: "shopper@example.com",
  firstName: "Jane",
  lastName: "Shopper",
  password: testPassword,
  passwordConfirmation: testPassword,
  requestId: "71000000-0000-4000-8000-000000000099",
  termsAccepted: true,
};
describe("email verification and enrollment continuation", () => {
  it("never treats callback notices as session authority", () => {
    expect(portalVerificationOutcome("verified")).toEqual({ state: "email-verified" });
    expect(portalVerificationOutcome("reconciliation")).toEqual({
      phase: "RECONCILIATION_REQUIRED",
      state: "registration-progress",
    });
    expect(portalVerificationOutcome("admitted")).toEqual({ state: "anonymous" });
    expect(portalVerificationOutcome()).toEqual({ state: "anonymous" });
  });
  it.effect("verification is not customer admission and consumes the token only once", () =>
    Effect.gen(function* verifiedEmailIsNotAdmission() {
      let calls = 0;
      const state = yield* verifyEmailWithPortalOwner(
        Effect.sync(() => {
          calls += 1;
          return { outcome: "EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT" as const };
        }),
      );
      expect(state).toBe("verified");
      expect(calls).toBe(1);
    }),
  );
  it.effect("does not retry an uncertain token consumption", () =>
    Effect.gen(function* uncertainVerification() {
      let calls = 0;
      const state = yield* verifyEmailWithPortalOwner(
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new PortalFailure({ reason: "unavailable" }));
        }),
      );
      expect(state).toBe("unconfirmed");
      expect(calls).toBe(1);
    }),
  );
  it.effect("preserves reconciliation instead of claiming verified email", () =>
    Effect.gen(function* reconciliationIsNotVerification() {
      const state = yield* verifyEmailWithPortalOwner(
        Effect.succeed({ outcome: "ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED" as const }),
      );
      expect(state).toBe("reconciliation");
    }),
  );
  it("offers continuation only for explicit pending enrollment states", () => {
    expect(canResumePortalEnrollment({ state: "verification-required" })).toBe(true);
    expect(
      canResumePortalEnrollment({ phase: "IN_PROGRESS", state: "registration-progress" }),
    ).toBe(true);
    const terminal: PortalOutcome[] = [
      { state: "unconfirmed" },
      { state: "anonymous" },
      { email: "a@example.com", name: "A", state: "admitted" },
      { methods: [], state: "mfa" },
    ];
    for (const value of terminal) {
      expect(canResumePortalEnrollment(value)).toBe(false);
    }
    for (const phase of ["COMPLETE", "RECONCILIATION_REQUIRED", "TERMINATED", "FAILED"] as const) {
      expect(canResumePortalEnrollment({ phase, state: "registration-progress" })).toBe(false);
    }
  });
});
describe("N1 portal channel", () => {
  it("isolates outgoing cookies to the commerce realm", () => {
    expect(
      portalCookie(
        "staff.session=secret; commerce-portal.session_token=portal; other=x; __Secure-commerce-portal.challenge=mfa",
      ),
    ).toBe("commerce-portal.session_token=portal; __Secure-commerce-portal.challenge=mfa");
  });
  it("forwards only host-only realm cookies, including expirations", () => {
    expect(
      portalSetCookies([
        "staff.session=x; Path=/",
        "commerce-portal.session_token=x; HttpOnly; Path=/",
        "commerce-portal.bad=x; Domain=.example.com",
        "commerce-portal.session_token=; Max-Age=0; Path=/",
      ]),
    ).toEqual([
      "commerce-portal.session_token=x; HttpOnly; Path=/",
      "commerce-portal.session_token=; Max-Age=0; Path=/",
    ]);
  });
  it("uses updated realm cookies for admission and removes revoked cookies", () => {
    expect(
      mergePortalCookies("commerce-portal.session_token=old; staff.session=x", [
        "commerce-portal.session_token=new; Path=/",
      ]),
    ).toBe("commerce-portal.session_token=new");
    expect(
      mergePortalCookies("commerce-portal.session_token=old", [
        "commerce-portal.session_token=; Max-Age=0; Path=/",
      ]),
    ).toBe("");
  });
  it("requires exact origin including protocol and port", () => {
    expect(isPortalOrigin("https://n1.example", "https://n1.example/api/account/login")).toBe(true);
    expect(isPortalOrigin("http://n1.example", "https://n1.example/api/account/login")).toBe(false);
    expect(isPortalOrigin("https://n1.example:8443", "https://n1.example/api/account/login")).toBe(
      false,
    );
    expect(isPortalOrigin(undefined, "https://n1.example/api/account/login")).toBe(false);
  });
  for (const extra of ["tenantId", "customerId", "sellingLegalEntityId", "callbackURL"]) {
    it.effect(`refuses browser-controlled ${extra}`, () =>
      Effect.gen(function* rejectsIdentityOverride() {
        const failure = yield* Effect.flip(
          decodePortalRegistration({ ...registration, [extra]: "attacker" }),
        );
        expect(failure).toBeDefined();
      }),
    );
  }
  it("enforces canonical password minimum and confirmation without a fixture rule", () => {
    expect(
      Schema.is(PortalRegistrationSchema)({
        ...registration,
        password: shortPassword,
        passwordConfirmation: shortPassword,
      }),
    ).toBe(false);
    expect(
      Schema.is(PortalRegistrationSchema)({
        ...registration,
        passwordConfirmation: testPassword.repeat(2),
      }),
    ).toBe(false);
    expect(
      Schema.is(PortalLoginSchema)({
        email: registration.email,
        password: shortPassword,
        rememberMe: false,
      }),
    ).toBe(false);
  });
  it.effect("keeps passwords out of idempotency and adds only server-owned seller identity", () =>
    Effect.gen(function* enrollmentEnvelope() {
      const input = yield* Schema.decodeUnknownEffect(PortalRegistrationSchema)(registration);
      const key = portalEnrollmentIdempotencyKey(input.requestId);
      expect(key).not.toContain(input.password);
      expect(key).toBe(`n1-enrollment:${registration.requestId}`);
      const body = enrollmentBody(input, "n1-seller");
      expect(body.sellingLegalEntityId).toBe("n1-seller");
      expect(body.journey).toBe("RETAIL_SELF_ENROLLMENT");
      expect(body).not.toHaveProperty("passwordConfirmation");
      expect(body).not.toHaveProperty("requestId");
    }),
  );
  it.effect("rejects a provider-only session as malformed customer admission", () =>
    Effect.gen(function* providerIsNotCustomer() {
      const failure = yield* Effect.flip(
        decodePortalAdmission({
          account: { email: registration.email, name: "Jane" },
          session: { token: "must-not-be-forwarded" },
          state: "authenticated",
        }),
      );
      expect(failure.reason).toBe("unconfirmed");
    }),
  );
  it.effect("admits only a matching tenant and publishes no owner identifiers", () =>
    Effect.gen(function* admitsCustomer() {
      const observation = yield* decodePortalAdmission({
        account: {
          email: registration.email,
          id: "provider-subject",
          name: "Jane",
          partyId: "71000000-0000-4000-8000-000000000099",
          tenantId: "71000000-0000-4000-8000-000000000098",
        },
        state: "authenticated",
      });
      const result = yield* portalAdmission(observation, "71000000-0000-4000-8000-000000000098");
      expect(result).toEqual({ email: registration.email, name: "Jane", state: "admitted" });
      const failure = yield* Effect.flip(portalAdmission(observation, "another-tenant"));
      expect(failure.reason).toBe("unconfirmed");
    }),
  );
  it("does not claim customer admission when enrollment is complete", () => {
    expect(portalEnrollmentProgress("COMPLETE")).toEqual({
      phase: "COMPLETE",
      state: "registration-progress",
    });
    expect(portalEnrollmentProgress("VERIFICATION_REQUIRED")).toEqual({
      state: "verification-required",
    });
    expect(portalEnrollmentProgress("FAILED")).toEqual({
      phase: "FAILED",
      state: "registration-progress",
    });
  });
});

for (const operation of ["login", "register"] as const) {
  it.effect(`${operation} preserves pre-write unavailability as safely retryable`, () =>
    Effect.gen(function* preWriteUnavailable() {
      const refusal = Effect.fail(new PortalFailure({ reason: "unavailable" }));
      const admission = Effect.succeed({ state: "anonymous" as const });
      const result =
        operation === "login"
          ? loginWithPortalOwner({ complete: admission, signIn: refusal })
          : registerWithPortalOwner({ admit: admission, start: refusal });
      const failure = yield* Effect.flip(result);
      expect(failure.reason).toBe("unavailable");
    }),
  );
  it.effect(`${operation} makes a fresh-context failure after the confirmed write terminal`, () =>
    Effect.gen(function* postWriteUnavailable() {
      let writes = 0;
      const cookies: string[] = [];
      const acknowledge = Effect.sync(() => {
        writes += 1;
        cookies.push("commerce-portal.session_token=acknowledged");
      });
      const failedAdmission = Effect.fail(new PortalFailure({ reason: "unavailable" }));
      const result =
        operation === "login"
          ? loginWithPortalOwner({
              complete: failedAdmission,
              signIn: acknowledge.pipe(Effect.as({ outcome: "SESSION_CREATED" as const })),
            })
          : registerWithPortalOwner({
              admit: failedAdmission,
              start: acknowledge.pipe(Effect.as({ attempt: { state: "COMPLETE" as const } })),
            });
      const failure = yield* Effect.flip(result);
      expect(failure.reason).toBe("unconfirmed");
      expect(writes).toBe(1);
      expect(cookies).toEqual(["commerce-portal.session_token=acknowledged"]);
    }),
  );
  it.effect(`${operation} makes a malformed post-write admission terminal`, () =>
    Effect.gen(function* malformedAdmissionAfterWrite() {
      const malformed = Schema.decodeUnknownEffect(Schema.Struct({ email: Schema.String }))({
        email: false,
      });
      const result =
        operation === "login"
          ? loginWithPortalOwner({
              complete: malformed.pipe(Effect.as({ state: "anonymous" as const })),
              signIn: Effect.succeed({ outcome: "SESSION_CREATED" as const }),
            })
          : registerWithPortalOwner({
              admit: malformed.pipe(Effect.as({ state: "anonymous" as const })),
              start: Effect.succeed({ attempt: { state: "COMPLETE" as const } }),
            });
      const failure = yield* Effect.flip(result);
      expect(failure.reason).toBe("unconfirmed");
    }),
  );
}
