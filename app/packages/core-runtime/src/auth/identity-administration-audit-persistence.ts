import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { auditEvents, principalCompanyMemberships, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import {
  IdentityAdministrationAuditEvidenceSchema,
  identityAdministrationAuditDetails,
} from './identity-administration-audit-contract.ts';
import type { IdentityAdministrationAuditInputSchema } from './identity-administration-audit-contract.ts';
import { identityAdministrationAuditUnavailable as unavailable } from './identity-administration-audit-unavailable.ts';

export const identityAdministrationAuditFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('IdentityAdministrationAudit.load')(function* load(
    input: typeof IdentityAdministrationAuditInputSchema.Type,
  ) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* unavailable('An exact selected company is required');
    }
    // JSON scalar predicates cannot be expressed as Drizzle column equality. No request supplies SQL or evidence.
    const manageAccount = sql`${auditEvents.evidenceJson}->>'actionKey' = 'core.identity.manage-demo-account'`;
    const actionRows = and(
      eq(auditEvents.legalEntityId, legalEntityId),
      inArray(auditEvents.eventType, ['action.executed', 'action.rejected']),
      input.subjects === 'agents'
        ? or(
            sql`${auditEvents.evidenceJson}->>'actionKey' in ('core.identity.configure-agent', 'core.identity.manage-agent-status', 'core.identity.replace-agent-operators')`,
            and(manageAccount, sql`${auditEvents.evidenceJson}->>'principalKind' = 'agent'`),
          )
        : and(manageAccount, sql`coalesce(${auditEvents.evidenceJson}->>'principalKind', 'human') <> 'agent'`),
    );
    // Retained company membership includes disabled/departed people; a caller can never submit this ID set.
    const retainedPeople = transaction
      .select({ principalId: principalCompanyMemberships.principalId })
      .from(principalCompanyMemberships)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, principalCompanyMemberships.tenantId),
          eq(principals.principalId, principalCompanyMemberships.principalId),
          eq(principals.kind, 'human'),
        ),
      )
      .where(
        and(
          eq(principalCompanyMemberships.tenantId, tenantId),
          eq(principalCompanyMemberships.legalEntityId, legalEntityId),
        ),
      );
    const otherRows =
      input.subjects === 'agents'
        ? and(
            eq(auditEvents.legalEntityId, legalEntityId),
            eq(auditEvents.eventType, 'identity.agent_operators_changed'),
          )
        : and(
            eq(auditEvents.eventType, 'authn.rejected'),
            eq(auditEvents.outcomeCode, 'principal_inactive'),
            // Login can fail before company selection. Such tenant-global evidence belongs only to retained
            // members; an explicitly different company's observation must never cross the selected scope.
            or(isNull(auditEvents.legalEntityId), eq(auditEvents.legalEntityId, legalEntityId)),
            inArray(auditEvents.principalId, retainedPeople),
          );
    const rows = yield* transaction
      .select({
        actorName: principals.displayName,
        auditEventId: auditEvents.auditEventId,
        eventType: auditEvents.eventType,
        evidence: auditEvents.evidenceJson,
        occurredAt: auditEvents.occurredAt,
        outcome: auditEvents.outcome,
        outcomeCode: auditEvents.outcomeCode,
        principalId: auditEvents.principalId,
      })
      .from(auditEvents)
      .leftJoin(
        principals,
        and(eq(principals.tenantId, auditEvents.tenantId), eq(principals.principalId, auditEvents.principalId)),
      )
      .where(and(eq(auditEvents.tenantId, tenantId), or(actionRows, otherRows)))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.auditEventId))
      .limit(80)
      .pipe(Effect.mapError(unavailable));
    const projected = yield* Effect.forEach(
      rows,
      (row) =>
        Schema.decodeUnknownEffect(IdentityAdministrationAuditEvidenceSchema)(row.evidence).pipe(
          Effect.flatMap((evidence) => identityAdministrationAuditDetails(evidence, row.eventType, row.principalId)),
          Effect.map((details) => ({ details, row })),
          Effect.mapError(unavailable),
        ),
      { concurrency: 1 },
    );
    const targetIds = [
      ...new Set(projected.flatMap(({ details }) => Option.toArray(details.targetPrincipalId ?? Option.none()))),
    ];
    const targets =
      targetIds.length === 0
        ? []
        : yield* transaction
            .select({ displayName: principals.displayName, principalId: principals.principalId })
            .from(principals)
            .where(and(eq(principals.tenantId, tenantId), inArray(principals.principalId, targetIds)))
            .pipe(Effect.mapError(unavailable));
    const names = new Map(targets.map((row) => [row.principalId, row.displayName]));
    return projected.map(({ details, row: { evidence: _evidence, principalId: _principalId, ...row } }) => {
      const targetId = Option.getOrUndefined(details.targetPrincipalId ?? Option.none());
      const targetName = targetId === undefined ? Option.none<string>() : Option.fromUndefinedOr(names.get(targetId));
      return {
        ...row,
        details,
        targetName:
          Option.isSome(targetName) || targetId === undefined ? targetName : (details.displayName ?? Option.none()),
      };
    });
  }),
});
