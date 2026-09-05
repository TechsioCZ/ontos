// expect-count: 5
import * as Effect from "effect/Effect";

const RETRYABLE = "AresSubjectThrottled";
const Tags = { throttled: "AresSubjectThrottled" } as const;

interface Failure {
  readonly _tag: string;
}

/** Comparing a tag against a variable is exactly as non-exhaustive as comparing it to a literal. */
export const isRetryable = (error: Failure): boolean => error._tag === RETRYABLE;

export const isThrottled = (error: Failure): boolean => error._tag === Tags.throttled;

export function Banner({ error }: { readonly error: Failure }) {
  const state = error._tag === "ContactsUnavailableProblem" ? "unavailable" : "failed";
  return <span data-state={state}>{error!._tag !== "ContactsCustomerNotFound" ? "x" : "y"}</span>;
}

export const recover = (program: Effect.Effect<number, Failure>) =>
  Effect.mapError(program, (error: Failure) => (error._tag === "AresSubjectTimeout" ? "timeout" : "other"));
