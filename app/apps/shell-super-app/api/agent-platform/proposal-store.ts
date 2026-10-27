/** Native Core proposal operations; Shell owns only presentation mapping and orchestration. */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

import {
  ActionRuntime,
  AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT,
  AgentProposalCommandPayloadSchema,
  agentActivityActorsRead,
  agentActivityRead,
  agentProposalQueueRead,
  mutateAgentProposalsAction,
  ReadRuntime,
} from '@app/core-runtime';
import type {
  AgentProposalCommandPayload,
  AgentProposalCommandResult,
  AgentProposalReservation,
  AgentProposalQueueInput,
  AgentProposalQueueRow,
  OperationalScopeRequest,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { AGENT_PAGE_SIZE } from '@app/shared-contracts/agent-proposals';
import type { AgentActivityRequest, AgentQueueRequest } from '@app/shared-contracts/agent-proposals';
import { Data, Effect, Match, Option, Schema, Stream, Tuple } from 'effect';

import { AgentActionRequestIdentity } from '../auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../auth/agent-request-identity.ts';
import { accessRowToEntry, auditRowToEntry, buildActivityResponse, proposalRowToEntries } from './mappers.ts';
import type { AgentProposalRow, ModuleTexts } from './mappers.ts';

export class AgentStoreUnavailable extends Data.TaggedError('AgentStoreUnavailable')<{ readonly cause: unknown }> {}
const unavailable = (cause: unknown) => new AgentStoreUnavailable({ cause });

const toRow = (row: AgentProposalQueueRow): AgentProposalRow => ({
  ...row,
  appliedAt: Option.getOrNull(row.appliedAt),
  batchRevertedAt: Option.getOrNull(row.batchRevertedAt),
  batchRevertedByPrincipalId: Option.getOrNull(row.batchRevertedByPrincipalId),
  batchRevertNote: Option.getOrNull(row.batchRevertNote),
  decidedAt: Option.getOrNull(row.decidedAt),
  decidedByPrincipalId: Option.getOrNull(row.decidedByPrincipalId),
  decisionNote: Option.getOrNull(row.decisionNote),
  failure: Option.getOrNull(row.failure),
  revert: Option.getOrNull(row.revert),
  revertedAt: Option.getOrNull(row.revertedAt),
  revertedByPrincipalId: Option.getOrNull(row.revertedByPrincipalId),
  runId: Option.getOrNull(row.runId),
});

const readProposals = Effect.fn('AgentStore.readProposals')(function* readProposals(
  principal: TrustedPrincipalContext,
  input: AgentProposalQueueInput,
) {
  const transport = yield* AgentReadRequestIdentity;
  return yield* (yield* ReadRuntime).runRead({ input, principal, registration: agentProposalQueueRead, transport });
});

export const findRunProposals = Effect.fn('AgentStore.findRunProposals')(function* findRunProposals(
  principal: TrustedPrincipalContext,
  runId: string,
) {
  return (yield* readProposals(principal, { mode: 'own-run', runId })).proposals.map(toRow);
});

/** Native own-recent is agent-only, company scoped and bounded to 300 rows. */
export const listCompanyProposals = Effect.fn('AgentStore.listCompanyProposals')(function* listCompanyProposals(
  principal: TrustedPrincipalContext,
) {
  return (yield* readProposals(principal, { mode: 'own-recent' })).proposals.map(toRow);
});

export const listCompanyProposalPage = Effect.fn('AgentStore.listCompanyProposalPage')(
  function* listCompanyProposalPage(principal: TrustedPrincipalContext, request: AgentQueueRequest) {
    const page = yield* readProposals(principal, { mode: 'queue', request });
    return { candidates: page.candidates, proposals: page.proposals.map(toRow) };
  },
);

/** Native exact-batch reads deny the entire batch if any Action or private record is not authorized. */
export const loadBatchProposals = Effect.fn('AgentStore.loadBatchProposals')(function* loadBatchProposals(
  principal: TrustedPrincipalContext,
  batchId: string,
) {
  return (yield* readProposals(principal, { batchId, mode: 'batch' })).proposals.map(toRow);
});

export const batchHasApprovalInProgress = Effect.fn('AgentStore.batchHasApprovalInProgress')(
  function* batchHasApprovalInProgress(principal: TrustedPrincipalContext, batchId: string) {
    return (yield* readProposals(principal, { batchId, mode: 'batch-state' })).approvalInProgress;
  },
);

export const isBatchReverted = Effect.fn('AgentStore.isBatchReverted')(function* isBatchReverted(
  principal: TrustedPrincipalContext,
  batchId: string,
) {
  return (yield* readProposals(principal, { batchId, mode: 'batch-state' })).batchReverted;
});

/** Whole-batch authorization also protects current caller-owned reservation evidence. */
export const loadProposalBatch = Effect.fn('AgentStore.loadProposalBatch')(function* loadProposalBatch(
  principal: TrustedPrincipalContext,
  batchId: string,
) {
  const batch = yield* readProposals(principal, { batchId, mode: 'batch' });
  return { ...batch, proposals: batch.proposals.map(toRow) };
});

/** Historical claim success is not authority to resume a released or replaced reservation. */
export const proposalClaimIsCurrent = (
  claim: AgentProposalCommandResult,
  operation: AgentProposalReservation['operation'],
  reservations: readonly AgentProposalReservation[],
) =>
  claim.reservationId !== undefined &&
  claim.affectedProposalIds.length > 0 &&
  reservations.some(
    (reservation) =>
      reservation.operation === operation &&
      reservation.reservationId === claim.reservationId &&
      reservation.revision === claim.revision &&
      reservation.proposalIds.length === claim.affectedProposalIds.length &&
      reservation.proposalIds.every((proposalId, index) => proposalId === claim.affectedProposalIds[index]),
  );

export const requireCurrentProposalClaim = Effect.fn('AgentStore.requireCurrentProposalClaim')(
  function* requireCurrentProposalClaim(
    principal: TrustedPrincipalContext,
    claim: AgentProposalCommandResult,
    operation: AgentProposalReservation['operation'],
  ) {
    const batch = yield* loadProposalBatch(principal, claim.batchId);
    if (!proposalClaimIsCurrent(claim, operation, batch.reservations ?? [])) {
      return yield* unavailable('The historical claim is not the current caller-owned reservation');
    }
    return batch;
  },
);

/** The persisted ingress key, fixed operation and exact target are the only subcommand-key inputs. */
export const proposalSubcommandKey = (
  ingressKey: string,
  operation: AgentProposalCommandPayload['operation'],
  target: string,
) => {
  const digest = Hex.encode(sha256(utf8ToBytes(`${ingressKey}\0${operation}\0${target}`)));
  return `agent-proposal:${digest}`;
};

/** Core verifies the exact invocation, original payload hash and retained audit/result before recovering a result.
 * A running or rejected invocation is not retry authority. There is no elapsed-time takeover.
 */
export const mutateAgentProposals = Effect.fn('AgentStore.mutateAgentProposals')(function* mutateAgentProposals(
  principal: TrustedPrincipalContext,
  payload: AgentProposalCommandPayload,
) {
  const transport = yield* AgentActionRequestIdentity;
  const target = Match.value(payload).pipe(
    Match.whenOr(
      { operation: 'insert' },
      { operation: 'claim-batch-revert' },
      { operation: 'close-pending-in-batch' },
      { operation: 'withdraw-pending-of-agent' },
      (command) => command.batchId,
    ),
    Match.orElse((command) => `${command.batchId}/${command.proposalId}`),
  );
  const idempotencyKey = proposalSubcommandKey(transport.idempotencyKey, payload.operation, target);
  const recover = readProposals(principal, { idempotencyKey, mode: 'command-recovery', payload }).pipe(
    Effect.flatMap((read) =>
      read.commandRecovery === undefined
        ? Effect.fail(unavailable('The native command recovery evidence is missing'))
        : Effect.succeed(read.commandRecovery),
    ),
  );
  const recovery = yield* recover;
  if (recovery.state === 'COMMITTED') {
    return recovery.result;
  }
  if (!recovery.retryCommand) {
    return yield* unavailable(`The native proposal command is ${recovery.state}`);
  }
  return yield* (yield* ActionRuntime)
    .runAction({
      payload,
      principal,
      registration: mutateAgentProposalsAction,
      transport: { ...transport, idempotencyKey },
    })
    .pipe(
      // Another delivery may commit between the Read and Action. Its error is never used as a result.
      Effect.catchTag('ActionAlreadyCommitted', (failure) =>
        recover.pipe(
          Effect.flatMap((current) =>
            current.state === 'COMMITTED' ? Effect.succeed(current.result) : Effect.fail(failure),
          ),
        ),
      ),
    );
});

type Command<Operation extends AgentProposalCommandPayload['operation']> = Omit<
  Extract<AgentProposalCommandPayload, { readonly operation: Operation }>,
  'operation'
>;

export const insertProposals = (principal: TrustedPrincipalContext, input: Command<'insert'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'insert' });
export const claimForApproval = (principal: TrustedPrincipalContext, input: Command<'claim-approval'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'claim-approval' });
export const releaseApprovalClaim = (principal: TrustedPrincipalContext, input: Command<'release-approval'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'release-approval' });
export const markApplied = Effect.fn('AgentStore.markApplied')(function* markApplied(
  principal: TrustedPrincipalContext,
  input: Omit<Command<'mark-applied'>, 'applyResult'> & { readonly applyResult: unknown },
) {
  // A module response is untrusted wire data. Decode the finite native payload before dispatch, without a cast.
  const payload = yield* Schema.decodeUnknownEffect(AgentProposalCommandPayloadSchema)({
    ...input,
    operation: 'mark-applied',
  });
  return yield* mutateAgentProposals(principal, payload);
});
export const markRejected = (principal: TrustedPrincipalContext, input: Command<'mark-rejected'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'mark-rejected' });
export const markFailed = (principal: TrustedPrincipalContext, input: Command<'mark-failed'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'mark-failed' });
export const markReverted = (principal: TrustedPrincipalContext, input: Command<'mark-reverted'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'mark-reverted' });
export const markRevertFailed = (principal: TrustedPrincipalContext, input: Command<'mark-revert-failed'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'mark-revert-failed' });
export const claimBatchRevert = (principal: TrustedPrincipalContext, input: Command<'claim-batch-revert'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'claim-batch-revert' });
export const closePendingInBatch = (principal: TrustedPrincipalContext, input: Command<'close-pending-in-batch'>) =>
  mutateAgentProposals(principal, { ...input, operation: 'close-pending-in-batch' });
