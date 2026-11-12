/**
 * The host side of module credential healing: which module keys are still live. It reads the key store, so it lives
 * apart from the channel code the owners process and the Outbox Worker host load.
 */
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';

import { AUTH_SCHEMA_NAME } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { loadPlatformCredentialBindings } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import type { CoreDatabaseExecutor } from '../../packages/core-runtime/src/db/types.ts';

/**
 * Which of the keys the host holds are live now: bound (an active binding) and still verifying in the key store
 * (enabled and not past their end). A key disabled while its binding stayed active, or one that ended, is not live, so
 * healing notices it within a minute instead of at its next rotation.
 */
export const liveModuleKeyIds = Effect.fn('ModuleCredentials.liveKeyIds')(function* liveKeyIds(
  executor: Pick<CoreDatabaseExecutor, 'execute' | 'select'>,
  held: readonly string[],
) {
  if (held.length === 0) {
    return new Set<string>();
  }
  // Bound: an active binding in whatever tenant the key is bound in (the platform tenant for a module key, the
  // workload's tenant for an internal workload key).
  const bound = new Set(
    (yield* loadPlatformCredentialBindings(executor, held)).map(({ providerKeyId }) => providerKeyId),
  );
  const verifying = yield* executor.execute<{ readonly id: string }>(
    sql`select id from ${sql.identifier(AUTH_SCHEMA_NAME)}.apikey where id in (${sql.join(
      held.map((providerKeyId) => sql`${providerKeyId}`),
      sql`, `,
    )}) and enabled and (expires_at is null or expires_at > now())`,
    'objects',
  );
  const verified = new Set(verifying.map(({ id }) => id));
  return new Set(held.filter((providerKeyId) => bound.has(providerKeyId) && verified.has(providerKeyId)));
});
