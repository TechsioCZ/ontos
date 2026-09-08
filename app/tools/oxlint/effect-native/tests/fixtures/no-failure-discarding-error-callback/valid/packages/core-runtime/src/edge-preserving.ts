// Every shape that genuinely reads the failure must stay silent.
import { Effect } from 'effect';

class Failure {
  constructor(readonly fields: { cause: unknown }) {}
}
declare const load: Effect.Effect<number, Error>;
declare const write: () => Promise<void>;

export const interpolated = load.pipe(Effect.mapError((error) => new Failure({ cause: `${String(error)}` })));
export const nested = load.pipe(Effect.mapError((error) => new Failure({ cause: (() => error)() })));
export const renamed = load.pipe(Effect.mapError(({ message: reason }) => new Failure({ cause: reason })));
export const defaulted = load.pipe(Effect.mapError((error = new Error('x')) => new Failure({ cause: error })));
export const methodShorthand = Effect.tryPromise({
  try: write,
  catch(cause) {
    return new Failure({ cause });
  },
});
export const matched = load.pipe(
  Effect.matchEffect({
    onFailure: (cause) => Effect.succeed(new Failure({ cause })),
    onSuccess: (value) => Effect.succeed(value),
  }),
);
export const shadowingInner = load.pipe(
  Effect.mapError((error) => {
    const inner = (error: unknown) => error;
    return new Failure({ cause: inner(error) });
  }),
);