/** Lifecycle ingress must enumerate complete affected batches through a native producer, never scalar scope SQL. */
export const withdrawPendingOfAgent = (
  principal: TrustedPrincipalContext,
  input: Command<'withdraw-pending-of-agent'>,
) => mutateAgentProposals(principal, { ...input, operation: 'withdraw-pending-of-agent' });

/** Reject a malformed/nonadvancing native page instead of looping or silently truncating lifecycle cleanup. */
export const withdrawalPageAdvances = (
  page: { readonly batchIds: readonly string[]; readonly nextAfterBatchId?: string },
  afterBatchId?: string,
) =>
  page.batchIds.length <= AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT &&
  page.batchIds.every((batchId, index) => {
    const previous = index === 0 ? afterBatchId : page.batchIds[index - 1];
    return previous === undefined || batchId > previous;
  }) &&
  (page.nextAfterBatchId === undefined || (page.batchIds.length > 0 && page.nextAfterBatchId === page.batchIds.at(-1)));

/** Lifecycle consumer: SQL, inactive-agent checks and reserved-approval exclusion remain entirely Core-owned. */
export const withdrawAllPendingOfAgent = Effect.fn('AgentStore.withdrawAllPendingOfAgent')(
  function* withdrawAllPendingOfAgent(
    originalPrincipal: TrustedPrincipalContext,
    input: { readonly agentPrincipalId: string; readonly note: string },
  ) {
    // Require the genuine persisted ingress key even when enumeration finds no pending proposals.
    yield* AgentActionRequestIdentity;
    const firstPage: Extract<AgentProposalQueueInput, { readonly mode: 'withdrawal-batches' }> = {
      agentPrincipalId: input.agentPrincipalId,
      mode: 'withdrawal-batches',
    };
    yield* Stream.paginate(
      firstPage,
      Effect.fn('AgentStore.withdrawalPage')(function* withdrawalPage(request: typeof firstPage) {
        const read = yield* readProposals(originalPrincipal, request);
        const page = read.withdrawalBatches;
        if (page === undefined || !withdrawalPageAdvances(page, request.afterBatchId)) {
          return yield* unavailable('The native withdrawal batch page is missing or does not advance');
        }
        const next =
          page.nextAfterBatchId === undefined
            ? Option.none<typeof firstPage>()
            : Option.some({ ...firstPage, afterBatchId: page.nextAfterBatchId });
        return Tuple.make(page.batchIds, next);
      }),
    ).pipe(Stream.runForEach((batchId) => withdrawPendingOfAgent(originalPrincipal, { batchId, note: input.note })));
  },
);

