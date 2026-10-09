import { Effect } from 'effect';

import type { CommercePortalAuthDatabaseExecutor } from '../persistence/portal-auth-database-types.ts';
import type { CommercePortalAuthAuditEvent } from './audit-contracts.ts';
import { commercePortalAuthAuditRow } from './audit-mapping.ts';
import { portalAuthAuditEvent } from './audit-tables.ts';
import { commercePortalAuthAuditUnavailable } from './audit-unavailable.ts';
import type { CommercePortalAuthAuditUnavailable } from './audit-unavailable.ts';

/** The handle the executor hands a transaction body; it writes the same tables the executor does. */
export type CommercePortalAuthDatabaseTransaction = Parameters<
  Parameters<CommercePortalAuthDatabaseExecutor['transaction']>[0]
>[0];

/**
 * The audit row for a mutation that actually changed state, written on that mutation's own
 * transaction handle. A refused insert fails the transaction, so the state change rolls back with
 * it and the operation reports the outage instead of committing without evidence. A transaction
 * that changed nothing passes `undefined`: that outcome is a decision, not a state change, and the
 * caller records it through the lenient recorder.
 *
 * Shared by every store that owns such a mutation — the session store's revokes, rotations and
 * account disable, and the recovery store's password-reset ledger consumption — so "the evidence
 * commits with the state change" is one implementation rather than one per owner.
 */
export const writeCommercePortalAuthAuditRow = (
  transaction: CommercePortalAuthDatabaseTransaction,
  audit: CommercePortalAuthAuditEvent | undefined,
): Effect.Effect<void, CommercePortalAuthAuditUnavailable> =>
  audit === undefined
    ? Effect.void
    : transaction
        .insert(portalAuthAuditEvent)
        .values(commercePortalAuthAuditRow(audit))
        .pipe(Effect.asVoid, Effect.mapError(commercePortalAuthAuditUnavailable));
