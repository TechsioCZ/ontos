import type { CoreTransaction } from '../../../packages/core-runtime/src/db/types.ts';
import { lockApplicationCompositionPublication } from '../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';

/** Settles only publication accounting for completed, lease-free owner answers awaiting review. */
export const settleParkedEnrollmentPublicationWork = Effect.fn('Enrollment.settleParkedPublicationWork')(
  function* settleParkedEnrollmentPublicationWorkEffect(transaction: CoreTransaction, expectedRevision: string) {
    // Use the publisher's fence before locking owner rows. Never upgrade a shared owner lock
    // after taking row locks: an admitted owner could otherwise wait on the same rows.
    yield* lockApplicationCompositionPublication(transaction);
    const [schema] = yield* transaction.execute<{ readonly installed: boolean }>(
      sql`select to_regclass('commerce_customer_context.portal_enrollment_owner_operations') is not null as installed`,
      'objects',
    );
    if (!schema?.installed) {
      return 0;
    }
    const [answer] = yield* transaction.execute<{ readonly settled: number }>(
      sql`with parked as materialized (
        select work.owner_module_key, work.original_revision, work.work_id
        from core.application_composition_durable_work work
        join commerce_customer_context.portal_enrollment_owner_operations operation
          on work.work_id = 'enrollment-operation:' || operation.tenant_id || ':'
            || operation.portal_enrollment_attempt_id || ':' || operation.owner_invocation_id
        join commerce_customer_context.portal_enrollment_attempts attempt
          on attempt.tenant_id = operation.tenant_id
          and attempt.portal_enrollment_attempt_id = operation.portal_enrollment_attempt_id
        join core.application_composition_authority authority on authority.authority_key = 'active'
        where work.owner_module_key = 'commerce.customer-context'
          and work.original_revision = ${expectedRevision}
          and coalesce(attempt.continuation_composition_revision, attempt.composition_revision) = work.original_revision
          and authority.revision = work.original_revision and authority.phase = 'active'
          and authority.durable_work_admission = 'closed' and authority.valid_until > clock_timestamp()
          and attempt.state = 'RECONCILIATION_REQUIRED'
          and attempt.lease_owner is null and attempt.lease_token is null and attempt.lease_expires_at is null
          and operation.status = 'FAILED' and operation.failure_code = 'owner_reconciliation_required'
          and operation.completed_at is not null
          and operation.lease_owner is null and operation.lease_token is null and operation.lease_expires_at is null
        for update of attempt, operation skip locked
      )
      select count(*)::integer as settled from (
        select core.track_application_composition_durable_work(
          owner_module_key, original_revision, work_id, false
        ) from parked
      ) settlement`,
      'objects',
    );
    return answer?.settled ?? 0;
  },
);
