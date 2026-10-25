import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { planProposalTransition, proposalReservationQuery } from './agent-proposal-command-transition.ts';

import { computeActionRequestHash, computeCanonicalValueHash } from '../actions/repository.ts';
import type { ActionRequestHashInput } from '../actions/repository.ts';
import {
  actionInvocations,
  agentProposals,
  auditEvents,
  principals,
  principalCompanyMemberships,
} from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import {
  agentProposalCommandActionKey,
  AgentProposalCommandAuditSchema,
  AgentProposalCommandPayloadSchema,
  AgentProposalCommandResultSchema,
  encodeAgentProposalCommand,
  proposalCommandTargetId,
} from './agent-proposal-command-contract.ts';
import type {
  AgentProposalCommandAudit,
  AgentProposalCommandPayload,
  AgentProposalCommandResult,
} from './agent-proposal-command-contract.ts';
import {
  proposalCommandConflict as conflict,
  proposalCommandInvalid as invalid,
  proposalCommandUnavailable as unavailable,
} from './agent-proposal-command-error.ts';

import type { AgentProposalCommandError } from './agent-proposal-command-error.ts';
import type { AgentProposalCommandRecovery, AgentProposalReservation } from './agent-proposal-queue-contract.ts';

type RecoveryTarget = {
  -readonly [Key in keyof ActionRequestHashInput['target']]: ActionRequestHashInput['target'][Key];
};

/** Exact caller-owned recovery; a native success alone is not a fabricated command result. */
export const loadProposalCommandRecovery = Effect.fn('AgentProposalCommand.recover')(function* recover(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  input: { readonly idempotencyKey: string; readonly payload: AgentProposalCommandPayload },
): Effect.fn.Return<AgentProposalCommandRecovery, AgentProposalCommandError> {
  if (
    scope.tenantId !== transaction.scope.tenantId ||
    scope.legalEntityId === undefined ||
    scope.legalEntityId !== transaction.scope.legalEntityId
  ) {
    return yield* invalid('Recovery requires the exact admitted transaction scope');
  }
  const records = yield* transaction
    .select({
      completedAt: actionInvocations.completedAt,
      evidence: auditEvents.evidenceJson,
      invocationId: actionInvocations.actionInvocationId,
      requestHash: actionInvocations.requestHash,
      status: actionInvocations.status,
      targetModuleKey: actionInvocations.targetModuleKey,
      targetResourceId: actionInvocations.targetResourceId,
      targetResourceType: actionInvocations.targetResourceType,
    })
    .from(actionInvocations)
    .leftJoin(
      auditEvents,
      and(
        eq(auditEvents.tenantId, actionInvocations.tenantId),
        eq(auditEvents.legalEntityId, scope.legalEntityId),
        eq(auditEvents.principalId, scope.principalId),
        eq(auditEvents.actionInvocationId, actionInvocations.actionInvocationId),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        sql`${auditEvents.evidenceJson}->>'actionKey' = ${agentProposalCommandActionKey}`,
      ),
    )
    .where(
      and(
        eq(actionInvocations.tenantId, scope.tenantId),
        eq(actionInvocations.legalEntityId, scope.legalEntityId),
        eq(actionInvocations.principalId, scope.principalId),
        eq(actionInvocations.actionKey, agentProposalCommandActionKey),
        eq(actionInvocations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(2)
    .pipe(Effect.mapError(unavailable));
  const [record] = records;
  if (record === undefined) {
    return { retryCommand: true, state: 'NOT_STARTED' };
  }
  if (records.length !== 1) {
    return yield* unavailable('The native invocation has ambiguous retained commit evidence');
  }
  const normalizedPayload = yield* Schema.encodeEffect(AgentProposalCommandPayloadSchema)(input.payload).pipe(
    Effect.mapError(unavailable),
  );
  const target: RecoveryTarget = {};
  if (record.targetModuleKey !== null) {
    target.targetModuleKey = record.targetModuleKey;
  }
  if (record.targetResourceId !== null) {
    target.targetResourceId = record.targetResourceId;
  }
  if (record.targetResourceType !== null) {
    target.targetResourceType = record.targetResourceType;
  }
  const requestHash = computeActionRequestHash({
    actionKey: agentProposalCommandActionKey,
    normalizedPayload,
    owningModuleKey: 'core.identity',
    principal: scope,
    schemaVersion: '1',
    target,
  });
  if (requestHash !== record.requestHash) {
    return yield* conflict('Recovery payload does not match the caller-owned native invocation');
  }
  const { invocationId } = record;
  if (record.status === 'succeeded') {
    const audit = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        ...AgentProposalCommandAuditSchema.fields,
        resultHash: Schema.String,
      }),
    )(record.evidence).pipe(Effect.mapError(unavailable));
    const result = yield* Schema.decodeEffect(AgentProposalCommandResultSchema)(audit).pipe(
      Effect.mapError(unavailable),
    );
    const encoded = yield* Schema.encodeEffect(AgentProposalCommandResultSchema)(result).pipe(
      Effect.mapError(unavailable),
    );
    if (
      record.completedAt === null ||
      audit.operation !== input.payload.operation ||
      audit.resultHash !== computeCanonicalValueHash(encoded)
    ) {
      return yield* unavailable('The retained command result does not match its native commit');
    }
    return { invocationId, result, retryCommand: false, state: 'COMMITTED' };
  }
  if (record.status === 'received' && record.completedAt === null) {
    return { invocationId, retryCommand: true, state: 'RETRYABLE' };
  }
  if ((record.status === 'running' || record.status === 'indeterminate') && record.completedAt === null) {
    return { invocationId, retryCommand: false, state: 'RUNNING' };
  }
  return { invocationId, retryCommand: false, state: 'REJECTED' };
});

