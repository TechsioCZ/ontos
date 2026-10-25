import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { agentProposals, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { ReadHandlerUnavailable, ReadPermissionDenied } from '../reads/errors.ts';
import { loadProposalCommandRecovery, loadProposalCommandReservations } from './agent-proposal-command-persistence.ts';
import {
  AGENT_PROPOSAL_COMMAND_RECOVERY_MODE,
  AGENT_PROPOSAL_QUEUE_CANDIDATE_LIMIT,
  AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT,
  AgentProposalQueueRiskSchema,
  AgentProposalQueueRowSchema,
  AgentProposalQueueStatusSchema,
} from './agent-proposal-queue-contract.ts';
import type {
  AgentProposalCommandRecovery,
  AgentProposalQueueInput,
  AgentProposalQueueResultSchema,
} from './agent-proposal-queue-contract.ts';
import {
  agentProposalQueueDenied,
  agentProposalQueueUnavailable as unavailable,
} from './agent-proposal-queue-unavailable.ts';

/** Derived solely from the admitted active composition and current module/Action checks. */
export interface AgentProposalQueueAction {
  readonly actionKey: string;
  readonly actionSlug: string;
  readonly appId: string;
  readonly moduleKey: string;
  readonly review: { readonly path: string; readonly privateRecords: boolean } | undefined;
}
type Proposal = typeof agentProposals.$inferSelect;
type QueueResult = typeof AgentProposalQueueResultSchema.Type;
const OWN_RECENT_MODE = 'own-recent';
const companyPredicate = ({ legalEntityId, tenantId }: OperationalScope) =>
  and(eq(agentProposals.tenantId, tenantId), eq(agentProposals.legalEntityId, legalEntityId ?? ''));
const ownRead = (input: AgentProposalQueueInput) =>
  input.mode === 'own-run' ||
  input.mode === OWN_RECENT_MODE ||
  (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE && input.payload.operation === 'insert');

const toRow = (row: Proposal) => ({
  actionSlug: row.actionSlug,
  agentLabel: row.agentLabel,
  agentPrincipalId: row.agentPrincipalId,
  appId: row.appId,
  appliedAt: row.appliedAt,
  applyResult: row.applyResultJson,
  batchId: row.batchId,
  batchInstruction: row.batchInstruction,
  batchRevertedAt: row.batchRevertedAt,
  batchRevertedByPrincipalId: row.batchRevertedByPrincipalId,
  batchRevertNote: row.batchRevertNote,
  command: row.commandJson,
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
  decidedByPrincipalId: row.decidedByPrincipalId,
  decisionNote: row.decisionNote,
  diff: row.diffJson,
  failure: row.failure,
  legalEntityId: row.legalEntityId,
  moduleKey: row.moduleKey,
  position: row.position,
  proposalId: row.proposalId,
  reason: row.reason,
  referenceAudiences: row.referenceAudiencesJson,
  revert: row.revertJson ?? null,
  revertedAt: row.revertedAt,
  revertedByPrincipalId: row.revertedByPrincipalId,
  risk: Schema.is(AgentProposalQueueRiskSchema)(row.risk) ? row.risk : 'medium',
  runId: row.runId,
  status: Schema.is(AgentProposalQueueStatusSchema)(row.status) ? row.status : 'failed',
  summary: row.summary,
  targetLabel: row.targetLabel,
  tenantId: row.tenantId,
});

const allowedActions = (actions: readonly AgentProposalQueueAction[], alias?: 'p'): SQL => {
  const module = alias === 'p' ? sql`p.module_key` : sql`${agentProposals.moduleKey}`;
  const app = alias === 'p' ? sql`p.app_id` : sql`${agentProposals.appId}`;
  const slug = alias === 'p' ? sql`p.action_slug` : sql`${agentProposals.actionSlug}`;
  return actions.length === 0
    ? sql`false`
    : sql`(${sql.join(
        actions.map(
          (action) =>
            sql`(${module} = ${action.moduleKey} and ${app} = ${action.appId} and ${slug} = ${action.actionSlug})`,
        ),
        sql` or `,
      )})`;
};

/** ID-only lifecycle projection: private business payloads are never exposed to people administrators. */
const withdrawalBatches = Effect.fn('AgentProposalQueue.withdrawalBatches')(function* withdrawalBatches(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  input: Extract<AgentProposalQueueInput, { mode: 'withdrawal-batches' }>,
): Effect.fn.Return<NonNullable<QueueResult['withdrawalBatches']>, ReadHandlerUnavailable | ReadPermissionDenied> {
  const [target] = yield* transaction
    .select({ status: principals.status })
    .from(principals)
    .where(
      and(
        eq(principals.tenantId, scope.tenantId),
        eq(principals.principalId, input.agentPrincipalId),
        eq(principals.kind, 'agent'),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (target === undefined || (target.status !== 'disabled' && target.status !== 'archived')) {
    return yield* agentProposalQueueDenied();
  }
  const candidates = yield* transaction
    .select({ batchId: agentProposals.batchId })
    .from(agentProposals)
    .where(
      and(
        companyPredicate(scope),
        eq(agentProposals.agentPrincipalId, input.agentPrincipalId),
        eq(agentProposals.status, 'pending'),
        sql`${agentProposals.decidedAt} is null`,
        input.afterBatchId === undefined ? sql`true` : gt(agentProposals.batchId, input.afterBatchId),
      ),
    )
    .groupBy(agentProposals.batchId)
    .orderBy(asc(agentProposals.batchId))
    .limit(AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT + 1)
    .pipe(Effect.mapError(unavailable));
  const batchIds = candidates.slice(0, AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT).map(({ batchId }) => batchId);
  const last = batchIds.at(-1);
  return candidates.length > AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT && last !== undefined
    ? { batchIds, nextAfterBatchId: last }
    : { batchIds };
});

const queuePredicate = (
  scope: OperationalScope,
  request: Extract<AgentProposalQueueInput, { mode: 'queue' }>['request'],
  actions: readonly AgentProposalQueueAction[],
) => {
  const selected = actions.filter(
    (action) => request.moduleKey === undefined || request.moduleKey === action.moduleKey,
  );
  const { legalEntityId, tenantId } = scope;
  const { cursor } = request;
  const before =
    cursor === undefined
      ? sql`true`
      : sql`(date_trunc('milliseconds', min(p.created_at)), ('core:' || p.batch_id::text) collate "C") < (${cursor.at}::timestamptz, ${cursor.id} collate "C")`;
  return and(
    companyPredicate(scope),
    allowedActions(selected),
    sql`${agentProposals.batchId} in (
    select p.batch_id from core.agent_proposals p
    where p.tenant_id = ${tenantId} and p.legal_entity_id = ${legalEntityId}
      and ${allowedActions(selected, 'p')}
      and ${request.batchKey === undefined ? sql`true` : sql`'core:' || p.batch_id::text = ${request.batchKey}`}
    group by p.batch_id having ${before}
      and ${request.pendingOnly === true ? sql`bool_or(p.status = 'pending')` : sql`true`}
    order by date_trunc('milliseconds', min(p.created_at)) desc, p.batch_id::text collate "C" desc
    limit ${AGENT_PROPOSAL_QUEUE_CANDIDATE_LIMIT}
  )`,
  );
};

interface Selection {
  readonly commandRecovery?: AgentProposalCommandRecovery;
  readonly conditions: SQL | undefined;
  readonly limit: number;
  readonly order: readonly SQL[];
}
const selectQueue = Effect.fn('AgentProposalQueue.select')(function* selectQueue(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  input: Exclude<AgentProposalQueueInput, { mode: 'withdrawal-batches' }>,
  actions: readonly AgentProposalQueueAction[],
): Effect.fn.Return<Selection, ReadHandlerUnavailable> {
  const company = companyPredicate(scope);
  const batchSelection = { limit: 51, order: [asc(agentProposals.position)] };
  if (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE) {
    const commandRecovery = yield* loadProposalCommandRecovery(transaction, scope, input).pipe(
      Effect.mapError(unavailable),
    );
    const batchId = commandRecovery.state === 'COMMITTED' ? commandRecovery.result.batchId : input.payload.batchId;
    return { ...batchSelection, commandRecovery, conditions: and(company, eq(agentProposals.batchId, batchId)) };
  }
  if (input.mode === 'own-run') {
    return {
      ...batchSelection,
      conditions: and(
        company,
        eq(agentProposals.agentPrincipalId, scope.principalId),
        eq(agentProposals.runId, input.runId),
      ),
    };
  }
  if (input.mode === OWN_RECENT_MODE) {
    return {
      conditions: and(company, eq(agentProposals.agentPrincipalId, scope.principalId)),
      limit: 300,
      order: [desc(agentProposals.createdAt), asc(agentProposals.position)],
    };
  }
  if (input.mode === 'queue') {
    return {
      conditions: queuePredicate(scope, input.request, actions),
      limit: AGENT_PROPOSAL_QUEUE_CANDIDATE_LIMIT * 50 + 1,
      order: [desc(agentProposals.createdAt), desc(agentProposals.batchId), asc(agentProposals.position)],
    };
  }
  // Batch consumers authorize the entire batch in finish; a partial view would break revert-all.
  return { ...batchSelection, conditions: and(company, eq(agentProposals.batchId, input.batchId)) };
});

const validateRecoveryBatch = Effect.fn('AgentProposalQueue.validateRecoveryBatch')(function* validateRecoveryBatch(
  rows: readonly Proposal[],
  recovery: AgentProposalCommandRecovery | undefined,
  own: boolean,
  principalId: string,
) {
  if (recovery === undefined) {
    return yield* Effect.void;
  }
  if (own && rows.some((row) => row.agentPrincipalId !== principalId)) {
    return yield* agentProposalQueueDenied();
  }
  if (recovery.state === 'COMMITTED') {
    const { proposalIds } = recovery.result;
    if (
      rows.length === 0 ||
      rows.length !== proposalIds.length ||
      rows.some((row, position) => row.proposalId !== proposalIds[position])
    ) {
      return yield* unavailable('The committed command no longer has its complete retained batch');
    }
  }
  return yield* Effect.void;
});

const queueCandidates = (proposals: readonly (typeof AgentProposalQueueRowSchema.Type)[]) => {
  const candidates = new Map<string, { readonly at: string; readonly id: string }>();
  for (const row of proposals) {
    const id = `core:${row.batchId}`;
    const at = row.createdAt.toISOString();
    const previous = candidates.get(id);
    if (previous === undefined || at < previous.at) {
      candidates.set(id, { at, id });
    }
  }
  return [...candidates.values()];
};

/** Internal owner service, reachable only with a Read-installed scoped transaction. Never a public DB facade. */
export const proposalQueueFromTransaction = (transaction: ScopedTransactionExecutor, scope: OperationalScope) => ({
  load: Effect.fn('AgentProposalQueue.load')(function* load(
    input: AgentProposalQueueInput,
    actions: readonly AgentProposalQueueAction[],
  ): Effect.fn.Return<QueueResult, ReadHandlerUnavailable | ReadPermissionDenied> {
    const { legalEntityId, tenantId } = transaction.scope;
    const { principalId } = scope;
    if (legalEntityId === undefined || scope.tenantId !== tenantId || scope.legalEntityId !== legalEntityId) {
      return yield* unavailable('An exact company context is required');
    }
    const own = ownRead(input);
    const admitted = yield* transaction
      .select({ principalId: principals.principalId })
      .from(principals)
      .where(
        and(
          eq(principals.tenantId, tenantId),
          eq(principals.principalId, principalId),
          eq(principals.kind, own ? 'agent' : 'human'),
          eq(principals.status, 'active'),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (admitted.length !== 1) {
      return yield* agentProposalQueueDenied();
    }
    const empty = { approvalInProgress: false, batchReverted: false, candidates: [], proposals: [] };
    if (input.mode === 'withdrawal-batches') {
      return { ...empty, withdrawalBatches: yield* withdrawalBatches(transaction, scope, input) };
    }
    if (
      input.mode === 'queue' &&
      !actions.some((action) => input.request.moduleKey === undefined || action.moduleKey === input.request.moduleKey)
    ) {
      return empty;
    }
    const selection = yield* selectQueue(transaction, scope, input, actions);
    const exact =
      input.mode === 'batch' || input.mode === 'batch-state' || input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE;
    const query = transaction
      .select()
      .from(agentProposals)
      .where(selection.conditions)
      .orderBy(...selection.order)
      .limit(selection.limit);
    // Keep current row state and subsequent retained-claim reads coherent under READ COMMITTED.
    // Native writers lock/update these same rows; no network runs until after this Read commits.
    const rows = yield* (exact ? query.for('share') : query).pipe(Effect.mapError(unavailable));
    // One sentinel beyond the domain bound detects invalid batches instead of truncating them.
    if (rows.length === selection.limit && input.mode !== OWN_RECENT_MODE) {
      return yield* unavailable('The persisted proposal batch exceeds its domain bound');
    }
    yield* validateRecoveryBatch(rows, selection.commandRecovery, own, principalId);
    const proposals = yield* Schema.decodeUnknownEffect(Schema.Array(AgentProposalQueueRowSchema))(
      rows.map(toRow),
    ).pipe(Effect.mapError(unavailable));
    // Same retained rows and durable semantics as the command state machine; elapsed time is not evidence.
    const result = {
      approvalInProgress: rows.some((row) => row.status === 'pending' && row.decidedAt !== null),
      batchReverted: rows.some((row) => row.batchRevertedAt !== null),
      candidates: queueCandidates(proposals),
      proposals,
    };
    const recovered =
      selection.commandRecovery === undefined ? result : { ...result, commandRecovery: selection.commandRecovery };
    if (
      !exact ||
      own ||
      (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE && input.payload.operation === 'withdraw-pending-of-agent')
    ) {
      return recovered;
    }
    const reservations = yield* loadProposalCommandReservations(transaction, scope, rows).pipe(
      Effect.mapError(unavailable),
    );
    return { ...recovered, reservations };
  }),
});
