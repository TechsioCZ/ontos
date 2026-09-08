// expect-count: 1
// A browser-relative import can fetch a chunk. The server-local adapter exception does not apply.
import { Effect } from 'effect';
export const load = Effect.promise(() => import('./chunk.ts'));
