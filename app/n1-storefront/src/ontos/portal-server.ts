import "server-only";
import { randomUUID } from "node:crypto";
import { commerceCustomerContextApi } from "@app/commerce-customer-context/api";
import { makeEffectBffClientOptions } from "@app/shared-contracts/client-runtime";
import { makeEffectHttpApiClient } from "@modern-js/bff-effect/effect-client";
import { Effect, Match, Redacted, Schema, Struct } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApi } from "effect/http-api";
import type { StorefrontConfiguration } from "./config";
import { readConfiguration } from "./config";
import type {
  PortalLogin,
  PortalMfaResult,
  PortalMfaVerify,
  PortalOutcome,
  PortalRegistration,
} from "./portal";
import {
  completeMfaWithPortalOwner,
  decodePortalAdmission,
  enrollmentBody,
  loginWithPortalOwner,
  mergePortalCookies,
  portalCookie,
  portalEnrollmentIdempotencyKey,
  portalEnrollmentProgress,
  PortalFailure,
  portalSetCookies,
  registerWithPortalOwner,
  verifyEmailWithPortalOwner,
} from "./portal-model";

/** Public owner API groups, without importing the owner's private handlers or provider implementation. */
const ownerApi = HttpApi.make("N1PortalOwner")
  .add(commerceCustomerContextApi.groups.customerOwnProfileRead)
  .add(commerceCustomerContextApi.groups.customerOwnProfileUpdate)
  .add(commerceCustomerContextApi.groups.portalAuthSession)
  .add(commerceCustomerContextApi.groups.portalAuthMfa)
  .add(commerceCustomerContextApi.groups.portalAuthEnrollment)
  .add(commerceCustomerContextApi.groups.portalAuthRecovery);
const readDeadline = "10 seconds";
const writeDeadline = "30 seconds";
const ContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String.check(Schema.isPattern(/^\/shell-super-app-api\/[a-z\d/-]+$/u)),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  expiresAt: Schema.Int,
  token: Schema.String.check(Schema.isMinLength(1)),
});
export interface PortalRequestContext {
  cookie: string;
  readonly origin: string;
  readonly setCookies: string[];
}
export const portalRequestContext = (
  origin: string,
  cookie: string | undefined,
): PortalRequestContext => ({ cookie: portalCookie(cookie), origin, setCookies: [] });
const freshContext = (config: StorefrontConfiguration) =>
  Effect.gen(function* freshPortalContext() {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(
        `${config.shellUrl}/shell-super-app-api/auth/api-key/gateway-context`,
      ).pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": config.apiKey,
          "x-correlation-id": randomUUID(),
        }),
      ),
      { audience: "commerce-customer-context", legalEntityId: config.legalEntityId },
    ).pipe(Effect.mapError(() => new PortalFailure({ reason: "unavailable" })));
    const response = yield* HttpClient.execute(request).pipe(
      Effect.timeout(readDeadline),
      Effect.mapError(() => new PortalFailure({ reason: "unavailable" })),
    );
    if (response.status === 403) {
      yield* Effect.logWarning("N1 Portal request refused").pipe(
        Effect.annotateLogs({ operation: "gateway-context", reason: "forbidden" }),
      );
      return yield* new PortalFailure({
        diagnostic: "gateway-context-forbidden",
        reason: "refused",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new PortalFailure({
        reason: "unavailable",
      });
    }
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ContextSchema)),
      Effect.timeout(readDeadline),
      Effect.mapError(() => new PortalFailure({ reason: "unavailable" })),
    );
  });
const capturePortalCookies = (request: PortalRequestContext) =>
  HttpClient.tap((response) =>
    Effect.sync(() => {
      const updates = portalSetCookies(Cookies.toSetCookieHeaders(response.cookies));
      request.setCookies.push(...updates);
      request.cookie = mergePortalCookies(request.cookie, updates);
    }),
  );
