import { Effect, ManagedRuntime, Match } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { PortalApi } from "./portal";
import type {
  PortalLogin,
  PortalMfaResult,
  PortalMfaVerify,
  PortalOutcome,
  PortalRegistration,
} from "./portal";

export const portalRuntime = ManagedRuntime.make(FetchHttpClient.layer);
const client = HttpApiClient.make(PortalApi);
const callLogin = (input: PortalLogin) =>
  client.pipe(Effect.flatMap((api) => api.portal.login({ payload: input })));
type ChannelFailure = Effect.Error<ReturnType<typeof callLogin>>;
const outcome = <R>(program: Effect.Effect<PortalOutcome, ChannelFailure, R>) =>
  program.pipe(
    Effect.match({
      onFailure: (error): PortalOutcome =>
        Match.value(error).pipe(
          Match.tags({
            PortalCredentialsProblem: () => ({ state: "credentials" as const }),
            PortalInvalidProblem: () => ({ state: "invalid" as const }),
            PortalRateLimitedProblem: (problem) => ({
              retryAfterSeconds: problem.retryAfterSeconds,
              state: "rate-limited" as const,
            }),
            PortalRefusedProblem: () => ({ state: "refused" as const }),
            PortalUnavailableProblem: () => ({ state: "unavailable" as const }),
            PortalUnconfirmedProblem: () => ({ state: "unconfirmed" as const }),
          }),
          Match.orElse(() => ({ state: "unconfirmed" as const })),
        ),
      onSuccess: (result) => result,
    }),
  );
export const loginPortal = (input: PortalLogin) => outcome(callLogin(input));
export const registerPortal = (input: PortalRegistration) =>
  outcome(client.pipe(Effect.flatMap((api) => api.portal.register({ payload: input }))));
export const readPortalCurrent = () =>
  outcome(client.pipe(Effect.flatMap((api) => api.portal.current())));
export const logoutPortal = () =>
  outcome(client.pipe(Effect.flatMap((api) => api.portal.logout({ payload: {} }))));
export const resumePortalEnrollment = () =>
  outcome(client.pipe(Effect.flatMap((api) => api.portal.resume({ payload: {} }))));

const callVerifyMfa = (input: PortalMfaVerify) =>
  client.pipe(Effect.flatMap((api) => api.portal.verifyMfa({ payload: input })));
type MfaChannelFailure = Effect.Error<ReturnType<typeof callVerifyMfa>>;
const mfaOutcome = <R>(program: Effect.Effect<PortalMfaResult, MfaChannelFailure, R>) =>
  program.pipe(
    Effect.match({
      onFailure: (error): PortalMfaResult =>
        Match.value(error).pipe(
          Match.tags({
            PortalInvalidProblem: () => ({
              reason: "invalid" as const,
              state: "mfa-error" as const,
            }),
            PortalMfaAuthenticationProblem: (problem) => ({
              reason: problem.reason,
              state: "mfa-error" as const,
            }),
            PortalMfaInvalidProblem: (problem) => ({
              reason: problem.reason,
              state: "mfa-error" as const,
            }),
            PortalMfaRateLimitedProblem: (problem) => ({
              reason: problem.reason,
              state: "mfa-error" as const,
            }),
            PortalMfaRefusedProblem: (problem) => ({
              reason: problem.reason,
              state: "mfa-error" as const,
            }),
            PortalMfaUnavailableProblem: (problem) => ({
              reason: problem.reason,
              state: "mfa-error" as const,
            }),
            PortalRefusedProblem: () => ({
              reason: "refused" as const,
              state: "mfa-error" as const,
            }),
          }),
          Match.orElse(() => ({ reason: "unconfirmed" as const, state: "mfa-error" as const })),
        ),
      onSuccess: (result) => result,
    }),
  );
export const verifyPortalMfa = (input: PortalMfaVerify) => mfaOutcome(callVerifyMfa(input));
export const requestPortalMfaOtp = () =>
  mfaOutcome(client.pipe(Effect.flatMap((api) => api.portal.requestMfaOtp({ payload: {} }))));
