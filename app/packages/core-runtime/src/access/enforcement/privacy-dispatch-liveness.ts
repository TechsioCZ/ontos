import { sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import type { RegisteredGatewayPrivacyDispatch } from '../../auth/system-principal-context-provenance.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';

export interface PrivacyDispatchLiveness {
  readonly read: (
    scope: OperationalScope,
    dispatch: RegisteredGatewayPrivacyDispatch,
    transaction?: CoreTransaction,
  ) => Effect.Effect<boolean, AccessDecisionUnavailable>;
}
/** Finite cross-owner Privacy dispatch evidence; the generic same-producer workload protocol stays unchanged. */
const makePrivacyDispatchLiveness = (
  database: Pick<CoreDatabaseExecutor, 'transaction'>,
  enrollment: DatabaseIdentityEnrollment,
): PrivacyDispatchLiveness => ({
  read: (scope, dispatch, transaction) => {
    const { authority } = dispatch;
    if (authority === undefined) {
      return Effect.succeed(false);
    }
    const query = (current: CoreTransaction) =>
      current
        .execute<{ readonly active: boolean }>(
          sql`
      select exists(
        select 1 from core.outbox_deliveries d
        join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
        join core.domain_events e on e.domain_event_id=m.domain_event_id and e.tenant_id=m.tenant_id
        join core.action_invocations a on a.action_invocation_id=e.action_invocation_id and a.tenant_id=m.tenant_id
        join core.principals p on p.tenant_id=a.tenant_id and p.principal_id=a.principal_id
        join core.principal_auth_bindings b on b.tenant_id=a.tenant_id and b.principal_auth_binding_id=a.auth_binding_id
        where d.outbox_delivery_id=${dispatch.deliveryId}::uuid and m.outbox_message_id=${dispatch.messageId}::uuid
          and e.domain_event_id=${dispatch.domainEventId}::uuid and a.action_invocation_id=${dispatch.dispatchInvocationId}::uuid
          and m.tenant_id=${scope.tenantId}::uuid and a.principal_id=${scope.principalId}::uuid
          and a.legal_entity_id=${dispatch.governanceLegalEntityId}::uuid and a.status='succeeded'
          and a.action_key=${authority.originActionKey} and p.kind='human' and p.status='active'
          and b.principal_id=p.principal_id and b.status='active' and b.revoked_at is null
          and d.worker_key=${authority.workerKey} and d.consumer_module_key=${authority.consumerModuleKey}
          and m.producer_module_key=${authority.producerModuleKey} and m.topic=${authority.topic}
          and e.producer_module_key=${authority.producerModuleKey} and e.subject_resource_type=${authority.subjectResourceType}
          and e.subject_resource_id=${dispatch.measureId}
          and (${dispatch.sourceMode}='dispatch' or (d.status='processing' and d.claimed_by=${dispatch.claimId ?? ''} and d.claim_expires_at>statement_timestamp()))
      ) as active`,
          'objects',
        )
        .pipe(Effect.map((rows) => rows.length === 1 && rows[0]?.active === true));
    return (
      transaction === undefined
        ? database.transaction((current) =>
            installOperationalScope(current, scope, enrollment).pipe(Effect.andThen(() => query(current))),
          )
        : query(transaction)
    ).pipe(Effect.mapError((cause) => accessDecisionUnavailable('The native Privacy dispatch is unavailable', cause)));
  },
});

export class PrivacyDispatchLivenessSource extends Context.Service<
  PrivacyDispatchLivenessSource,
  PrivacyDispatchLiveness
>()('@app/core-runtime/access/enforcement/privacy-dispatch-liveness/PrivacyDispatchLivenessSource') {}

export const PrivacyDispatchLivenessSourceLive = Layer.effect(
  PrivacyDispatchLivenessSource,
  Effect.gen(function* privacyDispatchLivenessLive() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makePrivacyDispatchLiveness(database.executor, enrollment);
  }),
);
