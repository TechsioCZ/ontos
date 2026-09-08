// Lookalike callees that are not Effect's, plus a block-scoped shadow of the real import.
import { Effect } from 'effect';

class Failure {}
declare const load: Effect.Effect<number, Error>;
declare const write: () => Promise<void>;

export const promiseCatch = write().catch(() => undefined);
export const chainedPromiseCatch = write()
  .then(() => 1)
  .catch(() => 0);

export function shadowedInBlock() {
  const Effect = { mapError: (_f: () => Failure) => undefined };
  return Effect.mapError(() => new Failure());
}

const helpers = { mapError: (_f: () => Failure) => undefined };
export const notEffect = helpers.mapError(() => new Failure());

export const Panel = () => <section>{String(load.pipe(Effect.catchTag('Gone', () => Effect.void)))}</section>;
