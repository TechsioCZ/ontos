import { Effect, ManagedRuntime, Match } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { PortalApi } from "./portal";
import type { PortalLogin, PortalOutcome, PortalRegistration } from "./portal";

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
