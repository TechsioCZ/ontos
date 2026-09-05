// expect-count: 7
import { Effect as E, Match as M, Schedule as Sched, pipe } from "effect";

interface Failure {
  readonly _tag: string;
}

/** Point-free `pipe(x, E.mapError(fn))` with an aliased named import. */
export const mapped = (program: E.Effect<number, Failure>) =>
  pipe(program, E.mapError((error: Failure) => (error._tag === "AresSubjectThrottled" ? "throttled" : "other")));

/** Method `.pipe` with a predicate/handler pair. */
export const caught = (program: E.Effect<number, Failure>) =>
  program.pipe(E.catchIf((error: Failure) => error._tag === "AresSubjectTimeout", () => E.succeed(0)));

/** A named function reference passed as the combinator callback still holds both comparisons. */
const isRetryable = (error: Failure): boolean =>
  error._tag === "AresSubjectThrottled" || error._tag === "AresSubjectTimeout";

export const retried = (program: E.Effect<number, Failure>) => program.pipe(E.retry(Sched.recurWhile(isRetryable)));

/** `Match.when` with a hand-written predicate instead of `Match.tag`. */
export const classify = (error: Failure): string =>
  M.value(error).pipe(
    M.when((candidate: Failure) => candidate._tag === "GatewayAuthenticationRequiredProblem", () => "auth"),
    M.orElse(() => "other"),
  );

/** The comparison hides two closures deep inside `tapError`. */
export const nested = (program: E.Effect<number, Failure>) =>
  program.pipe(E.tapError((error: Failure) => E.sync(() => (error._tag === "ActionTransactionError" ? 1 : 0))));

/** A returned closure is not an argument to any combinator, but is still a manual comparison. */
export const handler = (error: Failure) => (): boolean => error?._tag === "TenantAccessForbiddenError";