/** Original ingress principal and correlation are mandatory; there is no scalar-scope compatibility path. */
export const principalNames = Effect.fn('AgentStore.principalNames')(function* principalNames(
  principal: TrustedPrincipalContext,
  transport: OperationalScopeRequest,
) {
  const actors = yield* (yield* ReadRuntime)
    .runRead({
      input: {},
      principal,
      registration: agentActivityActorsRead,
      transport,
    })
    .pipe(Effect.mapError(unavailable));
  return new Map<string, string>(actors.names.map((row) => [row.principalId, row.displayName]));
});

/** Agent principals of the tenant; company filtering remains on their activity rows. */
export const listCompanyAgentIds = Effect.fn('AgentStore.listCompanyAgentIds')(function* listCompanyAgentIds(
  principal: TrustedPrincipalContext,
  transport: OperationalScopeRequest,
) {
  const actors = yield* (yield* ReadRuntime)
    .runRead({
      input: {},
      principal,
      registration: agentActivityActorsRead,
      transport,
    })
    .pipe(Effect.mapError(unavailable));
  return actors.agentIds;
});

export interface AgentActivityScope {
  readonly modules: ModuleTexts;
  /** Private-record module review already narrowed these; Core independently rechecks module/Action rights. */
  readonly visibleModules: ReadonlySet<string>;
}

