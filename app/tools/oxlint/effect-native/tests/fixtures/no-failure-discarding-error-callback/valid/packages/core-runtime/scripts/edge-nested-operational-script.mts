import { Effect } from 'effect';

class SchemaVerificationFailed {}
declare const verify: () => Promise<void>;

// Package-local operational scripts (audit B3, D tier) are out of scope, exactly like the five real
// `packages/*/scripts`, `apps/*/scripts` and `verticals/*/scripts` entrypoints.
export const program = Effect.tryPromise({ try: verify, catch: () => new SchemaVerificationFailed() });
