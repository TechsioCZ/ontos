import { Effect, Layer } from 'effect';

import { CommercePortalAuthDatabase } from '../persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from '../persistence/portal-auth-database-types.ts';
import { portalAuthAuditEvent } from './audit-tables.ts';
import type { CommercePortalAuthAuditEvent } from './audit-contracts.ts';
import { commercePortalAuthAuditRecord } from './audit-mapping.ts';
import { CommercePortalAuthAudit } from './audit-service.ts';
import type { CommercePortalAuthAuditRecorder } from './audit-service.ts';
import { CommercePortalAuthAuditUnavailable } from './audit-unavailable.ts';

const withCause = <ErrorValue extends object>(error: ErrorValue, cause: unknown): ErrorValue =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

const unavailable = (cause: unknown): CommercePortalAuthAuditUnavailable =>
  withCause(
    new CommercePortalAuthAuditUnavailable({
      operation: 'audit-record',
      reason: 'Commerce portal authentication audit evidence could not be persisted',
    }),
    cause,
  );

/**
 * One event becomes exactly one row. The insert projects through the audit record first, so a
 * field that is not part of the published record shape cannot reach a column even if a caller
 * attaches it to the in-process event.
 */
export const makeCommercePortalAuthAuditRecorder = (
  executor: CommercePortalAuthDatabaseExecutor,
): CommercePortalAuthAuditRecorder => ({
  record: (event: CommercePortalAuthAuditEvent) => {
    const record = commercePortalAuthAuditRecord(event);
    return executor
      .insert(portalAuthAuditEvent)
      .values({
        eventType: record.eventType,
        occurredAt: event.occurredAt,
        operation: record.operation ?? null,
        outcome: record.outcome,
        providerSubjectId: record.providerSubjectId ?? null,
        schemaVersion: record.schemaVersion,
        sessionRef: record.sessionRef ?? null,
        subjectDigest: record.subjectDigest ?? null,
      })
      .pipe(Effect.asVoid, Effect.mapError(unavailable));
  },
});

/** The single Layer the composition root wires for Commerce portal authentication audit evidence. */
export const CommercePortalAuthAuditLive = Layer.effect(
  CommercePortalAuthAudit,
  Effect.gen(function* makeCommercePortalAuthAuditLive() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthAuditRecorder(database.executor);
  }),
);
