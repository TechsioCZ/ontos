import { Effect, Option, Schema } from 'effect';

/** Bounded number of evaluation attempts; there is no TTL, expiry or renewal anywhere (#942 F18-F19, E). */
export const TAX_EVALUATION_MAX_ATTEMPTS = 3;

/** Why an evaluation candidate was discarded before publication (#942 F17-F18). */
export const TaxEvaluationDiscardReasonSchema = Schema.Literals(['RULE_SET_CHANGED', 'SELLER_STATE_CHANGED']);
export type TaxEvaluationDiscardReason = typeof TaxEvaluationDiscardReasonSchema.Type;

/** Completeness tokens of the TAX own state one attempt used; append-only owner tables make them monotonic. */
export interface TaxEvaluationStateTokens {
  readonly ruleSets: ReadonlyMap<string, Readonly<{ outcome: string; setFingerprint: string }>>;
  readonly seller: Readonly<{ reason: string; setFingerprint: string; state: string }>;
}

const sameRuleSets = (before: TaxEvaluationStateTokens['ruleSets'], after: TaxEvaluationStateTokens['ruleSets']) =>
  before.size === after.size &&
  [...before].every(([code, token]) => {
    const other = after.get(code);
    return other !== undefined && other.outcome === token.outcome && other.setFingerprint === token.setFingerprint;
  });

const sameSeller = (before: TaxEvaluationStateTokens['seller'], after: TaxEvaluationStateTokens['seller']) =>
  before.setFingerprint === after.setFingerprint && before.state === after.state && before.reason === after.reason;

/**
 * Evaluation-local conditional check: the state re-read after evaluation must carry the same completeness tokens as
 * the state the candidate used. Rule sets are compared before the seller, so the reported reason is deterministic.
 */
export const taxEvaluationStateChange = (
  before: TaxEvaluationStateTokens,
  after: TaxEvaluationStateTokens,
): Option.Option<TaxEvaluationDiscardReason> => {
  if (!sameRuleSets(before.ruleSets, after.ruleSets)) {
    return Option.some('RULE_SET_CHANGED');
  }
  return sameSeller(before.seller, after.seller) ? Option.none() : Option.some('SELLER_STATE_CHANGED');
};

export type TaxEvaluationAttemptLog = readonly Readonly<{
  attempt: number;
  discardedBecause: TaxEvaluationDiscardReason;
}>[];

/**
 * Outcome of the bounded retry: the published candidate with the state it rests on, or none after the bound. The
 * last observed state is kept only as evidence; it never becomes a published candidate.
 */
export interface BoundedTaxEvaluation<State, Output> {
  readonly attempts: number;
  readonly discarded: TaxEvaluationAttemptLog;
  readonly lastObserved: State;
  readonly published: Option.Option<Readonly<{ output: Output; state: State }>>;
}

interface BoundedRetryOptions<State, Output, Failure, Requirements> {
  readonly evaluate: (state: State) => Output;
  readonly observe: Effect.Effect<State, Failure, Requirements>;
  readonly tokensOf: (state: State) => TaxEvaluationStateTokens;
}

const attemptFrom = <State, Output, Failure, Requirements>(
  options: BoundedRetryOptions<State, Output, Failure, Requirements>,
  attempt: number,
  discarded: TaxEvaluationAttemptLog,
): Effect.Effect<BoundedTaxEvaluation<State, Output>, Failure, Requirements> =>
  options.observe.pipe(
    Effect.flatMap((state) => {
      const output = options.evaluate(state);
      return options.observe.pipe(
        Effect.flatMap((lastObserved) =>
          Option.match(taxEvaluationStateChange(options.tokensOf(state), options.tokensOf(lastObserved)), {
            onNone: () =>
              Effect.succeed({ attempts: attempt, discarded, lastObserved, published: Option.some({ output, state }) }),
            onSome: (discardedBecause) => {
              const log = [...discarded, { attempt, discardedBecause }];
              return attempt < TAX_EVALUATION_MAX_ATTEMPTS
                ? attemptFrom(options, attempt + 1, log)
                : Effect.succeed({ attempts: attempt, discarded: log, lastObserved, published: Option.none() });
            },
          }),
        ),
      );
    }),
  );

/**
 * Bounded evaluation-local retry (#942 F17-F19). Each attempt reads the whole own state afresh, evaluates, then
 * re-reads; equal tokens on both reads mean every predicate held one state across the evaluation, so the candidate
 * rests on one coherent cut. A changed token discards the whole candidate; the next attempt never combines old and
 * new state. After the bound nothing is published and the caller returns the approved indeterminate outcome.
 */
export const evaluateWithBoundedRetry = <State, Output, Failure, Requirements>(
  options: BoundedRetryOptions<State, Output, Failure, Requirements>,
): Effect.Effect<BoundedTaxEvaluation<State, Output>, Failure, Requirements> => attemptFrom(options, 1, []);
