// expect-count: 3
interface Failure {
  readonly _tag: string;
}

/**
 * `switch (error._tag)` belongs to `prefer-match-over-tag-switch`, but `switch (true)` is an
 * ordinary comparison ladder wearing a switch as a disguise.
 */
export const classify = (error: Failure): string => {
  switch (true) {
    case error._tag === "ActionTransactionError":
      return "tx";
    case error._tag === "ActionCollectorError" || error._tag === "ActionHandlerExecutionError":
      return "collector";
    default:
      return "other";
  }
};
