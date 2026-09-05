// "Existing patterns to preserve": one outer process/framework adapter seam. The throw lives in the
// adapter itself, outside every Effect callback.
import { Effect } from 'effect';

declare const program: Effect.Effect<number, Error>;

export async function main(): Promise<number> {
  const result = await Effect.runPromise(program);
  if (!Number.isFinite(result)) {
    throw new Error('the shell runtime produced a non-finite result');
  }
  return result;
}