type Proposal = typeof agentProposals.$inferSelect;
type Actor = Pick<typeof principals.$inferSelect, 'principalId' | 'kind' | 'status' | 'displayName'>;
export interface AgentProposalCommandSnapshot {
  readonly actor: Actor;
  readonly previous: AgentProposalCommandAudit | null;
  readonly proposer: Actor;
  readonly rows: readonly Proposal[];
}
export const proposalSnapshotHash = (snapshot: AgentProposalCommandSnapshot) => computeCanonicalValueHash(snapshot);
const company = (scope: OperationalScope) =>
  and(eq(agentProposals.tenantId, scope.tenantId), eq(agentProposals.legalEntityId, scope.legalEntityId ?? ''));
const sameCommands = (
  left: readonly Proposal[],
  payload: Extract<AgentProposalCommandPayload, { operation: 'insert' }>,
) =>
  computeCanonicalValueHash(left.map((row) => [row.appId, row.moduleKey, row.actionSlug, row.commandJson])) ===
  computeCanonicalValueHash(payload.proposals.map((row) => [row.appId, row.moduleKey, row.actionSlug, row.command]));

const loadActor = Effect.fn('AgentProposalCommand.loadActor')(function* loadActor(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  principalId: string,
  membership: 'active' | 'historical',
) {
  const [actor] = yield* transaction
    .select({
      displayName: principals.displayName,
      kind: principals.kind,
      principalId: principals.principalId,
      status: principals.status,
    })
    .from(principals)
    .leftJoin(
      principalCompanyMemberships,
      and(
        eq(principalCompanyMemberships.tenantId, principals.tenantId),
        eq(principalCompanyMemberships.principalId, principals.principalId),
        eq(principalCompanyMemberships.legalEntityId, scope.legalEntityId ?? ''),
      ),
    )
    .where(
      and(
        eq(principals.tenantId, scope.tenantId),
        eq(principals.principalId, principalId),
        membership === 'active' ? eq(principalCompanyMemberships.status, 'active') : sql`true`,
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (actor === undefined) {
    return yield* invalid('The principal is not a member of this exact company');
  }
  return actor;
});

const latestAudit = Effect.fn('AgentProposalCommand.latestAudit')(function* latestAudit(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  batchId: string,
  reservation?: { readonly operation: 'claim-approval' | 'claim-batch-revert'; readonly proposalId?: string },
) {
  const rows = yield* transaction
    .select({ evidence: auditEvents.evidenceJson })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, scope.tenantId),
        eq(auditEvents.legalEntityId, scope.legalEntityId ?? ''),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        sql`${auditEvents.evidenceJson}->>'actionKey' = ${agentProposalCommandActionKey}`,
        sql`${auditEvents.evidenceJson}->>'batchId' = ${batchId}`,
        reservation === undefined
          ? sql`true`
          : sql`${auditEvents.evidenceJson}->>'operation' = ${reservation.operation} and ${auditEvents.evidenceJson}->>'outcome' = 'changed'`,
        reservation?.proposalId === undefined
          ? sql`true`
          : sql`${auditEvents.evidenceJson}->'affectedProposalIds' ? ${reservation.proposalId}`,
      ),
    )
    .orderBy(
      sql`(${auditEvents.evidenceJson}->>'revision')::integer desc`,
      desc(auditEvents.occurredAt),
      desc(auditEvents.auditEventId),
    )
    .limit(1);
  const [row] = rows;
  return row === undefined ? null : yield* Schema.decodeUnknownEffect(AgentProposalCommandAuditSchema)(row.evidence);
}, Effect.mapError(unavailable));

