import { Match } from "effect";

export interface QuoteSelection {
  generation: number;
  key: string | null;
}
/** A -> B -> A is a new request generation even when the serialized cart repeats. */
export const advanceQuoteSelection = (
  previous: QuoteSelection,
  key: string | null,
): QuoteSelection =>
  previous.key === key ? previous : { generation: previous.generation + 1, key };
export const isCurrentQuoteSnapshot = (
  snapshot: (QuoteSelection & { attempt: number }) | null,
  selection: QuoteSelection,
  attempt: number,
) =>
  selection.key !== null &&
  snapshot?.key === selection.key &&
  snapshot.generation === selection.generation &&
  snapshot.attempt === attempt;
export interface QuoteFailureDetails {
  readonly _tag: string;
  readonly state?: string;
}
/** A changed market needs fresh server scope, not a retry of the obsolete request. */
export const quoteFailureState = (error: QuoteFailureDetails): "scope-mismatch" | "unavailable" =>
  Match.value(error).pipe(
    Match.when({ _tag: "CartQuoteScopeProblem" }, () => "scope-mismatch" as const),
    Match.orElse(() => "unavailable" as const),
  );
