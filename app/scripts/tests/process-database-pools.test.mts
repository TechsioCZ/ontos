import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import { startProcessDatabasePools } from '../zerops/process-database-pools.mts';

it.live('owns the process registry through startup and shutdown and rejects a second host', () =>
  Effect.gen(function* scopedHostRegistry() {
    expect(globalThis.ontosDatabasePoolRegistry).toBeUndefined();
    yield* Effect.scoped(
      Effect.gen(function* hostScope() {
        yield* startProcessDatabasePools;
        const registry = globalThis.ontosDatabasePoolRegistry;
        expect(registry).toBeDefined();
        const duplicate = yield* Effect.exit(Effect.scoped(startProcessDatabasePools));
        expect(Exit.isFailure(duplicate)).toBe(true);
        expect(String(duplicate)).toContain('DatabasePoolHostAlreadyStarted');
        expect(globalThis.ontosDatabasePoolRegistry).toBe(registry);
      }),
    );
    expect(globalThis.ontosDatabasePoolRegistry).toBeUndefined();
    yield* Effect.scoped(startProcessDatabasePools);
    expect(globalThis.ontosDatabasePoolRegistry).toBeUndefined();
  }),
);
