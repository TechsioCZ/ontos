import { Effect, Redacted, Schema, flow } from "effect";
import type { PortalEnrollmentPhase, PortalOutcome, PortalRegistration } from "./portal";

export class PortalFailure extends Schema.TaggedError<PortalFailure>()("PortalFailure", {
  reason: Schema.Literals(["invalid", "credentials", "refused", "unavailable", "unconfirmed"]),
}) {}

const realmName = /^(?:__Secure-)?commerce-portal\.[\w.-]+$/u;
/** Staff cookies and arbitrary browser cookies never enter the commerce realm. */
export const portalCookie = (header: string | undefined) =>
  (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf("=");
      return separator > 0 && realmName.test(part.slice(0, separator)) && !/[\r\n]/u.test(part);
    })
    .join("; ");
/** The owner uses host-only cookies; do not let an upstream Domain widen their scope. */
export const portalSetCookies = (headers: readonly string[]) =>
  headers.filter((header) => {
    const first = header.split(";")[0] ?? "";
    return (
      portalCookie(first) === first &&
      first.length > 0 &&
      !/[\r\n]/u.test(header) &&
      !/;\s*domain=/iu.test(header)
    );
  });
export const mergePortalCookies = (current: string, updates: readonly string[]) => {
  const jar = new Map<string, string>();
  for (const part of portalCookie(current).split("; ")) {
    const at = part.indexOf("=");
    if (at > 0) {
      jar.set(part.slice(0, at), part.slice(at + 1));
    }
  }
  for (const header of portalSetCookies(updates)) {
    const first = header.split(";")[0] ?? "";
    const at = first.indexOf("=");
    const name = first.slice(0, at);
    const value = first.slice(at + 1);
    if (value === "" || /;\s*max-age=0(?:;|$)/iu.test(header)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
};
export const isPortalOrigin = (origin: string | undefined, requestUrl: string) =>
  origin !== undefined &&
  URL.canParse(origin) &&
  URL.canParse(requestUrl) &&
  new URL(origin).origin === new URL(requestUrl).origin;
export const portalEnrollmentIdempotencyKey = (requestId: string) => `n1-enrollment:${requestId}`;
export const enrollmentBody = (input: PortalRegistration, sellingLegalEntityId: string) => ({
  displayName: `${input.firstName} ${input.lastName}`,
  email: input.email.toLowerCase(),
  journey: "RETAIL_SELF_ENROLLMENT" as const,
  password: Redacted.make(input.password),
  sellingLegalEntityId,
});
const nonempty = Schema.String.check(Schema.isMinLength(1));
export const PortalAccountObservationSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("anonymous") }),
  Schema.Struct({
    account: Schema.Struct({
      email: nonempty,
      id: nonempty,
      name: nonempty,
      partyId: Schema.String.check(Schema.isUUID()),
      tenantId: Schema.String.check(Schema.isUUID()),
    }),
    state: Schema.Literal("authenticated"),
  }),
]);
export type PortalAccountObservation = typeof PortalAccountObservationSchema.Type;
export const decodePortalAdmission = flow(
  Schema.decodeUnknownEffect(PortalAccountObservationSchema),
  Effect.mapError(() => new PortalFailure({ reason: "unconfirmed" })),
);
export const portalAdmission = (
  observation: PortalAccountObservation,
  tenantId: string,
): Effect.Effect<PortalOutcome, PortalFailure> => {
  if (observation.state === "anonymous") {
    return Effect.succeed({ state: "anonymous" });
  }
  if (observation.account.tenantId !== tenantId) {
    return Effect.fail(new PortalFailure({ reason: "unconfirmed" }));
  }
  return Effect.succeed({
    email: observation.account.email,
    name: observation.account.name,
    state: "admitted",
  });
};
/** COMPLETE is enrollment evidence, not the separate customer-account admission. */
export const portalEnrollmentProgress = (phase: PortalEnrollmentPhase): PortalOutcome =>
  phase === "VERIFICATION_REQUIRED"
    ? { state: "verification-required" }
    : { phase, state: "registration-progress" };

export const canResumePortalEnrollment = (outcome: PortalOutcome) =>
  outcome.state === "verification-required" ||
  (outcome.state === "registration-progress" && outcome.phase === "IN_PROGRESS");

/** A notice from the callback never grants a session or customer access. */
export const portalVerificationOutcome = (notice?: string): PortalOutcome => {
  switch (notice ?? "") {
    case "verified": {
      return { state: "email-verified" };
    }
    case "reconciliation": {
      return portalEnrollmentProgress("RECONCILIATION_REQUIRED");
    }
    case "invalid": {
      return { state: "invalid" };
    }
    case "unconfirmed": {
      return { state: "unconfirmed" };
    }
    default: {
      return { state: "anonymous" };
    }
  }
};

/** Verification consumes its token once. Neither success nor reconciliation is admission. */
export const verifyEmailWithPortalOwner = <E, R>(
  program: Effect.Effect<
    {
      readonly outcome:
        | "EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT"
        | "ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED";
    },
    E,
    R
  >,
) =>
  program.pipe(
    Effect.match({
      onFailure: () => "unconfirmed" as const,
      onSuccess: (result) =>
        result.outcome === "EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT"
          ? ("verified" as const)
          : ("reconciliation" as const),
    }),
  );

type PortalSignInAcknowledgement =
  | { readonly outcome: "SESSION_CREATED" }
  | { readonly methods: readonly ("otp" | "totp")[]; readonly outcome: "MFA_REQUIRED" };

/** Only the credential call may retain a pre-write retryable failure. Its acknowledged
 * session must be recovered with a safe read if any later admission step fails. */
export const loginWithPortalOwner = <WriteError, ReadError, WriteServices, ReadServices>(owner: {
  readonly complete: Effect.Effect<PortalOutcome, ReadError, ReadServices>;
  readonly signIn: Effect.Effect<PortalSignInAcknowledgement, WriteError, WriteServices>;
}) =>
  Effect.gen(function* loginWithPortalOwnerProgram() {
    const result = yield* owner.signIn;
    if (result.outcome === "MFA_REQUIRED") {
      return { methods: result.methods, state: "mfa" as const };
    }
    return yield* owner.complete.pipe(
      Effect.mapError(() => new PortalFailure({ reason: "unconfirmed" })),
    );
  });

/** Enrollment COMPLETE confirms a write, while customer admission is a separate read. */
export const registerWithPortalOwner = <WriteError, ReadError, WriteServices, ReadServices>(owner: {
  readonly admit: Effect.Effect<PortalOutcome, ReadError, ReadServices>;
  readonly start: Effect.Effect<
    { readonly attempt: { readonly state: PortalEnrollmentPhase } },
    WriteError,
    WriteServices
  >;
}) =>
  Effect.gen(function* registerWithPortalOwnerProgram() {
    const result = yield* owner.start;
    if (result.attempt.state !== "COMPLETE") {
      return portalEnrollmentProgress(result.attempt.state);
    }
    const admitted = yield* owner.admit.pipe(
      Effect.mapError(() => new PortalFailure({ reason: "unconfirmed" })),
    );
    return admitted.state === "admitted"
      ? admitted
      : portalEnrollmentProgress(result.attempt.state);
  });