const makeOwnerClient = (
  config: StorefrontConfiguration,
  request?: PortalRequestContext,
  idempotencyKey?: string,
) =>
  Effect.gen(function* makePortalOwnerClient() {
    const context = yield* freshContext(config);
    const options = yield* makeEffectBffClientOptions({
      baseUrl: `${config.shellUrl}${context.apiBaseUrl}`,
      defaultApiPrefix: "/commerce-customer-context-api",
      transportHeaders: {
        authorization: `Bearer ${context.token}`,
        cookie: request?.cookie === "" ? undefined : request?.cookie,
        "idempotency-key": idempotencyKey,
        origin: request?.origin,
        "x-correlation-id": randomUUID(),
        "x-ontos-composition-revision": context.compositionRevision,
      },
    }).pipe(Effect.mapError(() => new PortalFailure({ reason: "unavailable" })));
    return yield* makeEffectHttpApiClient(ownerApi, {
      ...options,
      transformClient: (client) =>
        request === undefined
          ? (options.transformClient?.(client) ?? client)
          : (options.transformClient?.(client) ?? client).pipe(capturePortalCookies(request)),
    });
  });
const configuration = readConfiguration(process.env).pipe(
  Effect.mapError(() => new PortalFailure({ reason: "unavailable" })),
);
/** Recovery uses only the native public operations; neither staff nor Portal cookies are relayed. */
export const requestPasswordResetWithOwner = (
  config: StorefrontConfiguration,
  email: string,
  origin: string,
) =>
  makeOwnerClient(config, portalRequestContext(origin, "")).pipe(
    Effect.flatMap((client) =>
      client.portalAuthRecovery
        .requestPasswordReset({ payload: { email } })
        .pipe(Effect.timeout(writeDeadline)),
    ),
  );
export const resetPasswordWithOwner = (
  config: StorefrontConfiguration,
  newPassword: Redacted.Redacted,
  token: Redacted.Redacted,
  origin: string,
) =>
  makeOwnerClient(config, portalRequestContext(origin, "")).pipe(
    Effect.flatMap((client) =>
      client.portalAuthRecovery
        .resetPassword({
          payload: {
            newPassword,
            token,
          },
        })
        .pipe(Effect.timeout(writeDeadline)),
    ),
  );
export const readPasswordResetCallbackWithOwner = (
  config: StorefrontConfiguration,
  token: Redacted.Redacted,
  callbackURL?: string,
) =>
  makeOwnerClient(config).pipe(
    Effect.flatMap((client) =>
      client.portalAuthRecovery
        .resetPasswordCallback({
          params: { token: Redacted.value(token) },
          query: callbackURL === undefined ? {} : { callbackURL },
        })
        .pipe(Effect.timeout(readDeadline)),
    ),
  );
/** Provider mail links target this public path. The token is the only browser authority;
 * do not relay cookies, callback URLs or an Origin, and never retry this consuming GET. */
export const verifyPortalEmailServer = (token: string) =>
  verifyEmailWithPortalOwner(
    Effect.gen(function* verifyPortalEmailProgram() {
      const config = yield* configuration;
      const client = yield* makeOwnerClient(config);
      return yield* client.portalAuthRecovery
        .verifyEmail({ query: { token } })
        .pipe(Effect.timeout(writeDeadline));
    }),
  );
interface PortalAccountIdentity {
  readonly email: string;
  readonly id: string;
  readonly name: string;
  readonly partyId: string;
  readonly tenantId: string;
}
export type PortalServerIdentity =
  | { readonly account: PortalAccountIdentity; readonly state: "admitted" }
  | { readonly state: "anonymous" };

