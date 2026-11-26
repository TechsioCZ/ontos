import { and, eq, sql } from 'drizzle-orm';
import { effectPgCodecs } from 'drizzle-orm/effect-postgres';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { Effect } from 'effect';
import type { ActionTestPreparationReadScript } from '@app/core-runtime/testing/actions';
import {
  communicationRequests,
  messageIntents,
  deliveryAttempts,
  providerObservations,
  providerObservationConflicts,
  providerObservationConflictResolutions,
  intentRecoveryEvaluations,
  intentHandoffStops,
} from '../../src/database/schema.ts';
import type { ResendOriginalFacts } from '../../src/domain/recovery/resend-admission.ts';

/** Native-shaped snapshot rows for a final suppressed original; no authority or handler is replaced. */
export const resendPreparationReads = (
  tenantId: string,
  originals: Readonly<Record<string, ResendOriginalFacts>>,
): readonly ActionTestPreparationReadScript[] => {
  const builder = new QueryBuilder({ codecs: effectPgCodecs });
  const originalId = '33333333-3333-4333-8333-333333333333';
  const original = originals[originalId];
  const lookup = builder
    .select({
      scopeKey: communicationRequests.scopeKey,
      sourceModule: communicationRequests.sourceModule,
      status: messageIntents.status,
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
    .where(
      and(
        eq(messageIntents.tenantId, tenantId),
        eq(messageIntents.intentId, originalId),
        eq(communicationRequests.sourceModule, 'fixture.source'),
        eq(communicationRequests.scopeKey, 'scope'),
      ),
    )
    .toSQL().sql;
  const scripts: ActionTestPreparationReadScript[] = [
    {
      execute: ({ params }) =>
        Effect.succeed(
          original === undefined || original.sourceModule !== params[2] || original.scopeKey !== params[3]
            ? []
            : [
                {
                  scope_key: original.scopeKey,
                  source_module: original.sourceModule,
                  status: 'SUPPRESSED',
                  type_id: original.typeId,
                },
              ],
        ),
      sql: lookup,
    },
  ];
  const queries = [
    builder
      .select({
        attemptId: deliveryAttempts.attemptId,
        reason: sql<string | null>`${deliveryAttempts.evidence}->>'reason'`,
        state: deliveryAttempts.state,
      })
      .from(deliveryAttempts)
      .where(and(eq(deliveryAttempts.tenantId, tenantId), eq(deliveryAttempts.intentId, originalId))),
    builder
      .select({
        attemptId: providerObservations.attemptId,
        kind: providerObservations.kind,
        recordedAt: providerObservations.recordedAt,
      })
      .from(providerObservations)
      .where(and(eq(providerObservations.tenantId, tenantId), eq(providerObservations.intentId, originalId))),
    builder
      .select({ conflictId: providerObservationConflicts.conflictId })
      .from(providerObservationConflicts)
      .where(
        and(eq(providerObservationConflicts.tenantId, tenantId), eq(providerObservationConflicts.intentId, originalId)),
      ),
    builder
      .select({
        conflictId: providerObservationConflictResolutions.conflictId,
        resolvedAt: providerObservationConflictResolutions.resolvedAt,
      })
      .from(providerObservationConflictResolutions)
      .where(
        and(
          eq(providerObservationConflictResolutions.tenantId, tenantId),
          eq(providerObservationConflictResolutions.intentId, originalId),
        ),
      ),
    builder
      .select({ outcome: intentRecoveryEvaluations.outcome, proven: intentRecoveryEvaluations.proven })
      .from(intentRecoveryEvaluations)
      .where(and(eq(intentRecoveryEvaluations.tenantId, tenantId), eq(intentRecoveryEvaluations.intentId, originalId))),
    builder
      .select({ proven: intentHandoffStops.proven })
      .from(intentHandoffStops)
      .where(and(eq(intentHandoffStops.tenantId, tenantId), eq(intentHandoffStops.intentId, originalId))),
  ];
  for (const query of queries) {
    scripts.push({ execute: () => Effect.succeed([]), sql: query.toSQL().sql });
  }
  return scripts;
};
