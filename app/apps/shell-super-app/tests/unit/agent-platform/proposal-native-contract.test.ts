import {
  AgentProposalCommandPayloadSchema,
  AgentProposalCommandRecoverySchema,
  AgentProposalQueueInputSchema,
  AgentProposalQueueResultSchema,
} from '@app/core-runtime';
import type {
  ActionRuntime,
  ActiveApplicationCompositionService,
  AgentProposalCommandResult,
  AgentProposalQueueModuleReview,
  AgentProposalReservation,
  ContextAccess,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { Option, Schema } from 'effect';
import type { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  proposalClaimIsCurrent,
  proposalSubcommandKey,
  withdrawAllPendingOfAgent,
  withdrawalPageAdvances,
} from '../../../api/agent-platform/proposal-store.ts';
import type { AgentProposalCommandPreparation } from '../../../../../packages/core-runtime/src/auth/agent-proposal-command-preparation.ts';
import type { AgentActionRequestIdentity } from '../../../api/auth/agent-action-request-identity.ts';
import type { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';

const batchId = '50000000-0000-4000-8000-000000000001';
const proposalId = '60000000-0000-4000-8000-000000000001';
const reservationId = '70000000-0000-4000-8000-000000000001';
const target = { batchId, proposalId };
const reserved = { ...target, reservationId };
const claim: AgentProposalCommandResult = {
  affectedProposalIds: [proposalId],
  batchId,
  outcome: 'changed',
  proposalIds: [proposalId],
  reservationId,
  revision: 3,
};
const reservation: AgentProposalReservation = {
  operation: 'claim-approval',
  proposalIds: [proposalId],
  reservationId,
  revision: 3,
};

it('derives stable, bounded, distinct native subcommand identities only from ingress key, operation and target', () => {
  const ingress = 'persisted-client-ingress-key';
  const claimKey = proposalSubcommandKey(ingress, 'claim-approval', `${batchId}/${proposalId}`);
  expect(claimKey).toBe(proposalSubcommandKey(ingress, 'claim-approval', `${batchId}/${proposalId}`));
  const operations = [
    'insert',
    'claim-approval',
    'release-approval',
    'mark-applied',
    'mark-rejected',
    'mark-failed',
    'mark-reverted',
    'mark-revert-failed',
    'claim-batch-revert',
    'close-pending-in-batch',
    'withdraw-pending-of-agent',
  ] as const;
  const keys = operations.map((operation) => proposalSubcommandKey(ingress, operation, batchId));
  expect(new Set(keys).size).toBe(11);
  expect(keys.every((key) => key.length <= 200)).toBe(true);
  expect(proposalSubcommandKey('different-ingress', 'claim-approval', `${batchId}/${proposalId}`)).not.toBe(claimKey);
  expect(proposalSubcommandKey(ingress, 'claim-approval', `${batchId}/other-proposal`)).not.toBe(claimKey);
});

it('accepts all eleven actual finite native payloads without caller-supplied authority or reservation fabrication', () => {
  const commands = [
    {
      batchId,
      instruction: 'Update the task',
      operation: 'insert',
      proposals: [
        {
          actionSlug: 'update',
          appId: 'tasks',
          command: { title: 'New' },
          diff: [],
          moduleKey: 'work.tasks',
          proposalId,
          reason: 'Requested',
          risk: 'low',
          summary: 'Update',
          targetLabel: 'Task',
        },
      ],
    },
    { ...target, operation: 'claim-approval' },
    { ...reserved, operation: 'release-approval' },
    { ...reserved, applyResult: { changed: true }, operation: 'mark-applied' },
    { ...target, operation: 'mark-rejected' },
    { ...reserved, failure: 'Module refused', operation: 'mark-failed' },
    { ...reserved, operation: 'mark-reverted' },
    { ...reserved, failure: 'Module unavailable', operation: 'mark-revert-failed' },
    { batchId, operation: 'claim-batch-revert' },
    { batchId, note: 'Closed', operation: 'close-pending-in-batch', reservationId },
    { batchId, note: 'Agent disabled', operation: 'withdraw-pending-of-agent' },
  ];
  const decode = Schema.decodeUnknownOption(AgentProposalCommandPayloadSchema, { onExcessProperty: 'error' });
  expect(commands.every((command) => Option.isSome(decode(command)))).toBe(true);
  expect(Option.isNone(decode({ ...target, applyResult: null, operation: 'mark-applied' }))).toBe(true);
  expect(Option.isNone(decode({ ...reserved, applyResult: { price: Infinity }, operation: 'mark-applied' }))).toBe(
    true,
  );
  expect(Option.isNone(decode({ ...reserved, by: 'other-human', operation: 'release-approval' }))).toBe(true);
  expect(Option.isNone(decode({ ...target, operation: 'claim-approval', tenantId: 'other-tenant' }))).toBe(true);
});

it('requires the original derived subcommand key and complete payload for native recovery', () => {
  const decode = Schema.decodeUnknownOption(AgentProposalQueueInputSchema, { onExcessProperty: 'error' });
  const payload = { ...reserved, applyResult: { createdId: 'owner-result' }, operation: 'mark-applied' };
  const input = {
    idempotencyKey: proposalSubcommandKey('original-ingress', 'mark-applied', `${batchId}/${proposalId}`),
    mode: 'command-recovery',
    payload,
  };
  expect(Option.isSome(decode(input))).toBe(true);
  expect(Option.isNone(decode({ ...input, payload: { ...target, operation: 'mark-applied' } }))).toBe(true);
  expect(Option.isNone(decode({ mode: input.mode, payload }))).toBe(true);
  expect(Option.isNone(decode({ ...input, principalId: reservationId }))).toBe(true);
});

it('committed recovery requires a real result; running/rejected states cannot grant retry authority', () => {
  const decode = Schema.decodeUnknownOption(AgentProposalCommandRecoverySchema, { onExcessProperty: 'error' });
  expect(
    Option.isSome(decode({ invocationId: reservationId, result: claim, retryCommand: false, state: 'COMMITTED' })),
  ).toBe(true);
  expect(Option.isNone(decode({ invocationId: reservationId, retryCommand: false, state: 'COMMITTED' }))).toBe(true);
  for (const state of ['RUNNING', 'REJECTED']) {
    expect(Option.isSome(decode({ invocationId: reservationId, retryCommand: false, state }))).toBe(true);
    expect(Option.isNone(decode({ invocationId: reservationId, retryCommand: true, state }))).toBe(true);
    expect(Option.isNone(decode({ invocationId: reservationId, result: claim, retryCommand: false, state }))).toBe(
      true,
    );
  }
  expect(Option.isSome(decode({ retryCommand: true, state: 'NOT_STARTED' }))).toBe(true);
  expect(Option.isSome(decode({ invocationId: reservationId, retryCommand: true, state: 'RETRYABLE' }))).toBe(true);
});

it('resumes only an exact current caller-owned reservation, not a historical claim result', () => {
  expect(proposalClaimIsCurrent(claim, 'claim-approval', [reservation])).toBe(true);
  expect(proposalClaimIsCurrent(claim, 'claim-approval', [])).toBe(false);
  expect(proposalClaimIsCurrent(claim, 'claim-batch-revert', [reservation])).toBe(false);
  expect(proposalClaimIsCurrent(claim, 'claim-approval', [{ ...reservation, reservationId: batchId }])).toBe(false);
  expect(proposalClaimIsCurrent(claim, 'claim-approval', [{ ...reservation, revision: 4 }])).toBe(false);
  expect(proposalClaimIsCurrent(claim, 'claim-approval', [{ ...reservation, proposalIds: [batchId] }])).toBe(false);
  expect(
    proposalClaimIsCurrent(claim, 'claim-approval', [{ ...reservation, proposalIds: [proposalId, batchId] }]),
  ).toBe(false);
  expect(proposalClaimIsCurrent({ ...claim, affectedProposalIds: [] }, 'claim-approval', [reservation])).toBe(false);
  const noReservation: AgentProposalCommandResult = {
    affectedProposalIds: claim.affectedProposalIds,
    batchId,
    outcome: 'changed',
    proposalIds: claim.proposalIds,
    revision: 3,
  };
  expect(proposalClaimIsCurrent(noReservation, 'claim-approval', [reservation])).toBe(false);
});

it('batch compensation requires the current whole-batch reservation, never an approval capability', () => {
  const batchClaim = { ...claim, affectedProposalIds: [proposalId, batchId], proposalIds: [proposalId, batchId] };
  const batchReservation: AgentProposalReservation = {
    ...reservation,
    operation: 'claim-batch-revert',
    proposalIds: batchClaim.proposalIds,
  };
  expect(proposalClaimIsCurrent(batchClaim, 'claim-batch-revert', [batchReservation])).toBe(true);
  expect(proposalClaimIsCurrent(batchClaim, 'claim-batch-revert', [reservation])).toBe(false);
  expect(
    proposalClaimIsCurrent(batchClaim, 'claim-batch-revert', [{ ...batchReservation, proposalIds: [proposalId] }]),
  ).toBe(false);
});

it('keeps lifecycle withdrawal requirements concrete instead of leaking an unknown Effect environment', () => {
  const withdraw = withdrawAllPendingOfAgent satisfies (
    ...args: Parameters<typeof withdrawAllPendingOfAgent>
  ) => Effect.Effect<
    void,
    Effect.Error<ReturnType<typeof withdrawAllPendingOfAgent>>,
    | ActionRuntime
    | ReadRuntime
    | AgentActionRequestIdentity
    | AgentReadRequestIdentity
    | ActionAuthority
    | ActiveApplicationCompositionService
    | ContextAccess
    | AgentProposalQueueModuleReview
    | AgentProposalCommandPreparation
  >;
  expect(withdraw).toBe(withdrawAllPendingOfAgent);
});

it('lifecycle pages carry only target agent, real batch IDs and a continuation, bounded to 31 per page', () => {
  const decodeInput = Schema.decodeUnknownOption(AgentProposalQueueInputSchema, { onExcessProperty: 'error' });
  expect(Option.isSome(decodeInput({ agentPrincipalId: proposalId, mode: 'withdrawal-batches' }))).toBe(true);
  expect(
    Option.isSome(decodeInput({ afterBatchId: batchId, agentPrincipalId: proposalId, mode: 'withdrawal-batches' })),
  ).toBe(true);
  expect(Option.isNone(decodeInput({ agentPrincipalId: proposalId, limit: 1000, mode: 'withdrawal-batches' }))).toBe(
    true,
  );
  const decodeResult = Schema.decodeUnknownOption(AgentProposalQueueResultSchema);
  const page = {
    approvalInProgress: false,
    batchReverted: false,
    candidates: [],
    proposals: [],
    withdrawalBatches: { batchIds: Array.from({ length: 31 }, () => batchId), nextAfterBatchId: batchId },
  };
  expect(Option.isSome(decodeResult(page))).toBe(true);
  expect(
    Option.isNone(
      decodeResult({ ...page, withdrawalBatches: { batchIds: Array.from({ length: 32 }, () => batchId) } }),
    ),
  ).toBe(true);
});

it('accepts successive lifecycle pages beyond 31 batches but rejects duplicate, regressing or invented cursors', () => {
  const batchIds = Array.from(
    { length: 124 },
    (_, index) => `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );
  let afterBatchId: string | undefined;
  for (let offset = 0; offset < batchIds.length; offset += 31) {
    const ids = batchIds.slice(offset, offset + 31);
    const last = ids.at(-1);
    if (last === undefined) {
      throw new Error('Expected a full native withdrawal page');
    }
    const page = { batchIds: ids, nextAfterBatchId: last };
    expect(withdrawalPageAdvances(page, afterBatchId)).toBe(true);
    afterBatchId = page.nextAfterBatchId;
  }
  expect(withdrawalPageAdvances({ batchIds: [] }, afterBatchId)).toBe(true);
  expect(withdrawalPageAdvances({ batchIds: [], nextAfterBatchId: batchId })).toBe(false);
  expect(withdrawalPageAdvances({ batchIds: [batchId, batchId] })).toBe(false);
  expect(withdrawalPageAdvances({ batchIds: [batchId] }, batchId)).toBe(false);
  expect(withdrawalPageAdvances({ batchIds: [batchId], nextAfterBatchId: proposalId })).toBe(false);
  expect(withdrawalPageAdvances({ batchIds })).toBe(false);
});

it('own-run/recent and exact-batch state reject scalar tenant, company, agent and visibility authority', () => {
  const decode = Schema.decodeUnknownOption(AgentProposalQueueInputSchema, { onExcessProperty: 'error' });
  for (const input of [
    { mode: 'own-recent' },
    { mode: 'own-run', runId: 'own-run' },
    { batchId, mode: 'batch' },
    { batchId, mode: 'batch-state' },
  ]) {
    expect(Option.isSome(decode(input))).toBe(true);
    for (const authority of [
      { tenantId: 'other-tenant' },
      { legalEntityId: 'other-company' },
      { agentPrincipalId: 'other-agent' },
      { visibleModules: ['work.tasks'] },
    ]) {
      expect(Option.isNone(decode({ ...input, ...authority }))).toBe(true);
    }
  }
});
