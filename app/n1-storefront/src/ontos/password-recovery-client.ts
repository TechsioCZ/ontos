import { Effect, Match } from "effect";
import { HttpApiClient } from "effect/http-api";
import { PasswordRecoveryApi } from "./password-recovery";
import type {
  PasswordRecoveryOutcome,
  PasswordRecoveryRequest,
  PasswordRecoveryReset,
} from "./password-recovery";

const client = HttpApiClient.make(PasswordRecoveryApi);
const requestProgram = (input: PasswordRecoveryRequest) =>
  client.pipe(Effect.flatMap((api) => api.passwordRecovery.request({ payload: input })));
type RecoveryFailure = Effect.Error<ReturnType<typeof requestProgram>>;

/** A lost response is never permission to repeat a password or mail mutation. */
const outcome = <R>(program: Effect.Effect<PasswordRecoveryOutcome, RecoveryFailure, R>) =>
  program.pipe(
    Effect.match({
      onFailure: (error): PasswordRecoveryOutcome =>
        Match.value(error).pipe(
          Match.tags({
            PasswordRecoveryForbiddenProblem: (problem) => ({ state: problem.state }),
            PasswordRecoveryInvalidProblem: (problem) => ({ state: problem.state }),
            PasswordRecoveryRateLimitedProblem: (problem) => ({ state: problem.state }),
            PasswordRecoveryUnavailableProblem: (problem) => ({ state: problem.state }),
          }),
          Match.orElse(() => ({ state: "unconfirmed" as const })),
        ),
      onSuccess: (value) => value,
    }),
  );

export const requestPasswordRecovery = (input: PasswordRecoveryRequest) =>
  outcome(requestProgram(input));
export const completePasswordRecovery = (input: PasswordRecoveryReset) =>
  outcome(client.pipe(Effect.flatMap((api) => api.passwordRecovery.reset({ payload: input }))));
