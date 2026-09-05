import type { runPromise, runSync } from 'effect/Effect';

/**
 * A type-only import is erased at compile time and can only appear in type positions, so no
 * reference to it can execute a program. `edge-type-positions.ts` covers the member form
 * (`typeof Effect.runSync`); the bare-identifier form must be treated identically.
 */
export type Runner = typeof runPromise;

export interface Ports {
	readonly run: typeof runSync;
}
