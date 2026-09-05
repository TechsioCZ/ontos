// expect-count: 1
import { Effect } from 'effect';

declare const load: Effect.Effect<string>;

/**
 * `apps/<app>/api/verticals/<x>/api/index.ts` is app code, not the `verticals/*​/api/index.ts`
 * adapter seam: truncating the path at the last workspace marker would silently exempt it.
 */
export const installed = Effect.runSync(load);
