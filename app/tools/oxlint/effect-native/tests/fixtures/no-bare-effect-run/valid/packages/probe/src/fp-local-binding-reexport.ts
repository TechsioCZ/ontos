import { runPromise } from 'effect/Effect';

/**
 * A re-export of a local import binding forwards a value; it starts no fiber. `edge-reexport.ts`
 * already covers the source-less form `export { runPromise } from "effect/Effect"`, which the rule
 * does not track at all — the two shapes must behave the same. (Today this file also produces two
 * identical diagnostics on the same span.)
 */
export { runPromise };
