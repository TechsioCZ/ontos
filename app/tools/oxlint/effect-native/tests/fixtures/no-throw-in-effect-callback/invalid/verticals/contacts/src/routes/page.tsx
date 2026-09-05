// expect-count: 4
// A4: the frontend reclassification seam — throws inside Match/Option/Effect callbacks in TSX.
import { Effect, Match, Option } from 'effect';

class SubmitRollback {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

declare const outcome: Option.Option<string>;

const label = Option.match(outcome, {
  onNone: () => {
    throw new Error('the customer list read produced no outcome');
  },
  onSome: (value: string) => value,
});

const classify = Match.type<string>().pipe(
  Match.when('conflict', () => {
    throw new Error('conflict');
  }),
  Match.orElse((value: string) => value),
);

const submit = Effect.gen(function* () {
  yield* Effect.log('submitting');
  throw new SubmitRollback('validation failed');
});

const rethrow = Effect.catchAll(submit, (error: unknown) => {
  throw error;
});

export function CustomerListPage(): unknown {
  void rethrow;
  return <section data-label={label}>{classify('ok')}</section>;
}