/** The native account subject stays on the server; a browser's claimed IDs are never an input. */
export const readPortalIdentityWithConfiguration = (
  config: StorefrontConfiguration,
  request: PortalRequestContext,
) =>
  makeOwnerClient(config, request).pipe(
    Effect.flatMap((client) =>
      client.portalAuthSession.getCustomerAccount().pipe(Effect.timeout(readDeadline)),
    ),
    Effect.flatMap(decodePortalAdmission),
    Effect.flatMap((observation): Effect.Effect<PortalServerIdentity, PortalFailure> => {
      if (observation.state === "anonymous") {
        return Effect.succeed({ state: "anonymous" });
      }
      if (observation.account.tenantId !== config.tenantId) {
        return Effect.fail(new PortalFailure({ reason: "unconfirmed" }));
      }
      return Effect.succeed({ account: observation.account, state: "admitted" });
    }),
    Effect.catchTag("CommercePortalAuthSessionAuthenticationProblem", () =>
      Effect.succeed<PortalServerIdentity>({ state: "anonymous" }),
    ),
  );
const readAdmission = (config: StorefrontConfiguration, request: PortalRequestContext) =>
  readPortalIdentityWithConfiguration(config, request).pipe(
    Effect.map((identity): PortalOutcome =>
      identity.state === "anonymous"
        ? { state: "anonymous" }
        : { email: identity.account.email, name: identity.account.name, state: "admitted" },
    ),
  );
/** Own-profile operations share the Portal transport boundary; consumers never construct a client. */
export const readPortalOwnProfile = (
  config: StorefrontConfiguration,
  request: PortalRequestContext,
) =>
  makeOwnerClient(config, request).pipe(
    Effect.flatMap((client) =>
      client.customerOwnProfileRead.execute().pipe(Effect.timeout(readDeadline)),
    ),
  );
type PortalOwnerClient = Effect.Success<ReturnType<typeof makeOwnerClient>>;
/** The native owner derives the address-book subject from the live Portal session. */
export const readPortalOwnAddressBook = (
  config: StorefrontConfiguration,
  request: PortalRequestContext,
) =>
  makeOwnerClient(config, request).pipe(
    Effect.flatMap((client) =>
      client.portalAuthSession.getCustomerAddressBook().pipe(Effect.timeout(readDeadline)),
    ),
  );
type PortalEnrollmentCallFailure = Effect.Error<
  | ReturnType<PortalOwnerClient["portalAuthEnrollment"]["startEnrollment"]>
  | ReturnType<PortalOwnerClient["portalAuthEnrollment"]["resumeCurrentEnrollment"]>
>;
/** Only closed owner codes enter logs; the error and its private cause remain unobserved. */
const logPortalEnrollmentFailure = (
  operation: "enrollment-start" | "enrollment-resume",
  error: PortalEnrollmentCallFailure,
) =>
  Effect.logWarning("N1 Portal enrollment failed").pipe(
    Effect.annotateLogs({
      operation,
      reason: Match.value(error).pipe(
        Match.tag("CommercePortalAuthEnrollmentForbiddenProblem", (problem) => problem.code),
        Match.tag(
          "CommercePortalAuthEnrollmentJourneyUnavailableProblem",
          () => "journey_unavailable",
        ),
        Match.orElse(() => "other"),
      ),
    }),
  );
type OwnProfileUpdate = Parameters<
  PortalOwnerClient["customerOwnProfileUpdate"]["execute"]
>[0]["payload"];
export const updatePortalOwnProfile = (
  config: StorefrontConfiguration,
  payload: OwnProfileUpdate,
  request: PortalRequestContext,
) =>
  makeOwnerClient(config, request).pipe(
    Effect.flatMap((client) =>
      client.customerOwnProfileUpdate.execute({ payload }).pipe(Effect.timeout("20 seconds")),
    ),
  );
const readEnrollment = (
  config: StorefrontConfiguration,
  request: PortalRequestContext,
  resume: boolean,
) =>
  Effect.gen(function* readPortalEnrollmentProgram() {
    const client = yield* makeOwnerClient(config, request);
    const attempt = yield* resume
      ? client.portalAuthEnrollment
          .resumeCurrentEnrollment({ payload: {} })
          .pipe(Effect.tapError((error) => logPortalEnrollmentFailure("enrollment-resume", error)))
      : client.portalAuthEnrollment.readCurrentEnrollment();
    return portalEnrollmentProgress(attempt.state);
  }).pipe(Effect.timeout(readDeadline));
