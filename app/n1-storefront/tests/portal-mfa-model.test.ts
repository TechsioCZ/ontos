import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-rstest";
import { PortalMfaVerifySchema } from "../src/ontos/portal";
import type { PortalOutcome } from "../src/ontos/portal";
import {
  completeMfaWithPortalOwner,
  portalMfaTransition,
  portalRefreshOutcome,
  PortalFailure,
} from "../src/ontos/portal-model";

const challenge: PortalOutcome = { methods: ["totp", "otp"], state: "mfa" };
const admitted: PortalOutcome = { email: "a@example.test", name: "A", state: "admitted" };

describe("MFA challenge ownership and native verification boundary", () => {
  it("does not invent six-digit numeric restrictions or silently trim codes", () => {
    for (const code of ["a", "1234567", "a".repeat(32)]) {
      expect(Schema.is(PortalMfaVerifySchema)({ code, method: "totp" })).toBe(true);
    }
    for (const code of ["", " padded ", "a".repeat(33)]) {
      expect(Schema.is(PortalMfaVerifySchema)({ code, method: "otp" })).toBe(false);
    }
  });
  it("rejects late MFA results after logout, admission or a replacement challenge", () => {
    const replacement: PortalOutcome = { methods: ["totp", "otp"], state: "mfa" };
    for (const current of [{ state: "anonymous" } as const, admitted, replacement]) {
      expect(
        portalMfaTransition(current, challenge, { outcome: admitted, state: "complete" }),
      ).toBe(current);
      expect(portalMfaTransition(current, challenge, { state: "otp-sent" })).toBe(current);
    }
  });
  it("only keeps local MFA presentation on anonymous safe reads, never revives it later", () => {
    expect(portalRefreshOutcome(challenge, { state: "anonymous" })).toBe(challenge);
    expect(portalRefreshOutcome(challenge, admitted)).toBe(admitted);
    const expired = portalMfaTransition(challenge, challenge, {
      reason: "expired",
      state: "mfa-error",
    });
    expect(expired).toEqual({ state: "mfa-expired" });
    expect(portalRefreshOutcome(expired, { state: "anonymous" })).toEqual({ state: "anonymous" });
    expect(portalMfaTransition(expired, challenge, { state: "otp-sent" })).toBe(expired);
  });
  it("keeps invalid and throttled feedback on the same advertised method instance", () => {
    for (const reason of ["invalid", "rejected", "throttled", "unavailable"] as const) {
      const result = portalMfaTransition(challenge, challenge, { reason, state: "mfa-error" });
      expect(result).toEqual({ ...challenge, feedback: reason });
      if (result.state === "mfa" && challenge.state === "mfa") {
        expect(result.methods).toBe(challenge.methods);
      }
    }
    expect(
      portalMfaTransition(challenge, challenge, { reason: "unconfirmed", state: "mfa-error" }),
    ).toEqual({ state: "unconfirmed" });
    expect(
      portalMfaTransition(challenge, challenge, {
        reason: "authentication-required",
        state: "mfa-error",
      }),
    ).toEqual({ state: "mfa-authentication-required" });
  });
  it.effect("consumes verification once and makes failed subsequent admission unconfirmed", () =>
    Effect.gen(function* consumedChallengeCannotRetry() {
      let writes = 0;
      const result = yield* Effect.flip(
        completeMfaWithPortalOwner({
          admit: Effect.fail(new PortalFailure({ reason: "unavailable" })),
          verify: Effect.sync(() => {
            writes += 1;
            return { status: true as const };
          }),
        }),
      );
      expect(result.reason).toBe("unconfirmed");
      expect(writes).toBe(1);
    }),
  );
  it.effect("does not read admission or retry a rejected consumption", () =>
    Effect.gen(function* noReadAfterRejectedCode() {
      let reads = 0;
      const result = yield* Effect.flip(
        completeMfaWithPortalOwner({
          admit: Effect.sync(() => {
            reads += 1;
            return admitted;
          }),
          verify: Effect.fail(new PortalFailure({ reason: "unconfirmed" })),
        }),
      );
      expect(result.reason).toBe("unconfirmed");
      expect(reads).toBe(0);
    }),
  );
});
