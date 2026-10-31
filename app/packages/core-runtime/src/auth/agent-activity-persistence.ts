import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { agentProposals, principals, auditEvents, actionInvocations, dataAccessEvents } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { activityActorsFromTransaction } from './agent-activity-actors-read.ts';
import type { AgentActivityRequestSchema } from './agent-activity-contract.ts';
import {
  AgentActivityResultSchema,
  AgentActivityRiskSchema,
  AgentActivityStatusSchema,
  AGENT_ACTIVITY_CANDIDATE_LIMIT,
} from './agent-activity-contract.ts';
import { agentProfilesFromTransaction } from './agent-profile-projection.ts';
import { agentActivityUnavailable as unavailable } from './agent-activity-unavailable.ts';

const toRow = (dbRow: typeof agentProposals.$inferSelect) => ({
  actionSlug: dbRow.actionSlug,
  agentLabel: dbRow.agentLabel,
  agentPrincipalId: dbRow.agentPrincipalId,
  appId: dbRow.appId,
  appliedAt: dbRow.appliedAt,
  applyResult: dbRow.applyResultJson,
  batchId: dbRow.batchId,
  batchInstruction: dbRow.batchInstruction,
  batchRevertedAt: dbRow.batchRevertedAt,
  batchRevertedByPrincipalId: dbRow.batchRevertedByPrincipalId,
  batchRevertNote: dbRow.batchRevertNote,
  command: dbRow.commandJson,
  createdAt: dbRow.createdAt,
  decidedAt: dbRow.decidedAt,
  decidedByPrincipalId: dbRow.decidedByPrincipalId,
  decisionNote: dbRow.decisionNote,
  diff: dbRow.diffJson,
  failure: dbRow.failure,
  legalEntityId: dbRow.legalEntityId,
  moduleKey: dbRow.moduleKey,
  position: dbRow.position,
  proposalId: dbRow.proposalId,
  reason: dbRow.reason,
  referenceAudiences: dbRow.referenceAudiencesJson,
  revert: dbRow.revertJson ?? null,
  revertedAt: dbRow.revertedAt,
  revertedByPrincipalId: dbRow.revertedByPrincipalId,
  risk: Schema.is(AgentActivityRiskSchema)(dbRow.risk) ? dbRow.risk : 'medium',
  runId: dbRow.runId,
  status: Schema.is(AgentActivityStatusSchema)(dbRow.status) ? dbRow.status : 'failed',
  summary: dbRow.summary,
  targetLabel: dbRow.targetLabel,
  tenantId: dbRow.tenantId,
});