export const loginPortalServer = (input: PortalLogin, request: PortalRequestContext) =>
  Effect.gen(function* loginPortalProgram() {
    const config = yield* configuration;
    const client = yield* makeOwnerClient(config, request);
    return yield* loginWithPortalOwner({
      complete: Effect.gen(function* completePortalLogin() {
        const admitted = yield* readAdmission(config, request);
        return admitted.state === "admitted"
          ? admitted
          : yield* readEnrollment(config, request, false);
      }),
      signIn: client.portalAuthSession
        .signIn({
          payload: {
            email: input.email.toLowerCase(),
            password: Redacted.make(input.password),
            rememberMe: input.rememberMe,
          },
        })
        .pipe(Effect.timeout(writeDeadline)),
    });
  });
export const registerPortalServer = (input: PortalRegistration, request: PortalRequestContext) =>
  Effect.gen(function* registerPortalProgram() {
    const config = yield* configuration;
    const client = yield* makeOwnerClient(
      config,
      request,
      portalEnrollmentIdempotencyKey(input.requestId),
    );
    return yield* registerWithPortalOwner({
      admit: readAdmission(config, request),
      start: client.portalAuthEnrollment
        .startEnrollment({ payload: enrollmentBody(input, config.legalEntityId) })
        .pipe(
          Effect.tapError((error) => logPortalEnrollmentFailure("enrollment-start", error)),
          Effect.timeout(writeDeadline),
        ),
    });
  });
export const currentPortalServer = (request: PortalRequestContext, resume = false) =>
  Effect.gen(function* currentPortalProgram() {
    const config = yield* configuration;
    const admitted = yield* readAdmission(config, request);
    if (admitted.state === "admitted") {
      return admitted;
    }
    const progress = yield* readEnrollment(config, request, resume).pipe(
      Effect.catchTags({
        CommercePortalAuthEnrollmentAuthenticationProblem: () =>
          Effect.succeed<PortalOutcome>({ state: "anonymous" }),
        CommercePortalAuthEnrollmentNotFoundProblem: () =>
          Effect.succeed<PortalOutcome>({ state: "anonymous" }),
      }),
    );
    if (resume && progress.state === "registration-progress" && progress.phase === "COMPLETE") {
      const admission = yield* readAdmission(config, request).pipe(
        Effect.mapError(() => new PortalFailure({ reason: "unconfirmed" })),
      );
      return admission.state === "admitted" ? admission : progress;
    }
    return progress;
  });
export const logoutPortalServer = (request: PortalRequestContext) =>
  Effect.gen(function* logoutPortalProgram() {
    const config = yield* configuration;
    const client = yield* makeOwnerClient(config, request);
    yield* client.portalAuthSession.signOut({ payload: {} }).pipe(Effect.timeout(writeDeadline));
    return { state: "anonymous" as const };
  });

/** Public declared owner problems are safe state transitions; all unknown write outcomes stay unconfirmed. */
type PortalOwnerFailure = Effect.Error<
  | ReturnType<typeof loginPortalServer>
  | ReturnType<typeof registerPortalServer>
  | ReturnType<typeof currentPortalServer>
  | ReturnType<typeof logoutPortalServer>
