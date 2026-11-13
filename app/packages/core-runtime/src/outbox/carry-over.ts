/**
 * The one definition of Outbox work that may cross a release boundary.
 *
 * The drain predicate, the publisher's pre-flight and the operator's pre-flight command all ask this exact
 * question, so what the pre-flight exempts is precisely what the drain carries over. It lives in its own leaf
 * module for that reason: the authority module and the Outbox repository both depend on it, neither on the other.
 *
 * Safety does not rest on this predicate alone — see `coreSystemCarryOverRule` below.
 */
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { outboxDeliveries, outboxDeliveryResolutions, outboxMessages } from '../db/schema.ts';

/**
 * What the carry-over of Core's own work depends on, beyond the proven-identical descriptor:
 *
 * - The handler is a whole-tenant reconcile that projects authorization from PostgreSQL intent and **ignores its
 *   message payload** (`core-system-worker-entry.ts`: `reconcileTenantFromClaim` takes `_payload`), so the next
 *   release reaching the same state does not depend on the payload it was written with.
 * - It is idempotent: a tenant that already carries the intent projects nothing.
 * - Topics are versioned (`core.identity.principal-lifecycle-changed.v1`). **The rule the carry-over depends on:
 *   a change to a core-system payload schema requires a new topic version.** A reused topic with a changed schema
 *   would hand the next release a message its handler decodes differently, which the descriptor equivalence
 *   cannot see — the descriptor pins the topic and the entrypoint, not the schema or the handler body.
 *
 * `scripts/tests/core-system-carry-over.test.mts` pins each core-system worker key to its versioned topic, so
 * reusing a topic for a changed shape has to be an explicit, reviewed edit.
 */
export const coreSystemCarryOverRule =
  'A core-system payload schema change requires a new topic version; the carry-over proves the descriptor, not the schema.';

/**
 * Work the retiring revision hands to the next one: Core's own untouched delivery under a proven-identical
 * descriptor, whose message is matched and carries no completion debt of the retiring revision, and which no
 * operator has resolved.
 *
 * Every condition is load-bearing:
 * - `pending`, `attempts_count = 0`, `claimed_by is null`: nothing has run it, so nothing is half-done.
 * - matched: an unmatched message still owes deliveries, which only the retiring authority's subscriptions decide.
 * - no `completion_original_revision`: tracked completion debt belongs to the revision that accepted it.
 * - no `core.outbox_delivery_resolutions` row: a redriven delivery is also pending with zero attempts and no
 *   claim, but an operator chose to run it on *this* release, so this release drains it.
 */
export const carriesOverToNextRelease = (carriedOverWorkerKeys: readonly string[]): SQL | undefined => {
  if (carriedOverWorkerKeys.length === 0) {
    return undefined;
  }
  const keys = sql.join(
    carriedOverWorkerKeys.map((workerKey) => sql`${workerKey}`),
    sql`, `,
  );
  return sql`(
    ${outboxDeliveries.status} = 'pending'
    and ${outboxDeliveries.attemptsCount} = 0
    and ${outboxDeliveries.claimedBy} is null
    and ${outboxDeliveries.workerKey} in (${keys})
    and exists (
      select 1 from ${outboxMessages}
      where ${outboxMessages.outboxMessageId} = ${outboxDeliveries.outboxMessageId}
        and ${outboxMessages.matchedAt} is not null
        and ${outboxMessages.completionOriginalRevision} is null
    )
    and not exists (
      select 1 from ${outboxDeliveryResolutions}
      where ${outboxDeliveryResolutions.outboxDeliveryId} = ${outboxDeliveries.outboxDeliveryId}
    )
  )`;
};
