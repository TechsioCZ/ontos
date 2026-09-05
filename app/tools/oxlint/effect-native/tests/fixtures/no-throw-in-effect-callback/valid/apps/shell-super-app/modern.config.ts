// `*.config.ts` is ignored by default: build configuration is not an Effect runtime seam.
import { Effect } from 'effect';

export default Effect.sync(() => {
  throw new Error('missing MODERN_ENV');
});
