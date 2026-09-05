// expect-count: 1
// Browser rule excludes server services under src; the server rule must still own these.
import { Effect } from 'effect';
export const resolve = () => Effect.runPromise(Effect.succeed(1));
