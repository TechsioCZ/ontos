import type { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect } from 'effect';

import { applicationCompositionAuthority, coreRelations } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import type { ActiveApplicationCompositionSnapshot } from '../modules/active-application-composition.ts';
import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../modules/application-composition-authority.ts';

/** The caller supplies PgClient at its test composition root; Core keeps its relations private. */
export const testCoreDatabase = makeWithDefaults({ relations: coreRelations });

/** Release a disposable fixture's dispatch queue without deleting append-only evidence. */
export const deleteTestCoreOutbox = Effect.fn('OwnerEvidence.deleteTestCoreOutbox')(
  function* deleteTestCoreOutboxEffect(client: PgClient.PgClient, tenantId: string) {
    yield* client.unsafe(
      `delete from core.outbox_attempts where outbox_delivery_id in (
    select outbox_delivery_id from core.outbox_deliveries where outbox_message_id in (
      select outbox_message_id from core.outbox_messages where tenant_id = $1))`,
      [tenantId],
    );
    yield* client.unsafe(
      `delete from core.outbox_deliveries where outbox_message_id in (
    select outbox_message_id from core.outbox_messages where tenant_id = $1)`,
      [tenantId],
    );
    yield* client.unsafe('delete from core.outbox_messages where tenant_id = $1', [tenantId]);
  },
);

/** Reset only test authority between sequential package suites; production work-drain checks still run. */
export const publishTestApplicationCompositionAuthority = Effect.fn('OwnerEvidence.publishTestAuthority')(
  function* publishTestAuthorityEffect(executor: CoreDatabaseExecutor, snapshot: ActiveApplicationCompositionSnapshot) {
    yield* executor.transaction(
      Effect.fn('OwnerEvidence.publishTestAuthorityTransaction')(
        function* publishTestAuthorityTransaction(transaction) {
          yield* lockApplicationCompositionPublication(transaction);
          yield* transaction
            .delete(applicationCompositionAuthority)
            .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
          yield* publishApplicationCompositionAuthority(transaction, snapshot);
        },
      ),
    );
  },
);

export { CoreDatabase, CoreDatabaseLive } from '../db/client.ts';
