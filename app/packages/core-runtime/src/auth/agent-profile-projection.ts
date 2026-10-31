import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { auditEvents } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { AgentProfileSchema, ConfigureAgentAuditEvidenceSchema } from '../modules/actions/configure-agent.action.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';

export const AgentProfileProjectionSchema = Schema.Struct({
  description: AgentProfileSchema.fields.description,
  hasProfile: Schema.Boolean,
  modules: AgentProfileSchema.fields.modules,
  ownerPrincipalId: AgentProfileSchema.fields.ownerPrincipalId,
  writePolicy: AgentProfileSchema.fields.writePolicy,
});
export type AgentProfile = typeof AgentProfileProjectionSchema.Type;

/** An absent or corrupt authoritative profile confers neither modules nor write authority. */
export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  description: null,
  hasProfile: false,
  modules: [],
  ownerPrincipalId: null,
  writePolicy: 'read_only',
};
export interface AgentProfileAuditRow {
  readonly evidence: unknown;
}
const TargetSchema = Schema.Struct({
  legalEntityId: ConfigureAgentAuditEvidenceSchema.fields.legalEntityId,
  targetPrincipalId: ConfigureAgentAuditEvidenceSchema.fields.targetPrincipalId,
});
const RevisionSchema = Schema.Struct({ revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) });

/** Only native exact-company evidence creates a profile; input order cannot supersede a higher revision. */
export const foldAgentProfiles = (
  legalEntityId: string,
  principalIds: readonly string[],
  evidenceOldestFirst: readonly AgentProfileAuditRow[],
): ReadonlyMap<string, AgentProfile> => {
  const wanted = new Set(principalIds);
  const profiles = new Map(principalIds.map((principalId) => [principalId, DEFAULT_AGENT_PROFILE]));
  const revisions = new Map<string, number>();
  for (const row of evidenceOldestFirst) {
    const target = Schema.decodeUnknownOption(TargetSchema)(row.evidence);
    if (
      Option.isNone(target) ||
      !wanted.has(target.value.targetPrincipalId) ||
      target.value.legalEntityId !== legalEntityId
    ) {
      continue;
    }
    const { targetPrincipalId } = target.value;
    const version = Schema.decodeUnknownOption(RevisionSchema)(row.evidence);
    const revision = Option.isSome(version) ? version.value.revision : Number.POSITIVE_INFINITY;
    if (revision > (revisions.get(targetPrincipalId) ?? 0)) {
      revisions.set(targetPrincipalId, revision);
      const parsed = Schema.decodeUnknownOption(ConfigureAgentAuditEvidenceSchema)(row.evidence);
      if (Option.isNone(parsed)) {
        profiles.set(targetPrincipalId, DEFAULT_AGENT_PROFILE);
      } else {
        const evidence = parsed.value;
        profiles.set(targetPrincipalId, {
          description: evidence.description,
          hasProfile: true,
          modules: evidence.modules,
          ownerPrincipalId: evidence.ownerPrincipalId,
          writePolicy: evidence.writePolicy,
        });
      }
    }
  }
  return profiles;
};

export const agentProfileReadUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Agent profiles are temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Core-internal scoped service shared by the two governed Reads, never an application database port. */
export const agentProfilesFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('AgentProfiles.load')(function* load(principalIds: readonly string[]) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* agentProfileReadUnavailable('An exact company context is required');
    }
    if (principalIds.length === 0) {
      return foldAgentProfiles(legalEntityId, [], []);
    }
    const rows = yield* transaction
      .select({ evidence: auditEvents.evidenceJson })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.legalEntityId, legalEntityId),
          eq(auditEvents.eventType, 'action.executed'),
          eq(auditEvents.outcome, 'succeeded'),
          sql`${auditEvents.evidenceJson}->>'actionKey' = 'core.identity.configure-agent'`,
          sql`${auditEvents.evidenceJson}->>'operation' in ('create-agent', 'configure-agent')`,
          inArray(sql<string>`${auditEvents.evidenceJson}->>'targetPrincipalId'`, [...principalIds]),
        ),
      )
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.auditEventId))
      .pipe(Effect.mapError(agentProfileReadUnavailable));
    return foldAgentProfiles(legalEntityId, principalIds, rows);
  }),
});
