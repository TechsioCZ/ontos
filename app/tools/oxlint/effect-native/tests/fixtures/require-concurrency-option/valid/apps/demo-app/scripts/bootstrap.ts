import { Effect } from 'effect';

declare const steps: readonly string[];
declare const apply: (step: string) => Effect.Effect<void>;

// Package-local `scripts/` directories are excluded exactly like the top-level one.
export const bootstrap = Effect.forEach(steps, apply);
