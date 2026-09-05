// expect-count: 3
// Adversarial TSX: generic arrows, JSX attribute callbacks and `Option`/`Match` combinators.
import { Effect, Match, Option } from 'effect';

declare const outcome: Option.Option<string>;
declare const program: Effect.Effect<string>;

// 1 — `Option.getOrElse` fallback.
const label = Option.getOrElse(outcome, () => {
  throw new Error('the customer list read produced no outcome');
});

// 2 — a generic arrow (TSX `<A,>`) passed to `Match.when`.
const matched = Match.value('x').pipe(
  Match.when('conflict', <A,>(value: A): A => {
    throw new Error('conflict');
  }),
  Match.orElse((value: string) => value),
);

// 3 — a JSX event handler created inside `Effect.gen`.
const view = Effect.gen(function* () {
  const value = yield* program;
  return (
    <span
      onClick={() => {
        throw new Error('jsx handler inside an Effect callback');
      }}
    >
      {value}
    </span>
  );
});

export function CustomerListPage(): unknown {
  void view;
  return <section data-label={label}>{matched}</section>;
}
