// FALSE POSITIVE (repo shape: packages/core-runtime/src/db/client.ts:37, verticals/contacts/src/db/client.ts:33,
// apps/shell-super-app/api/auth/db/client.ts:35). A `Effect.acquireRelease` release finalizer is run
// uninterruptibly at scope close; `Effect.timeout`/`Effect.retry` on it is meaningless, and the audit's
// D tier blesses "Promise adapters forced by ... Drizzle, and Node process entrypoints".
import { Effect } from 'effect';

interface PoolResource {
  readonly end: () => Promise<void>;
}

export const acquirePoolResource = <Resource extends PoolResource>(acquire: () => Resource) =>
  Effect.acquireRelease(
    Effect.try({ catch: () => new Error('pool unavailable'), try: acquire }),
    (pool) => Effect.promise(async () => await pool.end()),
  );