type ReservationTarget = Pick<AgentProposalReservation, 'operation' | 'proposalIds'> & { readonly proposalId?: string };
const APPROVAL_CLAIM_OPERATION = 'claim-approval';

/** Current caller-owned reservations, reconstructed from both live rows and successful native claim commits. */
export const loadProposalCommandReservations = Effect.fn('AgentProposalCommand.reservations')(function* reservations(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  rows: readonly Proposal[],
): Effect.fn.Return<readonly AgentProposalReservation[], AgentProposalCommandError> {
  const targets: ReservationTarget[] = rows.flatMap((row) =>
    row.status === 'pending' && row.decidedAt !== null && row.decidedByPrincipalId === scope.principalId
      ? [{ operation: APPROVAL_CLAIM_OPERATION, proposalId: row.proposalId, proposalIds: [row.proposalId] }]
      : [],
  );
  if (
    rows.length > 0 &&
    rows.every((row) => row.batchRevertedAt !== null && row.batchRevertedByPrincipalId === scope.principalId)
  ) {
    targets.push({ operation: 'claim-batch-revert', proposalIds: rows.map((row) => row.proposalId) });
  }
  return yield* Effect.forEach(
    targets,
    Effect.fn('AgentProposalCommand.reservation')(function* reservation(target: ReservationTarget) {
      const batchId = rows[0]?.batchId;
      if (batchId === undefined) {
        return yield* unavailable('The reservation has no complete batch');
      }
      const audit = yield* latestAudit(transaction, scope, batchId, target);
      if (
        audit?.reservationId === undefined ||
        computeCanonicalValueHash(audit.affectedProposalIds) !== computeCanonicalValueHash(target.proposalIds)
      ) {
        return yield* unavailable('The current reservation has no exact retained claim evidence');
      }
      const [invocation] = yield* transaction
        .select({ invocationId: actionInvocations.actionInvocationId })
        .from(actionInvocations)
        .where(
          and(
            eq(actionInvocations.tenantId, scope.tenantId),
            eq(actionInvocations.legalEntityId, scope.legalEntityId ?? ''),
            eq(actionInvocations.principalId, scope.principalId),
            eq(actionInvocations.actionKey, agentProposalCommandActionKey),
            eq(actionInvocations.actionInvocationId, audit.reservationId),
            eq(actionInvocations.status, 'succeeded'),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (invocation === undefined) {
        return yield* unavailable('The current reservation has no retained native commit');
      }
      return {
        operation: target.operation,
        proposalIds: target.proposalIds,
        reservationId: invocation.invocationId,
        revision: audit.revision,
      };
    }),
    { concurrency: 1 },
  );
});

const loadBatch = (transaction: ScopedTransactionExecutor, scope: OperationalScope, batchId: string) =>
  transaction
    .select()
    .from(agentProposals)
    .where(and(company(scope), eq(agentProposals.batchId, batchId)))
    .orderBy(asc(agentProposals.position))
    .limit(51)
    .pipe(Effect.mapError(unavailable));

/** SQL-only duplicate lookup; the proposer lock makes lookup plus insertion atomic. */
const loadInsertDuplicate = Effect.fn('AgentProposalCommand.loadInsertDuplicate')(function* loadInsertDuplicate(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  payload: Extract<AgentProposalCommandPayload, { operation: 'insert' }>,
) {
  if (payload.runId !== undefined) {
    const rows = yield* transaction
      .select()
      .from(agentProposals)
      .where(
        and(
          company(scope),
          eq(agentProposals.agentPrincipalId, scope.principalId),
          eq(agentProposals.runId, payload.runId),
        ),
      )
      .orderBy(asc(agentProposals.position))
      .limit(51)
      .pipe(Effect.mapError(unavailable));
    const [existing] = rows;
    if (existing !== undefined) {
      const siblings = yield* loadBatch(transaction, scope, existing.batchId);
      if (!sameCommands(siblings, payload) || siblings.some((row) => row.runId !== payload.runId)) {
        return yield* conflict('The run identity already names a different command batch');
      }
      return siblings;
    }
  }
  const matches = yield* Effect.forEach(
    payload.proposals,
    (proposal, position) =>
      encodeAgentProposalCommand(proposal.command).pipe(
        Effect.map(
          (command) => sql`(
            p.position = ${position} and p.app_id = ${proposal.appId} and p.module_key = ${proposal.moduleKey}
            and p.action_slug = ${proposal.actionSlug} and p.command_json = ${command}::jsonb
          )`,
        ),
        Effect.mapError(unavailable),
      ),
    { concurrency: 1 },
  );
  // Count EVERY sibling, including decided ones: never deduplicate against a partial pending batch.
  const rows = yield* transaction
    .select()
    .from(agentProposals)
    .where(
      and(
        company(scope),
        eq(agentProposals.agentPrincipalId, scope.principalId),
        sql`${agentProposals.batchId} = (select p.batch_id from core.agent_proposals p
      where p.tenant_id = ${scope.tenantId} and p.legal_entity_id = ${scope.legalEntityId}
        and p.agent_principal_id = ${scope.principalId}
      group by p.batch_id having count(*) = ${payload.proposals.length}
        and bool_and(p.status = 'pending' and p.batch_reverted_at is null
          and (${sql.join(matches, sql` or `)}))
      order by min(p.created_at), p.batch_id limit 1)`,
      ),
    )
    .orderBy(asc(agentProposals.position))
    .limit(51)
    .pipe(Effect.mapError(unavailable));
  return rows;
});

const validateActors = Effect.fn('AgentProposalCommand.validateActors')(function* validateActors(
  payload: AgentProposalCommandPayload,
  actor: Actor,
  proposer: Actor,
) {
  if (proposer.kind !== 'agent') {
    return yield* invalid('Only agent principals may propose module commands');
  }
  if (actor.status !== 'active' || (payload.operation === 'insert' ? actor.kind !== 'agent' : actor.kind !== 'human')) {
    return yield* invalid('Only active agents submit; only active humans decide or revert');
  }
  if (payload.operation === APPROVAL_CLAIM_OPERATION && proposer.status !== 'active') {
    return yield* invalid('A no-longer-active agent cannot acquire a new approval');
  }
  if (payload.operation === 'withdraw-pending-of-agent' && proposer.status === 'active') {
    return yield* invalid('Withdrawal requires a no-longer-active proposer');
  }
  return yield* Effect.void;
});

/** Used only inside native preflight and native Action owner transactions. Never exported from Core's public root. */
export const loadProposalCommandSnapshot = Effect.fn('AgentProposalCommand.loadSnapshot')(function* loadSnapshot(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  payload: AgentProposalCommandPayload,
) {
  if (
    scope.legalEntityId === undefined ||
    scope.tenantId !== transaction.scope.tenantId ||
    scope.legalEntityId !== transaction.scope.legalEntityId
  ) {
    return yield* invalid('The exact admitted tenant and company must match the native transaction scope');
  }
  const actor = yield* loadActor(transaction, scope, scope.principalId, 'active');
  const rows =
    payload.operation === 'insert'
      ? yield* loadInsertDuplicate(transaction, scope, payload)
      : yield* loadBatch(transaction, scope, payload.batchId);
  if (rows.length > 50 || (payload.operation !== 'insert' && rows.length === 0)) {
    return yield* invalid('A proposal command requires one complete batch of at most 50 rows');
  }
  const proposerId = payload.operation === 'insert' ? scope.principalId : rows[0]?.agentPrincipalId;
  if (proposerId === undefined) {
    return yield* invalid('The batch has no proposer');
  }
  if (
    rows.some(
      (row, position) =>
        row.agentPrincipalId !== proposerId || row.batchId !== rows[0]?.batchId || row.position !== position,
    )
  ) {
    return yield* invalid('The stored batch identity or ordering is inconsistent');
  }
  const membership = payload.operation === APPROVAL_CLAIM_OPERATION ? 'active' : 'historical';
  const proposer =
    proposerId === actor.principalId ? actor : yield* loadActor(transaction, scope, proposerId, membership);
  yield* validateActors(payload, actor, proposer);
  const targetId = proposalCommandTargetId(payload);
  if (Option.isSome(targetId) && !rows.some((row) => row.proposalId === targetId.value)) {
    return yield* invalid('The proposal does not belong to this exact batch and company');
  }
  const previous = yield* latestAudit(transaction, scope, rows[0]?.batchId ?? payload.batchId);
  return { actor, previous, proposer, rows } satisfies AgentProposalCommandSnapshot;
});

export const proposalCommandsFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  execute: Effect.fn('AgentProposalCommand.execute')(function* execute(
    payload: AgentProposalCommandPayload,
    input: {
      readonly actionInvocationId: string;
      readonly scope: OperationalScope;
      readonly snapshot: AgentProposalCommandSnapshot;
    },
  ) {
    const { scope, snapshot } = input;
    // One proposer lock orders insertion, approval, withdrawal, and batch revert against each other.
    // No graph/module calls run under it. Identity lifecycle already locks the same principal row.
    const [locked] = yield* transaction
      .select({ principalId: principals.principalId })
      .from(principals)
      .where(and(eq(principals.tenantId, scope.tenantId), eq(principals.principalId, snapshot.proposer.principalId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (locked === undefined) {
      return yield* conflict('The proposer disappeared during preparation');
    }
    // Distinct agents must not concurrently create different rows under one scoped batch identity.
    // The existing schema has no batch ownership row/unique key, so use one transaction-scoped lock.
    const batchIdentity = computeCanonicalValueHash({
      batchId: snapshot.rows[0]?.batchId ?? payload.batchId,
      legalEntityId: scope.legalEntityId,
      tenantId: scope.tenantId,
    });
    const batchLockKey = `agent-proposal-batch:${batchIdentity}`;
    yield* transaction
      .select({ lock: sql`pg_advisory_xact_lock(hashtextextended(${batchLockKey}, 0))` })
      .from(principals)
      .where(and(eq(principals.tenantId, scope.tenantId), eq(principals.principalId, snapshot.proposer.principalId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const current = yield* loadProposalCommandSnapshot(transaction, scope, payload);
    if (proposalSnapshotHash(current) !== proposalSnapshotHash(snapshot)) {
      return yield* conflict('The proposal target or version changed after authorization');
    }
    const previousRevision = current.previous?.revision ?? 0;
    const { rows } = current;
    const batchId = rows[0]?.batchId ?? payload.batchId;
    const proposalIds = rows.map((row) => row.proposalId);
    const base = { batchId, proposalIds, revision: previousRevision + 1 };
    if (payload.operation === 'insert') {
      if (rows.length > 0) {
        return { ...base, affectedProposalIds: [], outcome: 'replayed' as const };
      }
      const [collision] = yield* transaction
        .select({ proposalId: agentProposals.proposalId })
        .from(agentProposals)
        .where(and(company(scope), eq(agentProposals.batchId, payload.batchId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (
        collision !== undefined ||
        new Set(payload.proposals.map((row) => row.proposalId)).size !== payload.proposals.length
      ) {
        return yield* conflict('The proposed batch or proposal identity is already in use');
      }
      const inserted = yield* transaction
        .insert(agentProposals)
        .values(
          payload.proposals.map((proposal, position) => ({
            actionSlug: proposal.actionSlug,
            agentLabel: payload.agentLabel ?? current.actor.displayName,
            agentPrincipalId: scope.principalId,
            appId: proposal.appId,
            batchId: payload.batchId,
            batchInstruction: payload.instruction,
            commandJson: proposal.command,
            diffJson: proposal.diff,
            legalEntityId: scope.legalEntityId ?? '',
            moduleKey: proposal.moduleKey,
            position,
            proposalId: proposal.proposalId,
            reason: proposal.reason,
            referenceAudiencesJson: proposal.referenceAudiences ?? [],
            revertJson: null,
            risk: proposal.risk,
            runId: payload.runId ?? null,
            status: 'pending',
            summary: proposal.summary,
            targetLabel: proposal.targetLabel,
            tenantId: scope.tenantId,
          })),
        )
        .returning({ proposalId: agentProposals.proposalId })
        .pipe(Effect.mapError(unavailable));
      const ids = payload.proposals.map((row) => row.proposalId);
      const persisted = new Set(inserted.map((row) => row.proposalId));
      if (inserted.length !== ids.length || ids.some((id) => !persisted.has(id))) {
        return yield* conflict('The proposal insertion did not persist its entire admitted batch');
      }
      return { ...base, affectedProposalIds: ids, outcome: 'changed' as const, proposalIds: ids };
    }
    // Read the database clock AFTER acquiring the proposer lock, not the transaction's older start time.
    const [clock] = yield* transaction
      .select({ now: sql<Date>`date_trunc('milliseconds', clock_timestamp())`.mapWith(agentProposals.createdAt) })
      .from(principals)
      .where(and(eq(principals.tenantId, scope.tenantId), eq(principals.principalId, snapshot.proposer.principalId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (clock === undefined) {
      return yield* unavailable();
    }
    const query = proposalReservationQuery(payload);
    const claim = Option.isSome(query) ? yield* latestAudit(transaction, scope, batchId, query.value) : null;
    const { affected, reservationId, values } = yield* planProposalTransition(payload, {
      actorPrincipalId: scope.principalId,
      claim,
      invocationId: input.actionInvocationId,
      now: clock.now,
      rows,
    });
    const unchanged = { ...base, affectedProposalIds: [], outcome: 'unchanged' as const };
    if (affected.length === 0) {
      return unchanged;
    }
    const ids = affected.map((row) => row.proposalId);
    const updated = yield* transaction
      .update(agentProposals)
      .set(values)
      .where(
        and(
          company(scope),
          eq(agentProposals.batchId, batchId),
          eq(agentProposals.agentPrincipalId, current.proposer.principalId),
          sql`${agentProposals.proposalId} in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ),
      )
      .returning({ proposalId: agentProposals.proposalId })
      .pipe(Effect.mapError(unavailable));
    if (updated.length !== ids.length) {
      return yield* conflict('The proposal transition did not update its entire admitted target');
    }
    const result: AgentProposalCommandResult = { ...base, affectedProposalIds: ids, outcome: 'changed' };
    return reservationId === undefined ? result : { ...result, reservationId };
  }),
});