export const listAgentActivity = Effect.fn('AgentStore.listAgentActivity')(function* listAgentActivity(
  principal: TrustedPrincipalContext,
  request: AgentActivityRequest,
  scope: AgentActivityScope,
  transport: OperationalScopeRequest,
) {
  const rows = yield* (yield* ReadRuntime)
    .runRead({
      input: { request, visibleModules: [...scope.visibleModules] },
      principal,
      registration: agentActivityRead,
      transport,
    })
    .pipe(Effect.mapError(unavailable));
  const names = new Map<string, string>(rows.names.map((row) => [row.principalId, row.displayName]));
  const proposalOnly = new Set(rows.proposalOnlyAgentIds);
  const entries = [
    ...rows.audit.map((row) =>
      auditRowToEntry(
        {
          ...row,
          actionInvocationId: Option.getOrNull(row.actionInvocationId),
          actionKey: Option.getOrNull(row.actionKey),
          targetModuleKey: Option.getOrNull(row.targetModuleKey),
          targetResourceId: Option.getOrNull(row.targetResourceId),
          targetResourceType: Option.getOrNull(row.targetResourceType),
        },
        {
          modules: scope.modules,
          proposalOnly: proposalOnly.has(row.principalId),
        },
      ),
    ),
    ...rows.access.map((row) =>
      accessRowToEntry(
        {
          ...row,
          targetResourceId: Option.getOrNull(row.targetResourceId),
          targetResourceType: Option.getOrNull(row.targetResourceType),
        },
        scope.modules,
      ),
    ),
    ...rows.proposals.flatMap((row) =>
      proposalRowToEntries(
        {
          ...row,
          appliedAt: Option.getOrNull(row.appliedAt),
          batchRevertedAt: Option.getOrNull(row.batchRevertedAt),
          batchRevertedByPrincipalId: Option.getOrNull(row.batchRevertedByPrincipalId),
          batchRevertNote: Option.getOrNull(row.batchRevertNote),
          decidedAt: Option.getOrNull(row.decidedAt),
          decidedByPrincipalId: Option.getOrNull(row.decidedByPrincipalId),
          decisionNote: Option.getOrNull(row.decisionNote),
          failure: Option.getOrNull(row.failure),
          revert: Option.getOrNull(row.revert),
          revertedAt: Option.getOrNull(row.revertedAt),
          revertedByPrincipalId: Option.getOrNull(row.revertedByPrincipalId),
          runId: Option.getOrNull(row.runId),
        },
        names,
        scope.modules,
      ),
    ),
  ].filter((entry) => entry.moduleKey !== null && scope.visibleModules.has(entry.moduleKey));
  return buildActivityResponse(entries, { ...request, limit: AGENT_PAGE_SIZE + 1 });
});
