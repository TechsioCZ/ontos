// expect-count: 4
// A4/A5 evasion: `Effect.match*` is the same dual-handler shape as `Effect.mapBoth`, and a
// zero-arity `onFailure` collapses every failure reason exactly the same way. Six real sites do
// this today (permissions/service.ts:215, permissions/context-access.ts:174 and :272,
// auth/identity-lifecycle.ts:376, :400, :410).
import { Effect } from 'effect';

class Unavailable {}
declare const load: Effect.Effect<number, Error>;

export const matched = load.pipe(Effect.match({ onFailure: () => new Unavailable(), onSuccess: (value) => value }));

export const matchedEffect = Effect.matchEffect(load, {
  onFailure: () => Effect.succeed(new Unavailable()),
  onSuccess: (value) => Effect.succeed(value),
});

export const matchedCause = load.pipe(
  Effect.matchCause({ onFailure: () => new Unavailable(), onSuccess: (value) => value }),
);

export const matchedCauseEffect = load.pipe(
  Effect.matchCauseEffect({
    onFailure: () => Effect.succeed(new Unavailable()),
    onSuccess: (value) => Effect.succeed(value),
  }),
);
