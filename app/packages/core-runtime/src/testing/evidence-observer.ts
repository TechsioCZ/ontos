// @effect-diagnostics asyncFunction:off
import { sql } from '../db/sql.ts';
import type { CoreReadonlyDbExecutor } from '../db/types.ts';
import { rowsFromResult } from '../sql-result.ts';

export interface ObservedCoreActionAuditEvent {
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly eventType: string;
  readonly outcome: string;
}

export interface ObservedCoreActionOutboxMessage {
  readonly topic: string;
}

export interface ObservedCoreActionEvidence {
  readonly auditEvents: readonly ObservedCoreActionAuditEvent[];
  readonly outboxMessages: readonly ObservedCoreActionOutboxMessage[];
}

export const observeCoreActionEvidence = async ({
  actionInvocationId,
  db,
  tenantId,
}: {
  readonly actionInvocationId: string;
  readonly db: CoreReadonlyDbExecutor;
  readonly tenantId: string;
}): Promise<ObservedCoreActionEvidence> => {
  const auditResult = await db.execute(sql`
    select
      evidence_json as evidence,
      event_type as "eventType",
      outcome
    from core.audit_events
    where action_invocation_id = ${actionInvocationId}
      and tenant_id = ${tenantId}
    order by occurred_at, audit_event_id
  `);
  const outboxResult = await db.execute(sql`
    select message.topic
    from core.outbox_messages as message
    inner join core.domain_events as event
      on event.domain_event_id = message.domain_event_id
      and event.tenant_id = message.tenant_id
    where event.action_invocation_id = ${actionInvocationId}
      and event.tenant_id = ${tenantId}
    order by message.created_at, message.outbox_message_id
  `);
  return {
    auditEvents: [...rowsFromResult<ObservedCoreActionAuditEvent>(auditResult)],
    outboxMessages: [...rowsFromResult<ObservedCoreActionOutboxMessage>(outboxResult)],
  };
};