>;
export const portalFailureOutcome = (error: PortalOwnerFailure): PortalOutcome =>
  Match.value(error).pipe(
    Match.tags({
      CommercePortalAuthEnrollmentAuthenticationProblem: () => ({ state: "credentials" as const }),
      CommercePortalAuthEnrollmentForbiddenProblem: (problem) => ({
        diagnostic:
          problem.code === "origin_not_trusted"
            ? ("owner-origin-not-trusted" as const)
            : ("owner-enrollment-rejected" as const),
        state: "refused" as const,
      }),
      CommercePortalAuthEnrollmentInvalidProblem: () => ({ state: "invalid" as const }),
      CommercePortalAuthEnrollmentJourneyUnavailableProblem: () => ({
        diagnostic: "owner-journey-unavailable" as const,
        state: "refused" as const,
      }),
      CommercePortalAuthEnrollmentRateLimitedProblem: (problem) => ({
        retryAfterSeconds: problem.retryAfterSeconds,
        state: "rate-limited" as const,
      }),
      CommercePortalAuthSessionAuthenticationProblem: () => ({ state: "credentials" as const }),
      CommercePortalAuthSessionForbiddenProblem: (problem) => ({
        state:
          problem.code === "verification_required"
            ? ("verification-required" as const)
            : ("refused" as const),
      }),
      CommercePortalAuthSessionInvalidProblem: () => ({ state: "invalid" as const }),
      CommercePortalAuthSessionRateLimitedProblem: (problem) => ({
        retryAfterSeconds: problem.retryAfterSeconds,
        state: "rate-limited" as const,
      }),
      PortalFailure: (failure) =>
        failure.reason === "refused"
          ? { ...Struct.pick(failure, ["diagnostic"]), state: "refused" as const }
          : { state: failure.reason },
    }),
    Match.orElse(() => ({ state: "unconfirmed" as const })),
  );

/** Complete only the challenge already bound to the realm's HttpOnly cookie. */
export const verifyPortalMfaServer = (input: PortalMfaVerify, request: PortalRequestContext) =>
  Effect.gen(function* verifyPortalMfaProgram() {
    const config = yield* configuration;
    const client = yield* makeOwnerClient(config, request);
    const payload = { code: input.code, trustDevice: false };
    return yield* completeMfaWithPortalOwner({
      admit: readAdmission(config, request),
      verify: (input.method === "totp"
        ? client.portalAuthMfa.verifyTotp({ payload })
        : client.portalAuthMfa.verifyOtp({ payload })
      ).pipe(Effect.timeout(writeDeadline)),
    });
  });
export const requestPortalMfaOtpServer = (request: PortalRequestContext) =>
  Effect.gen(function* requestPortalMfaOtpProgram() {
    const config = yield* configuration;
    const client = yield* makeOwnerClient(config, request);
    const result = yield* client.portalAuthMfa
      .sendOtp({ payload: { trustDevice: false } })
      .pipe(Effect.timeout(writeDeadline));
    return result.status
      ? { state: "otp-sent" as const }
      : { reason: "unconfirmed" as const, state: "mfa-error" as const };
  });
type PortalMfaOwnerFailure = Effect.Error<
  ReturnType<typeof verifyPortalMfaServer> | ReturnType<typeof requestPortalMfaOtpServer>
>;
export const portalMfaFailureOutcome = (error: PortalMfaOwnerFailure): PortalMfaResult =>
  Match.value(error).pipe(
    Match.tags({
      CommercePortalAuthMfaAuthenticationProblem: (problem) => ({
        reason: (
          {
            mfa_authentication_not_fresh: "authentication-required",
            mfa_challenge_expired: "expired",
            mfa_rejected: "rejected",
          } as const
        )[problem.code],
        state: "mfa-error" as const,
      }),
      CommercePortalAuthMfaForbiddenProblem: () => ({
        reason: "refused" as const,
        state: "mfa-error" as const,
      }),
      CommercePortalAuthMfaInvalidProblem: () => ({
        reason: "invalid" as const,
        state: "mfa-error" as const,
      }),
      CommercePortalAuthMfaRateLimitedProblem: () => ({
        reason: "throttled" as const,
        state: "mfa-error" as const,
      }),
      CommercePortalAuthMfaUnavailableProblem: () => ({
        reason: "unavailable" as const,
        state: "mfa-error" as const,
      }),
      PortalFailure: (failure) => ({
        reason: failure.reason === "credentials" ? ("expired" as const) : failure.reason,
        state: "mfa-error" as const,
      }),
    }),
    Match.orElse(() => ({ reason: "unconfirmed" as const, state: "mfa-error" as const })),
  );
