import { Effect, Layer } from 'effect';

import { CommercePortalAuthDatabase } from '../persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from '../persistence/portal-auth-database-types.ts';
import { portalAuthAuditEvent } from './audit-tables.ts';
import type { CommercePortalAuthAuditEvent } from './audit-contracts.ts';
import { commercePortalAuthAuditRow } from './audit-mapping.ts';
import { CommercePortalAuthAudit } from './audit-service.ts';
import type { CommercePortalAuthAuditRecorder } from './audit-service.ts';
import { commercePortalAuthAuditUnavailable } from './audit-unavailable.ts';

/**
 * One event becomes exactly one row. The insert projects through the audit record first, so a
 * field that is not part of the published record shape cannot reach a column even if a caller
 * attaches it to the in-process event.
 *
 * This recorder writes on its own executor, outside whatever transaction the caller is in. That is
 * the right shape for a decision-only fact — a refused sign-in, a rate-limited attempt, a session
 * read — and the wrong shape for a state change, which must leave its evidence inside the same
 * transaction. The session store owns that strict path (`../persistence/portal-auth-session-store.ts`).
 */
export const makeCommercePortalAuthAuditRecorder = (
  executor: CommercePortalAuthDatabaseExecutor,
): CommercePortalAuthAuditRecorder => ({
  record: (event: CommercePortalAuthAuditEvent) =>
    executor
      .insert(portalAuthAuditEvent)
      .values(commercePortalAuthAuditRow(event))
      .pipe(Effect.asVoid, Effect.mapError(commercePortalAuthAuditUnavailable)),
});

/** The single Layer the composition root wires for Commerce portal authentication audit evidence. */
export const CommercePortalAuthAuditLive = Layer.effect(
  CommercePortalAuthAudit,
  Effect.gen(function* makeCommercePortalAuthAuditLive() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthAuditRecorder(database.executor);
  }),
);
