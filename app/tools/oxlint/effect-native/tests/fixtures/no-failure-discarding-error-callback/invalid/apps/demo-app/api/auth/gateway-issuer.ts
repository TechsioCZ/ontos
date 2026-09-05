// expect-count: 6
import { Effect } from 'effect';

class UnavailableError {}

declare const loadPrincipal: Effect.Effect<string, Error>;
declare const loadAudiences: Effect.Effect<string, Error>;
declare const signToken: () => Promise<string>;

export const principal = loadPrincipal.pipe(Effect.mapError(() => new UnavailableError()));

export const audiences = loadAudiences.pipe(Effect.mapError((_error) => new UnavailableError()));

export const configuration = Effect.mapError(loadAudiences, () => new UnavailableError());

export const signed = Effect.tryPromise({
  try: () => signToken(),
  catch: () => new UnavailableError(),
});

export const signedAgain = Effect.tryPromise({
  catch: function (cause) {
    return new UnavailableError();
  },
  try: () => signToken(),
});

export const both = loadPrincipal.pipe(
  Effect.mapBoth({
    onFailure: () => new UnavailableError(),
    onSuccess: (value) => value,
  }),
);
