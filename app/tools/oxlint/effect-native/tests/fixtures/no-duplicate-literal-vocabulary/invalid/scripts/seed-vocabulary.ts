// expect-count: 1
// Bare member imports from `effect/Schema`, in a script.
import { Literals, Struct } from 'effect/Schema';

const draft = Struct({ lifecycle: Literals(['draft', 'live', 'archived']) });
const published = Struct({ lifecycle: Literals(['live', 'archived', 'draft']) });

export const seed = Struct({ draft, published });
