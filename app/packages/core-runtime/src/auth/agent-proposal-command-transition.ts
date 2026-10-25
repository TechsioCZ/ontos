import { Effect, Match, Option } from 'effect';

import type { agentProposals } from '../db/schema.ts';
import type { AgentProposalCommandAudit, AgentProposalCommandPayload } from './agent-proposal-command-contract.ts';
import { proposalCommandTargetId } from './agent-proposal-command-contract.ts';
import { proposalCommandConflict as conflict } from './agent-proposal-command-error.ts';

type Proposal = typeof agentProposals.$inferSelect;
type Mutation = Exclude<AgentProposalCommandPayload, { readonly operation: 'insert' }>;
export interface ProposalTransition {
  readonly affected: readonly Proposal[];
  readonly reservationId?: string;
  readonly values: Partial<typeof agentProposals.$inferInsert>;
}
interface TransitionInput {
  readonly actorPrincipalId: string;
  readonly claim: AgentProposalCommandAudit | null;
  readonly invocationId: string;
  readonly now: Date;
  readonly rows: readonly Proposal[];
}
const pending = (row: Proposal) => row.status === 'pending';
const revertible = (row: Proposal) => row.status === 'applied' || row.status === 'revert_failed';
/** Durable reservations do not expire while a separately committed module Action may still be executing. */
export const proposalApprovalIsUnclaimed = (row: Proposal) => row.decidedAt === null;
const unchanged: ProposalTransition = { affected: [], values: {} };

export const proposalReservationQuery = (payload: Mutation) =>
  Match.value(payload).pipe(
    Match.whenOr(
      { operation: 'release-approval' },
      { operation: 'mark-applied' },
      { operation: 'mark-failed' },
      (value) => Option.some({ operation: 'claim-approval' as const, proposalId: value.proposalId }),
    ),
    Match.whenOr(
      { operation: 'mark-reverted' },
      { operation: 'mark-revert-failed' },
      { operation: 'close-pending-in-batch' },
      () => Option.some({ operation: 'claim-batch-revert' as const }),
    ),
    Match.orElse(() => Option.none()),
  );

/** Pure owner state machine; graph/module execution is deliberately absent. */
export const planProposalTransition = (payload: Mutation, input: TransitionInput) => {
  const { actorPrincipalId: by, claim, invocationId, now, rows } = input;
  const targetId = proposalCommandTargetId(payload);
  const target = Option.isSome(targetId) ? rows.find((row) => row.proposalId === targetId.value) : undefined;
  const batchReserved = rows.some((row) => row.batchRevertedAt !== null);
  const ownsApproval = (reservationId: string) =>
    target !== undefined &&
    pending(target) &&
    target.decidedAt !== null &&
    target.decidedByPrincipalId === by &&
    claim?.reservationId === reservationId;
  const ownsRevert = (reservationId: string) =>
    batchReserved &&
    claim?.reservationId === reservationId &&
    rows.every((row) => row.batchRevertedByPrincipalId === by);
  const approval = (reservationId: string, values: ProposalTransition['values']) =>
    ownsApproval(reservationId) && target !== undefined
      ? Effect.succeed<ProposalTransition>({ affected: [target], values })
      : Effect.fail(conflict('Only the exact current approval reservation may be completed or released'));
  const revert = (reservationId: string, transition: ProposalTransition) =>
    ownsRevert(reservationId)
      ? Effect.succeed(transition)
      : Effect.fail(conflict('Only the exact batch revert reservation may complete its work'));
  return Match.value(payload).pipe(
    Match.when({ operation: 'claim-approval' }, () =>
      Effect.succeed<ProposalTransition>(
        target === undefined || !pending(target) || !proposalApprovalIsUnclaimed(target) || batchReserved
          ? unchanged
          : { affected: [target], reservationId: invocationId, values: { decidedAt: now, decidedByPrincipalId: by } },
      ),
    ),
    Match.when({ operation: 'mark-rejected' }, (value) =>
      Effect.succeed<ProposalTransition>(
        target === undefined || !pending(target) || !proposalApprovalIsUnclaimed(target)
          ? unchanged
          : {
              affected: [target],
              values: {
                decidedAt: now,
                decidedByPrincipalId: by,
                decisionNote: value.note ?? null,
                status: 'rejected',
              },
            },
      ),
    ),
    Match.when({ operation: 'release-approval' }, (value) =>
      approval(value.reservationId, { decidedAt: null, decidedByPrincipalId: null }),
    ),
    Match.when({ operation: 'mark-applied' }, (value) =>
      approval(value.reservationId, {
        appliedAt: now,
        applyResultJson: value.applyResult,
        decidedAt: now,
        diffJson: value.diff ?? target?.diffJson,
        failure: null,
        revertJson: value.revert ?? null,
        status: 'applied',
      }),
    ),
    Match.when({ operation: 'mark-failed' }, (value) =>
      approval(value.reservationId, { decidedAt: now, failure: value.failure, status: 'failed' }),
    ),
    Match.when({ operation: 'claim-batch-revert' }, (value) =>
      Effect.succeed<ProposalTransition>(
        batchReserved || rows.some((row) => pending(row) && !proposalApprovalIsUnclaimed(row)) || !rows.some(revertible)
          ? unchanged
          : {
              affected: rows,
              reservationId: invocationId,
              values: { batchRevertedAt: now, batchRevertedByPrincipalId: by, batchRevertNote: value.note ?? null },
            },
      ),
    ),
    Match.when({ operation: 'close-pending-in-batch' }, (value) =>
      revert(value.reservationId, {
        affected: rows.filter((row) => pending(row) && proposalApprovalIsUnclaimed(row)),
        values: { decidedAt: now, decidedByPrincipalId: by, decisionNote: value.note, status: 'rejected' },
      }),
    ),
    Match.when({ operation: 'mark-reverted' }, (value) =>
      revert(value.reservationId, {
        affected: target !== undefined && revertible(target) ? [target] : [],
        values: { failure: null, revertedAt: now, revertedByPrincipalId: by, status: 'reverted' },
      }),
    ),
    Match.when({ operation: 'mark-revert-failed' }, (value) =>
      revert(value.reservationId, {
        affected: target !== undefined && revertible(target) ? [target] : [],
        values: { failure: value.failure, status: 'revert_failed' },
      }),
    ),
    Match.when({ operation: 'withdraw-pending-of-agent' }, (value) =>
      Effect.succeed<ProposalTransition>({
        affected: rows.filter((row) => pending(row) && proposalApprovalIsUnclaimed(row)),
        values: { decidedAt: now, decidedByPrincipalId: by, decisionNote: value.note, status: 'rejected' },
      }),
    ),
    Match.exhaustive,
  );
};
