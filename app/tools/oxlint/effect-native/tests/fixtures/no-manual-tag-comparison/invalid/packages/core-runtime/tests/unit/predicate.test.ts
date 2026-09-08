// expect-count: 3
interface Failure {
  readonly _tag: string;
}

/** Test predicates are in scope: they should assert through `Schema.is(TaggedError)`. */
export const isConfigError = (error: Failure): boolean => error._tag === "OutboxPollerConfigError";

export const isCollectorFailure = (error: Failure): boolean =>
  error._tag === "ActionCollectorError" || error._tag === "ActionHandlerExecutionError";
