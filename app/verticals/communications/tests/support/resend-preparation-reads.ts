import { and, asc, eq, getTableColumns, inArray, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { effectPgCodecs } from 'drizzle-orm/effect-postgres';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Effect, Predicate } from 'effect';
import type { ActionTestPreparationReadScript } from '@app/core-runtime/testing/actions';
import {
  communicationRequests,
  communicationDecisions,
  messageIntents,
  deliveryAttempts,
  providerObservationConflicts,
  intentDocumentPins,
  providerObservations,
  intentRecoveryEvaluations,
  intentResendLinks,
  providerObservationConflictResolutions,
  attemptRetryLinks,
  intentHandoffStops,
} from '../../src/database/schema.ts';
import type { StoredJson } from '../../src/database/schema.ts';
import type { ResendOriginalFacts } from '../../src/domain/recovery/resend-admission.ts';

type SnapshotRow = Readonly<Record<string, StoredJson | Date | undefined>>;

const rowFor = (table: PgTable, values: SnapshotRow) =>
  Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      column.name,
      Predicate.isDate(values[key]) ? values[key].toISOString() : (values[key] ?? null),
    ]),
  );

/** Native-shaped snapshot rows for a final suppressed original; no authority or handler is replaced. */
export const resendPreparationReads = (
  tenantId: string,
  originals: Readonly<Record<string, ResendOriginalFacts>>,
): readonly ActionTestPreparationReadScript[] => {
  const builder = new QueryBuilder({ codecs: effectPgCodecs });
  const originalId = '33333333-3333-4333-8333-333333333333';
  const requestId = '33333333-3333-4333-8333-333333333334';
  const decisionId = '33333333-3333-4333-8333-333333333335';
  const original = originals[originalId];
  const now = new Date('2026-11-19T10:00:00Z');
  const tableRead = (table: PgTable, where: SQL | undefined, values?: SnapshotRow, order?: SQL) => {
    const query = builder.select().from(table).where(where);
    const { sql } = (order === undefined ? query : query.orderBy(order)).toSQL();
    return {
      execute: () => Effect.succeed(original === undefined || values === undefined ? [] : [rowFor(table, values)]),
      sql,
    };
  };
  const lookup = builder
    .select({
      requestId: messageIntents.requestId,
      scopeKey: communicationRequests.scopeKey,
      sourceModule: communicationRequests.sourceModule,
      typeId: messageIntents.typeId,
    })
    .from(messageIntents)
    .innerJoin(
      communicationRequests,
      and(
        eq(communicationRequests.tenantId, messageIntents.tenantId),
        eq(communicationRequests.requestId, messageIntents.requestId),
      ),
    )
    .where(and(eq(messageIntents.tenantId, tenantId), eq(messageIntents.intentId, originalId)))
    .toSQL().sql;
  const scripts: ActionTestPreparationReadScript[] = [
    {
      execute: () =>
        Effect.succeed(
          original === undefined
            ? []
            : [
                {
                  request_id: requestId,
                  scope_key: original.scopeKey,
                  source_module: original.sourceModule,
                  type_id: original.typeId,
                },
              ],
        ),
      sql: lookup,
    },
    tableRead(
      communicationRequests,
      and(eq(communicationRequests.tenantId, tenantId), inArray(communicationRequests.requestId, [requestId])),
      {
        occurrenceId: 'original',
        occurrenceRevision: 1,
        payload: { scope: { tenantId } },
        purpose: 'fixture.single',
        receivedAt: now,
        requestId,
        sourceModule: original?.sourceModule,
        tenantId,
      },
    ),
    tableRead(
      communicationDecisions,
      and(eq(communicationDecisions.tenantId, tenantId), inArray(communicationDecisions.requestId, [requestId])),
      {
        decidedAt: now,
        decisionId,
        outcome: 'MESSAGE_INTENTS',
        requestId,
        requiredness: 'OPTIONAL',
        tenantId,
        unresolvedSlots: [],
      },
    ),
    tableRead(
      messageIntents,
      and(eq(messageIntents.tenantId, tenantId), inArray(messageIntents.requestId, [requestId])),
      {
        createdAt: now,
        intentId: originalId,
        recipientId: 'customer-1',
        recipientModule: 'fixture.source',
        recipientRole: 'original-recipient',
        recipientType: 'fixture.recipient',
        requestId,
        slotKey: 'primary',
        status: 'SUPPRESSED',
        tenantId,
        typeId: original?.typeId,
        typeRevision: 1,
      },
      asc(messageIntents.intentKey),
    ),
  ];
  for (const table of [
    deliveryAttempts,
    providerObservationConflicts,
    providerObservations,
    intentRecoveryEvaluations,
    providerObservationConflictResolutions,
    attemptRetryLinks,
    intentHandoffStops,
  ]) {
    scripts.push(tableRead(table, and(eq(table.tenantId, tenantId), inArray(table.intentId, [originalId]))));
  }
  scripts.push(
    tableRead(
      intentDocumentPins,
      and(eq(intentDocumentPins.tenantId, tenantId), inArray(intentDocumentPins.intentId, [originalId])),
      undefined,
      asc(intentDocumentPins.position),
    ),
    tableRead(
      intentResendLinks,
      and(
        eq(intentResendLinks.tenantId, tenantId),
        or(
          inArray(intentResendLinks.originalIntentId, [originalId]),
          inArray(intentResendLinks.resendIntentId, [originalId]),
        ),
      ),
    ),
  );
  return scripts;
};
