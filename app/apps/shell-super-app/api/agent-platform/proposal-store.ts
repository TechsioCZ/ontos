/**
 * Shell database store for the platform approval queue and agent activity (core.agent_proposals and read-only
 * views of the Core tables the activity feed joins). Pure row-to-wire mapping lives in ./mappers.ts.
 */
import type {
  AgentActivityRequest,
  AgentDiffLine,
  AgentItemStatus,
  AgentRevertPlan,
  AgentRisk,
} from '@app/shared-contracts/agent-proposals';
import { and, asc, desc, eq, ne, type SQL } from 'drizzle-orm';
import { integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Data, DateTime, Effect } from 'effect';

import { AuthDatabase } from '../auth/db/client.ts';
import {
  type AgentProposalRow,
  type AuditActivityRow,
  accessRowToEntry,
  auditRowToEntry,
  buildActivityResponse,
  proposalRowToEntries,
} from './mappers.ts';

const core = pgSchema('core');

const coreAgentProposals = core.table('agent_proposals', {
  actionSlug: text('action_slug').notNull(),
  agentLabel: text('agent_label').notNull(),
  agentPrincipalId: uuid('agent_principal_id').notNull(),
  appId: text('app_id').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  applyResultJson: jsonb('apply_result_json').$type<unknown>(),
  batchId: uuid('batch_id').notNull(),
  batchInstruction: text('batch_instruction').notNull(),
  batchRevertNote: text('batch_revert_note'),
  batchRevertedAt: timestamp('batch_reverted_at', { withTimezone: true }),
  batchRevertedByPrincipalId: uuid('batch_reverted_by_principal_id'),
  commandJson: jsonb('command_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByPrincipalId: uuid('decided_by_principal_id'),
  decisionNote: text('decision_note'),
  diffJson: jsonb('diff_json').$type<readonly AgentDiffLine[]>().notNull(),
  failure: text('failure'),
  legalEntityId: uuid('legal_entity_id').notNull(),
  moduleKey: text('module_key').notNull(),
  position: integer('position').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  reason: text('reason').notNull(),
  referenceAudiencesJson: jsonb('reference_audiences_json').$type<readonly string[]>().notNull(),
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  revertedByPrincipalId: uuid('reverted_by_principal_id'),
  revertJson: jsonb('revert_json').$type<AgentRevertPlan | null>(),
  risk: text('risk').notNull(),
  runId: text('run_id'),
  status: text('status').notNull(),
  summary: text('summary').notNull(),
  targetLabel: text('target_label').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

const corePrincipals = core.table('principals', {
  displayName: text('display_name').notNull(),
  kind: text('kind').notNull(),
  principalId: uuid('principal_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

const coreLegalEntities = core.table('legal_entities', {
  legalEntityId: uuid('legal_entity_id').notNull(),
  legalName: text('legal_name').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

const coreAuditEvents = core.table('audit_events', {
  actionInvocationId: uuid('action_invocation_id'),
  auditEventId: uuid('audit_event_id').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  principalId: uuid('principal_id'),
  tenantId: uuid('tenant_id').notNull(),
});

const coreActionInvocations = core.table('action_invocations', {
  actionInvocationId: uuid('action_invocation_id').notNull(),
  actionKey: text('action_key').notNull(),
});

const coreDataAccessEvents = core.table('data_access_events', {
  accessKind: text('access_kind').notNull(),
  dataAccessEventId: uuid('data_access_event_id').notNull(),
  legalEntityId: uuid('legal_entity_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  principalId: uuid('principal_id').notNull(),
  servingModuleKey: text('serving_module_key').notNull(),
  targetResourceType: text('target_resource_type'),
  tenantId: uuid('tenant_id').notNull(),
});

export class AgentStoreUnavailable extends Data.TaggedError('AgentStoreUnavailable')<{ readonly cause: unknown }> {}

const unavailable = (cause: unknown) => new AgentStoreUnavailable({ cause });

export interface NewAgentProposal {
  readonly proposalId: string;
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly batchId: string;
  readonly batchInstruction: string;
  readonly runId: string | null;
  readonly position: number;
  readonly agentPrincipalId: string;
  readonly agentLabel: string;
  readonly appId: string;
  readonly moduleKey: string;
  readonly actionSlug: string;
  readonly command: Readonly<Record<string, unknown>>;
  readonly referenceAudiences: readonly string[];
  readonly summary: string;
  readonly targetLabel: string;
  readonly reason: string;
  readonly risk: AgentRisk;
  readonly diff: readonly AgentDiffLine[];
  readonly revert: AgentRevertPlan | null;
}

const RISKS: readonly AgentRisk[] = ['low', 'medium', 'high'];
const STATUSES: readonly AgentItemStatus[] = [
  'pending',
  'applied',
  'rejected',
  'failed',
  'reverted',
  'revert_failed',
];

const isRisk = (value: string): value is AgentRisk => (RISKS as readonly string[]).includes(value);
const isStatus = (value: string): value is AgentItemStatus => (STATUSES as readonly string[]).includes(value);

type DbProposal = typeof coreAgentProposals.$inferSelect;

const toRow = (dbRow: DbProposal): AgentProposalRow => ({
  agentLabel: dbRow.agentLabel,
  agentPrincipalId: dbRow.agentPrincipalId,
  appId: dbRow.appId,
  actionSlug: dbRow.actionSlug,
  applyResult: dbRow.applyResultJson,
  appliedAt: dbRow.appliedAt,
  batchId: dbRow.batchId,
  batchInstruction: dbRow.batchInstruction,
  batchRevertNote: dbRow.batchRevertNote,
  batchRevertedAt: dbRow.batchRevertedAt,
  batchRevertedByPrincipalId: dbRow.batchRevertedByPrincipalId,
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
  risk: isRisk(dbRow.risk) ? dbRow.risk : 'medium',
  runId: dbRow.runId,
  status: isStatus(dbRow.status) ? dbRow.status : 'failed',
  summary: dbRow.summary,
  targetLabel: dbRow.targetLabel,
  tenantId: dbRow.tenantId,
});

export const insertProposals = Effect.fn('AgentStore.insertProposals')(function* insertProposals(
  rows: readonly NewAgentProposal[],
) {
  if (rows.length === 0) {
    return;
  }
  const { executor } = yield* AuthDatabase;
  const now = yield* DateTime.nowAsDate;
  yield* executor
    .insert(coreAgentProposals)
    .values(
      rows.map((row) => ({
        actionSlug: row.actionSlug,
        agentLabel: row.agentLabel,
        agentPrincipalId: row.agentPrincipalId,
        appId: row.appId,
        batchId: row.batchId,
        batchInstruction: row.batchInstruction,
        commandJson: row.command,
        createdAt: now,
        diffJson: row.diff,
        legalEntityId: row.legalEntityId,
        moduleKey: row.moduleKey,
        position: row.position,
        proposalId: row.proposalId,
        reason: row.reason,
        referenceAudiencesJson: row.referenceAudiences,
        revertJson: row.revert,
        risk: row.risk,
        runId: row.runId,
        status: 'pending',
        summary: row.summary,
        targetLabel: row.targetLabel,
        tenantId: row.tenantId,
      })),
    )
    .pipe(Effect.mapError(unavailable));
});

export const findRunProposals = Effect.fn('AgentStore.findRunProposals')(function* findRunProposals(
  tenantId: string,
  agentPrincipalId: string,
  runId: string,
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select()
    .from(coreAgentProposals)
    .where(
      and(
        eq(coreAgentProposals.tenantId, tenantId),
        eq(coreAgentProposals.agentPrincipalId, agentPrincipalId),
        eq(coreAgentProposals.runId, runId),
      ),
    )
    .orderBy(asc(coreAgentProposals.position))
    .pipe(Effect.mapError(unavailable));
  return rows.map(toRow);
});

export const listCompanyProposals = Effect.fn('AgentStore.listCompanyProposals')(function* listCompanyProposals(
  tenantId: string,
  legalEntityId: string,
  options: { readonly agentPrincipalId?: string; readonly limit: number },
) {
  const { executor } = yield* AuthDatabase;
  const conditions: SQL[] = [
    eq(coreAgentProposals.tenantId, tenantId),
    eq(coreAgentProposals.legalEntityId, legalEntityId),
  ];
  if (options.agentPrincipalId !== undefined) {
    conditions.push(eq(coreAgentProposals.agentPrincipalId, options.agentPrincipalId));
  }
  const rows = yield* executor
    .select()
    .from(coreAgentProposals)
    .where(and(...conditions))
    .orderBy(desc(coreAgentProposals.createdAt), asc(coreAgentProposals.position))
    .limit(options.limit)
    .pipe(Effect.mapError(unavailable));
  return rows.map(toRow);
});

export const loadBatchProposals = Effect.fn('AgentStore.loadBatchProposals')(function* loadBatchProposals(
  tenantId: string,
  legalEntityId: string,
  batchId: string,
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select()
    .from(coreAgentProposals)
    .where(
      and(
        eq(coreAgentProposals.tenantId, tenantId),
        eq(coreAgentProposals.legalEntityId, legalEntityId),
        eq(coreAgentProposals.batchId, batchId),
      ),
    )
    .orderBy(asc(coreAgentProposals.position))
    .pipe(Effect.mapError(unavailable));
  return rows.map(toRow);
});

export const markApplied = Effect.fn('AgentStore.markApplied')(function* markApplied(
  proposalId: string,
  input: { readonly by: string; readonly applyResult: unknown; readonly revert: AgentRevertPlan | null },
) {
  const { executor } = yield* AuthDatabase;
  const now = yield* DateTime.nowAsDate;
  yield* executor
    .update(coreAgentProposals)
    .set({
      appliedAt: now,
      applyResultJson: input.applyResult,
      decidedAt: now,
      decidedByPrincipalId: input.by,
      failure: null,
      revertJson: input.revert,
      status: 'applied',
    })
    .where(and(eq(coreAgentProposals.proposalId, proposalId), eq(coreAgentProposals.status, 'pending')))
    .pipe(Effect.mapError(unavailable));
});

export const markRejected = Effect.fn('AgentStore.markRejected')(function* markRejected(
  proposalId: string,
  input: { readonly by: string; readonly note: string | null },
) {
  const { executor } = yield* AuthDatabase;
  const now = yield* DateTime.nowAsDate;
  yield* executor
    .update(coreAgentProposals)
    .set({
      decidedAt: now,
      decidedByPrincipalId: input.by,
      decisionNote: input.note,
      status: 'rejected',
    })
    .where(and(eq(coreAgentProposals.proposalId, proposalId), eq(coreAgentProposals.status, 'pending')))
    .pipe(Effect.mapError(unavailable));
});

export const markFailed = Effect.fn('AgentStore.markFailed')(function* markFailed(
  proposalId: string,
  input: { readonly by: string; readonly failure: string },
) {
  const { executor } = yield* AuthDatabase;
  const now = yield* DateTime.nowAsDate;
  yield* executor
    .update(coreAgentProposals)
    .set({
      decidedAt: now,
      decidedByPrincipalId: input.by,
      failure: input.failure,
      status: 'failed',
    })
    .where(and(eq(coreAgentProposals.proposalId, proposalId), eq(coreAgentProposals.status, 'pending')))
    .pipe(Effect.mapError(unavailable));
});

export const markReverted = Effect.fn('AgentStore.markReverted')(function* markReverted(
  proposalId: string,
  input: { readonly by: string },
) {
  const { executor } = yield* AuthDatabase;
  const now = yield* DateTime.nowAsDate;
  yield* executor
    .update(coreAgentProposals)
    .set({
      revertedAt: now,
      revertedByPrincipalId: input.by,
      status: 'reverted',
    })
    .where(eq(coreAgentProposals.proposalId, proposalId))
    .pipe(Effect.mapError(unavailable));
});

export const markRevertFailed = Effect.fn('AgentStore.markRevertFailed')(function* markRevertFailed(
  proposalId: string,
  input: { readonly failure: string },
) {
  const { executor } = yield* AuthDatabase;
  yield* executor
    .update(coreAgentProposals)
    .set({ failure: input.failure, status: 'revert_failed' })
    .where(eq(coreAgentProposals.proposalId, proposalId))
    .pipe(Effect.mapError(unavailable));
});

export const markBatchReverted = Effect.fn('AgentStore.markBatchReverted')(function* markBatchReverted(
  batchId: string,
  input: { readonly by: string; readonly note: string | null },
) {
  const { executor } = yield* AuthDatabase;
  const now = yield* DateTime.nowAsDate;
  yield* executor
    .update(coreAgentProposals)
    .set({
      batchRevertNote: input.note,
      batchRevertedAt: now,
      batchRevertedByPrincipalId: input.by,
    })
    .where(eq(coreAgentProposals.batchId, batchId))
    .pipe(Effect.mapError(unavailable));
});

export const principalNames = Effect.fn('AgentStore.principalNames')(function* principalNames(tenantId: string) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ displayName: corePrincipals.displayName, principalId: corePrincipals.principalId })
    .from(corePrincipals)
    .where(eq(corePrincipals.tenantId, tenantId))
    .pipe(Effect.mapError(unavailable));
  return new Map<string, string>(rows.map((row) => [row.principalId, row.displayName]));
});

export const companyLegalName = Effect.fn('AgentStore.companyLegalName')(function* companyLegalName(
  tenantId: string,
  legalEntityId: string,
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ legalName: coreLegalEntities.legalName })
    .from(coreLegalEntities)
    .where(and(eq(coreLegalEntities.tenantId, tenantId), eq(coreLegalEntities.legalEntityId, legalEntityId)))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  return rows[0]?.legalName ?? legalEntityId;
});

export const listAgentActivity = Effect.fn('AgentStore.listAgentActivity')(function* listAgentActivity(
  tenantId: string,
  legalEntityId: string,
  request: AgentActivityRequest,
) {
  const { executor } = yield* AuthDatabase;
  const agentFilter = request.agentPrincipalId === undefined ? undefined : request.agentPrincipalId;
  const limit = 300;

  const auditRows = yield* executor
    .select({
      actionInvocationKey: coreActionInvocations.actionKey,
      auditEventId: coreAuditEvents.auditEventId,
      displayName: corePrincipals.displayName,
      evidenceJson: coreAuditEvents.evidenceJson,
      occurredAt: coreAuditEvents.occurredAt,
      outcome: coreAuditEvents.outcome,
      outcomeCode: coreAuditEvents.outcomeCode,
      principalId: corePrincipals.principalId,
    })
    .from(coreAuditEvents)
    .innerJoin(
      corePrincipals,
      and(
        eq(corePrincipals.principalId, coreAuditEvents.principalId),
        eq(corePrincipals.tenantId, coreAuditEvents.tenantId),
      ),
    )
    .leftJoin(
      coreActionInvocations,
      eq(coreActionInvocations.actionInvocationId, coreAuditEvents.actionInvocationId),
    )
    .where(
      and(
        eq(coreAuditEvents.tenantId, tenantId),
        eq(coreAuditEvents.legalEntityId, legalEntityId),
        ne(corePrincipals.kind, 'human'),
        ...(agentFilter === undefined ? [] : [eq(corePrincipals.principalId, agentFilter)]),
      ),
    )
    .orderBy(desc(coreAuditEvents.occurredAt))
    .limit(limit)
    .pipe(Effect.mapError(unavailable));

  const audit: AuditActivityRow[] = auditRows.map((row) => {
    const evidenceAction = row.evidenceJson['actionKey'];
    return {
      actionKey: row.actionInvocationKey ?? (typeof evidenceAction === 'string' ? evidenceAction : null),
      auditEventId: row.auditEventId,
      displayName: row.displayName,
      occurredAt: row.occurredAt,
      outcome: row.outcome,
      outcomeCode: row.outcomeCode,
      principalId: row.principalId,
    };
  });

  const accessRows = yield* executor
    .select({
      accessKind: coreDataAccessEvents.accessKind,
      dataAccessEventId: coreDataAccessEvents.dataAccessEventId,
      displayName: corePrincipals.displayName,
      occurredAt: coreDataAccessEvents.occurredAt,
      outcome: coreDataAccessEvents.outcome,
      outcomeCode: coreDataAccessEvents.outcomeCode,
      principalId: corePrincipals.principalId,
      servingModuleKey: coreDataAccessEvents.servingModuleKey,
      targetResourceType: coreDataAccessEvents.targetResourceType,
    })
    .from(coreDataAccessEvents)
    .innerJoin(
      corePrincipals,
      and(
        eq(corePrincipals.principalId, coreDataAccessEvents.principalId),
        eq(corePrincipals.tenantId, coreDataAccessEvents.tenantId),
      ),
    )
    .where(
      and(
        eq(coreDataAccessEvents.tenantId, tenantId),
        eq(coreDataAccessEvents.legalEntityId, legalEntityId),
        ne(corePrincipals.kind, 'human'),
        ...(agentFilter === undefined ? [] : [eq(corePrincipals.principalId, agentFilter)]),
      ),
    )
    .orderBy(desc(coreDataAccessEvents.occurredAt))
    .limit(limit)
    .pipe(Effect.mapError(unavailable));

  const proposals = yield* listCompanyProposals(tenantId, legalEntityId, {
    limit,
    ...(agentFilter === undefined ? {} : { agentPrincipalId: agentFilter }),
  });
  const names = yield* principalNames(tenantId);

  return buildActivityResponse(
    [
      ...audit.map(auditRowToEntry),
      ...accessRows.map(accessRowToEntry),
      ...proposals.flatMap((row) => proposalRowToEntries(row, names)),
    ],
    request,
  );
});