/** Private Core service: SQL is scoped to the native Read transaction, not an exported app executor. */
export const activityFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('AgentActivity.load')(function* load(
    request: typeof AgentActivityRequestSchema.Type,
    scope: { readonly nativeModules: readonly string[]; readonly visibleModules: readonly string[] },
  ) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* unavailable('An exact company context is required');
    }
    if (scope.visibleModules.length === 0) {
      return { access: [], audit: [], names: [], proposalOnlyAgentIds: [], proposals: [] };
    }
    const executor = transaction;
    const actors = yield* activityActorsFromTransaction(transaction).load();
    // Bound profile SQL independently of the number of historical agent principals.
    const profileBatches = yield* Effect.forEach(
      Array.from({ length: Math.ceil(actors.agentIds.length / 1000) }, (_, index) =>
        actors.agentIds.slice(index * 1000, (index + 1) * 1000),
      ),
      (ids) => agentProfilesFromTransaction(transaction).load(ids),
      { concurrency: 1 },
    );
    const profiles = new Map(profileBatches.flatMap((batch) => [...batch]));
    const proposalOnlyAgents = new Set(actors.agentIds.filter((id) => profiles.get(id)?.writePolicy === 'approval'));
    const agentFilter = request.agentPrincipalId;
    const limit = AGENT_ACTIVITY_CANDIDATE_LIMIT;
    const { cursor } = request;
    const before = (at: SQL, id: SQL) =>
      cursor === undefined
        ? sql`true`
        : sql`(date_trunc('milliseconds', ${at}), (${id}) collate "C") < (${cursor.at}::timestamptz, ${cursor.id} collate "C")`;
    const visibleModules = [...scope.visibleModules].filter(
      (key) => request.moduleKey === undefined || key === request.moduleKey,
    );
    if (visibleModules.length === 0) {
      return { access: [], audit: [], names: [], proposalOnlyAgentIds: [], proposals: [] };
    }
    const visible = (module: SQL) =>
      sql`${module} in (${sql.join(
        visibleModules.map((key) => sql`${key}`),
        sql`, `,
      )})`;
    const auditModule = sql`coalesce(${auditEvents.targetModuleKey}, regexp_replace(${actionInvocations.actionKey}, '[.][^.]+$', ''))`;
    const proposalOnly = [...proposalOnlyAgents];
    const nativeModuleKeys = new Set(scope.nativeModules);
    const nativeModules = visibleModules.filter((key) => nativeModuleKeys.has(key));
    const proposalAudit =
      proposalOnly.length === 0 || nativeModules.length === 0
        ? sql`false`
        : sql`${principals.principalId} in (${sql.join(
            proposalOnly.map((id) => sql`${id}`),
            sql`, `,
          )}) and ${auditModule} in (${sql.join(
            nativeModules.map((key) => sql`${key}`),
            sql`, `,
          )})`;
    const auditKind = sql`case when ${auditEvents.outcome} = 'succeeded' then case when ${proposalAudit} then 'proposal' else 'write' end when ${auditEvents.outcome} = 'denied' then 'denied' else 'failed' end`;
    const auditId = sql`'audit:' || ${auditEvents.auditEventId}::text`;
    const accessId = sql`'read:' || ${dataAccessEvents.dataAccessEventId}::text`;

    const auditRows = yield* executor
      .select({
        actionInvocationId: auditEvents.actionInvocationId,
        actionInvocationKey: actionInvocations.actionKey,
        auditEventId: auditEvents.auditEventId,
        displayName: principals.displayName,
        evidenceAction: sql<
          string | null
        >`case when jsonb_typeof(${auditEvents.evidenceJson}->'actionKey') = 'string' then ${auditEvents.evidenceJson}->>'actionKey' end`,
        occurredAt: auditEvents.occurredAt,
        outcome: auditEvents.outcome,
        outcomeCode: auditEvents.outcomeCode,
        principalId: principals.principalId,
        targetModuleKey: auditEvents.targetModuleKey,
        targetResourceId: sql<
          string | null
        >`coalesce(${auditEvents.targetResourceId}, ${actionInvocations.targetResourceId})`,
        targetResourceType: sql<
          string | null
        >`coalesce(${auditEvents.targetResourceType}, ${actionInvocations.targetResourceType})`,
      })
      .from(auditEvents)
      .innerJoin(
        principals,
        and(eq(principals.principalId, auditEvents.principalId), eq(principals.tenantId, auditEvents.tenantId)),
      )
      .leftJoin(
        actionInvocations,
        and(
          eq(actionInvocations.tenantId, tenantId),
          eq(actionInvocations.actionInvocationId, auditEvents.actionInvocationId),
        ),
      )
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.legalEntityId, legalEntityId),
          visible(auditModule),
          // Native engines own proposal history; exclude duplicate audit envelopes before taking the page.
          sql`not (${auditEvents.outcome} = 'succeeded' and (${proposalAudit}))`,
          before(sql`${auditEvents.occurredAt}`, auditId),
          ...(request.kind === undefined ? [] : [sql`${auditKind} = ${request.kind}`]),
          eq(principals.kind, 'agent'),
          ...(agentFilter === undefined ? [] : [eq(principals.principalId, agentFilter)]),
        ),
      )
      .orderBy(sql`date_trunc('milliseconds', ${auditEvents.occurredAt}) desc`, sql`${auditId} collate "C" desc`)
      .limit(limit)
      .pipe(Effect.mapError(unavailable));

    const audit = auditRows.map((row) => {
      const { evidenceAction } = row;
      return {
        actionInvocationId: row.actionInvocationId,
        actionKey: row.actionInvocationKey ?? evidenceAction,
        auditEventId: row.auditEventId,
        displayName: row.displayName,
        occurredAt: row.occurredAt,
        outcome: row.outcome,
        outcomeCode: row.outcomeCode,
        principalId: row.principalId,
        targetModuleKey: row.targetModuleKey,
        targetResourceId: row.targetResourceId,
        targetResourceType: row.targetResourceType,
      };
    });

    const accessRows = yield* executor
      .select({
        accessKind: dataAccessEvents.accessKind,
        dataAccessEventId: dataAccessEvents.dataAccessEventId,
        displayName: principals.displayName,
        occurredAt: dataAccessEvents.occurredAt,
        outcome: dataAccessEvents.outcome,
        outcomeCode: dataAccessEvents.outcomeCode,
        principalId: principals.principalId,
        servingModuleKey: dataAccessEvents.servingModuleKey,
        targetResourceId: dataAccessEvents.targetResourceId,
        targetResourceType: dataAccessEvents.targetResourceType,
      })
      .from(dataAccessEvents)
      .innerJoin(
        principals,
        and(
          eq(principals.principalId, dataAccessEvents.principalId),
          eq(principals.tenantId, dataAccessEvents.tenantId),
        ),
      )
      .where(
        and(
          eq(dataAccessEvents.tenantId, tenantId),
          eq(dataAccessEvents.legalEntityId, legalEntityId),
          visible(sql`${dataAccessEvents.servingModuleKey}`),
          before(sql`${dataAccessEvents.occurredAt}`, accessId),
          ...(request.kind === undefined
            ? []
            : [sql`case when ${dataAccessEvents.outcome} = 'allowed' then 'read' else 'denied' end = ${request.kind}`]),
          eq(principals.kind, 'agent'),
          ...(agentFilter === undefined ? [] : [eq(principals.principalId, agentFilter)]),
        ),
      )
      .orderBy(sql`date_trunc('milliseconds', ${dataAccessEvents.occurredAt}) desc`, sql`${accessId} collate "C" desc`)
      .limit(limit)
      .pipe(Effect.mapError(unavailable));

    const eligibleEvents = sql`(values
    (case when ${request.kind === undefined || request.kind === 'proposal'} then ${agentProposals.createdAt} end, 'proposal:' || ${agentProposals.proposalId}::text),
    (case when ${request.kind === undefined || request.kind === 'decision'} and ${agentProposals.status} <> 'pending' then ${agentProposals.decidedAt} end, 'decision:' || ${agentProposals.proposalId}::text),
    (case when ${request.kind === undefined || request.kind === 'decision'} then ${agentProposals.revertedAt} end, 'revert:' || ${agentProposals.proposalId}::text)
  )`;
    const latestEvent = (field: SQL) => sql`(select ${field} from ${eligibleEvents} e(at, id)
    where e.at is not null and ${before(sql`e.at`, sql`e.id`)}
    order by date_trunc('milliseconds', e.at) desc, e.id collate "C" desc limit 1)`;
    const eventAt = latestEvent(sql`date_trunc('milliseconds', e.at)`);
    const eventId = latestEvent(sql`e.id`);
    // A decision on an old proposal belongs on today's page, not the proposal's creation page.
    const proposalRows = yield* executor
      .select()
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.tenantId, tenantId),
          eq(agentProposals.legalEntityId, legalEntityId),
          visible(sql`${agentProposals.moduleKey}`),
          ...(agentFilter === undefined ? [] : [eq(agentProposals.agentPrincipalId, agentFilter)]),
          sql`${eventAt} is not null`,
        ),
      )
      .orderBy(sql`${eventAt} desc`, sql`${eventId} collate "C" desc`)
      .limit(limit)
      .pipe(Effect.mapError(unavailable));
    const proposals = proposalRows.map(toRow);

    return yield* Schema.decodeUnknownEffect(AgentActivityResultSchema)({
      access: accessRows,
      audit,
      names: actors.names,
      proposalOnlyAgentIds: [...proposalOnlyAgents],
      proposals,
    }).pipe(Effect.mapError(unavailable));
  }),
});
