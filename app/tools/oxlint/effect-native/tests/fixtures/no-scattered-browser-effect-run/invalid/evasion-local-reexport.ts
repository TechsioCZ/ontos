// expect-count: 1
// Import first, re-export second: the runner still reaches every route module.
import { runEffectRequest } from '../contacts-api.ts';

export { runEffectRequest };
