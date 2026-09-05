// Nothing here is Effect's `Effect`.
class Failure {}
declare const write: () => Promise<void>;

const Effect = {
  mapError: (_f: () => Failure) => undefined,
  tryPromise: (_options: { try: () => Promise<void>; catch: () => Failure }) => undefined,
};

export const shadowed = Effect.mapError(() => new Failure());
export const shadowedTry = Effect.tryPromise({ try: write, catch: () => new Failure() });

// A local `mapError` that has nothing to do with Effect.
const mapError = (_f: () => Failure) => undefined;
export const local = mapError(() => new Failure());

// Promise `.catch` is not Effect's `catch`.
export const promised = write().catch(() => undefined);

export function View() {
  return <div>{String(shadowed)}</div>;
}
